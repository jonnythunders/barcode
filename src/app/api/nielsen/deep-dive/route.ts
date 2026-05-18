/**
 * POST /api/nielsen/deep-dive
 *
 * Generate (and optionally email) a monthly deep dive from a Nielsen upload.
 *
 * Body: { uploadId, categoryIds?, recipientEmail?, send? }
 *
 * If `send=true` AND a recipient is provided AND Resend is configured, the
 * report is emailed; otherwise it's just persisted and returned.
 */
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { verifyAuthToken, getAdminSupabase } from "@/lib/supabase-admin";
import { getServerEnv, getFeatureFlags } from "@/lib/env";
import { buildMonthlyDeepDive, renderDeepDiveHtml } from "@/lib/nielsen/deep-dive";
import { nowIso } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    await verifyAuthToken(request);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }

  let body: { uploadId?: string; categoryIds?: string[]; recipientEmail?: string; send?: boolean };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  if (!body.uploadId) {
    return NextResponse.json({ error: "uploadId required" }, { status: 400 });
  }

  try {
    const payload = await buildMonthlyDeepDive({
      uploadId: body.uploadId,
      categoryIds: body.categoryIds,
    });
    const html = renderDeepDiveHtml(payload);

    const db = getAdminSupabase();
    // Persist the report
    const { data: reportRow, error: reportErr } = await db
      .from("reports")
      .insert({
        kind: "monthly_deep_dive",
        category_id: body.categoryIds?.[0] ?? null,
        period_start: payload.periodStart,
        period_end: payload.periodEnd,
        payload,
        rendered_html: html,
        status: "generating",
        recipient_email: body.recipientEmail ?? null,
      })
      .select("id")
      .single();
    if (reportErr || !reportRow) {
      return NextResponse.json({ error: reportErr?.message ?? "Failed to persist" }, { status: 500 });
    }

    let sent = false;
    let sendError: string | null = null;
    if (body.send && body.recipientEmail) {
      const env = getServerEnv();
      const flags = getFeatureFlags(env);
      if (flags.emailEnabled) {
        const resend = new Resend(env.resendApiKey!);
        const subject = `Monthly Deep Dive · ${payload.categories.map((c) => c.displayName).join(", ") || "Category"}`;
        const { error } = await resend.emails.send({
          from: env.resendFromEmail,
          to: body.recipientEmail,
          subject,
          html,
        });
        if (error) {
          sendError = error.message;
        } else {
          sent = true;
        }
      } else {
        sendError = "Resend not configured";
      }
    }

    await db
      .from("reports")
      .update({
        status: sent ? "sent" : sendError ? "failed" : "sent",
        sent_at: sent ? nowIso() : null,
        error_message: sendError,
      })
      .eq("id", reportRow.id);

    return NextResponse.json({
      reportId: reportRow.id,
      sent,
      sendError,
      summary: {
        callNow: payload.quadrant.counts.call_now,
        established: payload.quadrant.counts.established,
        incumbent: payload.quadrant.counts.incumbent,
        skip: payload.quadrant.counts.skip,
        notInRetailCount: payload.notInRetail.length,
        brandsInUpload: payload.categoryStats.brandsInUpload,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
