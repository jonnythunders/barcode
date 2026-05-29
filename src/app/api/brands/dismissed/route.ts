/**
 * GET /api/brands/dismissed
 *
 * Returns the set of brand ids currently deprioritized (team-scoped in V1), so
 * list views (dashboard, discovery) can flag/dim them at a glance. Read-only.
 *
 * Note: the weekly to-do HIDES dismissed brands; the browse/discovery views
 * instead SHOW them dimmed with a flag, so a rep can still see "I already dealt
 * with this" while triaging — the flag is the quick-scan value.
 */
import { NextResponse } from "next/server";
import { getDismissedBrandIds } from "@/lib/deprioritize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ids = await getDismissedBrandIds();
    return NextResponse.json(
      { dismissedIds: Array.from(ids) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message, dismissedIds: [] }, { status: 500 });
  }
}
