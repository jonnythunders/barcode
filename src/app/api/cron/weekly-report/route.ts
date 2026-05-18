/**
 * /api/cron/weekly-report
 *
 * Monday-morning send job (PRD §5.3). Builds + delivers the Weekly
 * Scouting Report for every active salesperson with weekly_report_enabled.
 *
 * Each salesperson gets:
 *   - Their own personalized report (their categories only)
 *   - One `reports` row written for the audit trail
 *   - One email if Resend is configured
 *
 * Also picks up any reports already queued in 'pending' status (e.g. via
 * Barry's `queue_weekly_report` tool) and processes them.
 *
 * Failure handling: per-salesperson failures don't abort the run. Each
 * failure becomes a `reports` row with `status='failed'` + error_message.
 */
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { getServerEnv, getFeatureFlags } from "@/lib/env";
import { verifyCronSecret, getAdminSupabase } from "@/lib/supabase-admin";
import { buildWeeklyReport, renderWeeklyReportHtml, type WeeklyReportPayload } from "@/lib/weekly-report";
import { nowIso } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface CronResult {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  salespeople: { attempted: number; sent: number; failed: number; skipped: number };
  queued: { attempted: number; sent: number; failed: number };
  totalDurationMs: number;
}

export async function GET(request: Request) { return handle(request); }
export async function POST(request: Request) { return handle(request); }

async function handle(request: Request): Promise<NextResponse<CronResult | { error: string }>> {
  try {
    verifyCronSecret(request);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const env = getServerEnv();
  const flags = getFeatureFlags(env);
  const resend = flags.emailEnabled ? new Resend(env.resendApiKey!) : null;
  const db = getAdminSupabase();

  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  // -----------------------------------------------------------------
  // Per-salesperson scheduled reports
  // -----------------------------------------------------------------
  const { data: salespeople } = await db
    .from("salespeople")
    .select("id, display_name, email, category_ids, weekly_report_enabled, is_active")
    .eq("is_active", true)
    .eq("weekly_report_enabled", true);

  for (const sp of salespeople ?? []) {
    attempted++;
    try {
      const payload = await buildWeeklyReport({ salespersonId: sp.id });
      const html = renderWeeklyReportHtml(payload);

      // Skip empty reports — don't spam reps when there's literally nothing
      if (payload.topBrands.length === 0 && payload.radarBrands.length === 0 && payload.notableSignals.length === 0) {
        skipped++;
        await insertReportRow(db, payload, sp.id, html, "sent", null, "Empty week — nothing to surface yet");
        continue;
      }

      const deliveryResult = await deliverIfPossible(resend, env.resendFromEmail, sp.email, payload, html);
      if (deliveryResult.sent) {
        sent++;
        await insertReportRow(db, payload, sp.id, html, "sent", sp.email, null);
      } else {
        // Resend disabled — still archive the report, just mark it as generated-not-sent
        await insertReportRow(db, payload, sp.id, html, "sent", null, "Email not configured; report archived only");
      }
    } catch (err) {
      failed++;
      console.error(`[weekly-report] ${sp.email}: ${err instanceof Error ? err.message : err}`);
      await db.from("reports").insert({
        kind: "weekly_scouting",
        salesperson_id: sp.id,
        payload: { error: err instanceof Error ? err.message : String(err) },
        status: "failed",
        error_message: err instanceof Error ? err.message : String(err),
        recipient_email: sp.email,
      });
    }
  }

  // -----------------------------------------------------------------
  // Queued reports (Barry's queue_weekly_report tool put these here)
  // -----------------------------------------------------------------
  const { data: queued } = await db
    .from("reports")
    .select("id, salesperson_id, recipient_email, payload")
    .eq("kind", "weekly_scouting")
    .eq("status", "pending");

  let qAttempted = 0;
  let qSent = 0;
  let qFailed = 0;
  for (const r of queued ?? []) {
    qAttempted++;
    try {
      const payload = await buildWeeklyReport({ salespersonId: r.salesperson_id });
      const html = renderWeeklyReportHtml(payload);
      const recipient = r.recipient_email ?? payload.salesperson.email;
      const deliveryResult = await deliverIfPossible(resend, env.resendFromEmail, recipient, payload, html);
      await db
        .from("reports")
        .update({
          payload,
          rendered_html: html,
          status: "sent",
          sent_at: deliveryResult.sent ? nowIso() : null,
          recipient_email: recipient,
        })
        .eq("id", r.id);
      if (deliveryResult.sent) qSent++;
    } catch (err) {
      qFailed++;
      await db
        .from("reports")
        .update({
          status: "failed",
          error_message: err instanceof Error ? err.message : String(err),
        })
        .eq("id", r.id);
    }
  }

  const result: CronResult = {
    ok: true,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: nowIso(),
    salespeople: { attempted, sent, failed, skipped },
    queued: { attempted: qAttempted, sent: qSent, failed: qFailed },
    totalDurationMs: Date.now() - startedAt,
  };
  console.log(`[weekly-report] done`, result);
  return NextResponse.json(result);
}

// =========================================================================
// Helpers
// =========================================================================

async function insertReportRow(
  db: ReturnType<typeof getAdminSupabase>,
  payload: WeeklyReportPayload,
  salespersonId: string | null,
  html: string,
  status: "sent" | "failed",
  recipientEmail: string | null,
  errorMessage: string | null
) {
  await db.from("reports").insert({
    kind: "weekly_scouting",
    salesperson_id: salespersonId,
    payload,
    rendered_html: html,
    status,
    sent_at: status === "sent" && recipientEmail ? nowIso() : null,
    recipient_email: recipientEmail,
    error_message: errorMessage,
    period_start: payload.periodStart || null,
    period_end: payload.periodEnd || null,
  });
}

async function deliverIfPossible(
  resend: Resend | null,
  fromEmail: string,
  toEmail: string | null,
  payload: WeeklyReportPayload,
  html: string
): Promise<{ sent: boolean; error?: string }> {
  if (!resend || !toEmail) return { sent: false };
  try {
    const subject = `Weekly Brand Radar · ${payload.topBrands[0]?.brandName ?? "no calls this week"}`;
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: toEmail,
      subject,
      html,
    });
    if (error) return { sent: false, error: error.message };
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}
