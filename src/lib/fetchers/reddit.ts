/**
 * Reddit fetcher — community signal layer (SociaVault-backed).
 *
 * Reddit's own commercial API is ~$12k/yr behind enterprise approval, so we
 * source Reddit the same way we source TikTok/Instagram: through SociaVault's
 * scraping API, reusing the credit pool we already pay for.
 *
 * Reddit is treated as a CONTEXT / CONFIDENCE signal, not a brand assessor:
 * it corroborates a brand the momentum model already likes ("the data likes
 * this brand AND there's genuine community buzz"), so it is pulled on a
 * gated/on-demand basis rather than for every brand on every poll (see
 * `shouldFetchReddit` in brand-card and the reddit_fetch_policy setting).
 *
 * Strategy:
 *   1. For each of the brand's category subreddits, search for the brand name
 *      sorted by `new` (so recency windowing is meaningful).
 *   2. Bucket results into the current N-day window and the prior N-day window
 *      by created_utc; mentions + velocity come from those buckets.
 *   3. Top threads = highest-scoring posts in the current window.
 *
 * IMPORTANT (learned from live testing): the search endpoint sorts by
 * relevance by default and will happily return posts from years ago, which
 * would wreck a "mentions in last 30d" count. We always pass sort=new AND
 * filter by created_utc client-side — never trust the server-side window.
 *
 * SociaVault endpoints used:
 *   GET /reddit/subreddit/search?subreddit={s}&query={q}&sort=new&time=year
 *   GET /reddit/post/comments?url={permalink}   (for sentiment sampling)
 *
 * Snapshots written when configured:
 *   - 'reddit', 'mention_count_30d'   (value_numeric)
 *   - 'reddit', 'mention_velocity'    (value_numeric, this/prior - 1)
 *   - 'reddit', 'top_threads'         (value_json)
 */
import { getServerEnv, getFeatureFlags } from "@/lib/env";
import { notConfiguredResult, withFetcherRun, writeSnapshot, type FetcherRunCtx } from "./_base";
import type { FetcherResult, RedditThreadSummary } from "@/lib/types";

const BASE_URL = "https://api.sociavault.com/v1/scrape";
const REQUEST_TIMEOUT_MS = 20_000;
export const REDDIT_SOURCE_LABEL = "Reddit (via SociaVault)";

export interface RedditResult {
  brandName: string;
  windowDays: number;
  mentionCount: number;
  priorMentionCount: number;
  velocity: number | null;
  topThreads: RedditThreadSummary[];
  subredditsSearched: string[];
  capturedAt: string;
}

export interface RedditOptions {
  brandId: string;
  brandName: string;
  subreddits?: string[];
  windowDays?: number;
  topThreadsLimit?: number;
  triggerKind?: "manual" | "cron" | "on_demand";
}

// =========================================================================
// Low-level SociaVault HTTP
// =========================================================================

interface RedditPostRaw {
  id?: string;
  author?: string;
  subreddit?: string;
  title?: string;
  score?: number;
  ups?: number;
  num_comments?: number;
  created_utc?: number;
  created_at_iso?: string;
  permalink?: string;
  url?: string;
}

interface RedditSearchEnvelope {
  success?: boolean;
  data?: {
    posts?: Record<string, RedditPostRaw> | RedditPostRaw[];
    cursor?: number;
  };
  credits_used?: number;
  error?: string;
}

interface RedditCommentRaw {
  body?: string;
  author?: string;
  score?: number;
}
interface RedditCommentsEnvelope {
  success?: boolean;
  data?: { comments?: Record<string, RedditCommentRaw> | RedditCommentRaw[] };
  error?: string;
}

async function svGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const env = getServerEnv();
  if (!env.sociavaultApiKey) throw new Error("SOCIAVAULT_API_KEY missing");
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "x-api-key": env.sociavaultApiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`sociavault ${path} returned ${res.status}`);
  const body = (await res.json()) as { success?: boolean; error?: string } & T;
  if (body.success === false || body.error) {
    throw new Error(`sociavault ${path}: ${body.error ?? "unknown error"}`);
  }
  return body;
}

/** Normalize the numeric-keyed-object OR array list shape SociaVault returns. */
function listValues<T>(v: Record<string, T> | T[] | undefined): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : Object.values(v);
}

// =========================================================================
// Main entry
// =========================================================================

export async function fetchReddit(opts: RedditOptions): Promise<FetcherResult<RedditResult>> {
  const flags = getFeatureFlags();
  if (!flags.redditEnabled) {
    return notConfiguredResult("Reddit not enabled (needs SociaVault key + reddit_fetch_policy != off)");
  }

  const trigger = opts.triggerKind ?? "on_demand";
  const windowDays = opts.windowDays ?? 30;
  const topLimit = opts.topThreadsLimit ?? 5;

  // Without category subreddits we have nothing to search — SociaVault's Reddit
  // search is subreddit-scoped (no site-wide search). Fall back to a small set
  // of broad subreddits so a brand with no category mapping still gets a signal.
  const subs = (opts.subreddits && opts.subreddits.length > 0)
    ? opts.subreddits
    : ["all"];

  return withFetcherRun(
    {
      fetcherName: "reddit",
      triggerKind: trigger,
      brandId: opts.brandId,
      metadata: { brandName: opts.brandName, windowDays, subreddits: subs, source: "sociavault" },
    },
    async (ctx: FetcherRunCtx): Promise<RedditResult> => {
      const nowSec = Math.floor(Date.now() / 1000);
      const windowStartSec = nowSec - windowDays * 24 * 60 * 60;
      const priorStartSec = nowSec - 2 * windowDays * 24 * 60 * 60;

      const query = opts.brandName;
      const seen = new Set<string>();
      const all: RedditPostRaw[] = [];

      for (const sub of subs) {
        try {
          const env = await svGet<RedditSearchEnvelope>("/reddit/subreddit/search", {
            subreddit: sub,
            query,
            sort: "new",     // recency-first so windowing is meaningful
            time: "year",    // cap server scan; we window precisely client-side
          });
          for (const p of listValues(env.data?.posts)) {
            if (p.id && !seen.has(p.id)) {
              seen.add(p.id);
              all.push(p);
            }
          }
        } catch (err) {
          console.warn(`[reddit] search in r/${sub} failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Bucket by window using created_utc (NEVER trust server-side recency).
      const inWindow: RedditPostRaw[] = [];
      const inPrior: RedditPostRaw[] = [];
      for (const p of all) {
        const t = p.created_utc ?? 0;
        if (t >= windowStartSec) inWindow.push(p);
        else if (t >= priorStartSec) inPrior.push(p);
      }

      const velocity =
        inPrior.length > 0 ? (inWindow.length - inPrior.length) / inPrior.length : null;

      const topThreads: RedditThreadSummary[] = inWindow
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, topLimit)
        .map((p) => ({
          title: p.title ?? "",
          subreddit: p.subreddit ?? "",
          upvotes: p.score ?? p.ups ?? 0,
          commentCount: p.num_comments ?? 0,
          url: p.permalink ? `https://www.reddit.com${p.permalink}` : (p.url ?? ""),
          postedAt: p.created_at_iso ?? (p.created_utc ? new Date(p.created_utc * 1000).toISOString() : ""),
        }));

      const snaps: Promise<void>[] = [
        writeSnapshot({
          brandId: opts.brandId, platform: "reddit", metric: "mention_count_30d",
          valueNumeric: inWindow.length,
          valueJson: { windowDays, query, subreddits: subs, source: "sociavault" },
          fetcherRunId: ctx.runId,
        }),
      ];
      ctx.snapshotsWritten++;

      if (velocity != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "reddit", metric: "mention_velocity",
          valueNumeric: velocity,
          valueJson: { thisWindow: inWindow.length, priorWindow: inPrior.length, source: "sociavault" },
          fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      if (topThreads.length > 0) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId, platform: "reddit", metric: "top_threads",
          valueJson: { threads: topThreads, source: "sociavault" },
          fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      await Promise.all(snaps);

      return {
        brandName: opts.brandName,
        windowDays,
        mentionCount: inWindow.length,
        priorMentionCount: inPrior.length,
        velocity,
        topThreads,
        subredditsSearched: subs,
        capturedAt: new Date().toISOString(),
      };
    }
  );
}

/**
 * Sample comments from a set of thread permalinks, for sentiment analysis.
 * Each thread costs 1 SociaVault credit, so callers should pass only the few
 * top threads. Returns plain comment bodies, filtering out automod/rules posts
 * and trivially short comments.
 */
export async function fetchRedditCommentSample(
  threadUrls: string[],
  maxCommentsPerThread: number = 20
): Promise<{ threadUrl: string; comments: string[] }[]> {
  const flags = getFeatureFlags();
  if (!flags.redditEnabled) return [];

  const out: { threadUrl: string; comments: string[] }[] = [];
  for (const url of threadUrls) {
    try {
      const env = await svGet<RedditCommentsEnvelope>("/reddit/post/comments", { url });
      const comments = listValues(env.data?.comments)
        .map((c) => (typeof c.body === "string" ? c.body : ""))
        .filter((b) => b.length > 15 && !/^Rules of r\//i.test(b) && !/this is an automated/i.test(b))
        .slice(0, maxCommentsPerThread);
      if (comments.length > 0) out.push({ threadUrl: url, comments });
    } catch (err) {
      console.warn(`[reddit] comment fetch failed for ${url}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return out;
}
