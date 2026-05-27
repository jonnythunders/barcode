/**
 * Demo Brand Card cache loader.
 *
 * Derives full, internally-consistent BrandCard payloads from the compact
 * data/seed-demo.json (the same file seed-demo.ts uses) and writes them to
 * brand_card_cache, keyed by brand_id. getBrandCard() returns these directly
 * while fresh (6h TTL), so every demo Brand Card renders fully populated
 * (social, Amazon, trends, reddit, sentiment, momentum) with NO live fetches.
 *
 * Run AFTER seed-demo.ts (needs the brand rows to exist):
 *   npm run seed:demo      # creates brands + snapshots
 *   npm run seed:cards     # creates the cached brand cards (this script)
 *
 * Re-runnable. Upserts on brand_id.
 *
 * Social figures are SIMULATED (clearly marked in the source data); Amazon and
 * retail figures derive from the real SmartScout x Nielsen analysis.
 *
 * To undo:
 *   DELETE FROM brand_card_cache WHERE brand_id IN
 *     (SELECT id FROM brands WHERE tags @> ARRAY['demo-seed']);
 */
import { readFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { getAdminSupabase } from "@/lib/supabase-admin";

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

// Deterministic 0..1 pseudo-random keyed by brand+salt (stable across runs)
function rseed(name: string, salt: string): number {
  const h = createHash("md5").update(name + salt).digest("hex");
  return parseInt(h.slice(0, 8), 16) / 0xffffffff;
}

function compact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
}

// Currency form of compact(), e.g. 49265650 -> "$49.3M". Kept separate so
// narrative templates never need a literal "$" adjacent to an interpolation.
function usd(n: number): string {
  return "$" + compact(n);
}

function isoDaysAgo(d: number): string {
  return new Date(Date.now() - d * 86400_000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
}
function dateDaysAgo(d: number): string {
  return isoDaysAgo(d).slice(0, 10);
}

const POS = ["effective results", "clean ingredients", "fast shipping", "great value",
  "noticeable difference", "quality packaging", "gentle formula", "good scent"];
const NEG = ["price point", "availability", "subscription friction", "slow restock"];

function pick<T>(arr: T[], seedName: string, salt: string, k: number): T[] {
  const idx = arr.map((_, i) => i).sort((a, b) => rseed(seedName, salt + a) - rseed(seedName, salt + b));
  return idx.slice(0, k).map((i) => arr[i]);
}

function buildCard(r: SeedRow, brandId: string) {
  const NOW = isoDaysAgo(0);
  const b = r.brand;
  const score = r.client_catcher_score;
  const amzGrowth = r.amazon_yoy_growth_pct;
  const ig = r.instagram_followers;
  const tt = r.tiktok_followers;
  const ttv = r.tiktok_views_30d;
  const retail = r.retail_annual_sales;
  const notInRetail = retail === 0;

  const action = score >= 70 && notInRetail ? "call_now" : score >= 50 ? "watch" : "skip";

  const eng = Math.round((0.03 + 0.09 * rseed(b, "eng") * (score / 100)) * 10000) / 10000;
  let stars = Math.round((3.9 + 1.0 * rseed(b, "star")) * 10) / 10;
  if (stars > 4.9) stars = 4.9;
  const reviews = Math.floor(r.amazon_monthly_units * (0.4 + 2.5 * rseed(b, "rev")));
  const bsr = Math.floor(50 + 4000 * rseed(b, "bsr") * (score < 70 ? 1 : 0.3));
  const bought = r.amazon_monthly_units > 1000
    ? `${Math.floor(r.amazon_monthly_units / 1000)}K+ bought past month`
    : `${r.amazon_monthly_units}+ bought past month`;

  const gtYoy = Math.round((amzGrowth / 100) * (0.5 + 0.5 * rseed(b, "gt")) * 100) / 100;
  const mentions = Math.floor(5 + 120 * rseed(b, "red") * (score / 100));
  const velocity = Math.round((amzGrowth / 100) * (0.4 + 0.6 * rseed(b, "vel")) * 100) / 100;
  const sentScore = Math.round(Math.min(0.95, 0.2 + 0.7 * (score / 100) + 0.1 * rseed(b, "sent")) * 100) / 100;

  const posThemes = pick(POS, b, "pos", score >= 70 ? 3 : 2);
  const negThemes = pick(NEG, b, "neg", score >= 60 ? 1 : 2);

  // IG follower trend (7 points over 90d), trending up with growth
  const baseIg = ig / (1 + (amzGrowth / 100) * 0.3);
  const igTrend = [90, 75, 60, 45, 30, 15, 0].map((dago, i) => ({
    date: dateDaysAgo(dago),
    value: Math.floor(baseIg + (ig - baseIg) * (i / 6) + ig * 0.01 * rseed(b, "ig" + i)),
  }));

  // Google Trends series (12 monthly points)
  const gseries = Array.from({ length: 12 }, (_, i) => {
    const dago = 330 - i * 30;
    const base = 40 + 55 * (i / 11) * (amzGrowth > 0 ? 1 : 0.4);
    return { date: dateDaysAgo(dago), value: Math.max(5, Math.min(100, Math.round(base + 12 * rseed(b, "g" + i) - 6))) };
  });

  // Top TikTok videos
  const vids = [0, 1, 2].map((i) => {
    const vv = Math.floor(ttv * (0.18 - 0.04 * i) * (0.7 + 0.6 * rseed(b, "v" + i)));
    return {
      id: createHash("md5").update(b + i).digest("hex").slice(0, 12),
      url: null,
      views: vv,
      likes: Math.floor(vv * (0.06 + 0.05 * rseed(b, "l" + i))),
      shares: Math.floor(vv * 0.01),
      comments: Math.floor(vv * 0.008),
      postedAt: isoDaysAgo(7 + i * 9),
    };
  });

  let narrative: string;
  if (action === "call_now") {
    narrative = `${b} is a high-priority prospect: ${usd(r.amazon_annual_sales)} in trailing Amazon sales, ` +
      `up ${amzGrowth.toFixed(0)}% YoY, with effectively no measured retail footprint. ` +
      `Strong online momentum with clear shelf-ready upside.`;
  } else if (action === "watch") {
    narrative = retail > 0
      ? `${b} shows solid momentum (${usd(r.amazon_annual_sales)} Amazon, ${amzGrowth >= 0 ? "+" : ""}${amzGrowth.toFixed(0)}% YoY) and has begun building retail presence (${usd(retail)} measured). Worth tracking as distribution expands.`
      : `${b} posts ${usd(r.amazon_annual_sales)} on Amazon (${amzGrowth >= 0 ? "+" : ""}${amzGrowth.toFixed(0)}% YoY), but recent signals are mixed. Monitor before prioritizing outreach.`;
  } else {
    narrative = `${b} is well-established in retail (${usd(retail)} measured sales) with mature, slow-growth dynamics. ` +
      `Limited upside for new distribution — low priority for outreach.`;
  }

  const breakdown = {
    tiktokGrowth: Math.round(Math.min(100, 40 + amzGrowth * 0.2) * 10) / 10,
    tiktokEngagement: Math.round(eng * 100 * 6 * 10) / 10,
    instagramGrowth: Math.round(Math.min(100, 45 + amzGrowth * 0.15) * 10) / 10,
    amazonVelocity: Math.round(Math.min(100, 50 + amzGrowth * 0.1) * 10) / 10,
    googleTrendsGrowth: Math.round(Math.min(100, Math.max(0, 50 + gtYoy * 30)) * 10) / 10,
    redditVelocity: Math.round(Math.min(100, Math.max(0, 50 + velocity * 30)) * 10) / 10,
    sentiment: Math.round(sentScore * 100 * 10) / 10,
  };

  const handle = b.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const slug = b.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  return {
    brand: { id: brandId, name: b, slug, primaryCategory: r.department },
    resolved: {
      tiktokHandle: handle, instagramHandle: handle, amazonBrand: b,
      websiteUrl: `https://${handle}.com`, resolutionConfidence: "high",
    },
    tiktok: {
      status: "ok", capturedAt: NOW, provenance: "sample", followerCount: tt,
      followingCount: Math.floor(50 + 200 * rseed(b, "fg")),
      likesCount: Math.floor(tt * (8 + 12 * rseed(b, "lk"))),
      videoCount: Math.floor(80 + 600 * rseed(b, "vc")),
      bio: `Official ${b} • Shop now`, isVerified: score >= 70, engagementRate: eng,
      topVideos: vids,
      adPresence: { hasActiveAds: score >= 60, estimatedReach: score >= 70 ? "100K–500K" : "10K–50K", adCount: Math.floor(1 + 8 * rseed(b, "ad")) },
    },
    instagram: {
      status: "ok", capturedAt: NOW, provenance: "sample", followerCount: ig,
      postCount: Math.floor(200 + 1500 * rseed(b, "pc")),
      bio: `${b} — as seen on Amazon & TikTok`, followerTrend: igTrend,
    },
    amazon: {
      status: "ok", capturedAt: NOW, provenance: "sample", starRating: stars, reviewCount: reviews,
      bsrRank: bsr, bsrCategory: r.department, boughtPastMonth: bought,
      productUrl: `https://www.amazon.com/s?k=${encodeURIComponent(b)}`,
    },
    googleTrends: { status: "ok", capturedAt: NOW, provenance: "sample", searchVolumeTrend: gseries, yoyChangePct: gtYoy },
    reddit: {
      status: "ok", capturedAt: NOW, provenance: "sample", mentionCount: mentions, velocity,
      // Thread-level data intentionally omitted in preview: we do not ship
      // fabricated links. Real threads populate once the Reddit API is wired.
      topThreads: [],
    },
    sentiment: {
      status: "ok", capturedAt: NOW, provenance: "sample", overallScore: sentScore,
      positiveThemes: posThemes, negativeThemes: negThemes,
      sampleSize: Math.floor(30 + 120 * rseed(b, "ss")),
    },
    commerce: {
      amazonAnnualSales: r.amazon_annual_sales,
      amazonYoyGrowthPct: r.amazon_yoy_growth_pct,
      amazonMonthlyUnits: r.amazon_monthly_units,
      retailAnnualSales: r.retail_annual_sales,
      retailYoyGrowthPct: r.retail_yoy_growth_pct,
      retailPresence: r.retail_presence,
      sourceLabel: "SmartScout × Nielsen xAOC · Apr 2026",
    },
    momentumScore: { score, breakdown, asOf: NOW, basis: "commerce" },
    narrative,
    recommendedAction: action,
    generatedAt: NOW,
    partial: false,
    errors: {},
  };
}

async function main() {
  const supabase = getAdminSupabase();
  // Load H&B brands, plus F&B brands if that seed file is present. Cards are
  // built for every demo brand found in either file.
  const rows: SeedRow[] = JSON.parse(readFileSync(join(process.cwd(), "data", "seed-demo.json"), "utf-8"));
  try {
    const fnb: SeedRow[] = JSON.parse(readFileSync(join(process.cwd(), "data", "seed-demo-fnb.json"), "utf-8"));
    rows.push(...fnb);
    console.log(`Loaded ${fnb.length} Functional Beverages brands too.`);
  } catch {
    // F&B seed file not present — H&B only.
  }

  // Map brand name -> brand_id from the DB
  const { data: brands, error } = await supabase.from("brands").select("id,name").contains("tags", ["demo-seed"]);
  if (error || !brands) {
    console.error("Failed to load brand rows. Run `npm run seed:demo` first.", error);
    process.exit(1);
  }
  const idByName = new Map<string, string>(brands.map((b) => [b.name, b.id]));
  console.log(`Found ${idByName.size} demo brands in DB.`);

  let ok = 0, missing = 0, failed = 0;
  for (const r of rows) {
    const brandId = idByName.get(r.brand);
    if (!brandId) { console.warn(`  ? no brand row for ${r.brand} — skipping`); missing++; continue; }
    const payload = buildCard(r, brandId);
    const { error: upErr } = await supabase.from("brand_card_cache").upsert(
      { brand_id: brandId, payload, generated_at: new Date().toISOString(), ttl_seconds: 31536000 },
      { onConflict: "brand_id" }
    );
    if (upErr) { console.error(`  ✗ ${r.brand}: ${upErr.message}`); failed++; }
    else { console.log(`  ✓ ${r.brand}`); ok++; }
  }
  console.log(`\nDone. Cached: ${ok}  Missing brand row: ${missing}  Failed: ${failed}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
