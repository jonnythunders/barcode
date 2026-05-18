/**
 * TikTok fetcher.
 *
 * Uses two TikTok APIs:
 *   1. Standard Developer API (Research/Display API) — public follower count,
 *      bio, video stats. Requires TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET.
 *      Endpoint: open.tiktokapis.com
 *   2. Commercial Content API — ad library data: active ads, estimated reach.
 *      Requires TIKTOK_COMMERCIAL_API_KEY (separate approval, ~2 day turnaround).
 *      Endpoint: business-api.tiktok.com/open_api/v1.3/research/adv/
 *
 * Both fail closed: when creds are missing, we return `notConfiguredResult`
 * which the Brand Card renders as a greyed-out "TikTok: not configured" pill.
 * No error toast, no surprises.
 *
 * Snapshots written when configured:
 *   - 'tiktok', 'follower_count'       (value_numeric)
 *   - 'tiktok', 'following_count'      (value_numeric)
 *   - 'tiktok', 'likes_count'          (value_numeric)
 *   - 'tiktok', 'video_count'          (value_numeric)
 *   - 'tiktok', 'is_verified'          (value_text 'true'/'false')
 *   - 'tiktok', 'bio'                  (value_text)
 *   - 'tiktok', 'engagement_rate'      (value_numeric, recent N videos)
 *   - 'tiktok', 'top_videos'           (value_json)
 *   - 'tiktok', 'has_active_ads'       (value_text 'true'/'false')
 *   - 'tiktok', 'ad_reach_estimate'    (value_text)
 *
 * Open question (V2): TikTok's auth flow is client-credentials OAuth2 with
 * scopes. We cache the access token in-memory; under cron load we may want
 * to persist it to a small `oauth_tokens` table. Punting until we have
 * real volume.
 */
import { getServerEnv, getFeatureFlags } from "@/lib/env";
import { notConfiguredResult, withFetcherRun, writeSnapshot, type FetcherRunCtx } from "./_base";
import type { FetcherResult, TikTokVideoSummary, TikTokAdSummary } from "@/lib/types";

export interface TikTokResult {
  handle: string;
  followerCount: number | null;
  followingCount: number | null;
  likesCount: number | null;
  videoCount: number | null;
  bio: string | null;
  isVerified: boolean | null;
  engagementRate: number | null;       // mean engagement (likes+comments+shares)/views over recent N videos
  topVideos: TikTokVideoSummary[];     // up to 5
  adSummary: TikTokAdSummary | null;   // null if ads API not configured
  capturedAt: string;
}

export interface TikTokOptions {
  brandId: string;
  handle: string;                      // without leading @
  videoSampleSize?: number;            // default 10
  triggerKind?: "manual" | "cron" | "on_demand";
}

// =========================================================================
// Auth token cache (in-memory, per-process)
// =========================================================================

interface CachedToken {
  token: string;
  expiresAt: number;
}
let _tokenCache: CachedToken | null = null;

async function getAccessToken(): Promise<string> {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000) {
    return _tokenCache.token;
  }
  const env = getServerEnv();
  if (!env.tiktokClientKey || !env.tiktokClientSecret) {
    throw new Error("TikTok client credentials not configured");
  }

  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: new URLSearchParams({
      client_key: env.tiktokClientKey,
      client_secret: env.tiktokClientSecret,
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`TikTok token endpoint returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  if (!body.access_token) {
    throw new Error(`TikTok token response missing access_token: ${JSON.stringify(body)}`);
  }
  _tokenCache = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 7200) * 1000,
  };
  return _tokenCache.token;
}

// =========================================================================
// Main entry
// =========================================================================

export async function fetchTikTok(opts: TikTokOptions): Promise<FetcherResult<TikTokResult>> {
  const flags = getFeatureFlags();
  if (!flags.tiktokEnabled) {
    return notConfiguredResult("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET missing");
  }

  const trigger = opts.triggerKind ?? "on_demand";
  const sampleSize = opts.videoSampleSize ?? 10;

  return withFetcherRun(
    {
      fetcherName: "tiktok",
      triggerKind: trigger,
      brandId: opts.brandId,
      metadata: { handle: opts.handle, sampleSize },
    },
    async (ctx: FetcherRunCtx): Promise<TikTokResult> => {
      const token = await getAccessToken();
      const handle = opts.handle.replace(/^@/, "");

      // ---- 1. User info (counts + bio + verified) ----
      const userInfo = await fetchUserInfo(token, handle);

      // ---- 2. Recent videos for engagement-rate calc ----
      let videos: TikTokVideoSummary[] = [];
      let engagementRate: number | null = null;
      try {
        videos = await fetchRecentVideos(token, handle, sampleSize);
        engagementRate = computeEngagementRate(videos);
      } catch (err) {
        // Videos endpoint sometimes 403s for accounts that haven't authorized
        // research API. Non-fatal — we still have follower count.
        console.warn(`[tiktok] video fetch failed for ${handle}: ${err}`);
      }

      // ---- 3. Ad presence (separate API, optional) ----
      let adSummary: TikTokAdSummary | null = null;
      if (flags.tiktokAdsEnabled) {
        try {
          adSummary = await fetchAdSummary(handle);
        } catch (err) {
          console.warn(`[tiktok] ad summary failed for ${handle}: ${err}`);
        }
      }

      // ---- 4. Persist snapshots ----
      const snaps: Promise<void>[] = [];
      const profileUrl = `https://www.tiktok.com/@${handle}`;

      if (userInfo.followerCount != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "follower_count",
          valueNumeric: userInfo.followerCount, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (userInfo.followingCount != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "following_count",
          valueNumeric: userInfo.followingCount, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (userInfo.likesCount != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "likes_count",
          valueNumeric: userInfo.likesCount, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (userInfo.videoCount != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "video_count",
          valueNumeric: userInfo.videoCount, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (userInfo.bio) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "bio",
          valueText: userInfo.bio, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (userInfo.isVerified != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "is_verified",
          valueText: userInfo.isVerified ? "true" : "false", sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (engagementRate != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "engagement_rate",
          valueNumeric: engagementRate, valueJson: { sampleSize: videos.length },
          sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (videos.length > 0) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "top_videos",
          valueJson: { videos: videos.slice(0, 5) },
          sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (adSummary) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "tiktok", metric: "has_active_ads",
          valueText: adSummary.hasActiveAds ? "true" : "false",
          valueJson: adSummary as unknown as Record<string, unknown>,
          fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }

      await Promise.all(snaps);

      return {
        handle,
        followerCount: userInfo.followerCount,
        followingCount: userInfo.followingCount,
        likesCount: userInfo.likesCount,
        videoCount: userInfo.videoCount,
        bio: userInfo.bio,
        isVerified: userInfo.isVerified,
        engagementRate,
        topVideos: videos.slice(0, 5),
        adSummary,
        capturedAt: new Date().toISOString(),
      };
    }
  );
}

// =========================================================================
// API calls
// =========================================================================

interface UserInfo {
  followerCount: number | null;
  followingCount: number | null;
  likesCount: number | null;
  videoCount: number | null;
  bio: string | null;
  isVerified: boolean | null;
}

async function fetchUserInfo(token: string, handle: string): Promise<UserInfo> {
  // TikTok Research API: POST /v2/research/user/info/
  // Returns user_info object keyed by username.
  // Fields list per TikTok docs; we request the maximum we're likely approved for.
  const fields = [
    "display_name", "bio_description", "is_verified",
    "follower_count", "following_count", "likes_count", "video_count",
  ].join(",");

  const url = `https://open.tiktokapis.com/v2/research/user/info/?fields=${fields}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username: handle }),
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 404) {
    throw new Error(`TikTok user @${handle} not found`);
  }
  if (!res.ok) {
    throw new Error(`TikTok user/info returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const data = body?.data ?? body;
  return {
    followerCount: data.follower_count ?? null,
    followingCount: data.following_count ?? null,
    likesCount: data.likes_count ?? null,
    videoCount: data.video_count ?? null,
    bio: data.bio_description ?? null,
    isVerified: data.is_verified ?? null,
  };
}

async function fetchRecentVideos(token: string, handle: string, count: number): Promise<TikTokVideoSummary[]> {
  // POST /v2/research/video/query/ — returns recent videos for a username.
  const url = "https://open.tiktokapis.com/v2/research/video/query/?fields=" +
    ["id", "create_time", "view_count", "like_count", "share_count", "comment_count"].join(",");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: { and: [{ operation: "EQ", field_name: "username", field_values: [handle] }] },
      max_count: count,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`TikTok video/query returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const videos: Array<Record<string, unknown>> = body?.data?.videos ?? [];

  return videos.map((v) => ({
    id: String(v.id ?? ""),
    url: v.id ? `https://www.tiktok.com/@${handle}/video/${v.id}` : undefined,
    views: Number(v.view_count ?? 0),
    likes: Number(v.like_count ?? 0),
    shares: Number(v.share_count ?? 0),
    comments: Number(v.comment_count ?? 0),
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
  return totalEngagements / totalViews;       // 0..1 ratio (multiply by 100 for %)
}

async function fetchAdSummary(handle: string): Promise<TikTokAdSummary> {
  const env = getServerEnv();
  if (!env.tiktokCommercialApiKey) {
    throw new Error("TikTok Commercial Content API key not configured");
  }

  // TikTok Commercial Content API: GET /open_api/v1.3/research/adv/...
  // The exact endpoint and response shape depend on approved scope.
  // Stubbed to a reasonable shape until we have real credentials in hand
  // to verify the response format. When you get approval, replace the
  // body below with the real call — the function contract is stable.
  const url = `https://business-api.tiktok.com/open_api/v1.3/research/adv/commercial_content/search/?advertiser_business_id=&query=${encodeURIComponent(handle)}`;

  const res = await fetch(url, {
    headers: {
      "Access-Token": env.tiktokCommercialApiKey,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`TikTok Commercial API returned ${res.status}`);
  }
  const body = await res.json();
  const ads: unknown[] = body?.data?.materials ?? [];

  return {
    hasActiveAds: ads.length > 0,
    adCount: ads.length,
    estimatedReach: undefined,         // populate from response once API surface is confirmed
  };
}
