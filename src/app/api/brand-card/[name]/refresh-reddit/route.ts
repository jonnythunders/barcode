/**
 * POST /api/brand-card/[name]/refresh-reddit
 *
 * Client-facing "refresh community context" action. Pulls fresh Reddit signal
 * for ONE brand via SociaVault, then returns the updated card.
 *
 * This endpoint spends SociaVault credits, and the app has no per-user auth in
 * V1, so it MUST be self-protecting. The guard is freshness-based: if the
 * brand's Reddit data is younger than REFRESH_COOLDOWN_MS we refuse and return
 * the existing card with refreshed:false. This bounds credit burn no matter how
 * often the button is clicked — there is no separate rate-limit table to keep
 * in sync, the snapshot timestamps ARE the rate limit.
 *
 * Reddit-only by design: TikTok/IG follower counts barely move week to week, so
 * a manual social refresh isn't worth the credits or the abuse surface. For
 * "see it live right now" the UI links straight to the brand's TikTok/IG pages.
 */
import { NextResponse } from "next/server";
import { getBrandCard } from "@/lib/brand-card";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { getFeatureFlags } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Minimum time between client-triggered Reddit refreshes for a given brand.
// 6h is plenty: Reddit buzz is a weekly-scale signal, and the weekly cron
// already covers the steady cadence. This is purely the anti-abuse floor.
const REFRESH_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ name: string }> }
) {
  try {
    const { name } = await ctx.params;
    const brandName = decodeURIComponent(name).trim();
    if (!brandName) {
      return NextResponse.json({ error: "brand name required" }, { status: 400 });
    }

    if (!getFeatureFlags().redditEnabled) {
      return NextResponse.json(
        { error: "Reddit signal is not enabled", refreshed: false },
        { status: 409 }
      );
    }

    const db = getAdminSupabase();

    // Resolve the brand id so we can check Reddit data freshness.
    const { data: brand } = await db
      .from("brands")
      .select("id, name")
      .or(`slug.eq.${brandName.toLowerCase().replace(/[^a-z0-9]+/g, "-")},name.ilike.${brandName}`)
      .limit(1)
      .maybeSingle();

    if (brand) {
      const { data: lastReddit } = await db
        .from("snapshots")
        .select("captured_at")
        .eq("brand_id", brand.id)
        .eq("platform", "reddit")
        .order("captured_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastReddit) {
        const ageMs = Date.now() - new Date(lastReddit.captured_at).getTime();
        if (ageMs < REFRESH_COOLDOWN_MS) {
          const minutesLeft = Math.ceil((REFRESH_COOLDOWN_MS - ageMs) / 60000);
          // Return the current card unchanged with a cooldown notice — the UI
          // shows "refreshed recently" rather than spending a credit.
          const card = await getBrandCard({ brandName });
          return NextResponse.json(
            { ...card, refreshed: false, cooldownMinutesRemaining: minutesLeft },
            { headers: { "Cache-Control": "no-store" } }
          );
        }
      }
    }

    // Cooldown passed (or no prior Reddit data) — force a fresh pull. The
    // brand-card gate sees forceRefresh and pulls Reddit regardless of the
    // recommended_stale policy (an explicit refresh always wins, except off).
    const card = await getBrandCard({ brandName, forceRefresh: true });
    return NextResponse.json(
      { ...card, refreshed: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[/api/brand-card/[name]/refresh-reddit] ${message}`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
