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
import { getServerEnv, getFeatureFlags } from "@/lib/env";
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
import {
  fetchSociaVaultTikTok,
  fetchSociaVaultInstagram,
  SOCIAVAULT_SOURCE_LABEL,
  type SociaVaultTikTokResult,
  type SociaVaultInstagramResult,
} from "@/lib/fetchers/sociavault";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface BrandCardOptions {
  brandName: string;
  forceRefresh?: boolean;
  override?: {
    tiktokHandle?: string;
    instagramHandle?: string;
    amazonBrand?: string;
    websiteUrl?: string;
  };
  contextHint?: string;
}

/** Typed "not found" stub so TypeScript knows exactly what T is. */
function notFoundResult<T>(reason: string): FetcherResult<T> {
  return { ok: false, error: `not_found: ${reason}`, capturedAt: nowIso() };
}

export async function getBrandCard(opts: BrandCardOptions): Promise<BrandCard> {
  const startedAt = Date.now();

  // --- Step 0: tracked-brand guard ---
  // This tool tracks a curated universe of brands (the ones surfaced from the
  // SmartScout x Nielsen analysis). Live fetchers for arbitrary brands require
  // API credentials that aren't configured, so rather than show a broken card
  // full of errors for an untracked name, return a clean "not tracked" card.
  //
  // EXCEPTION: when SociaVault is configured AND forceRefresh is true, we
  // skip the cache short-circuit and run the live pipeline so the seeded
  // demo brands can be enriched with real social signals. The merge guard
  // below ensures a partial-failure live fetch can't clobber a good card.
  const sociaVaultLive = getFeatureFlags().sociaVaultEnabled && opts.forceRefresh === true;
  const tracked = await findTrackedBrand(opts.brandName);
  if (tracked) {
    if (!sociaVaultLive) {
      const seeded = await readCacheRaw(tracked.id);
      if (seeded) return seeded;
    }
  } else {
    return notTrackedCard(opts.brandName);
  }

  // --- Step 1: handle resolution ---
  const resolution = await resolveBrandHandles({
    brandName: opts.brandName,
    persistToBrandsRow: true,
    override: opts.override,
  });
  if (!resolution.brandId) {
    throw new Error(`Could not resolve a brand row for "${opts.brandName}"`);
  }
  const brandId = resolution.brandId;

  // --- Step 2: cache check ---
  // Demo-seeded brands have curated cards that must never be overwritten by a
  // live fetch (live fetchers have no API credentials in this environment).
  // For these, always return the cached card, ignoring TTL and forceRefresh.
  //
  // EXCEPTION: when SociaVault is configured AND forceRefresh is true, we DO
  // run the live path so the demo brands can be enriched with real social
  // signals from SociaVault (which doesn't require per-platform OAuth). This
  // is how `npm run poll` and the weekly-poll cron upgrade demo cards from
  // "sample" social to "sourced" social once you have a SociaVault key.
  if (await isSeededBrand(brandId)) {
    if (!sociaVaultLive) {
      const seeded = await readCacheRaw(brandId);
      if (seeded) return seeded;
    }
  }

  if (!opts.forceRefresh) {
    const cached = await readCache(brandId);
    if (cached) return cached;
  }

  const primaryKeyword = opts.brandName;
  const flags = getFeatureFlags();

  // --- Step 3: fan-out fetchers ---
  // SociaVault is preferred when configured — it covers BOTH TikTok and
  // Instagram with a single API key and returns sourced (not sample) data.
  // When absent, fall back to the platform-native fetchers (most of which
  // need their own OAuth credentials).
  // Each promise is explicitly typed so TypeScript never widens to unknown.
  const tiktokPromise: Promise<FetcherResult<TikTokResult | SociaVaultTikTokResult>> = flags.sociaVaultEnabled && resolution.tiktokHandle
    ? fetchSociaVaultTikTok({ brandId, handle: resolution.tiktokHandle, triggerKind: "on_demand" })
    : resolution.tiktokHandle
      ? fetchTikTok({ brandId, handle: resolution.tiktokHandle, triggerKind: "on_demand" })
      : Promise.resolve(notFoundResult<TikTokResult>("no tiktok handle resolved"));

  const instagramPromise: Promise<FetcherResult<InstagramResult | SociaVaultInstagramResult>> = flags.sociaVaultEnabled && resolution.instagramHandle
    ? fetchSociaVaultInstagram({ brandId, handle: resolution.instagramHandle, triggerKind: "on_demand" })
    : resolution.instagramHandle
      ? fetchInstagram({ brandId, handle: resolution.instagramHandle, triggerKind: "on_demand" })
      : Promise.resolve(notFoundResult<InstagramResult>("no instagram handle resolved"));

  const shopifyPromise: Promise<FetcherResult<ShopifyResult>> = resolution.websiteUrl
    ? fetchShopify({ brandId, domain: resolution.websiteUrl, triggerKind: "on_demand" })
    : Promise.resolve(notFoundResult<ShopifyResult>("no shopify domain known"));

  const subredditsForBrand = await getSubredditsForBrand(brandId);

  const [trendsR, amazonR, shopifyR, tiktokR, instagramR, redditR]: [
    FetcherResult<GoogleTrendsResult>,
    FetcherResult<AmazonResult>,
    FetcherResult<ShopifyResult>,
    FetcherResult<TikTokResult | SociaVaultTikTokResult>,
    FetcherResult<InstagramResult | SociaVaultInstagramResult>,
    FetcherResult<RedditResult>,
  ] = await Promise.all([
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

  // --- Step 4: sentiment ---
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

  // --- Step 5: momentum ---
  const momentum = await computeMomentumScore({ brandId, persistSnapshot: true });

  // --- Step 6: IG trend line ---
  const igTrend = await getInstagramFollowerTrend(brandId, 90);

  // --- Step 6b: commerce block from snapshots ---
  // Always read from the snapshots table so the Commerce Hero survives a live
  // poll. seed-cards.ts wrote these when it seeded the demo; SmartScout uploads
  // refresh them monthly. Without this the assembled card has no commerce block
  // because live fetchers don't scrape SmartScout/Nielsen.
  const commerceBlock = await readCommerceBlock(brandId);

  // --- Step 7: narrative ---
  const partialFetches = collectErrors({ trendsR, amazonR, shopifyR, tiktokR, instagramR, redditR, sentimentR });
  const narrative = await generateNarrative({
    brandName: resolution.brandName,
    tiktok: tiktokR.ok ? (tiktokR.data ?? null) : null,
    instagram: instagramR.ok ? (instagramR.data ?? null) : null,
    amazon: amazonR.ok ? (amazonR.data ?? null) : null,
    trends: trendsR.ok ? (trendsR.data ?? null) : null,
    reddit: redditR.ok ? (redditR.data ?? null) : null,
    sentiment: sentimentR?.ok ? (sentimentR.data ?? null) : null,
    momentumScore: momentum.score,
    notInRetail: momentum.notInRetail,
  });

  // --- Step 8: assemble + cache ---
  const card: BrandCard = assembleBrandCard({
    brandId,
    resolution,
    commerceBlock,
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

  // Guard: don't let a mostly-failed live fetch clobber a good existing card.
  // If most platform fetches failed (e.g. missing API credentials), preserve
  // whatever is already cached rather than overwriting it with errors.
  //
  // EXCEPTION: if SociaVault succeeded on either TikTok or Instagram, that's
  // genuine NEW sourced data we want to keep, even if the other 4 fetchers
  // failed for lack of OAuth credentials. Merge instead of discard: take the
  // cached card, swap in the live SociaVault blocks.
  const failedCount = Object.keys(partialFetches).length;
  const sociaVaultTikTokOk = isSociaVaultTikTok(tiktokR.data) && tiktokR.ok;
  const sociaVaultInstagramOk = isSociaVaultInstagram(instagramR.data) && instagramR.ok;
  // Threshold = 2: Amazon + Reddit always fail without their credentials, so
  // in normal operation failedCount >= 2. When SociaVault succeeded we merge
  // the live social blocks into the existing cached card, preserving the
  // commerce hero and narrative that live fetchers can't regenerate.
  if (failedCount >= 2 && !sociaVaultTikTokOk && !sociaVaultInstagramOk) {
    const existing = await readCacheRaw(brandId);
    if (existing) {
      console.log(`[brand-card] ${resolution.brandName}: live fetch mostly failed (${failedCount}), keeping cached card`);
      return existing;
    }
  } else if (failedCount >= 2 && (sociaVaultTikTokOk || sociaVaultInstagramOk)) {
    // Merge path: SociaVault succeeded — overlay the freshly-assembled blocks
    // onto the cached card. Everything the live pipeline can authoritatively
    // recompute is taken from the fresh `card`, NOT inherited from `existing`:
    //   - commerce: re-read from snapshots every poll (readCommerceBlock). The
    //     old code inherited existing.commerce, so a card that ever lacked a
    //     commerce block kept losing it on every subsequent merge. Taking the
    //     fresh value (with a safety fallback to existing) ends that cascade.
    //   - narrative / momentumScore / recommendedAction: recomputed this run,
    //     so the cached copies would be stale.
    //   - tiktok / instagram: always take the fresh block. When a handle is
    //     null or unresolved the fresh block is a clean not_configured/
    //     not_found state — strictly more honest than a stale wrong-account
    //     block lingering in `existing`.
    // Only the cached `brand` identity (and any unrelated keys) are inherited.
    const existing = await readCacheRaw(brandId);
    if (existing) {
      const merged: BrandCard = {
        ...existing,
        commerce: card.commerce ?? existing.commerce,
        narrative: card.narrative ?? existing.narrative,
        momentumScore: card.momentumScore,
        recommendedAction: card.recommendedAction,
        tiktok: card.tiktok,
        instagram: card.instagram,
        // Carry any OTHER block whose live fetch succeeded this run. Without
        // this, a credential-free source like Google Trends (which always
        // runs and succeeds) would compute fresh data every poll yet never
        // reach the card — the stale sample block in `existing` would win.
        // We only overwrite when the fresh fetch was ok, so a transient
        // rate-limit can't wipe a previously-good block.
        googleTrends: trendsR.ok ? card.googleTrends : existing.googleTrends,
        reddit: redditR.ok ? card.reddit : existing.reddit,
        sentiment: sentimentR?.ok ? card.sentiment : existing.sentiment,
        amazon: amazonR.ok ? card.amazon : existing.amazon,
        partial: card.partial,
        errors: card.errors,
        generatedAt: nowIso(),
      };
      await writeCache(brandId, merged);
      console.log(`[brand-card] ${resolution.brandName}: merged SociaVault social into cached card (tt=${sociaVaultTikTokOk}, ig=${sociaVaultInstagramOk})`);
      return merged;
    }
  }

  await writeCache(brandId, card);
  console.log(`[brand-card] ${resolution.brandName} assembled in ${Date.now() - startedAt}ms (partial=${card.partial})`);
  return card;
}

// =========================================================================
// Commerce block reader
// =========================================================================

/**
 * Read the latest commerce signals from the snapshots table.
 * These are written by seed-cards.ts (demo seed) and by SmartScout uploads.
 * Populating this here ensures the Commerce Hero survives a live poll — the
 * live path through assembleBrandCard has no other way to get these numbers.
 */
async function readCommerceBlock(brandId: string): Promise<BrandCard["commerce"] | undefined> {
  const db = getAdminSupabase();
  const snap = async (platform: string, metric: string): Promise<number | null> => {
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
  };
  const [sales, yoy, units, retail, retailYoy] = await Promise.all([
    snap("smartscout", "annual_revenue"),
    snap("smartscout", "yoy_growth_pct"),
    snap("smartscout", "monthly_units"),
    snap("nielsen", "retail_annual_sales"),
    snap("nielsen", "retail_yoy_growth_pct"),
  ]);
  if (sales == null) return undefined;
  const r = retail ?? 0;
  const presence: "None" | "Minimal" | "Emerging" | "Established" =
    r <= 0 ? "None" : r < 100_000 ? "Minimal" : r < 15_000_000 ? "Emerging" : "Established";
  return {
    amazonAnnualSales: Math.round(sales),
    amazonYoyGrowthPct: yoy ?? undefined,
    amazonMonthlyUnits: units ? Math.round(units) : undefined,
    retailAnnualSales: Math.round(r),
    retailYoyGrowthPct: retailYoy ?? null,
    retailPresence: presence,
    sourceLabel: "SmartScout \u00d7 Nielsen xAOC \u00b7 Apr 2026",
  };
}

// =========================================================================
// Cache
// =========================================================================

/** Normalize a brand name for forgiving matching: lowercased, '&'<->'and'
 *  unified, punctuation stripped, whitespace collapsed. So "Head & Shoulders",
 *  "Head and Shoulders", and "head&shoulders" all compare equal. */
function normalizeBrandName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Find a tracked (demo-seeded) brand by name with forgiving matching. First
 *  tries an exact case-insensitive hit; if that misses, normalizes the input
 *  and compares against all seeded brands so '&' vs 'and', punctuation, and
 *  spacing differences don't cause a miss. Returns the brand id+name or null. */
async function findTrackedBrand(name: string): Promise<{ id: string; name: string } | null> {
  const db = getAdminSupabase();
  const trimmed = name.trim();
  if (!trimmed) return null;

  // Fast path: exact case-insensitive match.
  const { data: exact } = await db
    .from("brands")
    .select("id,name")
    .ilike("name", trimmed)
    .contains("tags", ["demo-seed"])
    .limit(1)
    .maybeSingle();
  if (exact) return { id: exact.id, name: exact.name };

  // Forgiving path: normalize and compare against all seeded brands. We match
  // on TWO normalizations so deep-links work regardless of how the slug was
  // formed:
  //   - normalizeBrandName: spaces between tokens ("DR.MELAXIN" -> "dr melaxin")
  //   - slugCompact:        punctuation removed, no spaces ("drmelaxin")
  // A URL like /brand-card/drmelaxin yields queryName "drmelaxin", which only
  // matches via the compact form — the space-separated form would miss.
  const target = normalizeBrandName(trimmed);
  const targetCompact = compactName(trimmed);
  if (!target && !targetCompact) return null;
  const { data: all } = await db
    .from("brands")
    .select("id,name")
    .contains("tags", ["demo-seed"]);
  if (!all) return null;
  const hit = all.find(
    (b) =>
      normalizeBrandName(b.name) === target ||
      compactName(b.name) === targetCompact
  );
  return hit ? { id: hit.id, name: hit.name } : null;
}

/** Punctuation- and space-free lowercase form. "DR.MELAXIN" -> "drmelaxin",
 *  "Head & Shoulders" -> "headandshoulders". Used so a slug that dropped all
 *  punctuation still resolves to its brand row. */
function compactName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

/** A clean "this brand isn't tracked yet" card. Returned for any name outside
 *  the curated universe so the UI never shows a wall of live-fetch errors. */
function notTrackedCard(name: string): BrandCard {
  const now = nowIso();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const block = { status: "skipped" as const, capturedAt: now };
  return {
    brand: { id: "", name, slug, primaryCategory: null },
    resolved: {
      tiktokHandle: null, instagramHandle: null, amazonBrand: null,
      websiteUrl: null, resolutionConfidence: "unresolved",
    },
    tiktok: block, instagram: block, amazon: block,
    googleTrends: block, reddit: block, sentiment: block,
    momentumScore: { score: null, asOf: now },
    narrative:
      `“${name}” isn’t in the tracked brand set yet. Kestrel currently covers the ` +
      `brands surfaced from the latest Amazon and Nielsen pull. ` +
      `Add it to the watchlist to start tracking, or try one of the ranked brands in Discovery.`,
    recommendedAction: null,
    generatedAt: now,
    partial: false,
    errors: {},
    notTracked: true,
  } as BrandCard & { notTracked: true };
}

/** True if the brand row is a demo-seeded brand (tags contain 'demo-seed').
 *  Seeded brands have curated cards that must never be overwritten by a live
 *  fetch, so callers short-circuit to the cached card for these. */
async function isSeededBrand(brandId: string): Promise<boolean> {
  const db = getAdminSupabase();
  const { data } = await db
    .from("brands")
    .select("tags")
    .eq("id", brandId)
    .maybeSingle();
  const tags = (data?.tags ?? []) as string[];
  return tags.includes("demo-seed");
}

/** Read the cached card ignoring TTL — used as a fallback when a live
 *  fetch mostly fails so we never serve errors over a good cached card. */
async function readCacheRaw(brandId: string): Promise<BrandCard | null> {
  const db = getAdminSupabase();
  const { data } = await db
    .from("brand_card_cache")
    .select("payload")
    .eq("brand_id", brandId)
    .maybeSingle();
  return data ? (data.payload as BrandCard) : null;
}

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
    { brand_id: brandId, payload: card, generated_at: nowIso(), ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) },
    { onConflict: "brand_id" }
  );
}

// =========================================================================
// Subreddit lookup
// =========================================================================

async function getSubredditsForBrand(brandId: string): Promise<string[]> {
  const db = getAdminSupabase();
  const { data } = await db
    .from("brands")
    .select("primary_category_id, categories!brands_primary_category_id_fkey(subreddits)")
    .eq("id", brandId)
    .maybeSingle();
  const subs = (data?.categories as { subreddits?: string[] } | null)?.subreddits ?? [];
  return Array.isArray(subs) ? subs : [];
}

// =========================================================================
// Narrative generation
// =========================================================================

interface NarrativeInput {
  brandName: string;
  tiktok: TikTokResult | SociaVaultTikTokResult | null;
  instagram: InstagramResult | SociaVaultInstagramResult | null;
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

    const facts: string[] = [];
    if (input.tiktok?.followerCount != null) {
      facts.push(`TikTok: ${formatNum(input.tiktok.followerCount)} followers`);
      if (input.tiktok.engagementRate != null)
        facts.push(`TikTok engagement: ${(input.tiktok.engagementRate * 100).toFixed(1)}%`);
    }
    if (input.instagram?.followerCount != null)
      facts.push(`Instagram: ${formatNum(input.instagram.followerCount)} followers`);
    if (input.amazon) {
      if (input.amazon.starRating != null && input.amazon.reviewCount != null)
        facts.push(`Amazon: ${input.amazon.starRating} stars (${formatNum(input.amazon.reviewCount)} reviews)`);
      if (input.amazon.bsrRank != null)
        facts.push(`Amazon BSR: #${input.amazon.bsrRank}${input.amazon.bsrCategory ? ` in ${input.amazon.bsrCategory}` : ""}`);
      if (input.amazon.boughtPastMonth)
        facts.push(`Amazon: ${input.amazon.boughtPastMonth} bought past month`);
    }
    if (input.trends?.yoyChangePct != null)
      facts.push(`Google Trends YoY: ${(input.trends.yoyChangePct * 100).toFixed(0)}%`);
    if (input.reddit && input.reddit.mentionCount > 0) {
      facts.push(`Reddit: ${input.reddit.mentionCount} mentions in past ${input.reddit.windowDays}d`);
      if (input.reddit.velocity != null)
        facts.push(`Reddit velocity: ${(input.reddit.velocity * 100).toFixed(0)}%`);
    }
    if (input.sentiment) {
      facts.push(`Sentiment: ${input.sentiment.label} (${input.sentiment.overallScore.toFixed(2)})`);
      if (input.sentiment.positiveThemes.length > 0)
        facts.push(`Praised for: ${input.sentiment.positiveThemes.slice(0, 3).join(", ")}`);
    }
    if (input.momentumScore != null) facts.push(`Momentum Score: ${input.momentumScore}/100`);
    if (input.notInRetail) facts.push(`Not yet in Nielsen retail data — DTC-only signal`);
    if (facts.length === 0) return null;

    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system:
        "You are a brand intelligence analyst at a consumer-goods rep group. " +
        "Given factual signals about a brand, write a 2-3 sentence executive summary. " +
        "Lead with the most important signal. Be direct and confident. " +
        "No preamble, no markdown.",
      messages: [
        { role: "user", content: `Brand: ${input.brandName}\n\nSignals:\n${facts.map((f) => `- ${f}`).join("\n")}` },
      ],
    });

    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim() || null;
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
  commerceBlock?: BrandCard["commerce"];
  tiktokR: FetcherResult<TikTokResult | SociaVaultTikTokResult>;
  instagramR: FetcherResult<InstagramResult | SociaVaultInstagramResult>;
  instagramTrend: { date: string; value: number }[];
  amazonR: FetcherResult<AmazonResult>;
  trendsR: FetcherResult<GoogleTrendsResult>;
  redditR: FetcherResult<RedditResult>;
  sentimentR: FetcherResult<SentimentResult> | null;
  momentum: { score: number | null; components: unknown; notInRetail: boolean };
  narrative: string | null;
  errors: Record<string, string>;
}

function isSociaVaultTikTok(r: TikTokResult | SociaVaultTikTokResult | undefined): r is SociaVaultTikTokResult {
  return !!r && (r as SociaVaultTikTokResult).source === "sociavault";
}
function isSociaVaultInstagram(r: InstagramResult | SociaVaultInstagramResult | undefined): r is SociaVaultInstagramResult {
  return !!r && (r as SociaVaultInstagramResult).source === "sociavault";
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

  // Provenance tagging — if the data came from SociaVault, the BrandCard's
  // PlatformBlock gets `provenance: "sourced"` + sourceLabel so the UI
  // renders a teal "SociaVault" badge instead of the amber "Preview · sample".
  const tiktokFromSocia = isSociaVaultTikTok(a.tiktokR.data);
  const igFromSocia = isSociaVaultInstagram(a.instagramR.data);

  // SociaVault TikTok result doesn't include the ad-presence object (that's
  // a separate Commercial API). Detect the type and read adSummary only when
  // it's actually the native fetcher.
  const tiktokNativeData = !tiktokFromSocia ? (a.tiktokR.data as TikTokResult | undefined) : undefined;

  return {
    brand: {
      id: a.brandId,
      name: a.resolution.brandName,
      slug: a.resolution.brandName.toLowerCase().replace(/\s+/g, "-"),
      primaryCategory: null,
    },
    commerce: a.commerceBlock,
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
      provenance: tiktokFromSocia ? "sourced" : undefined,
      sourceLabel: tiktokFromSocia ? SOCIAVAULT_SOURCE_LABEL : undefined,
      followerCount: a.tiktokR.data?.followerCount ?? undefined,
      followingCount: a.tiktokR.data?.followingCount ?? undefined,
      likesCount: a.tiktokR.data?.likesCount ?? undefined,
      videoCount: a.tiktokR.data?.videoCount ?? undefined,
      bio: a.tiktokR.data?.bio ?? undefined,
      isVerified: a.tiktokR.data?.isVerified ?? undefined,
      engagementRate: a.tiktokR.data?.engagementRate ?? undefined,
      topVideos: a.tiktokR.data?.topVideos as TikTokVideoSummary[] | undefined,
      adPresence: (tiktokNativeData?.adSummary ?? undefined) as TikTokAdSummary | undefined,
    },
    instagram: {
      status: platformStatus(a.instagramR),
      capturedAt: a.instagramR.capturedAt,
      error: a.instagramR.ok ? undefined : a.instagramR.error,
      provenance: igFromSocia ? "sourced" : undefined,
      sourceLabel: igFromSocia ? SOCIAVAULT_SOURCE_LABEL : undefined,
      followerCount: a.instagramR.data?.followerCount ?? undefined,
      postCount: igFromSocia
        ? (a.instagramR.data as SociaVaultInstagramResult).mediaCount ?? undefined
        : (a.instagramR.data as InstagramResult | undefined)?.mediaCount ?? undefined,
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
      // Google Trends needs no credentials and returns real interest-over-time
      // data, so a successful fetch is genuinely sourced — tag it so the UI
      // shows a teal "Google Trends" badge instead of amber "Preview · sample".
      provenance: a.trendsR.ok ? "sourced" : undefined,
      sourceLabel: a.trendsR.ok ? "Google Trends" : undefined,
      searchVolumeTrend: a.trendsR.data?.series ?? undefined,
      yoyChangePct: a.trendsR.data?.yoyChangePct ?? undefined,
    },
    reddit: {
      status: platformStatus(a.redditR),
      capturedAt: a.redditR.capturedAt,
      error: a.redditR.ok ? undefined : a.redditR.error,
      // A successful Reddit fetch is real community data — tag sourced.
      provenance: a.redditR.ok ? "sourced" : undefined,
      sourceLabel: a.redditR.ok ? "Reddit" : undefined,
      mentionCount: a.redditR.data?.mentionCount ?? undefined,
      velocity: a.redditR.data?.velocity ?? undefined,
      topThreads: a.redditR.data?.topThreads as RedditThreadSummary[] | undefined,
    },
    sentiment: {
      status: a.sentimentR ? platformStatus(a.sentimentR) : "skipped",
      capturedAt: a.sentimentR?.capturedAt,
      error: a.sentimentR && !a.sentimentR.ok ? a.sentimentR.error : undefined,
      provenance: a.sentimentR?.ok ? "sourced" : undefined,
      sourceLabel: a.sentimentR?.ok ? "Claude sentiment" : undefined,
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

function collectErrors(results: {
  trendsR: FetcherResult<unknown>;
  amazonR: FetcherResult<unknown>;
  shopifyR: FetcherResult<unknown>;
  tiktokR: FetcherResult<unknown>;
  instagramR: FetcherResult<unknown>;
  redditR: FetcherResult<unknown>;
  sentimentR: FetcherResult<unknown> | null;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (!results.trendsR.ok) out.google_trends = results.trendsR.error ?? "unknown";
  if (!results.amazonR.ok) out.amazon = results.amazonR.error ?? "unknown";
  if (!results.shopifyR.ok) out.shopify = results.shopifyR.error ?? "unknown";
  if (!results.tiktokR.ok) out.tiktok = results.tiktokR.error ?? "unknown";
  if (!results.instagramR.ok) out.instagram = results.instagramR.error ?? "unknown";
  if (!results.redditR.ok) out.reddit = results.redditR.error ?? "unknown";
  if (results.sentimentR && !results.sentimentR.ok) out.sentiment = results.sentimentR.error ?? "unknown";
  return out;
}
