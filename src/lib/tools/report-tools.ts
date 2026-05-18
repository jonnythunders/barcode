/**
 * Report tools — agent-facing wrappers around the reports table.
 *
 * The actual report-generation pipelines (weekly scouting + monthly deep
 * dive) live in their own modules and cron routes. These tools let the
 * agent queue an on-demand run and surface what's already in the archive.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { nowIso } from "@/lib/utils";

export async function executeQueueWeeklyReport(args: {
  salesperson_email?: string;
  category_slugs?: string[];
}) {
  const db = getAdminSupabase();

  let salespersonId: string | null = null;
  let recipientEmail: string | null = null;

  if (args.salesperson_email) {
    const { data } = await db
      .from("salespeople")
      .select("id, email")
      .ilike("email", args.salesperson_email)
      .maybeSingle();
    if (!data) return { error: `No salesperson with email "${args.salesperson_email}"` };
    salespersonId = data.id;
    recipientEmail = data.email;
  }

  const { data: report, error } = await db
    .from("reports")
    .insert({
      kind: "weekly_scouting",
      salesperson_id: salespersonId,
      payload: { queued_categories: args.category_slugs ?? null, queued_at: nowIso() },
      status: "pending",
      recipient_email: recipientEmail,
    })
    .select("id")
    .single();
  if (error) return { error: error.message };

  return {
    success: true,
    reportId: report.id,
    note:
      "Queued. The weekly poll + report job will pick this up on its next run, or you can " +
      "trigger /api/cron/weekly-report manually with the CRON_SECRET.",
  };
}

export async function executeListRecentReports(args: {
  kind?: "weekly_scouting" | "monthly_deep_dive" | "brand_card_export";
  salesperson_email?: string;
  limit?: number;
}) {
  const db = getAdminSupabase();
  let q = db
    .from("reports")
    .select("id, kind, salesperson_id, period_start, period_end, status, sent_at, recipient_email, created_at")
    .order("created_at", { ascending: false })
    .limit(Math.min(args.limit ?? 10, 50));

  if (args.kind) q = q.eq("kind", args.kind);

  if (args.salesperson_email) {
    const { data: sp } = await db
      .from("salespeople")
      .select("id")
      .ilike("email", args.salesperson_email)
      .maybeSingle();
    if (sp) q = q.eq("salesperson_id", sp.id);
  }

  const { data, error } = await q;
  if (error) return { error: error.message };
  return { reports: data ?? [], count: data?.length ?? 0 };
}

export async function executeGetReport(args: { report_id: string }) {
  const db = getAdminSupabase();
  const { data, error } = await db
    .from("reports")
    .select("*")
    .eq("id", args.report_id)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: `Report "${args.report_id}" not found` };
  return data;
}
