/**
 * Quadrant analysis — PRD §6.3.
 *
 * The 2x2 that defines Barcode's alpha:
 *
 *   HIGH social momentum + LOW retail velocity   = CALL NOW (DTC alpha)
 *   HIGH social momentum + HIGH retail velocity  = Established
 *   LOW social momentum + HIGH retail velocity   = Incumbent
 *   LOW social momentum + LOW retail velocity    = Skip
 *
 * Inputs:
 *   - Per-brand `momentum_score` snapshots (latest)
 *   - Per-brand sum of `nielsen_rows.sales_dollars` from the relevant
 *     upload (defines "retail velocity")
 *
 * Method:
 *   1. Pull all brands relevant to the upload's categories (or category
 *      filter).
 *   2. For each brand, compute:
 *        - socialMomentum (0-100): latest momentum_score, or 0 if missing
 *        - retailVelocity (0-100): rank-normalize sales_dollars across the
 *          upload. The brand with the highest sales gets 100, lowest > 0
 *          gets a small positive number, brands absent from Nielsen get 0.
 *   3. Quadrant by midpoints:
 *        social >= 50 = HIGH; retail >= 50 = HIGH
 *
 * Why rank-normalize retail instead of using raw dollars? Because raw
 * dollars vary wildly by category (snacks are huge; clean beauty is
 * niche). Rank-normalization makes the quadrant comparable across
 * categories within one upload.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import type { Quadrant, QuadrantEntry } from "@/lib/types";

export interface ComputeQuadrantOptions {
  uploadId: string;
  /** Restrict to brands in these categories. If omitted, all brands present in the upload. */
  categoryIds?: string[];
  /** Midpoint threshold. Default 50. */
  highThreshold?: number;
}

export interface QuadrantResult {
  uploadId: string;
  entries: QuadrantEntry[];
  counts: Record<Quadrant, number>;
  highThreshold: number;
}

export async function computeQuadrant(opts: ComputeQuadrantOptions): Promise<QuadrantResult> {
  const db = getAdminSupabase();
  const highThreshold = opts.highThreshold ?? 50;

  // Step 1: gather all brand_ids present in this upload (with category filter)
  let query = db
    .from("nielsen_rows")
    .select("brand_id, sales_dollars")
    .eq("upload_id", opts.uploadId)
    .not("brand_id", "is", null);

  if (opts.categoryIds && opts.categoryIds.length > 0) {
    query = query.in("category_id", opts.categoryIds);
  }

  const { data: rows, error } = await query;
  if (error) throw new Error(`computeQuadrant: ${error.message}`);

  // Sum sales per brand
  const salesByBrand = new Map<string, number>();
  for (const r of rows ?? []) {
    if (!r.brand_id) continue;
    const dollars = r.sales_dollars ?? 0;
    salesByBrand.set(r.brand_id, (salesByBrand.get(r.brand_id) ?? 0) + dollars);
  }

  // Step 2: also include brands that have social momentum scores but are
  // ABSENT from Nielsen — they're the call-now candidates. Pull every
  // monitored brand and add zeros for ones we missed.
  let brandsQuery = db
    .from("brands")
    .select("id, name, primary_category_id")
    .eq("is_archived", false);
  if (opts.categoryIds && opts.categoryIds.length > 0) {
    brandsQuery = brandsQuery.in("primary_category_id", opts.categoryIds);
  }
  const { data: brands } = await brandsQuery;

  const candidateBrandIds = new Set<string>([
    ...Array.from(salesByBrand.keys()),
    ...((brands ?? []).map((b) => b.id)),
  ]);

  // Names lookup
  const nameById = new Map<string, string>();
  for (const b of brands ?? []) nameById.set(b.id, b.name);
  // For brands in Nielsen but not in our `brands` list (shouldn't happen
  // after reconciliation, but just in case), fetch their names too
  const missingIds = [...candidateBrandIds].filter((id) => !nameById.has(id));
  if (missingIds.length > 0) {
    const { data: extra } = await db.from("brands").select("id, name").in("id", missingIds);
    for (const b of extra ?? []) nameById.set(b.id, b.name);
  }

  // Step 3: pull latest momentum per brand
  const candidateArr = [...candidateBrandIds];
  const momentumByBrand = new Map<string, number>();
  if (candidateArr.length > 0) {
    // Latest momentum_score per brand using a single query that we
    // post-process. (Supabase doesn't support DISTINCT ON via PostgREST.)
    const { data: snaps } = await db
      .from("snapshots")
      .select("brand_id, value_numeric, captured_at")
      .eq("platform", "derived")
      .eq("metric", "momentum_score")
      .in("brand_id", candidateArr)
      .order("captured_at", { ascending: false });
    for (const s of snaps ?? []) {
      if (!momentumByBrand.has(s.brand_id) && s.value_numeric != null) {
        momentumByBrand.set(s.brand_id, s.value_numeric);
      }
    }
  }

  // Step 4: rank-normalize sales to 0-100
  const salesArr = [...salesByBrand.entries()].sort((a, b) => b[1] - a[1]);
  const retailScoreById = new Map<string, number>();
  if (salesArr.length > 0) {
    const maxRank = salesArr.length - 1;
    salesArr.forEach(([brandId], idx) => {
      // 100 at rank 0, scaling down to ~5 at the bottom
      const score = maxRank > 0 ? 100 - (idx / maxRank) * 95 : 100;
      retailScoreById.set(brandId, Math.round(score));
    });
  }

  // Step 5: assemble entries + classify
  const entries: QuadrantEntry[] = [];
  for (const brandId of candidateBrandIds) {
    const socialMomentum = momentumByBrand.get(brandId) ?? 0;
    const retailVelocity = retailScoreById.get(brandId) ?? 0;
    const quadrant = classifyQuadrant(socialMomentum, retailVelocity, highThreshold);
    entries.push({
      brandId,
      brandName: nameById.get(brandId) ?? brandId,
      socialMomentum,
      retailVelocity,
      quadrant,
    });
  }

  // Sort entries by social momentum desc — the most interesting brands first
  entries.sort((a, b) => b.socialMomentum - a.socialMomentum);

  const counts: Record<Quadrant, number> = { call_now: 0, established: 0, incumbent: 0, skip: 0 };
  for (const e of entries) counts[e.quadrant]++;

  return { uploadId: opts.uploadId, entries, counts, highThreshold };
}

function classifyQuadrant(social: number, retail: number, threshold: number): Quadrant {
  const highSocial = social >= threshold;
  const highRetail = retail >= threshold;
  if (highSocial && !highRetail) return "call_now";
  if (highSocial && highRetail) return "established";
  if (!highSocial && highRetail) return "incumbent";
  return "skip";
}
