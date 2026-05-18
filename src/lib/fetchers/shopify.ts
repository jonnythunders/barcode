/**
 * Shopify storefront fetcher.
 *
 * Every public Shopify storefront exposes two useful endpoints:
 *   - `<domain>/products.json` — paginated JSON of all products (~250/page,
 *     ordered by created descending). Free, no auth.
 *   - `<domain>/collections/all?sort_by=best-selling` — HTML page showing
 *     best-selling order. We parse product handles from this HTML to get
 *     a real sales-rank signal (the PRD's "alpha" — real bestseller ordering
 *     pre-retail).
 *
 * Failure modes:
 *   - Some stores disable products.json (rare for DTC brands but possible).
 *     We return a not_found error, the Brand Card renders it as "no shopify
 *     signal" rather than crashing.
 *   - Some stores aren't Shopify at all. The handle resolver is responsible
 *     for not feeding us non-Shopify URLs; this fetcher trusts its input.
 *
 * Snapshots written:
 *   - platform='shopify', metric='product_count' (value_numeric)
 *   - platform='shopify', metric='latest_product_created_at' (value_text: ISO date)
 *   - platform='shopify', metric='top_bestsellers' (value_json: array of product handles in best-selling order)
 */
import { withFetcherRun, writeSnapshot, type FetcherRunCtx } from "./_base";
import type { FetcherResult } from "@/lib/types";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface ShopifyResult {
  domain: string;
  productCount: number;
  latestProductCreatedAt: string | null;     // ISO
  // First page of products (up to 50). Useful for spotting "they launched
  // five new SKUs this month" type signals.
  recentProducts: ShopifyProduct[];
  // Best-seller ordering (top ~12) if the /collections/all page was reachable.
  topBestsellerHandles: string[];
  capturedAt: string;
}

export interface ShopifyProduct {
  handle: string;
  title: string;
  productType: string;
  vendor: string;
  createdAt: string;
  publishedAt: string | null;
  url: string;
}

export interface ShopifyOptions {
  brandId: string;
  domain: string;          // bare domain, e.g. "vacationsunscreen.com"
  triggerKind?: "manual" | "cron" | "on_demand";
}

/**
 * Normalize a domain string into "https://host" form.
 * Accepts "vacation.com", "www.vacation.com", "https://vacation.com",
 * "https://vacation.com/products/foo" — strips everything except origin.
 */
function normalizeDomain(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    throw new Error(`Invalid Shopify domain: "${input}"`);
  }
}

export async function fetchShopify(opts: ShopifyOptions): Promise<FetcherResult<ShopifyResult>> {
  const trigger = opts.triggerKind ?? "on_demand";

  return withFetcherRun(
    {
      fetcherName: "shopify",
      triggerKind: trigger,
      brandId: opts.brandId,
      metadata: { domain: opts.domain },
    },
    async (ctx: FetcherRunCtx): Promise<ShopifyResult> => {
      const origin = normalizeDomain(opts.domain);
      const productsUrl = `${origin}/products.json?limit=50`;

      // ---- products.json ----
      const res = await fetch(productsUrl, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        // Vercel/Node's fetch supports AbortSignal.timeout()
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        throw new Error(`products.json returned ${res.status} for ${productsUrl}`);
      }

      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error(`Not a Shopify store (products.json returned ${contentType})`);
      }

      const body = await res.json();
      const products: Array<Record<string, unknown>> = body?.products ?? [];

      // Note: products.json caps at 250/page and we only request the first 50.
      // For accurate total count we'd need to paginate, but for trend
      // detection 50 is plenty. We mark this in the snapshot metadata.
      const recentProducts: ShopifyProduct[] = products.map((p) => ({
        handle: String(p.handle ?? ""),
        title: String(p.title ?? ""),
        productType: String(p.product_type ?? ""),
        vendor: String(p.vendor ?? ""),
        createdAt: String(p.created_at ?? ""),
        publishedAt: (p.published_at as string | null) ?? null,
        url: `${origin}/products/${p.handle}`,
      }));

      const latestProductCreatedAt =
        recentProducts.length > 0
          ? recentProducts
              .map((p) => p.createdAt)
              .filter(Boolean)
              .sort()
              .at(-1) ?? null
          : null;

      // ---- /collections/all?sort_by=best-selling ----
      // This page lists products in best-selling order. We just need the
      // handles in order — the prices/titles we already have from products.json.
      let topBestsellerHandles: string[] = [];
      try {
        const bestUrl = `${origin}/collections/all?sort_by=best-selling`;
        const bestRes = await fetch(bestUrl, {
          headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
          signal: AbortSignal.timeout(10_000),
        });
        if (bestRes.ok) {
          const html = await bestRes.text();
          topBestsellerHandles = extractProductHandles(html).slice(0, 12);
        }
      } catch {
        // Non-fatal: some stores password-protect collections or have JS-only
        // rendering. The Brand Card still gets product_count + recency from
        // products.json above.
      }

      // ---- persist ----
      await writeSnapshot({
        brandId: opts.brandId,
        platform: "shopify",
        metric: "product_count_sample",
        valueNumeric: products.length,
        valueJson: { sampled: 50, isCappedSample: products.length >= 50 },
        sourceUrl: productsUrl,
        fetcherRunId: ctx.runId,
      });
      ctx.snapshotsWritten++;

      if (latestProductCreatedAt) {
        await writeSnapshot({
          brandId: opts.brandId,
          platform: "shopify",
          metric: "latest_product_created_at",
          valueText: latestProductCreatedAt,
          sourceUrl: productsUrl,
          fetcherRunId: ctx.runId,
        });
        ctx.snapshotsWritten++;
      }

      if (topBestsellerHandles.length > 0) {
        await writeSnapshot({
          brandId: opts.brandId,
          platform: "shopify",
          metric: "top_bestsellers",
          valueJson: { handles: topBestsellerHandles },
          sourceUrl: `${origin}/collections/all?sort_by=best-selling`,
          fetcherRunId: ctx.runId,
        });
        ctx.snapshotsWritten++;
      }

      return {
        domain: origin,
        productCount: products.length,
        latestProductCreatedAt,
        recentProducts,
        topBestsellerHandles,
        capturedAt: new Date().toISOString(),
      };
    }
  );
}

/**
 * Extract Shopify product handles from a /collections/all HTML page.
 * Looks for `/products/<handle>` links and dedupes in source order.
 *
 * Why regex instead of an HTML parser: the Shopify storefront varies wildly
 * by theme. Custom selectors break on every theme switch. The product URL
 * pattern is stable across themes.
 */
function extractProductHandles(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /\/products\/([a-z0-9][a-z0-9-]*)(?=[?#"'\s/]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const handle = m[1].toLowerCase();
    // Skip Shopify's reserved/utility handles
    if (handle === "all" || handle.startsWith("vendor-") || handle === "products") continue;
    if (!seen.has(handle)) {
      seen.add(handle);
      out.push(handle);
    }
  }
  return out;
}
