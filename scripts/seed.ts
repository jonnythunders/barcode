/**
 * Seed script — drops a handful of well-known DTC brands into the `brands`
 * table so the system has something to chew on while we wait for Barcode's
 * real seed list.
 *
 * Run:
 *   npm run seed
 *
 * Env loading: the npm script passes `--env-file=.env.local` to tsx, which
 * loads it before user code runs. This avoids the "imports run before
 * dotenv.config()" pitfall.
 *
 * Idempotent — uses slug uniqueness to skip brands already inserted.
 *
 * The brands chosen here are intentionally varied:
 *   - Olipop: established DTC, now in retail (will land in "established" quadrant)
 *   - Vacation Sunscreen: high-momentum DTC, retail-light
 *   - Liquid Death: huge social, retail-saturated (incumbent test)
 *   - Magic Spoon: DTC cereal, mixed retail presence
 *   - Athletic Brewing: NA beer, growing retail
 *   - Graza: olive oil with strong DTC + retail story
 *   - Spindrift: established, broad retail
 *   - Hilma: emerging supplement brand
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { slugify } from "@/lib/utils";

interface SeedBrand {
  name: string;
  categorySlug: string;
  tiktokHandle?: string;
  instagramHandle?: string;
  amazonBrand?: string;
  websiteUrl?: string;
  notes?: string;
}

const SEED_BRANDS: SeedBrand[] = [
  {
    name: "Olipop",
    categorySlug: "functional-beverages",
    tiktokHandle: "drinkolipop",
    instagramHandle: "drinkolipop",
    amazonBrand: "OLIPOP",
    websiteUrl: "https://drinkolipop.com",
    notes: "Prebiotic soda. Established DTC, now national retail.",
  },
  {
    name: "Vacation Sunscreen",
    categorySlug: "clean-beauty-skincare",
    tiktokHandle: "vacationinc",
    instagramHandle: "vacationinc",
    amazonBrand: "Vacation",
    websiteUrl: "https://vacation.inc",
    notes: "Reef-safe SPF. PRD reference example.",
  },
  {
    name: "Liquid Death",
    categorySlug: "functional-beverages",
    tiktokHandle: "liquiddeath",
    instagramHandle: "liquiddeath",
    amazonBrand: "Liquid Death",
    websiteUrl: "https://liquiddeath.com",
    notes: "Canned water. Social juggernaut, broad retail presence.",
  },
  {
    name: "Magic Spoon",
    categorySlug: "better-for-you-snacks",
    tiktokHandle: "magicspoon",
    instagramHandle: "magicspoon",
    amazonBrand: "Magic Spoon",
    websiteUrl: "https://magicspoon.com",
    notes: "High-protein cereal.",
  },
  {
    name: "Athletic Brewing",
    categorySlug: "functional-beverages",
    tiktokHandle: "athleticbrewing",
    instagramHandle: "athleticbrewing",
    websiteUrl: "https://athleticbrewing.com",
    notes: "Non-alcoholic craft beer. Growing retail.",
  },
  {
    name: "Graza",
    categorySlug: "better-for-you-snacks",
    instagramHandle: "graza",
    tiktokHandle: "graza",
    amazonBrand: "Graza",
    websiteUrl: "https://graza.co",
    notes: "Squeeze-bottle olive oil. Strong DTC + emerging retail.",
  },
  {
    name: "Spindrift",
    categorySlug: "functional-beverages",
    instagramHandle: "spindriftfresh",
    tiktokHandle: "spindriftfresh",
    amazonBrand: "Spindrift",
    websiteUrl: "https://spindriftfresh.com",
    notes: "Real-fruit sparkling water. Mature retail.",
  },
  {
    name: "Hilma",
    categorySlug: "clean-beauty-skincare",
    instagramHandle: "drinkhilma",
    websiteUrl: "https://hilma.co",
    notes: "Natural supplements. Emerging DTC.",
  },
];

async function main() {
  const db = getAdminSupabase();

  const { data: cats, error: catErr } = await db.from("categories").select("id, slug");
  if (catErr) {
    console.error("Failed to fetch categories:", catErr.message);
    process.exit(1);
  }
  const catBySlug = new Map<string, string>();
  for (const c of cats ?? []) catBySlug.set(c.slug, c.id);

  let inserted = 0;
  let skipped = 0;

  for (const b of SEED_BRANDS) {
    const slug = slugify(b.name);
    const { data: existing } = await db
      .from("brands")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (existing) {
      skipped++;
      continue;
    }
    const categoryId = catBySlug.get(b.categorySlug) ?? null;
    const { error } = await db.from("brands").insert({
      name: b.name,
      slug,
      tiktok_handle: b.tiktokHandle ?? null,
      instagram_handle: b.instagramHandle ?? null,
      amazon_brand: b.amazonBrand ?? null,
      website_url: b.websiteUrl ?? null,
      primary_category_id: categoryId,
      discovery_source: "manual",
      notes: b.notes ?? null,
      is_monitored: true,
    });
    if (error) {
      console.error(`  ✗ Failed to insert ${b.name}: ${error.message}`);
      continue;
    }
    inserted++;
    console.log(`  ✓ ${b.name}`);
  }

  console.log(`\nSeed complete. Inserted: ${inserted}. Skipped (already present): ${skipped}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
