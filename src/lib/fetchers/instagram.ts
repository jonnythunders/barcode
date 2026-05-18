/**
 * Instagram fetcher — Meta Business Discovery API.
 *
 * The Business Discovery API lets you query public Business/Creator IG
 * accounts BY USERNAME without the target account having to authorize you.
 * It returns follower_count, media_count, biography, profile_picture_url,
 * and a paginated `media` edge.
 *
 * Required: META_ACCESS_TOKEN (Page-scoped access token with
 * `instagram_basic` and `instagram_manage_insights` permissions on a Page
 * that owns a Business IG account). The IG account doing the querying is
 * the "caller IG user id"; the queried account is identified by username.
 *
 * Note: Business Discovery does NOT work on personal accounts. If a brand
 * still has a personal IG, we'll get a useful error from Meta and surface
 * it as 'not_found' to the caller, who can fall back to public scraping
 * later or prompt the brand to convert.
 *
 * Snapshots written when configured:
 *   - 'instagram', 'follower_count'  (value_numeric)
 *   - 'instagram', 'media_count'     (value_numeric)
 *   - 'instagram', 'bio'             (value_text)
 *
 * Trend lines: follower_count over time is the entire point. Once we're
 * polling weekly, the system computes growth rates from the snapshot
 * history — Meta doesn't give us historicals, we have to build our own.
 */
import { getServerEnv, getFeatureFlags } from "@/lib/env";
import { notConfiguredResult, withFetcherRun, writeSnapshot, type FetcherRunCtx } from "./_base";
import type { FetcherResult } from "@/lib/types";
import { getAdminSupabase } from "@/lib/supabase-admin";

export interface InstagramResult {
  handle: string;
  followerCount: number | null;
  mediaCount: number | null;
  bio: string | null;
  profilePictureUrl: string | null;
  capturedAt: string;
}

export interface InstagramOptions {
  brandId: string;
  handle: string;                      // without leading @
  // The caller's IG Business User ID. Required by Meta's API. We resolve it
  // once per process from the access token, then cache.
  callerIgUserId?: string;
  triggerKind?: "manual" | "cron" | "on_demand";
}

// =========================================================================
// Caller IG user id — resolved on first call, cached in-memory
// =========================================================================

let _callerIgUserId: string | null = null;

async function resolveCallerIgUserId(accessToken: string): Promise<string> {
  if (_callerIgUserId) return _callerIgUserId;

  // Look up the Pages this token has access to, find one with an attached IG
  // Business account. Walks: GET /me/accounts → pick first page with
  // instagram_business_account field.
  const res = await fetch(
    `https://graph.facebook.com/v21.0/me/accounts?fields=instagram_business_account&access_token=${accessToken}`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (!res.ok) {
    throw new Error(`Meta /me/accounts returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const pages: Array<{ instagram_business_account?: { id: string } }> = body?.data ?? [];
  for (const p of pages) {
    if (p.instagram_business_account?.id) {
      _callerIgUserId = p.instagram_business_account.id;
      return _callerIgUserId;
    }
  }
  throw new Error("No Instagram Business account found on any Page accessible to this token");
}

// =========================================================================
// Main entry
// =========================================================================

export async function fetchInstagram(opts: InstagramOptions): Promise<FetcherResult<InstagramResult>> {
  const flags = getFeatureFlags();
  if (!flags.instagramEnabled) {
    return notConfiguredResult("META_ACCESS_TOKEN missing");
  }

  const trigger = opts.triggerKind ?? "on_demand";

  return withFetcherRun(
    {
      fetcherName: "instagram",
      triggerKind: trigger,
      brandId: opts.brandId,
      metadata: { handle: opts.handle },
    },
    async (ctx: FetcherRunCtx): Promise<InstagramResult> => {
      const env = getServerEnv();
      const accessToken = env.metaAccessToken!;
      const handle = opts.handle.replace(/^@/, "");

      const callerId = opts.callerIgUserId ?? (await resolveCallerIgUserId(accessToken));

      // GET /{ig-user-id}?fields=business_discovery.username({target}){followers_count,media_count,biography,profile_picture_url}
      const fields = "business_discovery.username(" + handle + "){followers_count,media_count,biography,profile_picture_url,username}";
      const url = `https://graph.facebook.com/v21.0/${callerId}?fields=${encodeURIComponent(fields)}&access_token=${accessToken}`;

      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

      if (res.status === 400) {
        // Most common 400: account not a Business/Creator account, or doesn't exist
        const body = await res.text();
        if (/does not exist|cannot be found|not a business/i.test(body)) {
          throw new Error(`Instagram @${handle} not found or not a Business/Creator account`);
        }
        throw new Error(`Meta Business Discovery 400: ${body}`);
      }
      if (!res.ok) {
        throw new Error(`Meta Business Discovery returned ${res.status}: ${await res.text()}`);
      }

      const body = await res.json();
      const bd = body?.business_discovery;
      if (!bd) {
        throw new Error(`Instagram @${handle}: no business_discovery payload (account may be personal)`);
      }

      const profileUrl = `https://www.instagram.com/${handle}/`;
      const snaps: Promise<void>[] = [];

      if (typeof bd.followers_count === "number") {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "instagram", metric: "follower_count",
          valueNumeric: bd.followers_count, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (typeof bd.media_count === "number") {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "instagram", metric: "media_count",
          valueNumeric: bd.media_count, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (bd.biography) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "instagram", metric: "bio",
          valueText: bd.biography, sourceUrl: profileUrl, fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      await Promise.all(snaps);

      return {
        handle,
        followerCount: bd.followers_count ?? null,
        mediaCount: bd.media_count ?? null,
        bio: bd.biography ?? null,
        profilePictureUrl: bd.profile_picture_url ?? null,
        capturedAt: new Date().toISOString(),
      };
    }
  );
}

/**
 * Helper: pull the follower-count time series for a brand from `snapshots`.
 * Used by the Brand Card to render the IG growth trend line — since Meta
 * doesn't give us history, we ARE the source of truth.
 */
export async function getInstagramFollowerTrend(brandId: string, lookbackDays: number = 90): Promise<{ date: string; value: number }[]> {
  const db = getAdminSupabase();
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("snapshots")
    .select("captured_at,value_numeric")
    .eq("brand_id", brandId)
    .eq("platform", "instagram")
    .eq("metric", "follower_count")
    .gte("captured_at", since)
    .order("captured_at", { ascending: true });
  if (error) throw new Error(`getInstagramFollowerTrend: ${error.message}`);
  return (data ?? [])
    .filter((r: { value_numeric: number | null }) => r.value_numeric != null)
    .map((r: { captured_at: string; value_numeric: number }) => ({
      date: r.captured_at,
      value: r.value_numeric,
    }));
}
