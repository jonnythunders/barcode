/**
 * POST   /api/brand/feedback  — record/update the logged-in rep's vote.
 *   Body: { brandId, vote: 1|-1, note? }
 * DELETE /api/brand/feedback  — clear the logged-in rep's vote.
 *   Body: { brandId }
 *
 * Per-rep attribution: the voter is the real auth user from verifyAuthToken,
 * NOT a team sentinel. The vote-time context snapshot (recommended_action,
 * momentum_score, brand_type) is read SERVER-SIDE from the current cached card,
 * so it reflects what the engine actually showed and can't be spoofed by the
 * client. Capture only — votes don't change the momentum score (tuning later).
 */
import { NextResponse } from "next/server";
import { verifyAuthToken, getAdminSupabase } from "@/lib/supabase-admin";
import {
  recordFeedback,
  clearFeedback,
  getFeedbackForBrand,
  type Vote,
} from "@/lib/recommendation-feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?brandId=... — the logged-in rep's current vote on a brand (for seeding
// the thumb state on the card). The brand-card route is unauthenticated and so
// can't attach this, so the control loads it here.
export async function GET(request: Request) {
  let authUserId: string;
  try {
    ({ authUserId } = await verifyAuthToken(request));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  try {
    const url = new URL(request.url);
    const brandId = url.searchParams.get("brandId");
    if (!brandId) return NextResponse.json({ error: "brandId required" }, { status: 400 });
    const state = await getFeedbackForBrand(brandId, authUserId);
    return NextResponse.json(
      { vote: state?.vote ?? null, note: state?.note ?? null },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}

async function readCardContext(brandId: string): Promise<{
  recommendedAction: string | null;
  momentumScore: number | null;
  brandType: string | null;
}> {
  const db = getAdminSupabase();
  const { data } = await db
    .from("brand_card_cache")
    .select("payload")
    .eq("brand_id", brandId)
    .maybeSingle();
  const payload = (data?.payload ?? {}) as {
    recommendedAction?: string | null;
    momentumScore?: { score?: number | null } | null;
    brandType?: string | null;
  };
  return {
    recommendedAction: payload.recommendedAction ?? null,
    momentumScore: payload.momentumScore?.score ?? null,
    brandType: payload.brandType ?? null,
  };
}

export async function POST(request: Request) {
  let authUserId: string;
  try {
    ({ authUserId } = await verifyAuthToken(request));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json().catch(() => ({}));
    const { brandId, vote, note } = body as { brandId?: string; vote?: number; note?: string };
    if (!brandId) return NextResponse.json({ error: "brandId required" }, { status: 400 });
    if (vote !== 1 && vote !== -1) {
      return NextResponse.json({ error: "vote must be 1 or -1" }, { status: 400 });
    }
    const ctx = await readCardContext(brandId);
    const result = await recordFeedback({
      brandId,
      authUserId,
      vote: vote as Vote,
      note: typeof note === "string" ? note : null,
      recommendedAction: ctx.recommendedAction,
      momentumScore: ctx.momentumScore,
      brandType: ctx.brandType,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true, vote });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  let authUserId: string;
  try {
    ({ authUserId } = await verifyAuthToken(request));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json().catch(() => ({}));
    const { brandId } = body as { brandId?: string };
    if (!brandId) return NextResponse.json({ error: "brandId required" }, { status: 400 });
    const result = await clearFeedback(brandId, authUserId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true, vote: null });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}
