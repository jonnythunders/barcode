/**
 * /api/admin/poll-brand
 *
 * Admin endpoint to manually trigger a brand-card poll (single brand or all
 * monitored brands) without running scripts locally. Designed for the
 * Vercel-first workflow.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 *
 * Usage (PowerShell):
 *   Invoke-WebRequest -Uri "https://barcodekestrel.vercel.app/api/admin/poll-brand?slug=liquid-death" `
 *     -Headers @{ "Authorization" = "Bearer $env:CRON_SECRET" } |
 *     Select-Object -ExpandProperty Content
 *
 *   # Limit when polling all (credit-aware smoke test):
 *   ?all=true&limit=5
 *
 *   # Diagnostic mode — bypasses the fail-safe so you SEE what each fetcher returned,
 *   # even if SociaVault failed and we would normally fall back to the cached card:
 *   ?slug=liquid-death&debug=1
 *
 * Returns: JSON with per-brand status, momentum, provenance, and diagnostics.
 */
import { NextResponse } from "next/server";
import { verifyCronSecret, getAdminSupabase } from "@/lib/supabase-admin";
import { getBrandCard } from "@/lib/brand-card";
import { nowIso } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface BrandResult {
  slug: string;
  name: string;
  ok: boolean;
  momentumScore: number | null;
  partial: boolean;
  tiktokProvenance?: "sourced" | "sample";
  tiktokSourceLabel?: string;
  tiktokFollowers?: number | null;
  instagramProvenance?: "sourced" | "sample";
  instagramSourceLabel?: string;
  instagramFollowers?: number | null;
  errors?: Record<string, string>;
  errorMessage?: string;
  durationMs: number;
  /** Populated when ?debug=1 — recent fetcher_runs rows for this brand,
   *  showing exactly what SociaVault (and other fetchers) did. */
  recentFetcherRuns?: {
    fetcherName: string;
    status: string;
    snapshotsWritten: number;
    errorMessage: string | null;
    startedAt: string;
    finishedAt: string | null;
    metadata: unknown;
  }[];
}

interface AdminPollResult {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  brandsAttempted: number;
  brandsSucceeded: number;
  brandsFailed: number;
  results: BrandResult[];
  totalDurationMs: number;
}

export async function GET(request: Request) {
  try {
    verifyCronSecret(request);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 }
    );
  }

  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  const all = url.searchParams.get("all") === "true";
  const limit = Number(url.searchParams.get("limit") ?? "0");
  const debug = url.searchParams.get("debug") === "1";

  if (!slug && !all) {
    return NextResponse.json(
      { error: "Must specify either ?slug=<brand-slug> or ?all=true" },
      { status: 400 }
    );
  }

  const db = getAdminSupabase();
  const startedAt = Date.now();

  let brandsQuery = db
    .from("brands")
    .select("id, name, slug")
    .eq("is_monitored", true)
    .eq("is_archived", false);
  if (slug) {
    brandsQuery = brandsQuery.eq("slug", slug);
  }
  if (limit > 0) {
    brandsQuery = brandsQuery.limit(limit);
  }
  const { data: brands, error } = await brandsQuery;
  if (error) {
    return NextResponse.json({ error: `Brand query failed: ${error.message}` }, { status: 500 });
  }
  if (!brands || brands.length === 0) {
    return NextResponse.json(
      { error: slug ? `No brand found with slug "${slug}"` : "No monitored brands" },
      { status: 404 }
    );
  }

  // Poll serially — keeps SociaVault credit usage predictable.
  const results: BrandResult[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const b of brands) {
    const start = Date.now();
    const pollStartIso = new Date(start - 1000).toISOString(); // small buffer
    try {
      const card = await getBrandCard({ brandName: b.name, forceRefresh: true });
      const result: BrandResult = {
        slug: b.slug,
        name: b.name,
        ok: true,
        momentumScore: card.momentumScore.score,
        partial: card.partial,
        tiktokProvenance: card.tiktok.provenance,
        tiktokSourceLabel: card.tiktok.sourceLabel,
        tiktokFollowers: card.tiktok.followerCount ?? null,
        instagramProvenance: card.instagram.provenance,
        instagramSourceLabel: card.instagram.sourceLabel,
        instagramFollowers: card.instagram.followerCount ?? null,
        errors: card.partial ? card.errors : undefined,
        durationMs: Date.now() - start,
      };

      // Diagnostic mode: pull the fetcher_runs rows that were just written
      // during this poll. This shows the SociaVault attempt regardless of
      // whether the fail-safe returned a cached card on top.
      if (debug) {
        const { data: runs } = await db
          .from("fetcher_runs")
          .select("fetcher_name, status, snapshots_written, error_message, started_at, finished_at, metadata")
          .eq("brand_id", b.id)
          .gte("started_at", pollStartIso)
          .order("started_at", { ascending: false });
        result.recentFetcherRuns = (runs ?? []).map((r) => ({
          fetcherName: r.fetcher_name,
          status: r.status,
          snapshotsWritten: r.snapshots_written ?? 0,
          errorMessage: r.error_message,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          metadata: r.metadata,
        }));
      }

      results.push(result);
      succeeded++;
    } catch (err) {
      failed++;
      results.push({
        slug: b.slug,
        name: b.name,
        ok: false,
        momentumScore: null,
        partial: true,
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
  }

  const result: AdminPollResult = {
    ok: true,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: nowIso(),
    brandsAttempted: brands.length,
    brandsSucceeded: succeeded,
    brandsFailed: failed,
    results,
    totalDurationMs: Date.now() - startedAt,
  };

  return NextResponse.json(result);
}
