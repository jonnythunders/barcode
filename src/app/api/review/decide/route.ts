/**
 * POST /api/review/decide
 *
 * Apply a human handle-review decision.
 *   Body: { resolutionId, decision: "approve"|"reject",
 *           tiktokHandle?, instagramHandle? }
 *
 * Approve writes the confirmed handle(s) onto the brands row and logs a
 * "manual" resolution; reject logs a "manual" resolution with null handles.
 * Never deletes. Does NOT re-poll (no credit spend) — the next scheduled poll
 * or a manual recompute/refresh picks up the now-authoritative handle.
 */
import { NextResponse } from "next/server";
import { verifyAuthToken } from "@/lib/supabase-admin";
import { applyReviewDecision } from "@/lib/handle-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await verifyAuthToken(request);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 }
    );
  }
  try {
    const body = await request.json().catch(() => ({}));
    const { resolutionId, decision, tiktokHandle, instagramHandle } = body as {
      resolutionId?: string;
      decision?: string;
      tiktokHandle?: string | null;
      instagramHandle?: string | null;
    };
    if (!resolutionId) {
      return NextResponse.json({ error: "resolutionId required" }, { status: 400 });
    }
    if (decision !== "approve" && decision !== "reject") {
      return NextResponse.json(
        { error: 'decision must be "approve" or "reject"' },
        { status: 400 }
      );
    }
    const result = await applyReviewDecision({
      resolutionId,
      decision,
      tiktokHandle: typeof tiktokHandle === "string" ? tiktokHandle : null,
      instagramHandle: typeof instagramHandle === "string" ? instagramHandle : null,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
