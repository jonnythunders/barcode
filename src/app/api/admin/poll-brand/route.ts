/**
 * /api/admin/poll-brand
 *
 * Admin endpoint to manually trigger a brand-card poll (single brand or all
 * monitored brands) without running scripts locally. Designed for the
 * Vercel-first workflow where running `npm run poll-once` locally is
 * inconvenient.
 *
 * Auth: requires `Authorization: Bearer ${CRON_SECRET}`. Same secret as
 * the weekly-poll cron route — no new env var.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        "https://barcodekestrel.vercel.app/api/admin/poll-brand?slug=liquid-death"
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        "https://barcodekestrel.vercel.app/api/admin/poll-brand?all=true"
 *
 *   # Limit to N brands when polling all (useful for credit-aware smoke tests):
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        "https://barcodekestrel.vercel.app/api/admin/poll-brand?all=true&limit=5"
 *
 * Returns: JSON with per-brand status, momentum scores, and any errors.
 *
 * NOT exposed in the UI navigation — discoverable only by direct URL.
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

  if (!slug && !all) {
    return NextResponse.json(
      { error: "Must specify either ?slug=<brand-slug> or ?all=true" },
      { status: 400 }
    );
  }

  const db = getAdminSupabase();
  const startedAt = Date.now();

  // Build the list of brands to poll.
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

  // Poll serially to keep external rate limits (SociaVault credits) predictable.
  const results: BrandResult[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const b of brands) {
    const start = Date.now();
    try {
      const card = await getBrandCard({ brandName: b.name, forceRefresh: true });
      results.push({
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
      });
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
