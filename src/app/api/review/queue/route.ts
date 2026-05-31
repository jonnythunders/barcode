/**
 * GET /api/review/queue
 *
 * Lists brands whose handle resolution was borderline ("needs_review") and is
 * awaiting a human approve/reject. Authenticated (it exposes brand data and
 * gates the write endpoint's companion). Read-only.
 */
import { NextResponse } from "next/server";
import { verifyAuthToken } from "@/lib/supabase-admin";
import { listReviewQueue } from "@/lib/handle-review";

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
    const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 200);
    const items = await listReviewQueue(limit);
    return NextResponse.json(
      { items, totalItems: items.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message, items: [] }, { status: 500 });
  }
}
