/**
 * Discovery orchestrator — runs all available discovery sources for all
 * active categories and reports the combined result.
 *
 * Called by:
 *   - The weekly poll cron (`/api/cron/weekly-poll`)
 *   - The `scripts/poll-once.ts` script (if extended)
 *   - Future: an agent tool "run_discovery"
 *
 * We run TikTok and Amazon serially per category (TikTok is rate-limit
 * sensitive and Amazon will block us if we go too parallel). Within a
 * category, the two sources run in parallel since they hit different domains.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { crawlTikTokForCategory } from "./tiktok-hashtag-crawler";
import { crawlAmazonCategoryForCategory } from "./amazon-category-crawler";
import type { FetcherResult } from "@/lib/types";
import type { DiscoveryResult } from "./_base";
import { nowIso } from "@/lib/utils";

export interface DiscoveryRunSummary {
  categoriesProcessed: number;
  totalNew: number;
  totalReActivated: number;
  totalSkipped: number;
  perCategoryErrors: { categoryId: string; categorySlug: string; source: string; error: string }[];
}

/** A no-op result used when a category has no seeds for a given source. */
function skippedResult(): FetcherResult<DiscoveryResult> {
  return {
    ok: true,
    data: { newCount: 0, reActivatedCount: 0, skippedCount: 0, insertedBrandIds: [] },
    capturedAt: nowIso(),
  };
}

export async function runDiscoveryForAllCategories(
  triggerKind: "manual" | "cron" | "on_demand" = "cron"
): Promise<DiscoveryRunSummary> {
  const db = getAdminSupabase();

  const { data: categories, error } = await db
    .from("categories")
    .select("id, slug, tiktok_hashtags, amazon_category_urls")
    .eq("is_active", true);
  if (error) throw new Error(`runDiscovery: ${error.message}`);

  const summary: DiscoveryRunSummary = {
    categoriesProcessed: 0,
    totalNew: 0,
    totalReActivated: 0,
    totalSkipped: 0,
    perCategoryErrors: [],
  };

  for (const cat of categories ?? []) {
    summary.categoriesProcessed++;

    const hasTiktokSeeds = (cat.tiktok_hashtags?.length ?? 0) > 0;
    const hasAmazonUrls = (cat.amazon_category_urls?.length ?? 0) > 0;

    const [tiktokRes, amazonRes] = await Promise.all([
      hasTiktokSeeds
        ? crawlTikTokForCategory({ categoryId: cat.id, triggerKind })
        : Promise.resolve(skippedResult()),
      hasAmazonUrls
        ? crawlAmazonCategoryForCategory({ categoryId: cat.id, triggerKind })
        : Promise.resolve(skippedResult()),
    ]);

    if (tiktokRes.ok && tiktokRes.data) {
      summary.totalNew += tiktokRes.data.newCount;
      summary.totalReActivated += tiktokRes.data.reActivatedCount;
      summary.totalSkipped += tiktokRes.data.skippedCount;
    } else if (!tiktokRes.ok) {
      summary.perCategoryErrors.push({
        categoryId: cat.id,
        categorySlug: cat.slug,
        source: "tiktok",
        error: tiktokRes.error ?? "unknown",
      });
    }

    if (amazonRes.ok && amazonRes.data) {
      summary.totalNew += amazonRes.data.newCount;
      summary.totalReActivated += amazonRes.data.reActivatedCount;
      summary.totalSkipped += amazonRes.data.skippedCount;
    } else if (!amazonRes.ok) {
      summary.perCategoryErrors.push({
        categoryId: cat.id,
        categorySlug: cat.slug,
        source: "amazon",
        error: amazonRes.error ?? "unknown",
      });
    }
  }

  return summary;
}
