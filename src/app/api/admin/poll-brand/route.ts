/**
 * /api/admin/poll-brand
 *
 * Admin endpoint to manually trigger a brand-card poll without running
 * scripts locally. Designed for the Vercel-first workflow.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`.
 *
 * Usage (PowerShell):
 *   (Invoke-WebRequest -Uri "https://barcodekestrel.vercel.app/api/admin/poll-brand?slug=liquid-death" `
 *     -Headers @{"Authorization"="Bearer $CRON_SECRET"}).Content
 *
 *   # Check env / feature-flag config without polling any brand:
 *   ?config=1
 *
 *   # Debug mode — includes recentFetcherRuns per brand:
 *   ?slug=liquid-death&debug=1
 *
 *   # Poll up to N monitored brands:
 *   ?all=true&limit=5
 */
import { NextResponse } from "next/server";
import { verifyCronSecret, getAdminSupabase } from "@/lib/supabase-admin";
import { getBrandCard } from "@/lib/brand-card";
import { getFeatureFlags, getServerEnv } from "@/lib/env";
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
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const debug = url.searchParams.get("debug") === "1";
  const configCheck = url.searchParams.get("config") === "1";
  // ?clear=1 deletes each brand's cached card BEFORE polling, forcing a clean
  // rebuild. Use after a code fix so a partial poll can't leave a stale
  // sample/error block lingering in the merged card.
  const clearCache = url.searchParams.get("clear") === "1";

  // ---- Config / env-var diagnostic mode ----
  // Returns what the runtime actually sees — without exposing key values.
  if (configCheck) {
    const env = getServerEnv();
    const flags = getFeatureFlags();
    return NextResponse.json({
      deployedAt: new Date().toISOString(),
      codeVersion: "2026-05-28-instagram-debug",
      runtimeEnv: {
        SOCIAVAULT_API_KEY: env.sociavaultApiKey
          ? `set (${env.sociavaultApiKey.length} chars, starts "${env.sociavaultApiKey.slice(0, 4)}...")`
          : "NOT SET",
        CRON_SECRET: env.cronSecret ? "set" : "NOT SET",
        OPENAI_API_KEY: env.openaiApiKey ? "set" : "NOT SET",
        RESEND_API_KEY: env.resendApiKey ? "set" : "NOT SET",
      },
      featureFlags: flags,
    });
  }

  if (!slug && !all) {
    return NextResponse.json(
      { error: "Must specify ?slug=<slug>, ?all=true, or ?config=1" },
      { status: 400 }
    );
  }

  const db = getAdminSupabase();
  const startedAt = Date.now();

  let brandsQuery = db
    .from("brands")
    .select("id, name, slug")
    .eq("is_monitored", true)
    .eq("is_archived", false)
    .order("name", { ascending: true });
  if (slug) brandsQuery = brandsQuery.eq("slug", slug);
  if (limit > 0) brandsQuery = brandsQuery.limit(limit).range(offset, offset + limit - 1);
  else if (offset > 0) brandsQuery = brandsQuery.range(offset, offset + 999);

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

  const results: BrandResult[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const b of brands) {
    const start = Date.now();
    const pollStartIso = new Date(start - 1000).toISOString();
    try {
      // When clearing, snapshot the existing card first so a failed rebuild
      // can be rolled back rather than leaving the brand with no card at all.
      let backupCard: unknown = null;
      if (clearCache) {
        const { data: existing } = await db
          .from("brand_card_cache")
          .select("payload")
          .eq("brand_id", b.id)
          .maybeSingle();
        backupCard = existing?.payload ?? null;
        await db.from("brand_card_cache").delete().eq("brand_id", b.id);
      }
      const card = await getBrandCard({ brandName: b.name, forceRefresh: true });
      // Rollback guard: if the rebuild produced a notTracked/empty card but we
      // had a real one before, restore the backup so clear=1 can never destroy data.
      if (clearCache && backupCard && (card as { notTracked?: boolean }).notTracked) {
        await db.from("brand_card_cache").upsert(
          { brand_id: b.id, payload: backupCard, generated_at: new Date().toISOString() },
          { onConflict: "brand_id" }
        );
      }
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

  return NextResponse.json({
    ok: true,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: nowIso(),
    brandsAttempted: brands.length,
    brandsSucceeded: succeeded,
    brandsFailed: failed,
    results,
    totalDurationMs: Date.now() - startedAt,
  });
}
