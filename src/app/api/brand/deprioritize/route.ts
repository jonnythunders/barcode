/**
 * POST   /api/brand/deprioritize   — dismiss a brand from the weekly to-do.
 * DELETE /api/brand/deprioritize   — undo (re-activate) a dismissal.
 *
 * Body (POST): { brandId, brandName, reason, detail? }
 * Body (DELETE): { brandId }
 *
 * V1: no per-user auth, so dismissals are team-scoped (see deprioritize.ts).
 * Writes only to the prios table; reversible; never deletes data (a re-activate
 * just flips status back to active), so this is safe under the no-permanent-
 * deletion posture.
 */
import { NextResponse } from "next/server";
import {
  deprioritizeBrand,
  reprioritizeBrand,
  type DeprioritizeReason,
} from "@/lib/deprioritize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_REASONS: DeprioritizeReason[] = [
  "not_a_fit",
  "already_contacted",
  "not_interested",
  "timing",
  "other",
];

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { brandId, brandName, reason, detail } = body as {
      brandId?: string;
      brandName?: string;
      reason?: string;
      detail?: string;
    };
    if (!brandId || !brandName) {
      return NextResponse.json({ error: "brandId and brandName required" }, { status: 400 });
    }
    if (!reason || !VALID_REASONS.includes(reason as DeprioritizeReason)) {
      return NextResponse.json(
        { error: `reason must be one of: ${VALID_REASONS.join(", ")}` },
        { status: 400 }
      );
    }
    const result = await deprioritizeBrand({
      brandId,
      brandName,
      reason: reason as DeprioritizeReason,
      detail: typeof detail === "string" ? detail.slice(0, 500) : undefined,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, dismissed: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { brandId } = body as { brandId?: string };
    if (!brandId) {
      return NextResponse.json({ error: "brandId required" }, { status: 400 });
    }
    const result = await reprioritizeBrand(brandId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, dismissed: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
