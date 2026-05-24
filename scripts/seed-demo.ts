/**
 * Demo seed script — loads the 47 Health & Beauty brands from
 * data/seed-demo.json into Supabase so the Discovery feed and Brand Cards
 * have something real to show during demos.
 *
 * The brands come from a real SmartScout × Nielsen H&B overlap analysis.
 * Amazon + retail figures are from your actual data files.
 * Social figures (instagram_followers, tiktok_followers, tiktok_views_30d)
 * are simulated for demo purposes and are clearly tagged in the data.
 *
 * Run:
 *   npm run seed:demo
 *
 * Idempotent — uses slug uniqueness to skip brands already inserted.
 * Safe to run multiple times.
 *
 * To appear in the Discovery feed, brands need:
 *   1. discovery_source != 'manual'   (we use 'nielsen_upload')
 *   2. first_seen_at >= 30 days ago   (we use now())
 *   3. A snapshot with platform='derived', metric='momentum_score'
 *
 * To remove the demo data later:
 *   DELETE FROM brands WHERE tags @> ARRAY['demo-seed'];
 *   (cascades to snapshots via ON DELETE CASCADE)
 */

import { readFileSync } from "fs";
import { join } from "path";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { slugify } from "@/lib/utils";

// ---- types ----------------------------------------------------------------

interface SeedRow {
  brand: string;
  category: string;         // Amazon subcategory
  department: string;       // Amazon main category
  amazon_annual_sales: number;
  amazon_yoy_growth_pct: number;
  amazon_monthly_units: number;
  retail_annual_sales: number;
  retail_yoy_growth_pct: number | null;
  retail_presence: "None" | "Minimal" | "Emerging" | "Established";
  instagram_followers: number;   // SIMULATED
  tiktok_followers: number;      // SIMULATED
  tiktok_views_30d: number;      // SIMULATED
  client_catcher_score: number;
  signal: string;
}

// ---- main -----------------------------------------------------------------

async function main() {
  const supabase = getAdminSupabase();

  // 1. Load the seed JSON
  const seedPath = join(process.cwd(), "data", "seed-demo.json");
  const seedRows: SeedRow[] = JSON.parse(readFileSync(seedPath, "utf-8"));
  console.log(`Loaded ${seedRows.length} brands from seed-demo.json`);

  // 2. Upsert the Health & Beauty category so we have a category_id
  const { data: cat, error: catErr } = await supabase
    .from("categories")
    .upsert(
      {
        slug: "health-beauty-personal-care",
        display_name: "Health, Beauty & Personal Care",
        description:
          "Skincare, cosmetics, hair care, supplements, personal care — online-first brands " +
          "growing fast on Amazon with under-served retail presence.",
        tiktok_hashtags: ["skincare", "cleanbeauty", "healthylifestyle", "supplements", "haircare"],
        subreddits: ["SkincareAddiction", "supplements", "beauty", "30PlusSkinCare"],
        google_trends_keywords: ["clean beauty", "skincare routine", "protein supplements", "hair growth"],
        is_active: true,
      },
      { onConflict: "slug", ignoreDuplicates: false }
    )
    .select("id")
    .single();

  if (catErr || !cat) {
    console.error("Failed to upsert category:", catErr);
    process.exit(1);
  }
  const categoryId: string = cat.id;
  console.log(`Category ID: ${categoryId}`);

  // 3. Seed each brand
  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of seedRows) {
    const slug = slugify(row.brand);

    // ---- insert brand (skip if slug already exists) ----
    const { data: brand, error: brandErr } = await supabase
      .from("brands")
      .insert({
        name: row.brand,
        slug,
        amazon_brand: row.brand,
        primary_category_id: categoryId,
        discovery_source: "nielsen_upload",  // shows in Discovery feed, not 'manual'
        first_seen_at: new Date().toISOString(),
        tags: ["demo-seed", "health-beauty", row.retail_presence.toLowerCase()],
        notes: `${row.signal}. SmartScout H&B × Nielsen xAOC overlap analysis, April 2026.`,
        is_monitored: true,
        is_archived: false,
      })
      .select("id")
      .single();

    if (brandErr) {
      if (brandErr.code === "23505") {
        // unique slug constraint — already seeded, skip
        skipped++;
        continue;
      }
      console.error(`  ✗ ${row.brand}:`, brandErr.message);
      failed++;
      continue;
    }

    const brandId: string = brand.id;

    // ---- insert snapshots ----
    // platform='derived', metric='momentum_score' is what the Discovery page sorts on
    const now = new Date().toISOString();
    const snapshots = [
      // Core score (the Discovery feed sorts on this). value_json carries the
      // notInRetail flag the weekly report's "Not yet in retail" section reads.
      { platform: "derived",      metric: "momentum_score",         value_numeric: row.client_catcher_score, value_json: { notInRetail: row.retail_annual_sales === 0 } },
      // SmartScout signals (real data)
      { platform: "smartscout",   metric: "annual_revenue",         value_numeric: row.amazon_annual_sales },
      { platform: "smartscout",   metric: "yoy_growth_pct",         value_numeric: row.amazon_yoy_growth_pct },
      { platform: "smartscout",   metric: "monthly_units",          value_numeric: row.amazon_monthly_units },
      // Nielsen signals (real data)
      { platform: "nielsen",      metric: "retail_annual_sales",    value_numeric: row.retail_annual_sales },
      ...(row.retail_yoy_growth_pct != null
        ? [{ platform: "nielsen", metric: "retail_yoy_growth_pct",  value_numeric: row.retail_yoy_growth_pct }]
        : []),
      // Social signals (SIMULATED — clearly noted in value_text)
      { platform: "instagram",    metric: "follower_count",         value_numeric: row.instagram_followers,  value_text: "SIMULATED" },
      { platform: "tiktok",       metric: "follower_count",         value_numeric: row.tiktok_followers,     value_text: "SIMULATED" },
      { platform: "tiktok",       metric: "views_30d",              value_numeric: row.tiktok_views_30d,     value_text: "SIMULATED" },
    ].map((s) => ({
      brand_id: brandId,
      captured_at: now,
      ...s,
    }));

    const { error: snapErr } = await supabase.from("snapshots").insert(snapshots);

    if (snapErr) {
      console.error(`  ✗ snapshots for ${row.brand}:`, snapErr.message);
      failed++;
    } else {
      console.log(`  ✓ ${row.brand.padEnd(28)} score=${row.client_catcher_score}  ${row.signal}`);
      inserted++;
    }
  }

  console.log(`\nDone. Inserted: ${inserted}  Skipped (already exist): ${skipped}  Failed: ${failed}`);
  console.log(`\nTo undo: DELETE FROM brands WHERE tags @> ARRAY['demo-seed'];`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
