/**
 * Brand tools — the agent's primary domain capabilities.
 *
 * All of these execute server-side against Supabase via the admin client.
 * Tool schemas live in `tools/index.ts`; this file is the implementations.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { getBrandCard } from "@/lib/brand-card";
import { computeMomentumScore } from "@/lib/momentum";
import { slugify, formatCompactNumber, formatPctDelta } from "@/lib/utils";

// =========================================================================
// lookup_brand
// =========================================================================

export async function executeLookupBrand(args: {
  brand_name: string;
  force_refresh?: boolean;
}) {
  const card = await getBrandCard({
    brandName: args.brand_name,
    forceRefresh: args.force_refresh === true,
  });

  // Return a model-friendly subset, not the entire card JSON. The agent
  // doesn't need the full trend arrays inline — if it needs history it can
  // call get_brand_history.
  return {
    brand: card.brand,
    resolved: card.resolved,
    momentumScore: card.momentumScore.score,
    momentumBreakdown: card.momentumScore.breakdown,
    recommendedAction: card.recommendedAction,
    narrative: card.narrative,
    tiktok: card.tiktok.status === "ok"
      ? {
          followers: card.tiktok.followerCount,
          engagementRate: card.tiktok.engagementRate,
          videoCount: card.tiktok.videoCount,
          verified: card.tiktok.isVerified,
        }
      : { status: card.tiktok.status, error: card.tiktok.error },
    instagram: card.instagram.status === "ok"
      ? { followers: card.instagram.followerCount, posts: card.instagram.postCount }
      : { status: card.instagram.status, error: card.instagram.error },
    amazon: card.amazon.status === "ok"
      ? {
          starRating: card.amazon.starRating,
          reviewCount: card.amazon.reviewCount,
          bsrRank: card.amazon.bsrRank,
          bsrCategory: card.amazon.bsrCategory,
          boughtPastMonth: card.amazon.boughtPastMonth,
        }
      : { status: card.amazon.status, error: card.amazon.error },
    googleTrends: card.googleTrends.status === "ok"
      ? { yoyChangePct: card.googleTrends.yoyChangePct }
      : { status: card.googleTrends.status, error: card.googleTrends.error },
    reddit: card.reddit.status === "ok"
      ? { mentions30d: card.reddit.mentionCount, velocity: card.reddit.velocity }
      : { status: card.reddit.status, error: card.reddit.error },
    sentiment: card.sentiment.status === "ok"
      ? {
          score: card.sentiment.overallScore,
          positiveThemes: card.sentiment.positiveThemes,
          negativeThemes: card.sentiment.negativeThemes,
        }
      : { status: card.sentiment.status, error: card.sentiment.error },
    partial: card.partial,
    cardUrl: `/brand-card/${card.brand.slug}`,
    generatedAt: card.generatedAt,
  };
}

// =========================================================================
// search_brands
// =========================================================================

export async function executeSearchBrands(args: {
  query?: string;
  category_slug?: string;
  min_momentum?: number;
  not_in_retail?: boolean;
  limit?: number;
}) {
  const db = getAdminSupabase();
  const limit = Math.min(args.limit ?? 25, 100);

  // Find category id if a slug was given
  let categoryId: string | null = null;
  if (args.category_slug) {
    const { data: cat } = await db
      .from("categories")
      .select("id")
      .eq("slug", args.category_slug)
      .maybeSingle();
    if (!cat) return { brands: [], count: 0, note: `Category "${args.category_slug}" not found` };
    categoryId = cat.id;
  }

  // We pull a wide net then filter in code. For larger volumes we'll move
  // this to a SQL view; for now N≈few hundred so this is fine.
  let q = db
    .from("brands")
    .select("id, name, slug, tiktok_handle, instagram_handle, primary_category_id, discovery_source, notes")
    .eq("is_archived", false)
    .limit(500);

  if (categoryId) q = q.eq("primary_category_id", categoryId);
  if (args.query) {
    const like = `%${args.query}%`;
    q = q.or(`name.ilike.${like},notes.ilike.${like}`);
  }

  const { data: brands, error } = await q;
  if (error) return { error: error.message };
  if (!brands || brands.length === 0) return { brands: [], count: 0 };

  // Attach latest momentum score + retail figure for each brand
  const enriched: Array<Record<string, unknown>> = [];
  for (const b of brands) {
    const { data: latestMomentum } = await db
      .from("snapshots")
      .select("value_numeric, value_json, captured_at")
      .eq("brand_id", b.id)
      .eq("platform", "derived")
      .eq("metric", "momentum_score")
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const score = latestMomentum?.value_numeric ?? null;
    const notInRetail =
      (latestMomentum?.value_json as { notInRetail?: boolean } | null)?.notInRetail ?? null;

    if (args.min_momentum != null && (score == null || score < args.min_momentum)) continue;
    if (args.not_in_retail === true && notInRetail !== true) continue;

    // Return only fields useful for ranking/recommending. Deliberately omit
    // internal plumbing (handle-resolution state, discovery_source) so the
    // agent never narrates "handles unresolved" or "nielsen upload" to a user.
    enriched.push({
      id: b.id,
      name: b.name,
      slug: b.slug,
      momentumScore: score,
      notInRetail,
      recommendedAction: score != null && score >= 70 && notInRetail ? "call_now" : score != null && score >= 50 ? "watch" : "skip",
      notes: b.notes,
    });
  }

  // Sort by momentum desc (nulls last), take limit
  enriched.sort((a, b) => {
    const sa = (a.momentumScore as number | null) ?? -1;
    const sb = (b.momentumScore as number | null) ?? -1;
    return sb - sa;
  });

  return { brands: enriched.slice(0, limit), count: enriched.length };
}

// =========================================================================
// get_brand_history
// =========================================================================

export async function executeGetBrandHistory(args: {
  brand_slug?: string;
  brand_id?: string;
  platform: string;
  metric: string;
  days?: number;
}) {
  const db = getAdminSupabase();
  const days = Math.min(args.days ?? 90, 365);

  let brandId = args.brand_id;
  let brandName: string | null = null;

  if (!brandId && args.brand_slug) {
    const slug = slugify(args.brand_slug);
    const { data: brand } = await db
      .from("brands")
      .select("id, name")
      .eq("slug", slug)
      .maybeSingle();
    if (!brand) return { error: `No brand with slug "${slug}"` };
    brandId = brand.id;
    brandName = brand.name;
  }
  if (!brandId) return { error: "Provide either brand_slug or brand_id" };

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("snapshots")
    .select("captured_at, value_numeric, value_text, value_json")
    .eq("brand_id", brandId)
    .eq("platform", args.platform)
    .eq("metric", args.metric)
    .gte("captured_at", since)
    .order("captured_at", { ascending: true });

  if (error) return { error: error.message };
  const points = (data ?? []).map((r: { captured_at: string; value_numeric: number | null; value_text: string | null; value_json: unknown }) => ({
    at: r.captured_at,
    value: r.value_numeric ?? r.value_text ?? r.value_json,
  }));

  // Compute first → last delta for quick summary
  const numeric = points
    .map((p) => (typeof p.value === "number" ? p.value : null))
    .filter((v): v is number => v != null);
  let deltaPct: number | null = null;
  if (numeric.length >= 2 && numeric[0] > 0) {
    deltaPct = (numeric[numeric.length - 1] - numeric[0]) / numeric[0];
  }

  return {
    brandId,
    brandName,
    platform: args.platform,
    metric: args.metric,
    windowDays: days,
    points,
    summary: {
      pointCount: points.length,
      first: numeric[0] ?? null,
      latest: numeric[numeric.length - 1] ?? null,
      deltaFormatted: deltaPct != null ? formatPctDelta(deltaPct) : null,
    },
  };
}

// =========================================================================
// compare_brands
// =========================================================================

export async function executeCompareBrands(args: {
  brand_names: string[];
}) {
  const cards = await Promise.all(
    args.brand_names.map(async (name) => {
      try {
        const card = await getBrandCard({ brandName: name });
        return {
          brand: card.brand.name,
          slug: card.brand.slug,
          momentumScore: card.momentumScore.score,
          tiktokFollowers: card.tiktok.followerCount ?? null,
          tiktokEngagement: card.tiktok.engagementRate ?? null,
          igFollowers: card.instagram.followerCount ?? null,
          amazonStars: card.amazon.starRating ?? null,
          amazonReviews: card.amazon.reviewCount ?? null,
          amazonBsr: card.amazon.bsrRank ?? null,
          trendsYoy: card.googleTrends.yoyChangePct ?? null,
          redditVelocity: card.reddit.velocity ?? null,
          sentimentScore: card.sentiment.overallScore ?? null,
          recommendedAction: card.recommendedAction,
          partial: card.partial,
        };
      } catch (err) {
        return {
          brand: name,
          error: err instanceof Error ? err.message : "Unknown error",
        };
      }
    })
  );

  // Pre-format some compact strings so the agent can put them in tables
  // without reformatting itself
  const formatted = cards.map((c) => {
    if ("error" in c) return c;
    return {
      ...c,
      tiktokFollowersFmt: formatCompactNumber(c.tiktokFollowers ?? undefined),
      igFollowersFmt: formatCompactNumber(c.igFollowers ?? undefined),
      amazonReviewsFmt: formatCompactNumber(c.amazonReviews ?? undefined),
      trendsYoyFmt: c.trendsYoy != null ? formatPctDelta(c.trendsYoy) : null,
    };
  });

  return { count: cards.length, brands: formatted };
}

// =========================================================================
// monitor_brand
// =========================================================================

export async function executeMonitorBrand(args: {
  brand_name: string;
  monitor: boolean;
}) {
  const db = getAdminSupabase();
  const slug = slugify(args.brand_name);

  const { data: brand } = await db
    .from("brands")
    .select("id, name, is_monitored")
    .or(`slug.eq.${slug},name.ilike.${args.brand_name}`)
    .maybeSingle();

  if (!brand) {
    // Auto-create when adding to monitoring
    if (args.monitor === true) {
      const { data: inserted, error } = await db
        .from("brands")
        .insert({
          name: args.brand_name,
          slug,
          discovery_source: "manual",
          is_monitored: true,
        })
        .select("id, name, is_monitored")
        .single();
      if (error) return { error: error.message };
      return { success: true, action: "created_and_enabled", brandId: inserted.id, brandName: inserted.name };
    }
    return { error: `Brand "${args.brand_name}" not found` };
  }

  await db.from("brands").update({ is_monitored: args.monitor }).eq("id", brand.id);
  return {
    success: true,
    action: args.monitor ? "enabled" : "disabled",
    brandId: brand.id,
    brandName: brand.name,
  };
}

// =========================================================================
// recompute_momentum
// =========================================================================

export async function executeRecomputeMomentum(args: { brand_name: string }) {
  const db = getAdminSupabase();
  const slug = slugify(args.brand_name);
  const { data: brand } = await db
    .from("brands")
    .select("id, name")
    .or(`slug.eq.${slug},name.ilike.${args.brand_name}`)
    .maybeSingle();
  if (!brand) return { error: `Brand "${args.brand_name}" not found` };

  const result = await computeMomentumScore({ brandId: brand.id, persistSnapshot: true });
  return {
    brandId: brand.id,
    brandName: brand.name,
    momentumScore: result.score,
    components: result.components,
    notInRetail: result.notInRetail,
  };
}
