/**
 * Manual one-shot of the weekly poll, for debugging.
 *
 * Run: `npm run poll-once`
 *
 * Iterates over `brands WHERE is_monitored = true AND is_archived = false`
 * and runs every available fetcher against each one. Same code path as the
 * Saturday-night cron — useful for:
 *   - Smoke-testing fetchers with real credentials
 *   - Backfilling snapshots after the schema has been live for a few days
 *   - Reproducing a cron failure locally
 *
 * Concurrency: we run one brand at a time (no parallelism across brands)
 * to keep external rate limits safe. Within a brand the fetchers fan out
 * in parallel — see `getBrandCard`.
 *
 * Skip behavior:
 *   - Passing a brand slug as the first argv arg runs only that brand:
 *     `npm run poll-once -- olipop`
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { getBrandCard } from "@/lib/brand-card";

async function main() {
  const targetSlug = process.argv[2];
  const db = getAdminSupabase();

  let query = db
    .from("brands")
    .select("id, name, slug")
    .eq("is_monitored", true)
    .eq("is_archived", false);

  if (targetSlug) {
    query = query.eq("slug", targetSlug);
  }

  const { data: brands, error } = await query;
  if (error) {
    console.error("Failed to fetch brands:", error.message);
    process.exit(1);
  }
  if (!brands || brands.length === 0) {
    console.log("No brands to poll.");
    return;
  }

  console.log(`Polling ${brands.length} brand(s)...\n`);

  for (const b of brands) {
    const start = Date.now();
    try {
      const card = await getBrandCard({ brandName: b.name, forceRefresh: true });
      const partial = card.partial ? " (partial)" : "";
      const score = card.momentumScore.score != null ? ` momentum=${card.momentumScore.score}` : "";
      console.log(`  ✓ ${b.name}${score}${partial} — ${Date.now() - start}ms`);
      if (card.partial) {
        for (const [platform, err] of Object.entries(card.errors)) {
          console.log(`      ✗ ${platform}: ${err.slice(0, 80)}`);
        }
      }
    } catch (err) {
      console.error(`  ✗ ${b.name} — ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
