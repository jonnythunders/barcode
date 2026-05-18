/**
 * Reddit fetcher — community signal layer.
 *
 * Strategy:
 *   1. Search across Reddit (and optionally specific subreddits if the
 *      brand's primary category has subreddit seeds) for mentions of the
 *      brand name in the past N days.
 *   2. Count mentions, identify top threads, compute velocity vs. the prior
 *      window.
 *
 * Using snoowrap (PRAW's Node equivalent). Script-type Reddit apps get
 * instant approval — this is the fastest fetcher to enable.
 *
 * Note: snoowrap's types are loose, so we narrow at the boundary. Each
 * response from Reddit is documented at reddit.com/dev/api.
 *
 * Snapshots written when configured:
 *   - 'reddit', 'mention_count_30d'   (value_numeric)
 *   - 'reddit', 'mention_velocity'    (value_numeric, this_window/prior_window - 1)
 *   - 'reddit', 'top_threads'         (value_json)
 */
import Snoowrap from "snoowrap";
import { getServerEnv, getFeatureFlags } from "@/lib/env";
import { notConfiguredResult, withFetcherRun, writeSnapshot, type FetcherRunCtx } from "./_base";
import type { FetcherResult, RedditThreadSummary } from "@/lib/types";

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
// snoowrap client (lazy singleton)
// =========================================================================

let _client: Snoowrap | null = null;

function getRedditClient(): Snoowrap {
  if (_client) return _client;
  const env = getServerEnv();
  if (!env.redditClientId || !env.redditClientSecret || !env.redditUsername || !env.redditPassword) {
    throw new Error("Reddit credentials not configured");
  }
  _client = new Snoowrap({
    userAgent: env.redditUserAgent,
    clientId: env.redditClientId,
    clientSecret: env.redditClientSecret,
    username: env.redditUsername,
    password: env.redditPassword,
  });
  _client.config({ requestDelay: 1000, continueAfterRatelimitError: true });
  return _client;
}

// =========================================================================
// Main entry
// =========================================================================

export async function fetchReddit(opts: RedditOptions): Promise<FetcherResult<RedditResult>> {
  const flags = getFeatureFlags();
  if (!flags.redditEnabled) {
    return notConfiguredResult("Reddit credentials missing");
  }

  const trigger = opts.triggerKind ?? "on_demand";
  const windowDays = opts.windowDays ?? 30;
  const topLimit = opts.topThreadsLimit ?? 5;

  return withFetcherRun(
    {
      fetcherName: "reddit",
      triggerKind: trigger,
      brandId: opts.brandId,
      metadata: { brandName: opts.brandName, windowDays, subreddits: opts.subreddits },
    },
    async (ctx: FetcherRunCtx): Promise<RedditResult> => {
      const client = getRedditClient();
      const nowSec = Math.floor(Date.now() / 1000);
      const windowStartSec = nowSec - windowDays * 24 * 60 * 60;
      const priorStartSec = nowSec - 2 * windowDays * 24 * 60 * 60;

      const subs = opts.subreddits ?? [];
      const query = `"${opts.brandName}"`;
      let allResults: Snoowrap.Submission[] = [];

      if (subs.length === 0) {
        // Site-wide search
        const res = await client
          .search({ query, time: "month", sort: "new", limit: 100 })
          .then((r) => r as unknown as Snoowrap.Submission[]);
        allResults = res;
      } else {
        // Per-subreddit search — restrictSr is implied when calling
        // .getSubreddit(sub).search(), so we omit it to satisfy the type.
        const seen = new Set<string>();
        for (const sub of subs) {
          try {
            const res = await client
              .getSubreddit(sub)
              .search({ query, time: "month", sort: "new", limit: 50 })
              .then((r) => r as unknown as Snoowrap.Submission[]);
            for (const r of res) {
              if (!seen.has(r.id)) {
                seen.add(r.id);
                allResults.push(r);
              }
            }
          } catch (err) {
            console.warn(`[reddit] search in r/${sub} failed: ${err}`);
          }
        }
      }

      // Bucket by time window
      const inWindow: Snoowrap.Submission[] = [];
      const inPriorWindow: Snoowrap.Submission[] = [];
      for (const s of allResults) {
        const t = s.created_utc;
        if (t >= windowStartSec) inWindow.push(s);
        else if (t >= priorStartSec) inPriorWindow.push(s);
      }

      const velocity =
        inPriorWindow.length > 0
          ? (inWindow.length - inPriorWindow.length) / inPriorWindow.length
          : null;

      const topThreads: RedditThreadSummary[] = inWindow
        .sort((a, b) => b.score - a.score)
        .slice(0, topLimit)
        .map((s) => ({
          title: s.title,
          subreddit: s.subreddit?.display_name ?? "",
          upvotes: s.score,
          commentCount: s.num_comments,
          url: `https://www.reddit.com${s.permalink}`,
          postedAt: new Date(s.created_utc * 1000).toISOString(),
        }));

      const snaps: Promise<void>[] = [
        writeSnapshot({
          brandId: opts.brandId,
          platform: "reddit",
          metric: "mention_count_30d",
          valueNumeric: inWindow.length,
          valueJson: { windowDays, query, subreddits: subs },
          fetcherRunId: ctx.runId,
        }),
      ];
      ctx.snapshotsWritten++;

      if (velocity != null) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId,
          platform: "reddit",
          metric: "mention_velocity",
          valueNumeric: velocity,
          valueJson: { thisWindow: inWindow.length, priorWindow: inPriorWindow.length },
          fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }

      if (topThreads.length > 0) {
        snaps.push(writeSnapshot({
          brandId: opts.brandId,
          platform: "reddit",
          metric: "top_threads",
          valueJson: { threads: topThreads },
          fetcherRunId: ctx.runId,
        }));
        ctx.snapshotsWritten++;
      }
      await Promise.all(snaps);

      return {
        brandName: opts.brandName,
        windowDays,
        mentionCount: inWindow.length,
        priorMentionCount: inPriorWindow.length,
        velocity,
        topThreads,
        subredditsSearched: subs,
        capturedAt: new Date().toISOString(),
      };
    }
  );
}

export async function fetchRedditCommentSample(
  threadUrls: string[],
  maxCommentsPerThread: number = 20
): Promise<{ threadUrl: string; comments: string[] }[]> {
  const client = getRedditClient();
  const out: { threadUrl: string; comments: string[] }[] = [];

  for (const url of threadUrls) {
    try {
      const m = /\/comments\/([a-z0-9]+)\//i.exec(url);
      if (!m) continue;
      const submission = client.getSubmission(m[1]);
      const comments = await submission
        .fetch()
        .then((sub) => sub.comments as unknown as Snoowrap.Comment[]);
      const sample = comments
        .filter((c) => typeof c.body === "string" && c.body.length > 10)
        .slice(0, maxCommentsPerThread)
        .map((c) => c.body);
      out.push({ threadUrl: url, comments: sample });
    } catch (err) {
      console.warn(`[reddit] comment fetch failed for ${url}: ${err}`);
    }
  }
  return out;
}
