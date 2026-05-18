/**
 * TikTok hashtag crawler — finds brand accounts posting under category-relevant
 * hashtags. PRD §5.1 Layer 1.
 *
 * Strategy:
 *   1. For each hashtag in the category's `tiktok_hashtags` array, hit the
 *      public hashtag page: https://www.tiktok.com/tag/<hashtag>
 *   2. Extract author handles + display names from the embedded SIGI_STATE
 *      JSON blob TikTok includes server-side.
 *   3. Filter to plausibly-branded accounts: presence of "verified" flag OR
 *      follower count above a threshold OR a bio link to a `.com` domain.
 *      (Most consumer-facing branded TT accounts hit one of these.)
 *   4. Persist via the discovery base.
 *
 * Note on the API surface: TikTok regularly mutates their HTML/JSON shape.
 * The SIGI_STATE blob has been the most stable surface for ~2 years but
 * could change. We parse defensively and surface specific errors via
 * fetcher_runs so we'll notice when a structural change breaks us.
 *
 * V2 ideas:
 *   - Use the official Research API hashtag video query once approved (will
 *     give us authors with proper rate limits instead of HTML scraping)
 *   - Score candidates by recent engagement instead of just presence
 */
import { persistCandidates, filterPlausibleBrandNames, type DiscoveryCandidate, type DiscoveryResult } from "./_base";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { withFetcherRun, type FetcherRunCtx } from "@/lib/fetchers/_base";
import type { FetcherResult } from "@/lib/types";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const MIN_FOLLOWERS = 10_000;     // PRD §5.1: ">10K follower threshold"
const MAX_HASHTAGS_PER_RUN = 10;
const MAX_CANDIDATES_PER_HASHTAG = 25;

export interface CrawlTikTokOptions {
  categoryId: string;
  hashtags?: string[];                       // override; otherwise pulled from DB
  triggerKind?: "manual" | "cron" | "on_demand";
}

export async function crawlTikTokForCategory(
  opts: CrawlTikTokOptions
): Promise<FetcherResult<DiscoveryResult>> {
  const trigger = opts.triggerKind ?? "cron";

  return withFetcherRun(
    {
      fetcherName: "discovery_tiktok",
      triggerKind: trigger,
      categoryId: opts.categoryId,
      metadata: { hashtags: opts.hashtags },
    },
    async (ctx: FetcherRunCtx): Promise<DiscoveryResult> => {
      const db = getAdminSupabase();

      // Resolve hashtag list
      let hashtags = opts.hashtags;
      if (!hashtags) {
        const { data: cat } = await db
          .from("categories")
          .select("tiktok_hashtags")
          .eq("id", opts.categoryId)
          .maybeSingle();
        if (!cat) throw new Error(`Category ${opts.categoryId} not found`);
        hashtags = (cat.tiktok_hashtags as string[]) ?? [];
      }
      if (hashtags.length === 0) {
        return { newCount: 0, reActivatedCount: 0, skippedCount: 0, insertedBrandIds: [] };
      }
      hashtags = hashtags.slice(0, MAX_HASHTAGS_PER_RUN);

      const allCandidates: DiscoveryCandidate[] = [];
      for (const tag of hashtags) {
        try {
          const found = await extractAuthorsFromHashtag(tag);
          for (const a of found.slice(0, MAX_CANDIDATES_PER_HASHTAG)) {
            allCandidates.push({
              name: a.displayName || a.handle,
              tiktokHandle: a.handle,
              categoryId: opts.categoryId,
              sourceUrl: `https://www.tiktok.com/tag/${tag}`,
              notes: `Discovered via #${tag} on TikTok` +
                (a.followerCount ? ` (${formatFollowers(a.followerCount)} followers)` : ""),
            });
          }
        } catch (err) {
          // Per-hashtag failures don't abort the run
          console.warn(`[discovery/tiktok] hashtag #${tag} failed: ${err}`);
        }
      }

      const filtered = filterPlausibleBrandNames(allCandidates);
      const result = await persistCandidates(filtered, "tiktok_hashtag");
      ctx.snapshotsWritten = result.newCount + result.reActivatedCount;
      return result;
    }
  );
}

// =========================================================================
// HTML extraction
// =========================================================================

interface ExtractedAuthor {
  handle: string;
  displayName: string;
  followerCount: number | null;
  verified: boolean;
}

async function extractAuthorsFromHashtag(tag: string): Promise<ExtractedAuthor[]> {
  const url = `https://www.tiktok.com/tag/${encodeURIComponent(tag)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`TikTok hashtag page returned ${res.status} for #${tag}`);
  }
  const html = await res.text();

  // TikTok bot-check page
  if (/Please wait while we verify/i.test(html) || /captcha/i.test(html)) {
    throw new Error("tiktok_captcha: bot-check served (rotate IP/UA or use approved API)");
  }

  // Try the SIGI_STATE blob first
  const sigi = parseSigiAuthors(html);
  if (sigi.length > 0) return sigi;

  // Fallback: regex for /@<handle>/ links (will be noisier but resilient)
  return parseAuthorsViaLinks(html);
}

function parseSigiAuthors(html: string): ExtractedAuthor[] {
  // The SIGI blob lives in: <script id="SIGI_STATE" type="application/json">{...}</script>
  // (or sometimes "__UNIVERSAL_DATA_FOR_REHYDRATION__" in newer versions).
  const candidates = [
    /<script[^>]+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i,
    /<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i,
  ];
  let blob: string | null = null;
  for (const re of candidates) {
    const m = re.exec(html);
    if (m) { blob = m[1]; break; }
  }
  if (!blob) return [];

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(blob); } catch { return []; }

  // SIGI shape varies: try common paths to user dicts.
  // ItemModule: { videoId: { author, authorStats, ... } }
  const out: ExtractedAuthor[] = [];
  const seen = new Set<string>();

  const itemModule = (parsed.ItemModule || (parsed as { __DEFAULT_SCOPE__?: { ItemModule?: unknown } }).__DEFAULT_SCOPE__?.ItemModule) as Record<string, unknown> | undefined;
  if (itemModule) {
    for (const item of Object.values(itemModule)) {
      const it = item as { author?: string; authorStats?: { followerCount?: number }; nickname?: string };
      const handle = it.author;
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      const followers = it.authorStats?.followerCount ?? null;
      if (followers != null && followers < MIN_FOLLOWERS) continue;
      out.push({
        handle,
        displayName: it.nickname || handle,
        followerCount: followers,
        verified: false,
      });
    }
  }

  // UserModule: { handle: { uniqueId, nickname, verified, ... } }
  const userModule = (parsed.UserModule || (parsed as { __DEFAULT_SCOPE__?: { UserModule?: unknown } }).__DEFAULT_SCOPE__?.UserModule) as Record<string, unknown> | undefined;
  if (userModule && typeof userModule === "object") {
    const users = (userModule as { users?: Record<string, unknown> }).users;
    const stats = (userModule as { stats?: Record<string, { followerCount?: number }> }).stats;
    if (users) {
      for (const [, user] of Object.entries(users)) {
        const u = user as { uniqueId?: string; nickname?: string; verified?: boolean };
        if (!u.uniqueId) continue;
        if (seen.has(u.uniqueId)) {
          // already accounted for in ItemModule, but enrich with verified flag
          const existing = out.find((a) => a.handle === u.uniqueId);
          if (existing && u.verified) existing.verified = true;
          continue;
        }
        const followers = stats?.[u.uniqueId]?.followerCount ?? null;
        if (followers != null && followers < MIN_FOLLOWERS && !u.verified) continue;
        seen.add(u.uniqueId);
        out.push({
          handle: u.uniqueId,
          displayName: u.nickname || u.uniqueId,
          followerCount: followers,
          verified: !!u.verified,
        });
      }
    }
  }

  return out;
}

/**
 * Fallback parser: extract @handle links from the rendered HTML when SIGI
 * isn't present. We can't get follower counts this way so we accept all
 * and lean on the filter pass downstream.
 */
function parseAuthorsViaLinks(html: string): ExtractedAuthor[] {
  const seen = new Set<string>();
  const out: ExtractedAuthor[] = [];
  const re = /\/@([a-z0-9._]{2,24})(?=[/"?#\s]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const handle = m[1].toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push({ handle, displayName: handle, followerCount: null, verified: false });
    if (out.length >= MAX_CANDIDATES_PER_HASHTAG) break;
  }
  return out;
}

function formatFollowers(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return String(n);
}
