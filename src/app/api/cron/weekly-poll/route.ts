/**
 * /api/cron/weekly-poll
 *
 * Saturday night data-collection job (PRD §5.3). Triggered by Vercel Cron
 * per the `vercel.json` schedule.
 *
 * Two phases:
 *   1. DISCOVERY — run all discovery sources across all active categories.
 *      New brands land in the `brands` table with `discovery_source` set
 *      and `is_monitored=true`.
 *   2. ENRICHMENT — for every monitored brand (including the new ones from
 *      phase 1), run the full Brand Card pipeline. This captures a fresh
 *      snapshot at every metric and computes Momentum Scores.
 *
 * Concurrency model:
 *   - Phase 1: categories serialized (the discovery functions themselves
 *     parallelize TikTok + Amazon per category).
 *   - Phase 2: brands processed in small parallel batches (BATCH_SIZE) so
 *     external rate limits stay safe but the total runtime is reasonable
 *     even with hundreds of brands.
 *
 * Vercel function timeout: 5 min on Hobby, 15 min on Pro, 900s on
 * Enterprise. If we ever exceed the budget we'll split into chunks
 * triggered by the cron via a queue table — but Barcode's volume won't
 * justify that for a long time.
 *
 * Auth: requires `Authorization: Bearer ${CRON_SECRET}`. Verified by
 * `verifyCronSecret` from supabase-admin.
 */
import { NextResponse } from "next/server";
import { verifyCronSecret, getAdminSupabase } from "@/lib/supabase-admin";
import { runDiscoveryForAllCategories } from "@/lib/discovery/runner";
import { getBrandCard } from "@/lib/brand-card";
import { nowIso } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel Pro/Enterprise can go higher; 300s = 5min default for Hobby.
export const maxDuration = 300;

const BATCH_SIZE = 4;          // parallel brands per batch in enrichment phase
const BATCH_DELAY_MS = 1_000;  // small pause between batches to be polite

interface CronResult {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  discovery: {
    categoriesProcessed: number;
    totalNew: number;
    totalReActivated: number;
    totalSkipped: number;
    errorCount: number;
  };
  enrichment: {
    brandsAttempted: number;
    brandsSucceeded: number;
    brandsPartial: number;
    brandsFailed: number;
    durationMs: number;
  };
  totalDurationMs: number;
}

export async function GET(request: Request) {
  return handle(request);
}
export async function POST(request: Request) {
  return handle(request);
}

async function handle(request: Request): Promise<NextResponse<CronResult | { error: string }>> {
  try {
    verifyCronSecret(request);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 }
    );
  }

  const startedAt = Date.now();

  // -----------------------------------------------------------------
  // Phase 1 — Discovery
  // -----------------------------------------------------------------
  let discoverySummary: Awaited<ReturnType<typeof runDiscoveryForAllCategories>>;
  try {
    discoverySummary = await runDiscoveryForAllCategories("cron");
  } catch (err) {
    return NextResponse.json(
      { error: `Discovery phase failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  // -----------------------------------------------------------------
  // Phase 2 — Enrichment
  // -----------------------------------------------------------------
  const db = getAdminSupabase();
  const { data: brands, error } = await db
    .from("brands")
    .select("id, name, slug")
    .eq("is_monitored", true)
    .eq("is_archived", false);

  if (error) {
    return NextResponse.json({ error: `Brand list query failed: ${error.message}` }, { status: 500 });
  }

  const enrichStart = Date.now();
  let succeeded = 0;
  let partial = 0;
  let failed = 0;

  // Process in batches to bound concurrency
  for (let i = 0; i < (brands ?? []).length; i += BATCH_SIZE) {
    const batch = brands!.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((b) =>
        // Force refresh so the cron always writes fresh snapshots,
        // bypassing the brand-card cache.
        getBrandCard({ brandName: b.name, forceRefresh: true })
      )
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value.partial) partial++;
        else succeeded++;
      } else {
        failed++;
        console.warn(`[weekly-poll] brand failed: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
      }
    }
    // Polite pause between batches (only if more remain)
    if (i + BATCH_SIZE < (brands ?? []).length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  const result: CronResult = {
    ok: true,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: nowIso(),
    discovery: {
      categoriesProcessed: discoverySummary.categoriesProcessed,
      totalNew: discoverySummary.totalNew,
      totalReActivated: discoverySummary.totalReActivated,
      totalSkipped: discoverySummary.totalSkipped,
      errorCount: discoverySummary.perCategoryErrors.length,
    },
    enrichment: {
      brandsAttempted: brands?.length ?? 0,
      brandsSucceeded: succeeded,
      brandsPartial: partial,
      brandsFailed: failed,
      durationMs: Date.now() - enrichStart,
    },
    totalDurationMs: Date.now() - startedAt,
  };

  console.log(`[weekly-poll] done in ${result.totalDurationMs}ms`, result);
  return NextResponse.json(result);
}
