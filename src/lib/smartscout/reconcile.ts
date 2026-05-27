/**
 * SmartScout reconciliation — match parsed rows to brands in the `brands`
 * table, aggregate per-brand metrics (sum TTM sales across subcategories,
 * revenue-weighted YoY growth), and write fresh snapshots.
 *
 * Match strategy:
 *   1. Exact name match (case-insensitive, normalized punctuation)
 *   2. amazon_brand exact match (this is the field SmartScout's name maps to)
 *   3. Forgiving normalization (strip spaces/punct/&-vs-and)
 *
 * Anything that doesn't match is logged with `match_confidence='unresolved'`
 * so the reconcile UI (#7) can surface it for human review.
 *
 * Snapshots written per matched brand (platform='smartscout'):
 *   - 'annual_revenue'    (numeric, $)
 *   - 'yoy_growth_pct'    (numeric, percent points, e.g. 32.5 for +32.5%)
 *   - 'monthly_units'     (numeric, units/month)
 *
 * These are the same metric keys momentum.ts's commerce path already reads,
 * so a fresh SmartScout upload immediately flows into live momentum scores.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { writeSnapshot } from "@/lib/fetchers/_base";
import { nowIso } from "@/lib/utils";
import type { SmartScoutRawRow } from "@/lib/smartscout/ingest";

export interface SmartScoutReconcileSummary {
  uploadId: string;
  brandsAggregated: number;
  brandsMatched: number;
  brandsUnmatched: number;
  rowsTotal: number;
  rowsMatched: number;
  rowsUnmatched: number;
  snapshotsWritten: number;
  /** Top unmatched brands by TTM sales — these are the candidates worth reviewing first. */
  topUnmatched: { brandName: string; trailing12Months: number; subcategory: string | null }[];
}

interface BrandLookup {
  id: string;
  name: string;
  amazonBrand: string | null;
}

/** Normalize a brand name for forgiving matching. Mirrors brand-card.ts. */
function normalizeBrandName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Aggregate parsed rows by brand name. */
interface BrandAgg {
  brandName: string;
  trailing12Months: number;
  estMonthlySales: number;
  weightedGrowthNumer: number;     // sum(growth * weight)
  weightedGrowthDenom: number;     // sum(weight)
  oneMonthGrowthNumer: number;
  oneMonthGrowthDenom: number;
  subcategories: Set<string>;
  rowCount: number;
}

function aggregateByBrand(rows: SmartScoutRawRow[]): Map<string, BrandAgg> {
  const map = new Map<string, BrandAgg>();
  for (const r of rows) {
    const key = r.brandName;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        brandName: r.brandName,
        trailing12Months: 0,
        estMonthlySales: 0,
        weightedGrowthNumer: 0,
        weightedGrowthDenom: 0,
        oneMonthGrowthNumer: 0,
        oneMonthGrowthDenom: 0,
        subcategories: new Set(),
        rowCount: 0,
      };
      map.set(key, agg);
    }
    const ttm = r.trailing12Months ?? 0;
    agg.trailing12Months += ttm;
    agg.estMonthlySales += r.estMonthlySales ?? 0;
    // Revenue-weighted growth — a tiny subcategory shouldn't dominate the average.
    const w = Math.max(ttm, 0);
    if (r.twelveMonthGrowth != null && w > 0) {
      agg.weightedGrowthNumer += r.twelveMonthGrowth * w;
      agg.weightedGrowthDenom += w;
    }
    if (r.oneMonthGrowth != null && w > 0) {
      agg.oneMonthGrowthNumer += r.oneMonthGrowth * w;
      agg.oneMonthGrowthDenom += w;
    }
    if (r.primarySubcategory) agg.subcategories.add(r.primarySubcategory);
    agg.rowCount++;
  }
  return map;
}

interface ReconcileOptions {
  uploadId: string;
  rows: SmartScoutRawRow[];
  /** Only process brands with TTM sales >= this threshold. Avoids writing
   *  snapshots for hundreds of long-tail brands no one is tracking. */
  minTtmSales?: number;
  /** Only match against monitored brands. Default true. */
  monitoredOnly?: boolean;
}

export async function reconcileSmartScoutUpload(opts: ReconcileOptions): Promise<SmartScoutReconcileSummary> {
  const minTtm = opts.minTtmSales ?? 500_000;
  const db = getAdminSupabase();

  // Aggregate by brand first; only meaningful-sized brands proceed.
  const aggMap = aggregateByBrand(opts.rows);
  const aggs = Array.from(aggMap.values()).filter((a) => a.trailing12Months >= minTtm);

  // Load all candidate brands once into memory for matching.
  let q = db.from("brands").select("id, name, amazon_brand").eq("is_archived", false);
  if (opts.monitoredOnly !== false) q = q.eq("is_monitored", true);
  const { data: brandsRaw, error: brandsErr } = await q;
  if (brandsErr) throw new Error(`Failed to load brands: ${brandsErr.message}`);
  const brands: BrandLookup[] = (brandsRaw ?? []).map((b) => ({
    id: b.id, name: b.name, amazonBrand: b.amazon_brand,
  }));

  // Build lookup maps.
  const byNameLower = new Map<string, BrandLookup>();
  const byAmazonBrand = new Map<string, BrandLookup>();
  const byNormalizedName = new Map<string, BrandLookup>();
  for (const b of brands) {
    byNameLower.set(b.name.toLowerCase(), b);
    byNormalizedName.set(normalizeBrandName(b.name), b);
    if (b.amazonBrand) byAmazonBrand.set(b.amazonBrand.toLowerCase(), b);
  }

  function matchAgg(brandName: string): { brand: BrandLookup; confidence: "high" | "medium" } | null {
    const lower = brandName.toLowerCase();
    const exact = byNameLower.get(lower);
    if (exact) return { brand: exact, confidence: "high" };
    const azExact = byAmazonBrand.get(lower);
    if (azExact) return { brand: azExact, confidence: "high" };
    const norm = normalizeBrandName(brandName);
    if (norm) {
      const fuzzy = byNormalizedName.get(norm);
      if (fuzzy) return { brand: fuzzy, confidence: "medium" };
    }
    return null;
  }

  // Process each aggregated brand.
  let brandsMatched = 0;
  let brandsUnmatched = 0;
  let rowsMatched = 0;
  let snapshotsWritten = 0;
  const unmatchedAggs: BrandAgg[] = [];
  const matchedRowIds = new Set<number>();      // for the smartscout_rows table updates
  const now = nowIso();

  for (const agg of aggs) {
    const match = matchAgg(agg.brandName);
    if (!match) {
      brandsUnmatched++;
      unmatchedAggs.push(agg);
      continue;
    }
    brandsMatched++;

    // Compute final per-brand metrics
    const yoyGrowthDecimal = agg.weightedGrowthDenom > 0
      ? agg.weightedGrowthNumer / agg.weightedGrowthDenom
      : null;
    const yoyGrowthPct = yoyGrowthDecimal != null ? Math.round(yoyGrowthDecimal * 1000) / 10 : null;
    // estMonthlySales in SmartScout is a per-subcategory monthly figure; sum
    // is reasonable across subcats for a given brand.
    const monthlyUnits = Math.round(agg.estMonthlySales);

    // Write the three commerce snapshots.
    const valueJson = {
      source: "smartscout" as const,
      upload_id: opts.uploadId,
      subcategories: Array.from(agg.subcategories).slice(0, 8),
      row_count: agg.rowCount,
    };
    await writeSnapshot({
      brandId: match.brand.id,
      platform: "smartscout",
      metric: "annual_revenue",
      valueNumeric: Math.round(agg.trailing12Months),
      valueJson,
      capturedAt: now,
    });
    snapshotsWritten++;
    if (yoyGrowthPct != null) {
      await writeSnapshot({
        brandId: match.brand.id,
        platform: "smartscout",
        metric: "yoy_growth_pct",
        valueNumeric: yoyGrowthPct,
        valueJson,
        capturedAt: now,
      });
      snapshotsWritten++;
    }
    if (monthlyUnits > 0) {
      await writeSnapshot({
        brandId: match.brand.id,
        platform: "smartscout",
        metric: "monthly_units",
        valueNumeric: monthlyUnits,
        valueJson,
        capturedAt: now,
      });
      snapshotsWritten++;
    }

    // Mark the smartscout_rows for this brand as matched. Cheaper than
    // updating each row individually: one UPDATE per brand match.
    await db
      .from("smartscout_rows")
      .update({
        matched_brand_id: match.brand.id,
        match_confidence: match.confidence,
        reconciled_at: now,
      })
      .eq("upload_id", opts.uploadId)
      .ilike("brand_name_raw", agg.brandName);
    rowsMatched += agg.rowCount;
  }

  // Mark the rest as unresolved (one update per upload).
  await db
    .from("smartscout_rows")
    .update({ match_confidence: "unresolved", reconciled_at: now })
    .eq("upload_id", opts.uploadId)
    .is("matched_brand_id", null);

  const rowsTotal = opts.rows.length;
  const rowsUnmatched = rowsTotal - rowsMatched;
  const topUnmatched = unmatchedAggs
    .sort((a, b) => b.trailing12Months - a.trailing12Months)
    .slice(0, 20)
    .map((a) => ({
      brandName: a.brandName,
      trailing12Months: Math.round(a.trailing12Months),
      subcategory: Array.from(a.subcategories)[0] ?? null,
    }));

  // Mark stack-of-matched IDs (used only for completeness in summary; some
  // callers may want it later for the reconcile UI).
  void matchedRowIds;

  return {
    uploadId: opts.uploadId,
    brandsAggregated: aggs.length,
    brandsMatched,
    brandsUnmatched,
    rowsTotal,
    rowsMatched,
    rowsUnmatched,
    snapshotsWritten,
    topUnmatched,
  };
}
