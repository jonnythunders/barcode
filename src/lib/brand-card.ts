/**
 * Brand Card orchestrator — the central piece of Module 1.
 *
 * Responsibilities:
 *   1. Check cache. If fresh, return it.
 *   2. Resolve handles (brand name → tiktok/ig/amazon/website).
 *   3. Fan out to every fetcher in parallel. Each fetcher fails independently.
 *   4. Compute Momentum Score from the resulting snapshots.
 *   5. Generate a 2-3 sentence narrative via Claude.
 *   6. Assemble the BrandCard JSON, persist to cache, return.
 *
 * Usage:
 *   const card = await getBrandCard({ brandName: "Olipop" });
 *
 * The endpoint at /api/brand-card/[name] is a thin wrapper around this.
 * The agent's `lookup_brand` tool also calls this directly.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getServerEnv } from "@/lib/env";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { nowIso } from "@/lib/utils";
import type {
  BrandCard,
  FetcherResult,
  PlatformBlock,
  RedditThreadSummary,
  TikTokVideoSummary,
  TikTokAdSummary,
} from "@/lib/types";

import { resolveBrandHandles, type HandleResolution } from "@/lib/fetchers/handle-resolver";
import { fetchGoogleTrends, type GoogleTrendsResult } from "@/lib/fetchers/google-trends";
import { fetchAmazon, type AmazonResult } from "@/lib/fetchers/amazon";
import { fetchShopify, type ShopifyResult } from "@/lib/fetchers/shopify";
import { fetchTikTok, type TikTokResult } from "@/lib/fetchers/tiktok";
import { fetchInstagram, getInstagramFollowerTrend, type InstagramResult } from "@/lib/fetchers/instagram";
import { fetchReddit, fetchRedditCommentSample, type RedditResult } from "@/lib/fetchers/reddit";
import { analyzeSentiment, type SentimentResult } from "@/lib/sentiment";
import { computeMomentumScore } from "@/lib/momentum";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;     // 6 hours

export interface BrandCardOptions {
  brandName: string;
  // If true, ignore the cache and force a fresh fetch.
  forceRefresh?: boolean;
  // Optional handle overrides — bypasses auto-resolution.
  override?: {
    tiktokHandle?: string;
    instagramHandle?: string;
    amazonBrand?: string;
    websiteUrl?: string;
  };
  // Optional context for sentiment disambiguation, etc.
  contextHint?: string;
}

export async function getBrandCard(opts: BrandCardOptions): Promise<BrandCard> {
  const startedAt = Date.now();

  // -----------------------------------------------------------------
  // Step 1: handle resolution
  // -----------------------------------------------------------------
  const resolution = await resolveBrandHandles({
    brandName: opts.brandName,
    persistToBrandsRow: true,
    override: opts.override,
  });

  if (!resolution.brandId) {
    // Couldn't even create a brand row. Almost never happens (the resolver
    // always inserts) — surface a useful error.
    throw new Error(`Could not resolve a brand row for "${opts.brandName}"`);
  }
  const brandId = resolution.brandId;

  // -----------------------------------------------------------------
  // Step 2: cache check
  // -----------------------------------------------------------------
  if (!opts.forceRefresh) {
    const cached = await readCache(brandId);
    if (cached) return cached;
  }

  // -----------------------------------------------------------------
  // Step 3: fan-out fetchers
  // -----------------------------------------------------------------
  const primaryKeyword = opts.brandName;

  // Some fetchers need a resolved handle to even attempt. Others (Google
  // Trends, Reddit, Amazon) can work off the brand name alone.
  const tiktokPromise = resolution.tiktokHandle
    ? fetchTikTok({ brandId, handle: resolution.tiktokHandle, triggerKind: "on_demand" })
    : Promise.resolve(notFoundPlatform("no tiktok handle resolved"));

  const instagramPromise = resolution.instagramHandle
    ? fetchInstagram({ brandId, handle: resolution.instagramHandle, triggerKind: "on_demand" })
    : Promise.resolve(notFoundPlatform("no instagram handle resolved"));

  const shopifyPromise = resolution.websiteUrl
    ? fetchShopify({ brandId, domain: resolution.websiteUrl, triggerKind: "on_demand" })
    : Promise.resolve(notFoundPlatform("no shopify domain known"));

  // Reddit: pull subreddit seeds from the brand's category if it has one
  const subredditsForBrand = await getSubredditsForBrand(brandId);

  const [trendsR, amazonR, shopifyR, tiktokR, instagramR, redditR] = await Promise.all([
    fetchGoogleTrends({ brandId, keyword: primaryKeyword, triggerKind: "on_demand" }),
    fetchAmazon({ brandId, brandName: resolution.amazonBrand ?? primaryKeyword, triggerKind: "on_demand" }),
    shopifyPromise,
    tiktokPromise,
    instagramPromise,
    fetchReddit({
      brandId,
      brandName: primaryKeyword,
      subreddits: subredditsForBrand,
      triggerKind: "on_demand",
    }),
  ]);

  // -----------------------------------------------------------------
  // Step 4: sentiment (only if reddit returned threads)
  // -----------------------------------------------------------------
  let sentimentR: FetcherResult<SentimentResult> | null = null;
  if (redditR.ok && redditR.data && redditR.data.topThreads.length > 0) {
    try {
      const threadUrls = redditR.data.topThreads.map((t) => t.url);
      const sampled = await fetchRedditCommentSample(threadUrls, 15);
      const allComments = sampled.flatMap((s) => s.comments);
      if (allComments.length >= 3) {
        sentimentR = await analyzeSentiment({
          brandId,
          brandName: primaryKeyword,
          comments: allComments,
          contextHint: opts.contextHint,
          triggerKind: "on_demand",
        });
      }
    } catch (err) {
      console.warn(`[brand-card] sentiment failed: ${err}`);
    }
  }

  // -----------------------------------------------------------------
  // Step 5: momentum score
  // -----------------------------------------------------------------
  const momentum = await computeMomentumScore({ brandId, persistSnapshot: true });

  // -----------------------------------------------------------------
  // Step 6: IG trend line (from our own snapshot history)
  // -----------------------------------------------------------------
  const igTrend = await getInstagramFollowerTrend(brandId, 90);

  // -----------------------------------------------------------------
  // Step 7: narrative
  // -----------------------------------------------------------------
  const partialFetches = collectErrors({ trendsR, amazonR, shopifyR, tiktokR, instagramR, redditR, sentimentR });
  const narrative = await generateNarrative({
    brandName: resolution.brandName,
    tiktok: tiktokR.ok ? tiktokR.data : null,
    instagram: instagramR.ok ? instagramR.data : null,
    amazon: amazonR.ok ? amazonR.data : null,
    trends: trendsR.ok ? trendsR.data : null,
    reddit: redditR.ok ? redditR.data : null,
    sentiment: sentimentR?.ok ? sentimentR.data : null,
    momentumScore: momentum.score,
    notInRetail: momentum.notInRetail,
  });

  // -----------------------------------------------------------------
  // Step 8: assemble + cache
  // -----------------------------------------------------------------
  const card: BrandCard = assembleBrandCard({
    brandId,
    resolution,
    tiktokR,
    instagramR,
    instagramTrend: igTrend,
    amazonR,
    trendsR,
    redditR,
    sentimentR,
    momentum,
    narrative,
    errors: partialFetches,
  });

  await writeCache(brandId, card);

  console.log(`[brand-card] ${resolution.brandName} assembled in ${Date.now() - startedAt}ms (partial=${card.partial})`);
  return card;
}

// =========================================================================
// Cache
// =========================================================================

async function readCache(brandId: string): Promise<BrandCard | null> {
  const db = getAdminSupabase();
  const { data } = await db
    .from("brand_card_cache")
    .select("payload,generated_at,ttl_seconds")
    .eq("brand_id", brandId)
    .maybeSingle();
  if (!data) return null;
  const generatedAt = new Date(data.generated_at).getTime();
  const ttlMs = (data.ttl_seconds ?? 21600) * 1000;
  if (Date.now() - generatedAt > ttlMs) return null;
  return data.payload as BrandCard;
}

async function writeCache(brandId: string, card: BrandCard): Promise<void> {
  const db = getAdminSupabase();
  await db.from("brand_card_cache").upsert(
    {
      brand_id: brandId,
      payload: card,
      generated_at: nowIso(),
      ttl_seconds: Math.floor(CACHE_TTL_MS / 1000),
    },
    { onConflict: "brand_id" }
  );
}

// =========================================================================
// Subreddit lookup from category seeds
// =========================================================================

async function getSubredditsForBrand(brandId: string): Promise<string[]> {
  const db = getAdminSupabase();
  const { data } = await db
    .from("brands")
    .select("primary_category_id, categories!brands_primary_category_id_fkey(subreddits)")
    .eq("id", brandId)
    .maybeSingle();
  // Supabase relational select returns a nested object
  const subs = (data?.categories as { subreddits?: string[] } | null)?.subreddits ?? [];
  return Array.isArray(subs) ? subs : [];
}

// =========================================================================
// Narrative generation
// =========================================================================

interface NarrativeInput {
  brandName: string;
  tiktok: TikTokResult | null;
  instagram: InstagramResult | null;
  amazon: AmazonResult | null;
  trends: GoogleTrendsResult | null;
  reddit: RedditResult | null;
  sentiment: SentimentResult | null;
  momentumScore: number | null;
  notInRetail: boolean;
}

async function generateNarrative(input: NarrativeInput): Promise<string | null> {
  try {
    const env = getServerEnv();
    const client = new Anthropic({ apiKey: env.anthropicApiKey });

    // Build a compact factual summary the model can riff on. We hand the
    // model facts, not raw API responses, so its output is grounded.
    const facts: string[] = [];
    if (input.tiktok?.followerCount != null) {
      facts.push(`TikTok: ${formatNum(input.tiktok.followerCount)} followers`);
      if (input.tiktok.engagementRate != null) {
        facts.push(`TikTok engagement: ${(input.tiktok.engagementRate * 100).toFixed(1)}%`);
      }
    }
    if (input.instagram?.followerCount != null) {
      facts.push(`Instagram: ${formatNum(input.instagram.followerCount)} followers`);
    }
    if (input.amazon) {
      if (input.amazon.starRating != null && input.amazon.reviewCount != null) {
        facts.push(`Amazon: ${input.amazon.starRating} stars (${formatNum(input.amazon.reviewCount)} reviews)`);
      }
      if (input.amazon.bsrRank != null) {
        facts.push(`Amazon BSR: #${input.amazon.bsrRank}${input.amazon.bsrCategory ? ` in ${input.amazon.bsrCategory}` : ""}`);
      }
      if (input.amazon.boughtPastMonth) {
        facts.push(`Amazon: ${input.amazon.boughtPastMonth} bought past month`);
      }
    }
    if (input.trends?.yoyChangePct != null) {
      facts.push(`Google Trends YoY: ${(input.trends.yoyChangePct * 100).toFixed(0)}%`);
    }
    if (input.reddit && input.reddit.mentionCount > 0) {
      facts.push(`Reddit: ${input.reddit.mentionCount} mentions in past ${input.reddit.windowDays}d`);
      if (input.reddit.velocity != null) {
        facts.push(`Reddit velocity: ${(input.reddit.velocity * 100).toFixed(0)}%`);
      }
    }
    if (input.sentiment) {
      facts.push(`Sentiment: ${input.sentiment.label} (${input.sentiment.overallScore.toFixed(2)})`);
      if (input.sentiment.positiveThemes.length > 0) {
        facts.push(`Praised for: ${input.sentiment.positiveThemes.slice(0, 3).join(", ")}`);
      }
    }
    if (input.momentumScore != null) {
      facts.push(`Momentum Score: ${input.momentumScore}/100`);
    }
    if (input.notInRetail) {
      facts.push(`Not yet in Nielsen retail data — DTC-only signal`);
    }

    if (facts.length === 0) {
      return null;
    }

    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system:
        "You are a brand intelligence analyst at a consumer-goods rep group. " +
        "Given factual signals about a brand, write a 2-3 sentence executive summary " +
        "that synthesizes what the data says. Lead with the most important signal. " +
        "Be direct and confident, not hedgy. Don't repeat all the numbers — pick the " +
        "ones that matter most for a sales rep deciding whether to pitch this brand. " +
        "End with an action recommendation if the data warrants it. No preamble, no markdown.",
      messages: [
        {
          role: "user",
          content: `Brand: ${input.brandName}\n\nSignals:\n${facts.map((f) => `- ${f}`).join("\n")}`,
        },
      ],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return text || null;
  } catch (err) {
    console.warn(`[brand-card] narrative generation failed: ${err}`);
    return null;
  }
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
}

// =========================================================================
// Assembly
// =========================================================================

interface AssembleInput {
  brandId: string;
  resolution: HandleResolution;
  tiktokR: FetcherResult<TikTokResult>;
  instagramR: FetcherResult<InstagramResult>;
  instagramTrend: { date: string; value: number }[];
  amazonR: FetcherResult<AmazonResult>;
  trendsR: FetcherResult<GoogleTrendsResult>;
  redditR: FetcherResult<RedditResult>;
  sentimentR: FetcherResult<SentimentResult> | null;
  momentum: { score: number | null; components: unknown; notInRetail: boolean };
  narrative: string | null;
  errors: Record<string, string>;
}

function assembleBrandCard(a: AssembleInput): BrandCard {
  const partial = Object.keys(a.errors).length > 0;

  const recommendedAction =
    a.momentum.score == null
      ? null
      : a.momentum.score >= 70 && a.momentum.notInRetail
        ? "call_now"
        : a.momentum.score >= 50
          ? "watch"
          : "skip";

  return {
    brand: {
      id: a.brandId,
      name: a.resolution.brandName,
      slug: a.resolution.brandName.toLowerCase().replace(/\s+/g, "-"),
      primaryCategory: null,
    },
    resolved: {
      tiktokHandle: a.resolution.tiktokHandle,
      instagramHandle: a.resolution.instagramHandle,
      amazonBrand: a.resolution.amazonBrand,
      websiteUrl: a.resolution.websiteUrl,
      resolutionConfidence: a.resolution.confidence,
    },
    tiktok: {
      status: platformStatus(a.tiktokR),
      capturedAt: a.tiktokR.capturedAt,
      error: a.tiktokR.ok ? undefined : a.tiktokR.error,
      followerCount: a.tiktokR.data?.followerCount ?? undefined,
      followingCount: a.tiktokR.data?.followingCount ?? undefined,
      likesCount: a.tiktokR.data?.likesCount ?? undefined,
      videoCount: a.tiktokR.data?.videoCount ?? undefined,
      bio: a.tiktokR.data?.bio ?? undefined,
      isVerified: a.tiktokR.data?.isVerified ?? undefined,
      engagementRate: a.tiktokR.data?.engagementRate ?? undefined,
      topVideos: a.tiktokR.data?.topVideos as TikTokVideoSummary[] | undefined,
      adPresence: (a.tiktokR.data?.adSummary ?? undefined) as TikTokAdSummary | undefined,
    },
    instagram: {
      status: platformStatus(a.instagramR),
      capturedAt: a.instagramR.capturedAt,
      error: a.instagramR.ok ? undefined : a.instagramR.error,
      followerCount: a.instagramR.data?.followerCount ?? undefined,
      postCount: a.instagramR.data?.mediaCount ?? undefined,
      bio: a.instagramR.data?.bio ?? undefined,
      followerTrend: a.instagramTrend.length > 1 ? a.instagramTrend : undefined,
    },
    amazon: {
      status: platformStatus(a.amazonR),
      capturedAt: a.amazonR.capturedAt,
      error: a.amazonR.ok ? undefined : a.amazonR.error,
      starRating: a.amazonR.data?.starRating ?? undefined,
      reviewCount: a.amazonR.data?.reviewCount ?? undefined,
      bsrRank: a.amazonR.data?.bsrRank ?? undefined,
      bsrCategory: a.amazonR.data?.bsrCategory ?? undefined,
      boughtPastMonth: a.amazonR.data?.boughtPastMonth ?? undefined,
      productUrl: a.amazonR.data?.productUrl ?? undefined,
    },
    googleTrends: {
      status: platformStatus(a.trendsR),
      capturedAt: a.trendsR.capturedAt,
      error: a.trendsR.ok ? undefined : a.trendsR.error,
      searchVolumeTrend: a.trendsR.data?.series ?? undefined,
      yoyChangePct: a.trendsR.data?.yoyChangePct ?? undefined,
    },
    reddit: {
      status: platformStatus(a.redditR),
      capturedAt: a.redditR.capturedAt,
      error: a.redditR.ok ? undefined : a.redditR.error,
      mentionCount: a.redditR.data?.mentionCount ?? undefined,
      velocity: a.redditR.data?.velocity ?? undefined,
      topThreads: a.redditR.data?.topThreads as RedditThreadSummary[] | undefined,
    },
    sentiment: {
      status: a.sentimentR ? platformStatus(a.sentimentR) : "skipped",
      capturedAt: a.sentimentR?.capturedAt,
      error: a.sentimentR && !a.sentimentR.ok ? a.sentimentR.error : undefined,
      overallScore: a.sentimentR?.data?.overallScore ?? undefined,
      positiveThemes: a.sentimentR?.data?.positiveThemes ?? undefined,
      negativeThemes: a.sentimentR?.data?.negativeThemes ?? undefined,
      sampleSize: a.sentimentR?.data?.sampleSize ?? undefined,
    },
    momentumScore: {
      score: a.momentum.score,
      breakdown: a.momentum.components as Record<string, number>,
      asOf: nowIso(),
    },
    narrative: a.narrative,
    recommendedAction,
    generatedAt: nowIso(),
    partial,
    errors: a.errors,
  };
}

function platformStatus(r: FetcherResult<unknown>): PlatformBlock["status"] {
  if (r.ok) return "ok";
  if (!r.error) return "error";
  if (r.error.startsWith("not_configured")) return "not_configured";
  if (/not found|404|no .* results/i.test(r.error)) return "not_found";
  return "error";
}

function notFoundPlatform<T>(reason: string): FetcherResult<T> {
  return { ok: false, error: `not_found: ${reason}`, capturedAt: nowIso() };
}

function collectErrors(results: {
  trendsR: FetcherResult<unknown>;
  amazonR: FetcherResult<unknown>;
  shopifyR: FetcherResult<unknown>;
  tiktokR: FetcherResult<unknown>;
  instagramR: FetcherResult<unknown>;
  redditR: FetcherResult<unknown>;
  sentimentR: FetcherResult<unknown> | null;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!results.trendsR.ok) errors.google_trends = results.trendsR.error ?? "unknown";
  if (!results.amazonR.ok) errors.amazon = results.amazonR.error ?? "unknown";
  if (!results.shopifyR.ok) errors.shopify = results.shopifyR.error ?? "unknown";
  if (!results.tiktokR.ok) errors.tiktok = results.tiktokR.error ?? "unknown";
  if (!results.instagramR.ok) errors.instagram = results.instagramR.error ?? "unknown";
  if (!results.redditR.ok) errors.reddit = results.redditR.error ?? "unknown";
  if (results.sentimentR && !results.sentimentR.ok) errors.sentiment = results.sentimentR.error ?? "unknown";
  return errors;
}
