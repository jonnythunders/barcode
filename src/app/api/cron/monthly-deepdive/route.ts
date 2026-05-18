/**
 * /api/cron/monthly-deepdive
 *
 * 1st-of-the-month job: build a deep dive from the most recent Nielsen
 * upload in the past 45 days, per category that has data, and email each
 * to the salespeople covering that category.
 *
 * Why "most recent upload": Module 3 is semi-automated — Barcode uploads
 * a Nielsen file when they get it. The cron just picks up whatever they
 * uploaded most recently.
 *
 * If no upload exists in the lookback window, the cron is a no-op and
 * returns a clear summary saying so. Better to skip than send empty reports.
 */
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { verifyCronSecret, getAdminSupabase } from "@/lib/supabase-admin";
import { getServerEnv, getFeatureFlags } from "@/lib/env";
import { buildMonthlyDeepDive, renderDeepDiveHtml } from "@/lib/nielsen/deep-dive";
import { nowIso } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LOOKBACK_DAYS = 45;

export async function GET(request: Request) { return handle(request); }
export async function POST(request: Request) { return handle(request); }

async function handle(request: Request) {
  try {
    verifyCronSecret(request);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const db = getAdminSupabase();
  const env = getServerEnv();
  const flags = getFeatureFlags(env);
  const resend = flags.emailEnabled ? new Resend(env.resendApiKey!) : null;

  // Find the most recent upload
  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: uploads } = await db
    .from("nielsen_uploads")
    .select("id, filename, created_at")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(1);

  if (!uploads || uploads.length === 0) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: `No Nielsen uploads in the past ${LOOKBACK_DAYS} days`,
      durationMs: Date.now() - startedAt,
    });
  }
  const upload = uploads[0];

  // Figure out which categories the upload touches
  const { data: catRows } = await db
    .from("nielsen_rows")
    .select("category_id")
    .eq("upload_id", upload.id)
    .not("category_id", "is", null);
  const categoryIds = Array.from(new Set((catRows ?? []).map((r) => r.category_id as string)));

  // Pull salespeople and which of these categories they cover
  const { data: salespeople } = await db
    .from("salespeople")
    .select("id, display_name, email, category_ids, weekly_report_enabled")
    .eq("is_active", true);

  const generated: Array<{ recipientEmail: string; reportId: string; sent: boolean; sendError: string | null; categoryIds: string[] }> = [];
  let failed = 0;

  if (categoryIds.length === 0) {
    // Generate one un-scoped report and email it to anyone who's active
    const payload = await buildMonthlyDeepDive({ uploadId: upload.id });
    const html = renderDeepDiveHtml(payload);
    for (const sp of salespeople ?? []) {
      if (!sp.email) continue;
      const r = await deliver(db, resend, env.resendFromEmail, sp.email, payload, html, null);
      generated.push({ recipientEmail: sp.email, reportId: r.reportId, sent: r.sent, sendError: r.sendError, categoryIds: [] });
      if (!r.sent && r.sendError) failed++;
    }
  } else {
    // Per-salesperson, scoped to the intersection of their categories with the upload's
    for (const sp of salespeople ?? []) {
      if (!sp.email) continue;
      const spCats = (sp.category_ids ?? []) as string[];
      const relevant = spCats.filter((c) => categoryIds.includes(c));
      if (relevant.length === 0) continue; // upload doesn't touch their categories

      try {
        const payload = await buildMonthlyDeepDive({ uploadId: upload.id, categoryIds: relevant });
        const html = renderDeepDiveHtml(payload);
        const r = await deliver(db, resend, env.resendFromEmail, sp.email, payload, html, relevant[0]);
        generated.push({ recipientEmail: sp.email, reportId: r.reportId, sent: r.sent, sendError: r.sendError, categoryIds: relevant });
        if (!r.sent && r.sendError) failed++;
      } catch (err) {
        failed++;
        console.error(`[monthly-deepdive] ${sp.email} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  return NextResponse.json({
    ok: true,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: nowIso(),
    uploadId: upload.id,
    uploadFilename: upload.filename,
    categoriesInUpload: categoryIds.length,
    reportsGenerated: generated.length,
    reportsFailed: failed,
    perReport: generated,
    durationMs: Date.now() - startedAt,
  });
}

async function deliver(
  db: ReturnType<typeof getAdminSupabase>,
  resend: Resend | null,
  fromEmail: string,
  toEmail: string,
  payload: Awaited<ReturnType<typeof buildMonthlyDeepDive>>,
  html: string,
  primaryCategoryId: string | null
): Promise<{ reportId: string; sent: boolean; sendError: string | null }> {
  const { data: reportRow } = await db
    .from("reports")
    .insert({
      kind: "monthly_deep_dive",
      category_id: primaryCategoryId,
      period_start: payload.periodStart,
      period_end: payload.periodEnd,
      payload,
      rendered_html: html,
      status: "generating",
      recipient_email: toEmail,
    })
    .select("id")
    .single();

  if (!reportRow) {
    return { reportId: "", sent: false, sendError: "Persist failed" };
  }

  let sent = false;
  let sendError: string | null = null;
  if (resend) {
    const subject = `Monthly Deep Dive · ${payload.categories.map((c) => c.displayName).join(", ") || "Category"}`;
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: toEmail,
      subject,
      html,
    });
    if (error) sendError = error.message;
    else sent = true;
  } else {
    sendError = "Resend not configured (report still archived)";
  }

  await db
    .from("reports")
    .update({
      status: sent ? "sent" : "failed",
      sent_at: sent ? nowIso() : null,
      error_message: sendError,
    })
    .eq("id", reportRow.id);

  return { reportId: reportRow.id, sent, sendError };
}
