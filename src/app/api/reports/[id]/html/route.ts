/**
 * GET /api/reports/[id]/html
 *
 * Returns the rendered HTML of a report directly, so the UI can render
 * it in an iframe (the safest way to display arbitrary email HTML without
 * letting it style the rest of the app).
 *
 * Falls back to re-rendering from the stored payload if `rendered_html` is
 * missing — handy when we've updated the template and want preview to
 * reflect the new look without re-running the cron. Handles both
 * `weekly_scouting` and `monthly_deep_dive` kinds.
 */
import { NextResponse } from "next/server";
import { verifyAuthToken, getAdminSupabase } from "@/lib/supabase-admin";
import { renderWeeklyReportHtml, type WeeklyReportPayload } from "@/lib/weekly-report";
import { renderDeepDiveHtml, type DeepDivePayload } from "@/lib/nielsen/deep-dive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    await verifyAuthToken(request);
  } catch {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const { id } = await ctx.params;
  const db = getAdminSupabase();
  const { data, error } = await db
    .from("reports")
    .select("kind, payload, rendered_html")
    .eq("id", id)
    .maybeSingle();
  if (error) return new NextResponse(error.message, { status: 500 });
  if (!data) return new NextResponse("Not found", { status: 404 });

  let html = data.rendered_html as string | null;
  if (!html) {
    try {
      if (data.kind === "weekly_scouting") {
        html = renderWeeklyReportHtml(data.payload as WeeklyReportPayload);
      } else if (data.kind === "monthly_deep_dive") {
        html = renderDeepDiveHtml(data.payload as DeepDivePayload);
      }
    } catch (err) {
      return new NextResponse(`Render failed: ${err instanceof Error ? err.message : err}`, { status: 500 });
    }
  }
  if (!html) {
    return new NextResponse("No rendered HTML available for this report type yet", { status: 501 });
  }
  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
