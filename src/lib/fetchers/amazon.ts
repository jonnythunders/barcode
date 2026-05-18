/**
 * Amazon public product page scraper.
 *
 * Strategy:
 *   1. Hit the search results page for a brand name (no auth, no JS needed).
 *   2. From the top organic result, extract the ASIN and brand name.
 *   3. Hit the product detail page directly.
 *   4. Parse star rating, review count, BSR rank, "X bought in past month",
 *      product title, and detail-page URL.
 *
 * We DON'T use Playwright here for V1 because Amazon renders all the fields
 * we care about server-side, into the initial HTML. Plain HTTP + regex is
 * faster (no browser launch) and simpler to debug. If bot-detection becomes
 * a real problem, the upgrade path is:
 *   - swap `fetch` for a Playwright `page.goto()` that handles cookies/JS
 *   - or swap to a paid scraper API (Rainforest, ScraperAPI, Bright Data)
 *
 * Snapshots written:
 *   - platform='amazon', metric='star_rating'           (value_numeric: 0-5)
 *   - platform='amazon', metric='review_count'          (value_numeric)
 *   - platform='amazon', metric='bsr_rank'              (value_numeric, with value_text=category)
 *   - platform='amazon', metric='bought_past_month'     (value_text: badge text)
 *   - platform='amazon', metric='product_title'         (value_text)
 *
 * Failure modes:
 *   - Amazon may serve a CAPTCHA / "Enter the characters" page. We detect
 *     this (the page contains "Type the characters you see") and surface as
 *     a specific error so the caller can decide whether to retry.
 *   - Search may return no organic results. We return `not_found`.
 *   - Brand-name mismatch: search for "Vacation" finds vacation packages, not
 *     the sunscreen brand. We score candidates by brand-name overlap and
 *     require a minimum match score (configurable). Below threshold = not_found.
 */
import { withFetcherRun, writeSnapshot, type FetcherRunCtx } from "./_base";
import type { FetcherResult } from "@/lib/types";

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const COMMON_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

export interface AmazonResult {
  asin: string;
  brand: string | null;            // brand as listed on the page (may differ from query)
  productTitle: string;
  productUrl: string;
  starRating: number | null;       // 0-5
  reviewCount: number | null;
  bsrRank: number | null;          // rank within bsrCategory
  bsrCategory: string | null;
  boughtPastMonth: string | null;  // e.g. "1K+", "100+", "10K+"
  capturedAt: string;
}

export interface AmazonOptions {
  brandId: string;
  brandName: string;               // what to search for
  // Optional: known ASIN to skip the search step
  knownAsin?: string;
  // Minimum required overlap between brand name query and the candidate's
  // brand field. 0.0–1.0 (default 0.4 = >=40% of query tokens appear in brand).
  minBrandMatchScore?: number;
  triggerKind?: "manual" | "cron" | "on_demand";
}

export async function fetchAmazon(opts: AmazonOptions): Promise<FetcherResult<AmazonResult>> {
  const trigger = opts.triggerKind ?? "on_demand";
  const minMatch = opts.minBrandMatchScore ?? 0.4;

  return withFetcherRun(
    {
      fetcherName: "amazon",
      triggerKind: trigger,
      brandId: opts.brandId,
      metadata: { brandName: opts.brandName, knownAsin: opts.knownAsin },
    },
    async (ctx: FetcherRunCtx): Promise<AmazonResult> => {
      // Step 1: resolve an ASIN to fetch.
      let asin = opts.knownAsin;
      let resolvedBrand: string | null = null;
      let resolvedTitle = "";

      if (!asin) {
        const candidate = await searchForBestCandidate(opts.brandName, minMatch);
        asin = candidate.asin;
        resolvedBrand = candidate.brand;
        resolvedTitle = candidate.title;
      }

      // Step 2: fetch the product detail page
      const productUrl = `https://www.amazon.com/dp/${asin}`;
      const html = await fetchHtml(productUrl);

      // Step 3: parse the fields
      const starRating = parseStarRating(html);
      const reviewCount = parseReviewCount(html);
      const bsr = parseBsrRank(html);
      const boughtPastMonth = parseBoughtPastMonth(html);
      // Title and brand may already come from search; if not, parse from detail page.
      const productTitle = resolvedTitle || parseProductTitle(html) || "";
      const brand = resolvedBrand ?? parseBrand(html);

      // Step 4: persist snapshots (only for fields we actually parsed)
      const snapshotPromises: Promise<void>[] = [];
      if (starRating != null) {
        snapshotPromises.push(
          writeSnapshot({
            brandId: opts.brandId,
            platform: "amazon",
            metric: "star_rating",
            valueNumeric: starRating,
            sourceUrl: productUrl,
            fetcherRunId: ctx.runId,
          })
        );
        ctx.snapshotsWritten++;
      }
      if (reviewCount != null) {
        snapshotPromises.push(
          writeSnapshot({
            brandId: opts.brandId,
            platform: "amazon",
            metric: "review_count",
            valueNumeric: reviewCount,
            sourceUrl: productUrl,
            fetcherRunId: ctx.runId,
          })
        );
        ctx.snapshotsWritten++;
      }
      if (bsr && bsr.rank != null) {
        snapshotPromises.push(
          writeSnapshot({
            brandId: opts.brandId,
            platform: "amazon",
            metric: "bsr_rank",
            valueNumeric: bsr.rank,
            valueText: bsr.category,
            sourceUrl: productUrl,
            fetcherRunId: ctx.runId,
          })
        );
        ctx.snapshotsWritten++;
      }
      if (boughtPastMonth) {
        snapshotPromises.push(
          writeSnapshot({
            brandId: opts.brandId,
            platform: "amazon",
            metric: "bought_past_month",
            valueText: boughtPastMonth,
            sourceUrl: productUrl,
            fetcherRunId: ctx.runId,
          })
        );
        ctx.snapshotsWritten++;
      }
      if (productTitle) {
        snapshotPromises.push(
          writeSnapshot({
            brandId: opts.brandId,
            platform: "amazon",
            metric: "product_title",
            valueText: productTitle,
            sourceUrl: productUrl,
            fetcherRunId: ctx.runId,
          })
        );
        ctx.snapshotsWritten++;
      }
      await Promise.all(snapshotPromises);

      return {
        asin,
        brand,
        productTitle,
        productUrl,
        starRating,
        reviewCount,
        bsrRank: bsr?.rank ?? null,
        bsrCategory: bsr?.category ?? null,
        boughtPastMonth,
        capturedAt: new Date().toISOString(),
      };
    }
  );
}

// =========================================================================
// HTTP helper
// =========================================================================

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": pickUserAgent(), ...COMMON_HEADERS },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Amazon returned ${res.status} for ${url}`);
  }
  const html = await res.text();

  // Detect Amazon's bot-check page. Several variants of the same wording exist.
  const isCaptcha =
    /Type the characters you see/i.test(html) ||
    /To discuss automated access to Amazon data/i.test(html) ||
    /Robot Check/i.test(html);
  if (isCaptcha) {
    throw new Error("amazon_captcha: Amazon served a bot-check page (rotate IP/UA or use a paid scraper API)");
  }

  return html;
}

// =========================================================================
// Search → best candidate
// =========================================================================

interface SearchCandidate {
  asin: string;
  brand: string | null;
  title: string;
  matchScore: number;
}

async function searchForBestCandidate(brandName: string, minMatch: number): Promise<SearchCandidate> {
  const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(brandName)}`;
  const html = await fetchHtml(searchUrl);

  // Each organic result is wrapped in <div data-component-type="s-search-result" data-asin="XXXX">.
  // We pull all of them and score by brand-name overlap.
  const results: SearchCandidate[] = [];
  const resultRe = /<div[^>]+data-component-type="s-search-result"[^>]+data-asin="([A-Z0-9]{10})"[^>]*>([\s\S]*?)(?=<div[^>]+data-component-type="s-search-result"|<\/div>\s*<div[^>]+data-component-type="sp-sponsored-result")/gi;

  let m: RegExpExecArray | null;
  while ((m = resultRe.exec(html)) !== null) {
    const asin = m[1];
    const block = m[2];

    // Title: typically inside an <h2><a><span>Title</span></a></h2>
    const titleMatch = /<h2[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i.exec(block);
    const title = titleMatch?.[1]?.trim() ?? "";

    // Brand: not always present in search snippet; we fall back to the
    // first chunk of the title (Amazon often leads with brand name).
    const brand = inferBrandFromTitle(title);

    const matchScore = brandMatchScore(brandName, title, brand);

    results.push({ asin, brand, title, matchScore });
  }

  if (results.length === 0) {
    throw new Error(`No Amazon search results for "${brandName}"`);
  }

  // Pick the highest-scoring candidate above threshold
  results.sort((a, b) => b.matchScore - a.matchScore);
  const best = results[0];
  if (best.matchScore < minMatch) {
    throw new Error(
      `No Amazon result strongly matches "${brandName}" (best score=${best.matchScore.toFixed(2)}, ` +
        `top result="${best.title.slice(0, 80)}"). Provide knownAsin to skip search.`
    );
  }
  return best;
}

/**
 * Score how well a query matches a candidate title + brand. 0–1 range.
 * Strategy: tokenize the query, count tokens that appear in the title or brand.
 * Robust to "Vacation Sunscreen" matching "Vacation Inc. Classic Whip SPF 30".
 */
function brandMatchScore(query: string, title: string, brand: string | null): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const haystack = (title + " " + (brand ?? "")).toLowerCase();
  let hits = 0;
  for (const t of queryTokens) {
    if (haystack.includes(t)) hits++;
  }
  return hits / queryTokens.length;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function inferBrandFromTitle(title: string): string | null {
  if (!title) return null;
  // Amazon titles usually lead with the brand, sometimes followed by a comma
  // or hyphen. "Vacation Classic Whip SPF 30 Sunscreen" -> "Vacation".
  // Take up to the first 3 leading capitalized words.
  const words = title.split(/\s+/).slice(0, 3);
  const leading: string[] = [];
  for (const w of words) {
    if (/^[A-Z]/.test(w)) leading.push(w);
    else break;
  }
  return leading.length > 0 ? leading.join(" ") : null;
}

// =========================================================================
// Detail page parsers
// =========================================================================

function parseStarRating(html: string): number | null {
  // Most stable selector: span with class "a-icon-alt" containing "X.X out of 5 stars"
  const m = /([0-5](?:\.\d)?)\s+out of 5 stars/i.exec(html);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseReviewCount(html: string): number | null {
  // Patterns:
  //   "2,847 ratings"
  //   "<span id=\"acrCustomerReviewText\">2,847 ratings</span>"
  //   "12,345 global ratings"
  const m = /([\d,]+)\s+(?:global\s+)?ratings?\b/i.exec(html);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseBsrRank(html: string): { rank: number; category: string } | null {
  // Pattern: "Best Sellers Rank: #3 in Sun Care" or
  //          "#3 in Sun Care (See Top 100 in Beauty & Personal Care)"
  // We take the FIRST (most specific) rank.
  const m = /#([\d,]+)\s+in\s+([^<(\n]+)/i.exec(html);
  if (!m) return null;
  const rank = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(rank)) return null;
  const category = m[2].trim().replace(/\s+/g, " ");
  return { rank, category };
}

function parseBoughtPastMonth(html: string): string | null {
  // Pattern: "1K+ bought in past month" or "100+ bought in past month"
  const m = /([0-9]+[KkMm]?\+?)\s+bought\s+in\s+past\s+month/i.exec(html);
  return m?.[1] ?? null;
}

function parseProductTitle(html: string): string | null {
  // <span id="productTitle">Title</span>
  const m = /<span[^>]+id="productTitle"[^>]*>([^<]+)</i.exec(html);
  return m?.[1]?.trim() ?? null;
}

function parseBrand(html: string): string | null {
  // Several patterns Amazon uses:
  //   <a id="bylineInfo" ...>Visit the Vacation Store</a>
  //   <a id="bylineInfo" ...>Brand: Vacation</a>
  const byline = /id="bylineInfo"[^>]*>([^<]+)</i.exec(html);
  if (byline) {
    const text = byline[1].trim();
    const visit = /^Visit the (.+?) Store$/i.exec(text);
    if (visit) return visit[1];
    const brandColon = /^Brand:\s*(.+)$/i.exec(text);
    if (brandColon) return brandColon[1];
    return text;
  }
  return null;
}
