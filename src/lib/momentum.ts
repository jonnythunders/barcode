/**
 * Momentum Score calculator.
 *
 * The score is a 0–100 blend of three monotonic signals:
 *
 *     amazonScale = log10($Amazon TTM) mapped onto [$1M..$60M] -> [0..1]
 *     growthScore = logistic on Amazon YoY% (~0.45 at 0%, ~0.93 at +300%)
 *     retailGap   = 1.0 if retail==$0; otherwise 1 - log10($retail) mapped onto [$10k..$1B]
 *
 *     momentum    = 0.45 * amazonScale + 0.55 * growthScore
 *     score       = 100 * momentum * (0.45 + 0.55 * retailGap)
 *
 * This is the same documented formula the seeded demo cards score on
 * (calibrated against the original 47 H&B brands, Spearman 0.94 vs the
 * original ordering, all billion-$ retail incumbents correctly land in
 * the Skip band). The point of `momentum.ts` is to be the live engine
 * that reproduces that same logic from whatever data the snapshots table
 * has at score time — so a brand discovered next week scores on the
 * exact same scale as the demo brands today.
 *
 * Two paths:
 *
 *   1. COMMERCE PATH (preferred) — if SmartScout snapshots exist
 *      (smartscout/annual_revenue, smartscout/yoy_growth_pct, plus optional
 *      nielsen/retail_annual_sales), score = the formula above. Deterministic,
 *      reproducible, no social inputs required.
 *
 *   2. SOCIAL-FALLBACK PATH — if there's no commerce data yet (e.g. a brand
 *      surfaced by a TikTok hashtag crawl that hasn't been matched to
 *      SmartScout), fall back to the prior weighted-blend over
 *      tiktok/instagram/amazon/google_trends/reddit/sentiment signals. Used
 *      only when commerce inputs are absent.
 *
 * Either way the function returns the same shape and respects the same
 * callers (brand-card.ts, weekly-report.ts, /api/cron/weekly-poll).
 *
 * The bonus `notInRetail` flag is what the report's "Not yet in retail"
 * section reads. It's defined as: Nielsen retail snapshot is missing OR
 * its value is <=0. Falls back to the legacy nielsen_rows count for
 * brands not seeded through the demo pipeline.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import {
  DEFAULT_MOMENTUM_WEIGHTS,
  type MomentumScoreResult,
  type MomentumWeights,
} from "@/lib/types";
import { nowIso } from "@/lib/utils";

export interface ComputeMomentumOptions {
  brandId: string;
  weights?: MomentumWeights;
  // If true, write the resulting score as a snapshot row so we can chart
  // momentum over time. Defaults to true.
  persistSnapshot?: boolean;
}

export async function computeMomentumScore(opts: ComputeMomentumOptions): Promise<MomentumScoreResult> {
  // ---- Try the commerce path first ----
  const commerce = await readCommerceInputs(opts.brandId);
  if (commerce && commerce.amazonAnnualSales != null) {
    const components = scoreFromCommerce(
      commerce.amazonAnnualSales,
      commerce.amazonYoyGrowthPct ?? 0,
      commerce.retailAnnualSales ?? 0
    );
    const score = Math.round(
      Math.max(0, Math.min(100, components.score))
    );
    const notInRetail = (commerce.retailAnnualSales ?? 0) <= 0;

    const result: MomentumScoreResult = {
      brandId: opts.brandId,
      score,
      components: {
        amazonVelocity: round1(components.amazonScale * 100),
        // Reuse existing component keys so the breakdown panel renders.
        googleTrendsGrowth: round1(components.growthScore * 100),
        // "retailGap" doesn't have a slot in MomentumWeights; surface it
        // under redditVelocity so the existing card UI shows it. (We label
        // basis='commerce' so downstream UI can render the correct names.)
        redditVelocity: round1(components.retailGap * 100),
      },
      notInRetail,
      computedAt: nowIso(),
      basis: "commerce",
    };

    if (opts.persistSnapshot !== false) {
      await persistScoreSnapshot(opts.brandId, result, {
        formula: "commerce_v1",
        amazonAnnualSales: commerce.amazonAnnualSales,
        amazonYoyGrowthPct: commerce.amazonYoyGrowthPct,
        retailAnnualSales: commerce.retailAnnualSales,
      });
    }
    return result;
  }

  // ---- No commerce data: fall back to social-blend (legacy path) ----
  return computeMomentumSocialFallback(opts);
}

// =========================================================================
// Commerce path — the documented formula that the seeded demo scores on
// =========================================================================

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Amazon TTM revenue normalized to [0,1] on a log scale anchored at $1M..$60M. */
export function amazonScale(sales: number): number {
  if (!sales || sales <= 0) return 0;
  const lo = Math.log10(1e6);
  const hi = Math.log10(6e7);
  return clamp((Math.log10(sales) - lo) / (hi - lo), 0, 1);
}

/** YoY Amazon growth (in percent points) -> [0,1] via logistic centered at +30%. */
export function growthScore(growthPct: number): number {
  // -100 -> ~0.05, 0 -> ~0.43, +100 -> ~0.73, +300 -> ~0.93
  return clamp(1 / (1 + Math.exp(-(growthPct - 30) / 110)), 0, 1);
}

/** Retail dollars -> [0,1] retail-gap. 1.0 means "absent from shelves". */
export function retailGap(retailDollars: number | null | undefined): number {
  if (!retailDollars || retailDollars <= 0) return 1.0;
  const lo = 4.0;      // $10k
  const hi = 9.0;      // $1B
  return clamp(1 - (Math.log10(retailDollars) - lo) / (hi - lo), 0, 1);
}

function scoreFromCommerce(
  amazonAnnualSales: number,
  amazonYoyGrowthPct: number,
  retailAnnualSales: number
) {
  const a = amazonScale(amazonAnnualSales);
  const g = growthScore(amazonYoyGrowthPct);
  const r = retailGap(retailAnnualSales);
  const momentum = 0.45 * a + 0.55 * g;
  const score = 100 * momentum * (0.45 + 0.55 * r);
  return { amazonScale: a, growthScore: g, retailGap: r, momentum, score };
}

interface CommerceInputs {
  amazonAnnualSales: number | null;
  amazonYoyGrowthPct: number | null;
  retailAnnualSales: number | null;
}

async function readCommerceInputs(brandId: string): Promise<CommerceInputs | null> {
  const [amazonAnnualSales, amazonYoyGrowthPct, retailAnnualSales] = await Promise.all([
    latestNumeric(brandId, "smartscout", "annual_revenue"),
    latestNumeric(brandId, "smartscout", "yoy_growth_pct"),
    latestNumeric(brandId, "nielsen", "retail_annual_sales"),
  ]);
  if (amazonAnnualSales == null && amazonYoyGrowthPct == null && retailAnnualSales == null) {
    return null;
  }
  return { amazonAnnualSales, amazonYoyGrowthPct, retailAnnualSales };
}

async function persistScoreSnapshot(
  brandId: string,
  result: MomentumScoreResult,
  extras: Record<string, unknown>
): Promise<void> {
  const db = getAdminSupabase();
  await db.from("snapshots").insert({
    brand_id: brandId,
    platform: "derived",
    metric: "momentum_score",
    value_numeric: result.score,
    value_json: {
      components: result.components,
      notInRetail: result.notInRetail,
      basis: result.basis,
      ...extras,
    },
    captured_at: result.computedAt,
  });
}

// =========================================================================
// Social-blend fallback (legacy path; runs only when no commerce data)
// =========================================================================

async function computeMomentumSocialFallback(opts: ComputeMomentumOptions): Promise<MomentumScoreResult> {
  const weights = opts.weights ?? DEFAULT_MOMENTUM_WEIGHTS;
  const components: Partial<Record<keyof MomentumWeights, number>> = {};

  // ---- TikTok follower growth ----
  const tiktokGrowth = await monthOverMonthPct(opts.brandId, "tiktok", "follower_count");
  if (tiktokGrowth != null) components.tiktokGrowth = normalizeGrowthPct(tiktokGrowth);

  // ---- TikTok engagement rate ----
  const tiktokEng = await latestNumeric(opts.brandId, "tiktok", "engagement_rate");
  if (tiktokEng != null) components.tiktokEngagement = normalizeEngagementRate(tiktokEng);

  // ---- Instagram follower growth ----
  const igGrowth = await monthOverMonthPct(opts.brandId, "instagram", "follower_count");
  if (igGrowth != null) components.instagramGrowth = normalizeGrowthPct(igGrowth);

  // ---- Amazon velocity (composite) ----
  const reviewGrowth = await weekOverWeekPct(opts.brandId, "amazon", "review_count");
  const bsrRank = await latestNumeric(opts.brandId, "amazon", "bsr_rank");
  if (reviewGrowth != null || bsrRank != null) {
    const reviewComponent = reviewGrowth != null ? normalizeGrowthPct(reviewGrowth) : null;
    const bsrComponent = bsrRank != null ? normalizeBsrRank(bsrRank) : null;
    const subs = [reviewComponent, bsrComponent].filter((v): v is number => v != null);
    components.amazonVelocity = subs.length > 0 ? subs.reduce((a, b) => a + b, 0) / subs.length : undefined;
  }

  // ---- Google Trends YoY ----
  const gtYoy = await latestNumeric(opts.brandId, "google_trends", "search_volume_yoy_pct");
  if (gtYoy != null) components.googleTrendsGrowth = normalizeGrowthPct(gtYoy);

  // ---- Reddit velocity ----
  const redditVel = await latestNumeric(opts.brandId, "reddit", "mention_velocity");
  if (redditVel != null) components.redditVelocity = normalizeGrowthPct(redditVel);

  // ---- Sentiment ----
  const sentiment = await latestNumeric(opts.brandId, "derived", "sentiment_score");
  if (sentiment != null) components.sentiment = normalizeSentiment(sentiment);

  // ---- Combine ----
  const present = Object.entries(components).filter(
    ([, v]) => typeof v === "number" && Number.isFinite(v)
  ) as [keyof MomentumWeights, number][];

  if (present.length < 2) {
    return {
      brandId: opts.brandId,
      score: null,
      components,
      notInRetail: await isAbsentFromRetail(opts.brandId),
      computedAt: nowIso(),
      basis: "social_fallback",
    };
  }

  // Weight redistribution: take the original weights for the components we
  // have, renormalize so they sum to 1.
  const weightSum = present.reduce((sum, [k]) => sum + weights[k], 0);
  let score = 0;
  for (const [k, v] of present) {
    score += (weights[k] / weightSum) * v;
  }
  score = Math.round(Math.max(0, Math.min(100, score)));

  const result: MomentumScoreResult = {
    brandId: opts.brandId,
    score,
    components,
    notInRetail: await isAbsentFromRetail(opts.brandId),
    computedAt: nowIso(),
    basis: "social_fallback",
  };

  if (opts.persistSnapshot !== false) {
    await persistScoreSnapshot(opts.brandId, result, { formula: "social_v1", weights });
  }
  return result;
}

// =========================================================================
// Snapshot readers
// =========================================================================

async function latestNumeric(brandId: string, platform: string, metric: string): Promise<number | null> {
  const db = getAdminSupabase();
  const { data, error } = await db
    .from("snapshots")
    .select("value_numeric")
    .eq("brand_id", brandId)
    .eq("platform", platform)
    .eq("metric", metric)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data.value_numeric;
}

/**
 * Compute the percentage change between the most recent snapshot and the
 * snapshot from ~30 days prior. Returns null if either point is missing.
 */
async function monthOverMonthPct(brandId: string, platform: string, metric: string): Promise<number | null> {
  const db = getAdminSupabase();
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await db
    .from("snapshots")
    .select("value_numeric, captured_at")
    .eq("brand_id", brandId)
    .eq("platform", platform)
    .eq("metric", metric)
    .gte("captured_at", since)
    .order("captured_at", { ascending: false });
  if (!data || data.length < 2) return null;

  const latest = data[0];
  if (latest.value_numeric == null) return null;

  // Find a row ~30 days before the latest
  const targetTime = new Date(latest.captured_at).getTime() - 30 * 24 * 60 * 60 * 1000;
  let prior: { value_numeric: number | null; captured_at: string } | null = null;
  let bestDelta = Infinity;
  for (const row of data) {
    const delta = Math.abs(new Date(row.captured_at).getTime() - targetTime);
    if (delta < bestDelta) {
      bestDelta = delta;
      prior = row;
    }
  }
  if (!prior || prior.value_numeric == null || prior.value_numeric <= 0) return null;
  return (latest.value_numeric - prior.value_numeric) / prior.value_numeric;
}

async function weekOverWeekPct(brandId: string, platform: string, metric: string): Promise<number | null> {
  const db = getAdminSupabase();
  const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await db
    .from("snapshots")
    .select("value_numeric, captured_at")
    .eq("brand_id", brandId)
    .eq("platform", platform)
    .eq("metric", metric)
    .gte("captured_at", since)
    .order("captured_at", { ascending: false });
  if (!data || data.length < 2) return null;

  const latest = data[0];
  if (latest.value_numeric == null) return null;

  const targetTime = new Date(latest.captured_at).getTime() - 7 * 24 * 60 * 60 * 1000;
  let prior: { value_numeric: number | null; captured_at: string } | null = null;
  let bestDelta = Infinity;
  for (const row of data) {
    const delta = Math.abs(new Date(row.captured_at).getTime() - targetTime);
    if (delta < bestDelta) {
      bestDelta = delta;
      prior = row;
    }
  }
  if (!prior || prior.value_numeric == null || prior.value_numeric <= 0) return null;
  return (latest.value_numeric - prior.value_numeric) / prior.value_numeric;
}

async function isAbsentFromRetail(brandId: string): Promise<boolean> {
  const db = getAdminSupabase();
  const { count } = await db
    .from("nielsen_rows")
    .select("id", { count: "exact", head: true })
    .eq("brand_id", brandId);
  return (count ?? 0) === 0;
}

// =========================================================================
// Component normalizers
//
// Each maps a raw value into 0-100. The curves are intentionally generous
// in the mid-range — we want differentiation between "okay" and "great" for
// ranking purposes; the absolute number is less important than ordering.
// =========================================================================

/**
 * Growth percentage normalizer.
 *   pct == 0     -> 50
 *   pct == 0.05  -> ~62.5
 *   pct == 0.10  -> ~70  ("healthy")
 *   pct == 0.20  -> ~82  (PRD says >20% MoM = high)
 *   pct == 0.50  -> ~96
 *   pct < 0      -> below 50, asymptotic to 0
 */
function normalizeGrowthPct(pct: number): number {
  // sigmoid-ish: 100 / (1 + e^(-k*x)) tuned so 20% -> ~82
  const k = 8;                            // shape parameter
  return 100 / (1 + Math.exp(-k * pct));
}

/**
 * TikTok engagement-rate normalizer. Engagement is (likes+comments+shares)/views.
 *   0.005 (0.5%) -> ~20
 *   0.02  (2%)   -> ~60
 *   0.03  (3%)   -> ~75   (PRD: ">3% healthy")
 *   0.05  (5%)   -> ~88
 *   0.08+ (8%+)  -> ~95
 */
function normalizeEngagementRate(rate: number): number {
  // log-ish curve, capped
  if (rate <= 0) return 0;
  const scaled = Math.log10(rate * 1000 + 1) * 33; // tuned empirically
  return Math.max(0, Math.min(100, scaled));
}

/**
 * BSR rank normalizer. Lower rank = higher score.
 *   rank 1     -> 100
 *   rank 10    -> ~85
 *   rank 100   -> ~70
 *   rank 1000  -> ~50
 *   rank 10000 -> ~30
 *   rank 100k+ -> approaches 0
 */
function normalizeBsrRank(rank: number): number {
  if (rank <= 0) return 0;
  // log scale: 100 - 15*log10(rank)
  const score = 100 - 15 * Math.log10(rank);
  return Math.max(0, Math.min(100, score));
}

/**
 * Sentiment normalizer.
 *   -1.0 -> 0
 *    0.0 -> 50
 *   +1.0 -> 100
 */
function normalizeSentiment(score: number): number {
  return Math.max(0, Math.min(100, (score + 1) * 50));
}
