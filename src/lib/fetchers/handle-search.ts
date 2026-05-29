/**
 * Handle Search — resolve a brand name to its real social handles by SEARCHING
 * the platform, instead of guessing slug variants.
 *
 * Why this exists: the old resolver guessed handles from the brand name
 * ("Foo Bar" -> @foobar / @foo_bar / @foo) and handed the first guess to the
 * fetchers. That hit wrong or tiny accounts constantly (the manual-correction
 * grind). This module instead asks SociaVault's search endpoint "who matches
 * this brand name?" and scores the candidates so we only auto-accept a handle
 * we're actually confident in.
 *
 * Confidence model:
 *   - score >= AUTO_ACCEPT  -> "high"        (use it, persist to brands row)
 *   - score >= REVIEW_FLOOR -> "needs_review"(use it, but flag for human check)
 *   - below                 -> null          (honest "not configured" beats wrong)
 *
 * Cost: 1 SociaVault credit per search call. We search TikTok directly (the
 * one search shape we've confirmed). Instagram is resolved by VERIFYING
 * candidate handles against the /instagram/profile endpoint we already use,
 * which avoids depending on an unconfirmed IG-search response shape. If/when
 * you confirm the IG search shape from the SociaVault dashboard, drop it into
 * `searchInstagramHandle` the same way TikTok is done.
 */
import { getServerEnv, getFeatureFlags } from "@/lib/env";

const BASE_URL = "https://api.sociavault.com/v1/scrape";
const REQUEST_TIMEOUT_MS = 20_000;

// Scoring thresholds (0..1 scale). Tuned against live SociaVault results.
//   - A candidate must clear AUTO_ACCEPT AND beat the runner-up by AUTO_MARGIN
//     to be auto-applied. The margin gate is what makes this safe: for generic
//     or acronym names (BPN, ZOA) several unrelated popular accounts score
//     similarly, so a near-tie is sent to review instead of guessed.
//   - REVIEW_FLOOR..AUTO_ACCEPT (or a winner without enough margin) -> applied
//     for this fetch but flagged "needs_review".
//   - below REVIEW_FLOOR -> null. Honest "not configured" beats a wrong account.
const AUTO_ACCEPT = 0.70;
const AUTO_MARGIN = 0.20;
const REVIEW_FLOOR = 0.50;

export interface HandleCandidate {
  handle: string;
  displayName: string | null;
  followerCount: number | null;
  isVerified: boolean;
  score: number;
  scoreBreakdown: {
    nameSimilarity: number;
    verifiedBonus: number;
    followerBonus: number;
    exactSlugBonus: number;
  };
}

export interface HandleSearchResult {
  query: string;
  platform: "tiktok" | "instagram";
  best: HandleCandidate | null;
  confidence: "high" | "needs_review" | "unresolved";
  candidates: HandleCandidate[];
  creditsUsed: number;
  error?: string;
}

// =========================================================================
// Name normalization + similarity
// =========================================================================

/** Compact, lowercase, alnum-only form. "Dr. Squatch" -> "drsquatch". */
function compact(s: string): string {
  return s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
}

/** Token set form for word-overlap scoring. "Liquid Death" -> ["liquid","death"]. */
function tokens(s: string): string[] {
  return s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

/** Levenshtein distance, iterative, O(n*m). Small strings so cost is trivial. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Name similarity 0..1 between a brand name and a candidate (handle + display
 * name). We take the best of three signals:
 *   - compact-string edit-distance ratio (handles "drsquatch" vs "Dr. Squatch")
 *   - token overlap (handles word-order / partial matches)
 *   - containment (brand compact fully inside candidate compact or vice-versa)
 */
function nameSimilarity(brand: string, candidateHandle: string, candidateDisplay: string | null): number {
  const b = compact(brand);
  const cand = [candidateHandle, candidateDisplay ?? ""].map(compact).filter(Boolean);
  if (b.length === 0 || cand.length === 0) return 0;

  let best = 0;
  for (const c of cand) {
    // Edit-distance ratio.
    const dist = levenshtein(b, c);
    const editRatio = 1 - dist / Math.max(b.length, c.length);

    // Containment: brand fully inside candidate (e.g. "based" in "basedbody").
    const contains = c.includes(b) || b.includes(c) ? 0.85 : 0;

    best = Math.max(best, editRatio, contains);
  }

  // Token overlap on the display name (word-level).
  const bTok = new Set(tokens(brand));
  const dTok = tokens(candidateDisplay ?? candidateHandle);
  if (bTok.size > 0 && dTok.length > 0) {
    const overlap = dTok.filter((t) => bTok.has(t)).length / bTok.size;
    best = Math.max(best, overlap);
  }
  return Math.min(1, best);
}

/** Follower CREDIBILITY 0..1 — a gate, not a small bonus. A strong name match
 *  with trivial followers is almost always a squatter/fan account, so it gets
 *  multiplied down hard. Real brand accounts nearly always clear ~5K+. */
function followerCredibility(followers: number | null): number {
  if (!followers || followers <= 0) return 0;
  if (followers < 1_000) return 0.15;     // almost certainly not the brand
  if (followers < 10_000) return 0.55;    // plausible small/emerging brand
  if (followers < 100_000) return 0.85;   // solid
  return 1.0;                             // clearly established
}

function scoreCandidate(brand: string, c: { handle: string; displayName: string | null; followerCount: number | null; isVerified: boolean }): HandleCandidate {
  const nameSim = nameSimilarity(brand, c.handle, c.displayName);
  const credibility = followerCredibility(c.followerCount);
  const verified = c.isVerified ? 0.10 : 0;
  const exactSlug = compact(brand) === compact(c.handle) ? 0.05 : 0;

  // Name similarity and follower credibility are MULTIPLICATIVE — BOTH must be
  // high. This is what kills the "@bpn with 36 followers" squatter (1.0 * 0.15
  // = 0.15) while keeping "@drinkspindrift 155K" (~0.85 * 1.0 = 0.85). Verified
  // and exact-slug are small additive nudges for tie-breaking only.
  const score = Math.min(1, nameSim * credibility + verified + exactSlug);

  return {
    handle: c.handle,
    displayName: c.displayName,
    followerCount: c.followerCount,
    isVerified: c.isVerified,
    score,
    scoreBreakdown: { nameSimilarity: nameSim, verifiedBonus: verified, followerBonus: credibility, exactSlugBonus: exactSlug },
  };
}

// =========================================================================
// SociaVault search HTTP
// =========================================================================

interface TikTokSearchUserInfo {
  unique_id?: string;
  nickname?: string;
  follower_count?: number;
  custom_verify?: string; // "Verified account" when verified, "" otherwise
  search_user_name?: string;
}
interface TikTokSearchEnvelope {
  success?: boolean;
  data?: {
    user_list?: Record<string, { user_info?: TikTokSearchUserInfo }> | Array<{ user_info?: TikTokSearchUserInfo }>;
  };
  credits_used?: number;
  error?: string;
}

async function svGet(path: string, params: Record<string, string>): Promise<unknown> {
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
  return res.json();
}

// =========================================================================
// TikTok handle search (confirmed endpoint shape)
// =========================================================================

export async function searchTikTokHandle(brandName: string): Promise<HandleSearchResult> {
  const flags = getFeatureFlags();
  if (!flags.sociaVaultEnabled) {
    return { query: brandName, platform: "tiktok", best: null, confidence: "unresolved", candidates: [], creditsUsed: 0, error: "SociaVault not configured" };
  }
  try {
    // NOTE: do NOT pass trim=true — it strips the user_list from the response.
    const raw = (await svGet("/tiktok/search/users", { query: brandName })) as TikTokSearchEnvelope;
    const listRaw = raw.data?.user_list ?? {};
    const entries = Array.isArray(listRaw) ? listRaw : Object.values(listRaw);
    const candidates = entries
      .map((e) => e?.user_info)
      .filter((u): u is TikTokSearchUserInfo => !!u && !!u.unique_id)
      .map((u) =>
        scoreCandidate(brandName, {
          handle: u.unique_id!,
          displayName: u.nickname ?? u.search_user_name ?? null,
          followerCount: u.follower_count ?? null,
          isVerified: !!u.custom_verify && u.custom_verify.length > 0,
        })
      )
      .sort((a, b) => b.score - a.score);

    return finalize(brandName, "tiktok", candidates, raw.credits_used ?? 1);
  } catch (err) {
    return { query: brandName, platform: "tiktok", best: null, confidence: "unresolved", candidates: [], creditsUsed: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// =========================================================================
// Instagram handle resolution by VERIFICATION
// =========================================================================

interface IgProfileEnvelope {
  success?: boolean;
  data?: Record<string, unknown> & { data?: { user?: Record<string, unknown> } };
  credits_used?: number;
}

/** Pull follower_count out of the (variably-shaped) IG profile envelope. */
function igFollowers(env: IgProfileEnvelope): number | null {
  const d = env.data as Record<string, unknown> | undefined;
  if (!d) return null;
  const nestedUser = (d["data"] as { user?: Record<string, unknown> } | undefined)?.user;
  const flat = d as Record<string, unknown>;
  const fc =
    (nestedUser?.["follower_count"] as number | undefined) ??
    (flat["follower_count"] as number | undefined) ??
    (flat["followers"] as number | undefined) ??
    null;
  return fc != null ? Number(fc) : null;
}
function igVerified(env: IgProfileEnvelope): boolean {
  const d = env.data as Record<string, unknown> | undefined;
  const nestedUser = (d?.["data"] as { user?: Record<string, unknown> } | undefined)?.user;
  return !!(nestedUser?.["is_verified"] ?? (d?.["is_verified"] as boolean | undefined));
}

/**
 * Resolve an Instagram handle by verifying candidate handles against the
 * /instagram/profile endpoint (confirmed working). We try, in order: the
 * TikTok handle we just resolved (brands very often share it), then compact
 * and dotted slug variants. The first that resolves with a real follower
 * count wins; among multiple resolving, the highest-follower one wins.
 *
 * Costs up to `maxProbes` credits. Defaults to 3 to bound credit burn.
 */
export async function searchInstagramHandle(
  brandName: string,
  seedHandles: string[] = [],
  maxProbes = 3
): Promise<HandleSearchResult> {
  const flags = getFeatureFlags();
  if (!flags.sociaVaultEnabled) {
    return { query: brandName, platform: "instagram", best: null, confidence: "unresolved", candidates: [], creditsUsed: 0, error: "SociaVault not configured" };
  }

  const slug = compact(brandName);
  const dotted = brandName.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
  const probeList = [...new Set([...seedHandles.map((h) => h.replace(/^@/, "")), slug, dotted].filter((h) => h && h.length >= 2))].slice(0, maxProbes);

  const candidates: HandleCandidate[] = [];
  let credits = 0;
  for (const handle of probeList) {
    try {
      const env = (await svGet("/instagram/profile", { handle })) as IgProfileEnvelope;
      credits++;
      const followers = igFollowers(env);
      if (followers == null) continue; // didn't resolve to a real profile
      candidates.push(
        scoreCandidate(brandName, { handle, displayName: null, followerCount: followers, isVerified: igVerified(env) })
      );
    } catch {
      credits++; // a probe still costs if it hit the API; 404s are caught here
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return finalize(brandName, "instagram", candidates, credits);
}

// =========================================================================
// Shared finalize
// =========================================================================

function finalize(query: string, platform: "tiktok" | "instagram", candidates: HandleCandidate[], creditsUsed: number): HandleSearchResult {
  const best = candidates[0] ?? null;
  const runnerUp = candidates[1]?.score ?? 0;
  const margin = best ? best.score - runnerUp : 0;

  // Auto-accept ("high") requires BOTH a strong absolute score AND a clear gap
  // over the runner-up. A near-tie (e.g. BPN: 0.85 vs 0.85, ZOA: 1.0 vs 1.0)
  // means the name is ambiguous, so we downgrade to needs_review rather than
  // guess. This is the safety gate that prevents wrong auto-assignment.
  let confidence: HandleSearchResult["confidence"];
  if (best == null || best.score < REVIEW_FLOOR) {
    confidence = "unresolved";
  } else if (best.score >= AUTO_ACCEPT && margin >= AUTO_MARGIN) {
    confidence = "high";
  } else {
    confidence = "needs_review";
  }
  return { query, platform, best: confidence === "unresolved" ? null : best, confidence, candidates, creditsUsed };
}

export const HANDLE_SEARCH_THRESHOLDS = { AUTO_ACCEPT, AUTO_MARGIN, REVIEW_FLOOR };
