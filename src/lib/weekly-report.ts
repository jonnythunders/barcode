/**
 * Weekly Scouting Report — payload assembly + HTML rendering.
 *
 * Per PRD §5.3:
 *   - Personalized: each salesperson gets only their assigned categories
 *   - Sections:
 *       * Top 5 Brands to Watch This Week (highest Momentum Score in their categories)
 *       * Brands on Your Radar (full ranked list, 6-20)
 *       * Trending Hashtags (TODO V2 — needs hashtag-volume tracking)
 *       * Notable Signals (brands with notInRetail=true and high momentum)
 *   - Each entry: Momentum Score, follower counts, WoW change, Amazon
 *     signals, 1-line summary, recommended action
 *   - Schedule: poll Saturday night, send Monday 7am
 *
 * This file is the report-data builder + HTML renderer; the cron route
 * that emails it lives at /api/cron/weekly-report.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { publicEnv } from "@/lib/env";
import { formatCompactNumber, formatPctDelta, nowIso } from "@/lib/utils";
import type { Salesperson } from "@/lib/types";

// =========================================================================
// Types
// =========================================================================

export interface WeeklyReportEntry {
  brandId: string;
  brandName: string;
  brandSlug: string;
  momentumScore: number | null;
  notInRetail: boolean;
  recommendedAction: "call_now" | "watch" | "skip" | null;
  // Headline signals — small, designed to fit in an email row
  tiktokFollowers: number | null;
  tiktokGrowthPct: number | null;
  igFollowers: number | null;
  amazonStars: number | null;
  amazonReviews: number | null;
  amazonBsrRank: number | null;
  trendsYoyPct: number | null;
  redditVelocity: number | null;
  narrative: string | null;
}

export interface WeeklyReportPayload {
  generatedAt: string;
  periodStart: string;          // ISO date (Mon of last week)
  periodEnd: string;            // ISO date (Sun of last week)
  salesperson: {
    id: string | null;
    displayName: string | null;
    email: string | null;
  };
  categories: { id: string; displayName: string; slug: string }[];
  topBrands: WeeklyReportEntry[];      // up to 5 — the Watch This Week list
  radarBrands: WeeklyReportEntry[];    // next 6-20
  notableSignals: WeeklyReportEntry[]; // notInRetail && momentum >= 60
  brandsConsidered: number;
}

// =========================================================================
// Build payload
// =========================================================================

interface BuildOptions {
  salespersonId?: string | null;       // null = unscoped (general report)
  categoryIds?: string[];              // override; otherwise pulled from salesperson row
  topLimit?: number;
  radarLimit?: number;
}

export async function buildWeeklyReport(opts: BuildOptions = {}): Promise<WeeklyReportPayload> {
  const db = getAdminSupabase();

  // Resolve salesperson + categories
  let salesperson: Salesperson | null = null;
  if (opts.salespersonId) {
    const { data } = await db.from("salespeople").select("*").eq("id", opts.salespersonId).maybeSingle();
    if (data) {
      salesperson = {
        id: data.id,
        authUserId: data.auth_user_id ?? null,
        displayName: data.display_name,
        email: data.email,
        categoryIds: data.category_ids ?? [],
        isActive: data.is_active,
        weeklyReportEnabled: data.weekly_report_enabled,
        weeklyReportDay: data.weekly_report_day,
        weeklyReportHour: data.weekly_report_hour,
        timezone: data.timezone,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      };
    }
  }

  const categoryIds =
    opts.categoryIds && opts.categoryIds.length > 0
      ? opts.categoryIds
      : salesperson?.categoryIds ?? [];

  const { data: catRows } = await db
    .from("categories")
    .select("id, display_name, slug")
    .in("id", categoryIds.length > 0 ? categoryIds : ["00000000-0000-0000-0000-000000000000"]);

  const categories =
    (catRows ?? []).map((c: { id: string; display_name: string; slug: string }) => ({
      id: c.id,
      displayName: c.display_name,
      slug: c.slug,
    }));

  // Pull all monitored brands in those categories (or all if no cats)
  let brandsQuery = db
    .from("brands")
    .select("id, name, slug, primary_category_id")
    .eq("is_monitored", true)
    .eq("is_archived", false);
  if (categoryIds.length > 0) {
    brandsQuery = brandsQuery.in("primary_category_id", categoryIds);
  }
  const { data: brands } = await brandsQuery;
  const brandsConsidered = brands?.length ?? 0;

  if (!brands || brands.length === 0) {
    return emptyReport(salesperson, categories);
  }

  // Build entries with their headline signals
  const entries: WeeklyReportEntry[] = [];
  for (const b of brands) {
    const entry = await buildEntryForBrand(b.id, b.name, b.slug);
    if (entry) entries.push(entry);
  }

  // Sort by momentum desc (nulls last)
  entries.sort((a, b) => (b.momentumScore ?? -1) - (a.momentumScore ?? -1));

  const topLimit = opts.topLimit ?? 5;
  const radarLimit = opts.radarLimit ?? 15;

  const topBrands = entries.filter((e) => e.momentumScore != null).slice(0, topLimit);
  const radarBrands = entries
    .filter((e) => e.momentumScore != null)
    .slice(topLimit, topLimit + radarLimit);
  const notableSignals = entries.filter((e) => e.notInRetail && (e.momentumScore ?? 0) >= 60).slice(0, 5);

  // Period: last completed Mon-Sun
  const now = new Date();
  const day = now.getUTCDay();
  const daysSinceLastSunday = day === 0 ? 7 : day;
  const lastSunday = new Date(now);
  lastSunday.setUTCDate(now.getUTCDate() - daysSinceLastSunday);
  const lastMonday = new Date(lastSunday);
  lastMonday.setUTCDate(lastSunday.getUTCDate() - 6);

  return {
    generatedAt: nowIso(),
    periodStart: lastMonday.toISOString().slice(0, 10),
    periodEnd: lastSunday.toISOString().slice(0, 10),
    salesperson: {
      id: salesperson?.id ?? null,
      displayName: salesperson?.displayName ?? null,
      email: salesperson?.email ?? null,
    },
    categories,
    topBrands,
    radarBrands,
    notableSignals,
    brandsConsidered,
  };
}

function emptyReport(
  salesperson: Salesperson | null,
  categories: { id: string; displayName: string; slug: string }[]
): WeeklyReportPayload {
  return {
    generatedAt: nowIso(),
    periodStart: "",
    periodEnd: "",
    salesperson: {
      id: salesperson?.id ?? null,
      displayName: salesperson?.displayName ?? null,
      email: salesperson?.email ?? null,
    },
    categories,
    topBrands: [],
    radarBrands: [],
    notableSignals: [],
    brandsConsidered: 0,
  };
}

// =========================================================================
// Per-brand entry assembly (cached signals only — no fresh fetches)
// =========================================================================

async function buildEntryForBrand(brandId: string, brandName: string, brandSlug: string): Promise<WeeklyReportEntry | null> {
  const db = getAdminSupabase();

  // Latest momentum snapshot (and its notInRetail flag from value_json)
  const { data: momentumRow } = await db
    .from("snapshots")
    .select("value_numeric, value_json, captured_at")
    .eq("brand_id", brandId)
    .eq("platform", "derived")
    .eq("metric", "momentum_score")
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const score = momentumRow?.value_numeric ?? null;
  const notInRetail =
    (momentumRow?.value_json as { notInRetail?: boolean } | null)?.notInRetail ?? false;

  // Latest headline signals
  const [tiktokFol, tiktokGrowth, igFol, amazonStars, amazonReviews, amazonBsr, trendsYoy, redditVel, narrativeRow] = await Promise.all([
    latestNumeric(db, brandId, "tiktok", "follower_count"),
    monthOverMonthPct(db, brandId, "tiktok", "follower_count"),
    latestNumeric(db, brandId, "instagram", "follower_count"),
    latestNumeric(db, brandId, "amazon", "star_rating"),
    latestNumeric(db, brandId, "amazon", "review_count"),
    latestNumeric(db, brandId, "amazon", "bsr_rank"),
    latestNumeric(db, brandId, "google_trends", "search_volume_yoy_pct"),
    latestNumeric(db, brandId, "reddit", "mention_velocity"),
    latestNarrative(db, brandId),
  ]);

  const recommendedAction =
    score == null ? null : score >= 70 && notInRetail ? "call_now" : score >= 50 ? "watch" : "skip";

  return {
    brandId,
    brandName,
    brandSlug,
    momentumScore: score,
    notInRetail,
    recommendedAction,
    tiktokFollowers: tiktokFol,
    tiktokGrowthPct: tiktokGrowth,
    igFollowers: igFol,
    amazonStars,
    amazonReviews,
    amazonBsrRank: amazonBsr,
    trendsYoyPct: trendsYoy,
    redditVelocity: redditVel,
    narrative: narrativeRow,
  };
}

async function latestNumeric(
  db: ReturnType<typeof getAdminSupabase>,
  brandId: string,
  platform: string,
  metric: string
): Promise<number | null> {
  const { data } = await db
    .from("snapshots")
    .select("value_numeric")
    .eq("brand_id", brandId)
    .eq("platform", platform)
    .eq("metric", metric)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.value_numeric ?? null;
}

async function monthOverMonthPct(
  db: ReturnType<typeof getAdminSupabase>,
  brandId: string,
  platform: string,
  metric: string
): Promise<number | null> {
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await db
    .from("snapshots")
    .select("value_numeric, captured_at")
    .eq("brand_id", brandId)
    .eq("platform", platform)
    .eq("metric", metric)
    .gte("captured_at", since)
    .order("captured_at", { ascending: false });
  if (!data || data.length < 2) return null;
  const latest = data[0];
  if (latest.value_numeric == null) return null;
  const targetTime = new Date(latest.captured_at).getTime() - 30 * 24 * 60 * 60 * 1000;
  let prior: { value_numeric: number | null; captured_at: string } | null = null;
  let bestDelta = Infinity;
  for (const row of data) {
    const delta = Math.abs(new Date(row.captured_at).getTime() - targetTime);
    if (delta < bestDelta) {
      bestDelta = delta;
      prior = row;
    }
  }
  if (!prior || prior.value_numeric == null || prior.value_numeric <= 0) return null;
  return (latest.value_numeric - prior.value_numeric) / prior.value_numeric;
}

async function latestNarrative(
  db: ReturnType<typeof getAdminSupabase>,
  brandId: string
): Promise<string | null> {
  // Narratives live in `brand_card_cache.payload.narrative`. Cheaper to
  // read than regenerate.
  const { data } = await db
    .from("brand_card_cache")
    .select("payload")
    .eq("brand_id", brandId)
    .maybeSingle();
  if (!data) return null;
  const payload = data.payload as { narrative?: string };
  return payload.narrative ?? null;
}

// =========================================================================
// HTML rendering
//
// Email-safe HTML: inline styles, table-based layout. No external CSS.
// =========================================================================

export function renderWeeklyReportHtml(payload: WeeklyReportPayload): string {
  const appUrl = publicEnv.appUrl.replace(/\/$/, "");
  const greeting = payload.salesperson.displayName
    ? `Hi ${payload.salesperson.displayName.split(" ")[0]},`
    : "Hi there,";
  const catList = payload.categories.map((c) => c.displayName).join(", ") || "all categories";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Weekly Brand Radar</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f8fafc;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,0.06)">

        <!-- Header -->
        <tr><td style="padding:24px 32px 16px 32px;border-bottom:1px solid #e2e8f0">
          <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#94a3b8">Barcode · Weekly Brand Radar</p>
          <h1 style="margin:6px 0 0 0;font-size:22px;font-weight:600;color:#0f172a">Top brands to call this week</h1>
          <p style="margin:6px 0 0 0;font-size:13px;color:#64748b">${escape(payload.periodStart)} – ${escape(payload.periodEnd)} · ${escape(catList)}</p>
        </td></tr>

        <!-- Greeting -->
        <tr><td style="padding:20px 32px 8px 32px;font-size:14px;color:#334155">
          <p style="margin:0 0 12px 0">${escape(greeting)}</p>
          <p style="margin:0">${
            payload.topBrands.length > 0
              ? `Here&rsquo;s what the signals are surfacing this week across <strong>${escape(catList)}</strong>. We looked at ${payload.brandsConsidered} monitored brand${payload.brandsConsidered === 1 ? "" : "s"} and ranked them by momentum.`
              : `Nothing of note hit the threshold this week. Once your monitored brands accumulate a few more weekly snapshots, the Top section will fill out.`
          }</p>
        </td></tr>

        ${renderTopSection(payload.topBrands, appUrl)}
        ${renderNotableSection(payload.notableSignals, appUrl)}
        ${renderRadarSection(payload.radarBrands, appUrl)}

        <!-- Footer -->
        <tr><td style="padding:20px 32px 24px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8">
          <p style="margin:0">Generated ${escape(payload.generatedAt.slice(0, 19).replace("T", " "))} UTC. Reply to this email or ping Barry in-app to dig deeper on any of these.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function renderTopSection(entries: WeeklyReportEntry[], appUrl: string): string {
  if (entries.length === 0) return "";
  return `<tr><td style="padding:24px 32px 8px 32px">
    <h2 style="margin:0 0 12px 0;font-size:15px;font-weight:600;color:#0f172a">⭐ Top brands to watch</h2>
    ${entries.map((e, i) => renderTopEntry(e, i + 1, appUrl)).join("")}
  </td></tr>`;
}

function renderTopEntry(e: WeeklyReportEntry, rank: number, appUrl: string): string {
  const actionPill = renderActionPill(e.recommendedAction, e.notInRetail);
  const scoreColor = (e.momentumScore ?? 0) >= 70 ? "#16a34a" : (e.momentumScore ?? 0) >= 50 ? "#d97706" : "#64748b";
  const signals = renderSignalLine(e);
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 8px 0">
    <tr>
      <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          <tr>
            <td valign="top" style="padding-right:12px">
              <p style="margin:0;font-size:11px;color:#94a3b8">#${rank}</p>
              <a href="${appUrl}/brand-card/${encodeURIComponent(e.brandSlug)}" style="text-decoration:none;color:#0f172a">
                <p style="margin:2px 0 0 0;font-size:15px;font-weight:600">${escape(e.brandName)}</p>
              </a>
              <p style="margin:4px 0 0 0;font-size:12px;color:#475569">${signals}</p>
              ${e.narrative ? `<p style="margin:6px 0 0 0;font-size:12px;color:#334155;font-style:italic">${escape(e.narrative)}</p>` : ""}
            </td>
            <td valign="top" align="right" width="100" style="text-align:right">
              <div style="display:inline-block;background:${scoreColor}1a;color:${scoreColor};border-radius:6px;padding:6px 10px;text-align:center;min-width:62px">
                <div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.8">Momentum</div>
                <div style="font-size:20px;font-weight:700;line-height:1">${e.momentumScore ?? "—"}</div>
              </div>
              <div style="margin-top:6px">${actionPill}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

function renderNotableSection(entries: WeeklyReportEntry[], appUrl: string): string {
  if (entries.length === 0) return "";
  return `<tr><td style="padding:16px 32px 8px 32px">
    <h2 style="margin:0 0 12px 0;font-size:15px;font-weight:600;color:#0f172a">🚨 Not yet in retail</h2>
    <p style="margin:0 0 10px 0;font-size:12px;color:#64748b">High social momentum, absent from Nielsen — Barcode&rsquo;s call-now quadrant.</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      ${entries.map((e) => `<tr><td style="padding:8px 0;border-bottom:1px solid #e2e8f0">
        <a href="${appUrl}/brand-card/${encodeURIComponent(e.brandSlug)}" style="text-decoration:none;color:#0f172a;font-size:13px;font-weight:500">${escape(e.brandName)}</a>
        <span style="font-size:12px;color:#64748b"> · momentum ${e.momentumScore ?? "—"}</span>
      </td></tr>`).join("")}
    </table>
  </td></tr>`;
}

function renderRadarSection(entries: WeeklyReportEntry[], appUrl: string): string {
  if (entries.length === 0) return "";
  return `<tr><td style="padding:16px 32px 8px 32px">
    <h2 style="margin:0 0 12px 0;font-size:15px;font-weight:600;color:#0f172a">📡 Also on your radar</h2>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      ${entries.map((e) => `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:13px">
          <a href="${appUrl}/brand-card/${encodeURIComponent(e.brandSlug)}" style="text-decoration:none;color:#0f172a">${escape(e.brandName)}</a>
        </td>
        <td style="padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b;text-align:right">${e.momentumScore ?? "—"}</td>
      </tr>`).join("")}
    </table>
  </td></tr>`;
}

function renderSignalLine(e: WeeklyReportEntry): string {
  const parts: string[] = [];
  if (e.tiktokFollowers != null) {
    const growth = e.tiktokGrowthPct != null ? ` (${formatPctDelta(e.tiktokGrowthPct)})` : "";
    parts.push(`TT ${formatCompactNumber(e.tiktokFollowers)}${growth}`);
  }
  if (e.igFollowers != null) parts.push(`IG ${formatCompactNumber(e.igFollowers)}`);
  if (e.amazonStars != null) {
    parts.push(
      `Amz ${e.amazonStars.toFixed(1)}★${e.amazonReviews != null ? ` (${formatCompactNumber(e.amazonReviews)})` : ""}`
    );
  }
  if (e.amazonBsrRank != null) parts.push(`BSR #${e.amazonBsrRank}`);
  if (e.trendsYoyPct != null) parts.push(`Trends ${formatPctDelta(e.trendsYoyPct)}`);
  return parts.join(" · ") || "Signals accumulating…";
}

function renderActionPill(action: WeeklyReportEntry["recommendedAction"], notInRetail: boolean): string {
  if (!action) return "";
  const styles: Record<string, { bg: string; fg: string; label: string }> = {
    call_now: { bg: "#dcfce7", fg: "#166534", label: "Call now" },
    watch: { bg: "#fef3c7", fg: "#92400e", label: "Watch" },
    skip: { bg: "#f1f5f9", fg: "#475569", label: "Skip" },
  };
  const s = styles[action] ?? styles.skip;
  const label = action === "call_now" && notInRetail ? "Call now · DTC" : s.label;
  return `<span style="display:inline-block;background:${s.bg};color:${s.fg};border-radius:999px;padding:3px 8px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">${label}</span>`;
}

function escape(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
