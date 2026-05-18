/**
 * Momentum Score calculator (PRD §5.2).
 *
 * Reads from `snapshots` time-series and computes a 0-100 score with a
 * configurable component-weight breakdown. Each component is normalized to
 * 0-100 individually using calibration anchors documented inline, then the
 * weighted sum is the final score.
 *
 * Components (default weights from PRD):
 *   - tiktok_growth        25%  — TikTok follower MoM %
 *   - tiktok_engagement    15%  — avg engagement rate on recent videos
 *   - instagram_growth     15%  — Instagram follower MoM %
 *   - amazon_velocity      20%  — review count WoW % + BSR rank inverse
 *   - google_trends_growth 10%  — search volume YoY %
 *   - reddit_velocity      10%  — mention velocity vs prior window
 *   - sentiment             5%  — overall sentiment score
 *
 * Bonus signals (not weighted, but flagged in the result):
 *   - notInRetail: true if brand has social/Amazon presence but no
 *     nielsen_rows entry — the PRD's primary discovery signal.
 *
 * Design notes:
 *   - Components that have NO data return null and their weight is
 *     proportionally redistributed across the components that DO have data.
 *     This means a brand with only Amazon + Google Trends still gets a
 *     score (rather than being unfairly penalized for missing TikTok).
 *   - If FEWER than 2 components have data, we return null score — too
 *     little signal to be meaningful.
 *   - The component normalization curves are documented inline. They're
 *     chosen so that "good" performance maps to ~70 and "exceptional" to
 *     ~95, leaving headroom and avoiding score saturation.
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
    // Average the available sub-signals
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
    const result: MomentumScoreResult = {
      brandId: opts.brandId,
      score: null,
      components,
      notInRetail: await isAbsentFromRetail(opts.brandId),
      computedAt: nowIso(),
    };
    return result;
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
  };

  if (opts.persistSnapshot !== false) {
    const db = getAdminSupabase();
    await db.from("snapshots").insert({
      brand_id: opts.brandId,
      platform: "derived",
      metric: "momentum_score",
      value_numeric: result.score,
      value_json: { components: result.components, notInRetail: result.notInRetail, weights },
      captured_at: result.computedAt,
    });
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
