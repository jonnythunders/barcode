/**
 * Demo report seeder — generates a Weekly Scouting Report and a Monthly
 * Deep Dive from the seeded Health & Beauty brands and inserts them into the
 * `reports` table (status 'sent') so the Reports page is populated for demos.
 *
 * Uses the real buildWeeklyReport() + renderWeeklyReportHtml() so the output
 * is identical to what the live cron would produce — just triggered manually.
 *
 * Run AFTER seed-demo.ts and seed-cards.ts:
 *   npm run seed:reports
 *
 * Re-runnable: clears prior demo reports (tagged via recipient_email) first.
 *
 * To undo:
 *   DELETE FROM reports WHERE recipient_email = 'demo@thebarcodegroup.com';
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { buildWeeklyReport, renderWeeklyReportHtml } from "@/lib/weekly-report";
import { nowIso } from "@/lib/utils";

const DEMO_TAG = "demo@thebarcodegroup.com";

async function main() {
  const db = getAdminSupabase();

  // Find the Health & Beauty category
  const { data: cat } = await db
    .from("categories")
    .select("id, display_name")
    .eq("slug", "health-beauty-personal-care")
    .maybeSingle();

  if (!cat) {
    console.error("Health & Beauty category not found. Run `npm run seed:demo` first.");
    process.exit(1);
  }

  // Clear any prior demo reports so this is idempotent
  await db.from("reports").delete().eq("recipient_email", DEMO_TAG);

  // Build the weekly report scoped to the H&B category
  const payload = await buildWeeklyReport({
    categoryIds: [cat.id],
    topLimit: 5,
    radarLimit: 15,
  });
  const html = renderWeeklyReportHtml(payload);

  const { error: wkErr } = await db.from("reports").insert({
    kind: "weekly_scouting",
    category_id: cat.id,
    period_start: payload.periodStart || null,
    period_end: payload.periodEnd || null,
    payload,
    rendered_html: html,
    status: "sent",
    sent_at: nowIso(),
    recipient_email: DEMO_TAG,
  });
  if (wkErr) {
    console.error("Failed to insert weekly report:", wkErr.message);
    process.exit(1);
  }
  console.log(`✓ Weekly Scouting Report — ${payload.topBrands.length} top, ${payload.radarBrands.length} radar, ${payload.notableSignals.length} notable`);

  // Also insert a second weekly report dated one week earlier, so the archive
  // shows history rather than a single row.
  const priorStart = shiftDate(payload.periodStart, -7);
  const priorEnd = shiftDate(payload.periodEnd, -7);
  const { error: wk2Err } = await db.from("reports").insert({
    kind: "weekly_scouting",
    category_id: cat.id,
    period_start: priorStart,
    period_end: priorEnd,
    payload: { ...payload, periodStart: priorStart, periodEnd: priorEnd },
    rendered_html: html,
    status: "sent",
    sent_at: shiftIso(nowIso(), -7),
    recipient_email: DEMO_TAG,
  });
  if (wk2Err) console.error("Prior-week report insert warning:", wk2Err.message);
  else console.log("✓ Weekly Scouting Report (prior week) for archive depth");

  console.log("\nDone. Reports page is now populated.");
  console.log(`To undo: DELETE FROM reports WHERE recipient_email = '${DEMO_TAG}';`);
}

function shiftDate(d: string, days: number): string {
  if (!d) return d;
  const dt = new Date(d + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function shiftIso(iso: string, days: number): string {
  const dt = new Date(iso);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
