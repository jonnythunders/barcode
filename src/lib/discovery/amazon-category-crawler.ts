/**
 * Amazon top-100 category crawler — PRD §5.1 Layer 2.
 *
 * Scrapes Amazon "Best Sellers" category pages to harvest the brand names
 * occupying top SKUs. We pull `amazon_category_urls` per category from the
 * DB; each URL points to something like:
 *   https://www.amazon.com/Best-Sellers-Health-Personal-Care-Sunscreens/zgbs/hpc/3761491
 *
 * For each URL:
 *   1. Fetch the HTML.
 *   2. Extract product blocks; each carries ASIN + title + (sometimes) brand.
 *   3. Infer brand name when not in a `byline` block (Amazon's title-leads-
 *      with-brand convention from amazon.ts works here too).
 *   4. Persist as discovery candidates.
 *
 * We DO NOT enrich each ASIN with a full product-page fetch here — that's
 * what the weekly poll does once the brand is in the system. Discovery
 * stays cheap and broad; enrichment is per-brand.
 *
 * Failure modes: same as amazon.ts (CAPTCHA detection).
 */
import { withFetcherRun, type FetcherRunCtx } from "@/lib/fetchers/_base";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { persistCandidates, filterPlausibleBrandNames, type DiscoveryCandidate, type DiscoveryResult } from "./_base";
import type { FetcherResult } from "@/lib/types";

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];
function pickUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

const MAX_BRANDS_PER_URL = 50;

export interface CrawlAmazonCategoryOptions {
  categoryId: string;
  urls?: string[];                  // override; otherwise pulled from DB
  triggerKind?: "manual" | "cron" | "on_demand";
}

export async function crawlAmazonCategoryForCategory(
  opts: CrawlAmazonCategoryOptions
): Promise<FetcherResult<DiscoveryResult>> {
  const trigger = opts.triggerKind ?? "cron";

  return withFetcherRun(
    {
      fetcherName: "discovery_amazon",
      triggerKind: trigger,
      categoryId: opts.categoryId,
      metadata: { urls: opts.urls },
    },
    async (ctx: FetcherRunCtx): Promise<DiscoveryResult> => {
      const db = getAdminSupabase();

      let urls = opts.urls;
      if (!urls) {
        const { data: cat } = await db
          .from("categories")
          .select("amazon_category_urls")
          .eq("id", opts.categoryId)
          .maybeSingle();
        if (!cat) throw new Error(`Category ${opts.categoryId} not found`);
        urls = (cat.amazon_category_urls as string[]) ?? [];
      }
      if (urls.length === 0) {
        return { newCount: 0, reActivatedCount: 0, skippedCount: 0, insertedBrandIds: [] };
      }

      const allCandidates: DiscoveryCandidate[] = [];
      for (const url of urls) {
        try {
          const brands = await extractBrandsFromCategoryPage(url);
          for (const b of brands.slice(0, MAX_BRANDS_PER_URL)) {
            allCandidates.push({
              name: b.brandName,
              amazonBrand: b.brandName,
              categoryId: opts.categoryId,
              sourceUrl: url,
              notes: `Discovered in Amazon top-100 (${b.productCount} SKU${b.productCount === 1 ? "" : "s"} in list)`,
            });
          }
        } catch (err) {
          console.warn(`[discovery/amazon] ${url} failed: ${err}`);
        }
      }

      const filtered = filterPlausibleBrandNames(allCandidates);
      const result = await persistCandidates(filtered, "amazon_top100");
      ctx.snapshotsWritten = result.newCount + result.reActivatedCount;
      return result;
    }
  );
}

// =========================================================================
// HTML extraction
// =========================================================================

interface BrandCount {
  brandName: string;
  productCount: number;     // how many SKUs in this list mention the brand
}

async function extractBrandsFromCategoryPage(url: string): Promise<BrandCount[]> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": pickUA(),
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Amazon category page returned ${res.status}`);
  }
  const html = await res.text();
  if (/Type the characters you see/i.test(html) || /Robot Check/i.test(html)) {
    throw new Error("amazon_captcha");
  }

  // Best-sellers list items typically appear in <div id="zg-ordered-list">
  // with each item in <div id="..."> containing the title and (sometimes)
  // brand byline. Title text is the most reliable harvest source — Amazon
  // titles almost always lead with the brand.
  //
  // We collect title strings, infer brand from each, and tally.
  const titles = extractProductTitles(html);
  const tally = new Map<string, number>();
  for (const t of titles) {
    const brand = inferBrandFromTitle(t);
    if (!brand) continue;
    tally.set(brand, (tally.get(brand) ?? 0) + 1);
  }
  // Sort by count desc
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([brandName, productCount]) => ({ brandName, productCount }));
}

function extractProductTitles(html: string): string[] {
  // Amazon's best-sellers list uses a few wrapping patterns; we look for
  // anchors whose text is the product title. The most reliable is the
  // `_cDEzb_p13n-sc-css-line-clamp-` class family Amazon uses on titles,
  // but classes rotate. Most-reliable signal: a span with line clamp inside
  // a product card. We grab span text inside `<a class="a-link-normal" ...>`.
  const titles: string[] = [];
  const re = /<a[^>]*class="[^"]*a-link-normal[^"]*"[^>]*>[\s\S]*?<span[^>]*>([^<]{15,200})<\/span>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const t = m[1].trim();
    if (t && !/^\$/.test(t)) titles.push(t);
  }
  return titles;
}

/**
 * Infer brand name from an Amazon product title.
 *
 * Strategy: Amazon titles almost always lead with the brand, often
 * separated from the rest by a comma, dash, or "—". Take the leading
 * capitalized run up to one of those, then strip generic prefixes like
 * "OFFICIAL".
 *
 *   "Vacation Classic Whip SPF 30 Sunscreen Mousse, 6 oz"
 *     → "Vacation"
 *
 *   "OLIPOP - A New Kind of Soda, Variety Pack (12 cans)"
 *     → "OLIPOP"
 *
 *   "Liquid Death Mountain Water, 100% Mountain Water, 16.9 oz Tallboys (12-Pack)"
 *     → "Liquid Death"
 */
function inferBrandFromTitle(title: string): string | null {
  // Take everything before the first delimiter that signals "this is
  // marketing copy, not brand."
  const trimmed = title.split(/[,—–:|]|\s-\s|\s\(/)[0].trim();
  if (!trimmed) return null;

  // Drop obvious noise prefixes
  const cleaned = trimmed
    .replace(/^\b(NEW|OFFICIAL|GENUINE|AUTHENTIC|FRESH)\b\s+/i, "")
    .trim();
  if (cleaned.length < 3 || cleaned.length > 50) return null;

  // Heuristic: take up to first 4 leading words that are Title-Case or ALL-CAPS.
  // Stop at the first lowercase-leading word.
  const words = cleaned.split(/\s+/);
  const leading: string[] = [];
  for (const w of words) {
    // Allow ampersands and apostrophes inside brand names
    if (/^[A-Z][\w'&.-]*$/.test(w) || /^[A-Z]{2,}$/.test(w)) {
      leading.push(w);
      if (leading.length >= 4) break;
    } else {
      break;
    }
  }
  if (leading.length === 0) return null;
  return leading.join(" ");
}
