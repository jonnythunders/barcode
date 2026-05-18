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
 *
 * The comment text from top threads is NOT stored here — that's handled
 * by the sentiment module which fetches comments lazily when needed.
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
  velocity: number | null;             // (this - prior) / prior; null if prior=0
  topThreads: RedditThreadSummary[];
  subredditsSearched: string[];
  capturedAt: string;
}

export interface RedditOptions {
  brandId: string;
  brandName: string;
  // Optional subreddit list to focus the search. If empty, we do a
  // site-wide search.
  subreddits?: string[];
  windowDays?: number;                 // default 30
  topThreadsLimit?: number;            // default 5
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
  // Be a good citizen — Reddit's API caps at 60 req/min for script apps.
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

      // We pull a generous limit and filter by timestamp client-side, because
      // Reddit's API doesn't accept date filters on search.
      let allResults: Snoowrap.Submission[] = [];

      if (subs.length === 0) {
        // Site-wide search
        const res = await client
          .search({ query, time: "month", sort: "new", limit: 100 })
          .then((r) => r as unknown as Snoowrap.Submission[]);
        allResults = res;
      } else {
        // Per-subreddit search, deduped by id
        const seen = new Set<string>();
        for (const sub of subs) {
          try {
            const res = await client
              .getSubreddit(sub)
              .search({ query, time: "month", sort: "new", restrictSr: true, limit: 50 })
              .then((r) => r as unknown as Snoowrap.Submission[]);
            for (const r of res) {
              if (!seen.has(r.id)) {
                seen.add(r.id);
                allResults.push(r);
              }
            }
          } catch (err) {
            // Subreddit might be banned/private/quarantined — skip it
            console.warn(`[reddit] search in r/${sub} failed: ${err}`);
          }
        }
      }

      // Bucket by time window. created_utc is in seconds.
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

      // Top threads by score
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

      // Persist snapshots
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

/**
 * Pull comment text from a list of thread URLs — used by the sentiment
 * module. We separate this from `fetchReddit` because comment fetching is
 * rate-limit-heavy and we only want to do it when sentiment is actually
 * being computed (not on every brand card refresh).
 */
export async function fetchRedditCommentSample(
  threadUrls: string[],
  maxCommentsPerThread: number = 20
): Promise<{ threadUrl: string; comments: string[] }[]> {
  const client = getRedditClient();
  const out: { threadUrl: string; comments: string[] }[] = [];

  for (const url of threadUrls) {
    // Convert permalink to submission id. snoowrap accepts full URL via getSubmission.
    try {
      // Extract submission id from URL: .../comments/{id}/...
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
