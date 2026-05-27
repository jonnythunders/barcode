/**
 * SociaVault fetcher.
 *
 * SociaVault (https://sociavault.com) is a unified social-media scraping API
 * that returns real-time public data for TikTok, Instagram, YouTube, and
 * 20+ other platforms with a single API key. We use it as our primary
 * source for TikTok and Instagram signals — replacing the
 * client-credentials TikTok OAuth flow and the Meta access-token flow,
 * neither of which is configured in this environment.
 *
 * Auth: `x-api-key: $SOCIAVAULT_API_KEY` header.
 * Base: https://api.sociavault.com/v1/scrape
 *
 * Endpoints used:
 *   GET /tiktok/profile?handle={h}   — followers, likes, video count, verified, bio
 *   GET /tiktok/videos?handle={h}    — recent videos for engagement-rate calc
 *   GET /instagram/profile?handle={h}— followers, post count, verified, bio
 *
 * Response shapes are documented at docs.sociavault.com but vary slightly
 * by endpoint (some return camelCase under `data.user` + `data.stats`,
 * others return snake_case at `data.*`). The parsers below tolerate both
 * shapes by checking each location.
 *
 * Snapshots written when the call succeeds:
 *   - 'tiktok' / 'follower_count', 'following_count', 'likes_count', 'video_count'
 *   - 'tiktok' / 'is_verified', 'bio', 'engagement_rate', 'top_videos'
 *   - 'instagram' / 'follower_count', 'following_count', 'media_count'
 *   - 'instagram' / 'is_verified', 'bio'
 *
 * Each snapshot row also gets value_json.source = 'sociavault' so the
 * provenance can be surfaced in the BrandCard's status badges.
 */
import { getServerEnv, getFeatureFlags } from "@/lib/env";
import { notConfiguredResult, withFetcherRun, writeSnapshot, type FetcherRunCtx } from "./_base";
import type { FetcherResult, TikTokVideoSummary } from "@/lib/types";

const BASE_URL = "https://api.sociavault.com/v1/scrape";
const REQUEST_TIMEOUT_MS = 20_000;
const PROVENANCE_LABEL = "SociaVault";

// =========================================================================
// Result shapes (what the Brand Card consumes)
// =========================================================================

export interface SociaVaultTikTokResult {
  handle: string;
  followerCount: number | null;
  followingCount: number | null;
  likesCount: number | null;
  videoCount: number | null;
  bio: string | null;
  isVerified: boolean | null;
  engagementRate: number | null;       // 0..1 across recent N videos
  topVideos: TikTokVideoSummary[];     // up to 5
  source: "sociavault";
  capturedAt: string;
}

export interface SociaVaultInstagramResult {
  handle: string;
  followerCount: number | null;
  followingCount: number | null;
  mediaCount: number | null;
  bio: string | null;
  isVerified: boolean | null;
  source: "sociavault";
  capturedAt: string;
}

export interface SociaVaultOptions {
  brandId: string;
  handle: string;                      // without leading @
  videoSampleSize?: number;            // for engagement-rate; default 12
  triggerKind?: "manual" | "cron" | "on_demand";
}

// =========================================================================
// Low-level HTTP
// =========================================================================

interface SociaVaultEnvelope<T = unknown> {
  success?: boolean;
  data?: T;
  credits_used?: number;
  message?: string;
  error?: string;
}

async function sociaVaultGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const env = getServerEnv();
  if (!env.sociavaultApiKey) {
    throw new Error("SOCIAVAULT_API_KEY missing");
  }
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-api-key": env.sociavaultApiKey,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status === 404) {
    throw new Error(`sociavault: ${path} returned 404 (handle not found)`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`sociavault: ${path} auth failed (${res.status}) — check SOCIAVAULT_API_KEY`);
  }
  if (res.status === 429) {
    throw new Error(`sociavault: ${path} rate-limited (429) — check credit balance`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`sociavault: ${path} returned ${res.status}: ${body.slice(0, 200)}`);
  }
  const body = (await res.json()) as SociaVaultEnvelope<T>;
  if (body.success === false || body.error) {
    throw new Error(`sociavault: ${path} returned error: ${body.error ?? body.message ?? "unknown"}`);
  }
  if (body.data === undefined) {
    throw new Error(`sociavault: ${path} returned no data field`);
  }
  return body.data;
}

// =========================================================================
// TikTok
// =========================================================================

interface TikTokProfileRaw {
  // Variant A: nested camelCase
  user?: {
    uniqueId?: string;
    nickname?: string;
    signature?: string;     // bio
    verified?: boolean;
  };
  stats?: {
    followerCount?: number;
    followingCount?: number;
    heart?: number;
    heartCount?: number;
    videoCount?: number;
  };
  // Variant B: flat snake_case
  username?: string;
  follower_count?: number;
  following_count?: number;
  likes?: number;            // = heart count
  video_count?: number;
  verified?: boolean;
  bio?: string;
  signature?: string;
}

function parseTikTokProfile(raw: TikTokProfileRaw, handle: string): Omit<SociaVaultTikTokResult, "engagementRate" | "topVideos" | "source" | "capturedAt"> {
  const u = raw.user ?? {};
  const s = raw.stats ?? {};
  return {
    handle,
    followerCount: s.followerCount ?? raw.follower_count ?? null,
    followingCount: s.followingCount ?? raw.following_count ?? null,
    likesCount: s.heartCount ?? s.heart ?? raw.likes ?? null,
    videoCount: s.videoCount ?? raw.video_count ?? null,
    bio: u.signature ?? raw.signature ?? raw.bio ?? null,
    isVerified: u.verified ?? raw.verified ?? null,
  };
}

interface TikTokVideoRaw {
  aweme_id?: string;
  desc?: string;
  create_time?: number;          // unix seconds
  statistics?: {
    play_count?: number;
    digg_count?: number;          // likes
    comment_count?: number;
    share_count?: number;
  };
}

interface TikTokVideosResponse {
  aweme_list?: Record<string, TikTokVideoRaw> | TikTokVideoRaw[];
  max_cursor?: number;
  has_more?: number;
}

function parseTikTokVideos(raw: TikTokVideosResponse, handle: string, limit: number): TikTokVideoSummary[] {
  const list = raw.aweme_list ?? {};
  // SociaVault returns videos as {"0": {...}, "1": {...}} — Object.values
  // also handles the case where it's already an array.
  const items: TikTokVideoRaw[] = Array.isArray(list) ? list : Object.values(list);
  return items.slice(0, limit).map((v) => ({
    id: String(v.aweme_id ?? ""),
    url: v.aweme_id ? `https://www.tiktok.com/@${handle}/video/${v.aweme_id}` : undefined,
    views: Number(v.statistics?.play_count ?? 0),
    likes: Number(v.statistics?.digg_count ?? 0),
    shares: Number(v.statistics?.share_count ?? 0),
    comments: Number(v.statistics?.comment_count ?? 0),
    postedAt: v.create_time ? new Date(Number(v.create_time) * 1000).toISOString() : undefined,
  }));
}

function computeEngagementRate(videos: TikTokVideoSummary[]): number | null {
  if (videos.length === 0) return null;
  let totalEngagements = 0;
  let totalViews = 0;
  for (const v of videos) {
    totalEngagements += v.likes + v.comments + v.shares;
    totalViews += v.views;
  }
  if (totalViews === 0) return null;
  return totalEngagements / totalViews;       // 0..1 ratio
}

export async function fetchSociaVaultTikTok(opts: SociaVaultOptions): Promise<FetcherResult<SociaVaultTikTokResult>> {
  const flags = getFeatureFlags();
  if (!flags.sociaVaultEnabled) {
    return notConfiguredResult("SOCIAVAULT_API_KEY missing");
  }

  const handle = opts.handle.replace(/^@/, "");
  const trigger = opts.triggerKind ?? "on_demand";
  const sampleSize = opts.videoSampleSize ?? 12;

  return withFetcherRun(
    {
      fetcherName: "sociavault_tiktok",
      triggerKind: trigger,
      brandId: opts.brandId,
      metadata: { handle, sampleSize, source: "sociavault" },
    },
    async (ctx: FetcherRunCtx): Promise<SociaVaultTikTokResult> => {
      const profileUrl = `https://www.tiktok.com/@${handle}`;

      // ---- Profile (1 credit) ----
      const profileRaw = await sociaVaultGet<TikTokProfileRaw>("/tiktok/profile", { handle });
      const profile = parseTikTokProfile(profileRaw, handle);

      // ---- Videos for engagement rate (1 credit) ----
      // Non-fatal — engagement rate is nice-to-have, follower count is the must-have.
      let videos: TikTokVideoSummary[] = [];
      let engagementRate: number | null = null;
      try {
        const vidsRaw = await sociaVaultGet<TikTokVideosResponse>("/tiktok/videos", { handle });
        videos = parseTikTokVideos(vidsRaw, handle, sampleSize);
        engagementRate = computeEngagementRate(videos);
      } catch (err) {
        console.warn(`[sociavault-tiktok] video fetch failed for @${handle}: ${err instanceof Error ? err.message : err}`);
      }

      // ---- Persist snapshots ----
      const baseJson = { source: "sociavault" as const };
      const snaps: Promise<void>[] = [];

      if (profile.followerCount != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "follower_count",
          valueNumeric: profile.followerCount, valueJson: baseJson, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (profile.followingCount != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "following_count",
          valueNumeric: profile.followingCount, valueJson: baseJson, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (profile.likesCount != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "likes_count",
          valueNumeric: profile.likesCount, valueJson: baseJson, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (profile.videoCount != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "video_count",
          valueNumeric: profile.videoCount, valueJson: baseJson, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (profile.bio) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "bio",
          valueText: profile.bio, valueJson: baseJson, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (profile.isVerified != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "is_verified",
          valueText: profile.isVerified ? "true" : "false", valueJson: baseJson, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (engagementRate != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "engagement_rate",
          valueNumeric: engagementRate,
          valueJson: { ...baseJson, sampleSize: videos.length },
          sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (videos.length > 0) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "top_videos",
          valueJson: { ...baseJson, videos: videos.slice(0, 5) },
          sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }

      await Promise.all(snaps);

      return {
        ...profile,
        engagementRate,
        topVideos: videos.slice(0, 5),
        source: "sociavault",
        capturedAt: new Date().toISOString(),
      };
    }
  );
}

// =========================================================================
// Instagram
// =========================================================================

interface InstagramProfileRaw {
  // Variant A: flat snake_case (what the blog posts most often show)
  username?: string;
  full_name?: string;
  biography?: string;
  follower_count?: number;
  following_count?: number;
  media_count?: number;
  is_verified?: boolean;
  is_business?: boolean;
  is_business_account?: boolean;
  // Variant B: nested under data.data.user (some endpoints)
  user?: {
    username?: string;
    full_name?: string;
    biography?: string;
    is_verified?: boolean;
    edge_followed_by?: { count?: number };
    edge_follow?: { count?: number };
    edge_owner_to_timeline_media?: { count?: number };
  };
}

function parseInstagramProfile(raw: InstagramProfileRaw, handle: string): Omit<SociaVaultInstagramResult, "source" | "capturedAt"> {
  const u = raw.user ?? {};
  return {
    handle,
    followerCount: raw.follower_count ?? u.edge_followed_by?.count ?? null,
    followingCount: raw.following_count ?? u.edge_follow?.count ?? null,
    mediaCount: raw.media_count ?? u.edge_owner_to_timeline_media?.count ?? null,
    bio: raw.biography ?? u.biography ?? null,
    isVerified: raw.is_verified ?? u.is_verified ?? null,
  };
}

export async function fetchSociaVaultInstagram(opts: SociaVaultOptions): Promise<FetcherResult<SociaVaultInstagramResult>> {
  const flags = getFeatureFlags();
  if (!flags.sociaVaultEnabled) {
    return notConfiguredResult("SOCIAVAULT_API_KEY missing");
  }

  const handle = opts.handle.replace(/^@/, "");
  const trigger = opts.triggerKind ?? "on_demand";

  return withFetcherRun(
    {
      fetcherName: "sociavault_instagram",
      triggerKind: trigger,
      brandId: opts.brandId,
      metadata: { handle, source: "sociavault" },
    },
    async (ctx: FetcherRunCtx): Promise<SociaVaultInstagramResult> => {
      const profileUrl = `https://www.instagram.com/${handle}/`;

      const profileRaw = await sociaVaultGet<InstagramProfileRaw>("/instagram/profile", { handle });
      const profile = parseInstagramProfile(profileRaw, handle);

      const baseJson = { source: "sociavault" as const };
      const snaps: Promise<void>[] = [];

      if (profile.followerCount != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "instagram", metric: "follower_count",
          valueNumeric: profile.followerCount, valueJson: baseJson, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (profile.followingCount != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "instagram", metric: "following_count",
          valueNumeric: profile.followingCount, valueJson: baseJson, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (profile.mediaCount != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "instagram", metric: "media_count",
          valueNumeric: profile.mediaCount, valueJson: baseJson, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (profile.bio) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "instagram", metric: "bio",
          valueText: profile.bio, valueJson: baseJson, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (profile.isVerified != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "instagram", metric: "is_verified",
          valueText: profile.isVerified ? "true" : "false", valueJson: baseJson, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }

      await Promise.all(snaps);

      return {
        ...profile,
        source: "sociavault",
        capturedAt: new Date().toISOString(),
      };
    }
  );
}

/** Source label used in PlatformBlock.sourceLabel when these results flow
 *  through to the BrandCard. Keeps the UI text in one place. */
export const SOCIAVAULT_SOURCE_LABEL = PROVENANCE_LABEL;
