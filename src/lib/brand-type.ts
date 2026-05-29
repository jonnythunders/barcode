/**
 * Brand-type classifier.
 *
 * Distinguishes WHAT KIND of brand a row is, so the product can set honest
 * expectations and avoid surfacing unplaceable junk as a hot prospect.
 *
 * The problem this solves: the momentum formula rewards Amazon velocity, so an
 * FBA/arbitrage product (HomLand, RosaBella, SHPAVVER) with a big Amazon number,
 * fast growth, and no retail scores ~97 — identical to a genuine emerging DTC
 * brand — even though there's no actual BRAND for the rep group to place. Type
 * classification separates "real brand worth a call" from "Amazon product with
 * no brand identity".
 *
 * Types:
 *   - dtc_brand       real, DTC-led brand. Social + Amazon meaningful; little/no
 *                     retail yet. THE prime prospect.
 *   - retail_brand    established, meaningful measured retail presence. Commerce
 *                     is the story; social corroborates.
 *   - amazon_supplier FBA/arbitrage. Only sales velocity is real — no brand
 *                     footprint (no social, no retail, unresolved handles).
 *                     Social/sentiment/Reddit panels are noise for these.
 *   - unknown         not enough signal to classify yet.
 *
 * This is a HEURISTIC over signals we already collect. It is deliberately
 * conservative: when unsure it returns 'unknown' rather than mislabel. A human
 * override (brands.brand_type_source = 'manual') is always respected — the
 * classifier never overwrites a manual label.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";

export type BrandType = "dtc_brand" | "retail_brand" | "amazon_supplier" | "unknown";

export interface BrandTypeResult {
  brandType: BrandType;
  reason: string;
  signals: {
    amazonAnnualSales: number | null;
    retailAnnualSales: number | null;
    tiktokFollowers: number | null;
    instagramFollowers: number | null;
    hasResolvedHandle: boolean;
  };
}

// A brand is considered to have real measured retail presence above this.
// Below it (incl. the $17 Charlotte-Tilbury Nielsen artifact) is treated as
// effectively not-in-retail.
const RETAIL_PRESENCE_FLOOR = 50_000;
// Minimum social following to count as a real brand footprint. FBA products
// typically have zero/none; a real brand usually clears a few thousand.
const SOCIAL_FOOTPRINT_FLOOR = 2_000;

async function latestNumeric(brandId: string, platform: string, metric: string): Promise<number | null> {
  const db = getAdminSupabase();
  const { data } = await db
    .from("snapshots")
    .select("value_numeric")
    .eq("brand_id", brandId)
    .eq("platform", platform)
    .eq("metric", metric)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.value_numeric ?? null;
}

/**
 * Classify a brand from its current snapshots + resolved handles.
 *
 * @param hasResolvedHandle whether the handle resolver found a real (non-null)
 *   tiktok/instagram handle for this brand. Passed in because the caller (poll
 *   path) already has the resolution; falls back to reading brands row if omitted.
 */
export async function classifyBrandType(
  brandId: string,
  hasResolvedHandle?: boolean
): Promise<BrandTypeResult> {
  const db = getAdminSupabase();

  const [amazonAnnualSales, retailAnnualSales, tiktokFollowers, instagramFollowers] =
    await Promise.all([
      latestNumeric(brandId, "smartscout", "annual_revenue"),
      latestNumeric(brandId, "nielsen", "retail_annual_sales"),
      latestNumeric(brandId, "tiktok", "follower_count"),
      latestNumeric(brandId, "instagram", "follower_count"),
    ]);

  // Resolve handle presence if not supplied.
  let resolved = hasResolvedHandle;
  if (resolved === undefined) {
    const { data } = await db
      .from("brands")
      .select("tiktok_handle, instagram_handle")
      .eq("id", brandId)
      .maybeSingle();
    resolved = !!(data?.tiktok_handle || data?.instagram_handle);
  }

  const signals = {
    amazonAnnualSales,
    retailAnnualSales,
    tiktokFollowers,
    instagramFollowers,
    hasResolvedHandle: !!resolved,
  };

  const retail = retailAnnualSales ?? 0;
  const maxSocial = Math.max(tiktokFollowers ?? 0, instagramFollowers ?? 0);
  // A follower count only counts as a real footprint if a handle was actually
  // resolved. Orphaned follower snapshots (sample/seed data, or stale numbers
  // from a since-cleared resolution) must NOT count — otherwise an FBA supplier
  // with leftover sample followers gets misclassified as a real brand.
  const hasSocialFootprint = !!resolved && maxSocial >= SOCIAL_FOOTPRINT_FLOOR;
  const hasRealRetail = retail >= RETAIL_PRESENCE_FLOOR;

  // 1) Established in measured retail -> retail_brand.
  if (hasRealRetail) {
    return {
      brandType: "retail_brand",
      reason: `Measured retail sales $${Math.round(retail).toLocaleString()} >= floor`,
      signals,
    };
  }

  // 2) Has a real brand footprint (resolved handle + real following) -> dtc_brand.
  //    This is the prime prospect: real brand, not yet in retail.
  if (signals.hasResolvedHandle && hasSocialFootprint) {
    return {
      brandType: "dtc_brand",
      reason: `Resolved social handle with ${maxSocial.toLocaleString()} followers, not in retail`,
      signals,
    };
  }

  // 3) Big Amazon number but NO brand footprint anywhere -> amazon_supplier.
  //    The FBA/arbitrage signature: meaningful Amazon sales, no resolved social
  //    handle (or trivial following), and not in retail.
  if ((amazonAnnualSales ?? 0) > 0 && !signals.hasResolvedHandle && !hasSocialFootprint) {
    return {
      brandType: "amazon_supplier",
      reason: `Amazon sales present but no resolved social handle and no real following — FBA/arbitrage signature`,
      signals,
    };
  }

  // 4) Not enough signal.
  return {
    brandType: "unknown",
    reason: "Insufficient signal to classify confidently",
    signals,
  };
}

/**
 * Classify and persist, RESPECTING a manual override. If the brand's
 * brand_type_source is 'manual', we return the existing manual value and do
 * not overwrite it. Otherwise we write the auto classification.
 */
export async function classifyAndPersistBrandType(
  brandId: string,
  hasResolvedHandle?: boolean
): Promise<BrandType> {
  const db = getAdminSupabase();
  const { data: row } = await db
    .from("brands")
    .select("brand_type, brand_type_source")
    .eq("id", brandId)
    .maybeSingle();

  // Never overwrite a human decision.
  if (row?.brand_type_source === "manual") {
    return (row.brand_type as BrandType) ?? "unknown";
  }

  const result = await classifyBrandType(brandId, hasResolvedHandle);
  await db
    .from("brands")
    .update({ brand_type: result.brandType, brand_type_source: "auto" })
    .eq("id", brandId);
  return result.brandType;
}
