/**
 * GET /api/feedback/list — the owner's internal feedback review.
 *
 * Returns all rep votes, down-votes first (the high-signal disagreements),
 * with brand name, voter email, the vote-time context snapshot, and the rep's
 * note. Authenticated. Read-only.
 */
import { NextResponse } from "next/server";
import { verifyAuthToken } from "@/lib/supabase-admin";
import { listFeedback } from "@/lib/recommendation-feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await verifyAuthToken(request);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized", items: [] },
      { status: 401 }
    );
  }
  try {
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 500);
    const items = await listFeedback(limit);
    return NextResponse.json(
      { items, totalItems: items.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error", items: [] },
      { status: 500 }
    );
  }
}
