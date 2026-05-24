/**
 * Functional Beverages demo seed — loads data/seed-demo-fnb.json into Supabase
 * so the tool can demonstrate a SECOND category (F&B) alongside Health & Beauty.
 * This shows how Scout extends across categories and how a VP could toggle
 * between category purviews.
 *
 * Same structure as seed-demo.ts. Amazon + retail figures are representative;
 * social figures are simulated for the demo (clearly tagged).
 *
 * Run (after seed-demo for H&B if you want both):
 *   npm run seed:demo:fnb
 *   npm run seed:cards        # rebuilds cards for ALL demo brands incl. F&B
 *   npm run seed:reports      # (optional) regenerate reports
 *
 * Idempotent — skips brands whose slug already exists.
 *
 * To remove ONLY the F&B demo data:
 *   DELETE FROM brands WHERE tags @> ARRAY['demo-fnb'];
 */

import { readFileSync } from "fs";
import { join } from "path";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { slugify } from "@/lib/utils";

interface SeedRow {
  brand: string;
  category: string;
  department: string;
  amazon_annual_sales: number;
  amazon_yoy_growth_pct: number;
  amazon_monthly_units: number;
  retail_annual_sales: number;
  retail_yoy_growth_pct: number | null;
  retail_presence: "None" | "Minimal" | "Emerging" | "Established";
  instagram_followers: number;
  tiktok_followers: number;
  tiktok_views_30d: number;
  client_catcher_score: number;
  signal: string;
}

async function main() {
  const supabase = getAdminSupabase();

  const seedPath = join(process.cwd(), "data", "seed-demo-fnb.json");
  const seedRows: SeedRow[] = JSON.parse(readFileSync(seedPath, "utf-8"));
  console.log(`Loaded ${seedRows.length} brands from seed-demo-fnb.json`);

  // Upsert the Functional Beverages category
  const { data: cat, error: catErr } = await supabase
    .from("categories")
    .upsert(
      {
        slug: "functional-beverages",
        display_name: "Functional Beverages",
        description:
          "Prebiotic sodas, adaptogen drinks, electrolytes, non-alc, and energy — " +
          "DTC-native beverage brands scaling fast online ahead of broad retail distribution.",
        tiktok_hashtags: ["prebioticsoda", "guthealth", "functionalbeverage", "nonalcoholic", "energydrink"],
        subreddits: ["functionalbeverages", "decaf", "Coffee", "energydrinks"],
        google_trends_keywords: ["prebiotic soda", "gut health drink", "non alcoholic", "adaptogen drink"],
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

  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of seedRows) {
    const slug = slugify(row.brand);

    const { data: brand, error: brandErr } = await supabase
      .from("brands")
      .insert({
        name: row.brand,
        slug,
        amazon_brand: row.brand,
        primary_category_id: categoryId,
        discovery_source: "nielsen_upload",
        first_seen_at: new Date().toISOString(),
        // Tagged both 'demo-seed' (so it's treated as curated/tracked everywhere)
        // and 'demo-fnb' (so F&B can be removed independently).
        tags: ["demo-seed", "demo-fnb", "functional-beverages", row.retail_presence.toLowerCase()],
        notes: `${row.signal}. Functional Beverages category demo.`,
        is_monitored: true,
        is_archived: false,
      })
      .select("id")
      .single();

    if (brandErr) {
      if (brandErr.code === "23505") {
        skipped++;
        continue;
      }
      console.error(`  ✗ ${row.brand}:`, brandErr.message);
      failed++;
      continue;
    }

    const brandId: string = brand.id;
    const now = new Date().toISOString();
    const snapshots = [
      { platform: "derived",      metric: "momentum_score",         value_numeric: row.client_catcher_score, value_json: { notInRetail: row.retail_annual_sales === 0 } },
      { platform: "smartscout",   metric: "annual_revenue",         value_numeric: row.amazon_annual_sales },
      { platform: "smartscout",   metric: "yoy_growth_pct",         value_numeric: row.amazon_yoy_growth_pct },
      { platform: "smartscout",   metric: "monthly_units",          value_numeric: row.amazon_monthly_units },
      { platform: "nielsen",      metric: "retail_annual_sales",    value_numeric: row.retail_annual_sales },
      ...(row.retail_yoy_growth_pct != null
        ? [{ platform: "nielsen", metric: "retail_yoy_growth_pct",  value_numeric: row.retail_yoy_growth_pct }]
        : []),
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

  console.log(`\nDone. Inserted: ${inserted}  Skipped: ${skipped}  Failed: ${failed}`);
  console.log(`\nTo undo F&B only: DELETE FROM brands WHERE tags @> ARRAY['demo-fnb'];`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
