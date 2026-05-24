/**
 * Monthly Deep Dive — Module 3 report builder (PRD §6.4).
 *
 * Generates the category landscape report that Barcode brings to Target
 * buyer meetings. Built on top of:
 *   - The Nielsen upload + reconciliation
 *   - The quadrant analysis (`quadrant.ts`)
 *   - Snapshot history per brand
 *   - Claude-generated opportunity narrative
 *
 * Output:
 *   - Structured payload (saved to `reports.payload`)
 *   - Email-safe HTML (saved to `reports.rendered_html`) with an embedded
 *     SVG quadrant plot
 *
 * The narrative is intentionally short and action-oriented — 3-4 sentences
 * naming specific brands and what to do about them. Not an essay.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getAdminSupabase } from "@/lib/supabase-admin";
import { getServerEnv, publicEnv } from "@/lib/env";
import { computeQuadrant, type QuadrantResult } from "./quadrant";
import { formatCompactNumber, nowIso, formatPctDelta } from "@/lib/utils";
import type { QuadrantEntry } from "@/lib/types";

// =========================================================================
// Types
// =========================================================================

export interface DeepDivePayload {
  uploadId: string;
  generatedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  categories: { id: string; displayName: string; slug: string }[];
  // Category-level totals from the upload
  categoryStats: {
    totalDollars: number;
    totalUnits: number;
    brandsInUpload: number;
    avgYoyGrowthPct: number | null;
  };
  // Quadrant result + plot data
  quadrant: QuadrantResult;
  // Per-quadrant top brands (with extra signals for the report)
  topByQuadrant: Record<"call_now" | "established" | "incumbent" | "skip", DeepDiveBrandRow[]>;
  // Brands present in social but absent from Nielsen entirely
  notInRetail: DeepDiveBrandRow[];
  // Claude-generated narrative
  narrative: string | null;
}

export interface DeepDiveBrandRow {
  brandId: string;
  brandName: string;
  brandSlug: string;
  socialMomentum: number;
  retailVelocity: number;
  retailDollars: number | null;
  retailYoyPct: number | null;
  tiktokFollowers: number | null;
  igFollowers: number | null;
  amazonStars: number | null;
  amazonReviews: number | null;
  notInNielsen: boolean;
}

export interface BuildDeepDiveOptions {
  uploadId: string;
  /** Restrict the report to specific categories. If omitted, all categories present in the upload. */
  categoryIds?: string[];
}

// =========================================================================
// Builder
// =========================================================================

export async function buildMonthlyDeepDive(opts: BuildDeepDiveOptions): Promise<DeepDivePayload> {
  const db = getAdminSupabase();

  // Upload metadata
  const { data: upload } = await db
    .from("nielsen_uploads")
    .select("id, period_start, period_end, source_kind")
    .eq("id", opts.uploadId)
    .maybeSingle();
  if (!upload) throw new Error(`Upload ${opts.uploadId} not found`);

  // Categories present in the upload (and/or filter)
  const { data: catRows } = await db
    .from("nielsen_rows")
    .select("category_id")
    .eq("upload_id", opts.uploadId)
    .not("category_id", "is", null);
  let categoryIds = Array.from(new Set((catRows ?? []).map((r) => r.category_id as string)));
  if (opts.categoryIds && opts.categoryIds.length > 0) {
    categoryIds = categoryIds.filter((id) => opts.categoryIds!.includes(id));
  }
  const { data: cats } = await db
    .from("categories")
    .select("id, display_name, slug")
    .in("id", categoryIds.length > 0 ? categoryIds : ["00000000-0000-0000-0000-000000000000"]);
  const categories = (cats ?? []).map((c) => ({
    id: c.id,
    displayName: c.display_name,
    slug: c.slug,
  }));

  // Category-level aggregates
  const { data: aggRows } = await db
    .from("nielsen_rows")
    .select("sales_dollars, sales_units, yoy_growth_pct, brand_id")
    .eq("upload_id", opts.uploadId);

  let totalDollars = 0;
  let totalUnits = 0;
  const yoyValues: number[] = [];
  const brandsSet = new Set<string>();
  const retailByBrand = new Map<string, { dollars: number; yoy: number | null }>();
  for (const r of aggRows ?? []) {
    totalDollars += r.sales_dollars ?? 0;
    totalUnits += r.sales_units ?? 0;
    if (r.yoy_growth_pct != null) yoyValues.push(r.yoy_growth_pct);
    if (r.brand_id) {
      brandsSet.add(r.brand_id);
      const existing = retailByBrand.get(r.brand_id) ?? { dollars: 0, yoy: null };
      existing.dollars += r.sales_dollars ?? 0;
      if (r.yoy_growth_pct != null) existing.yoy = r.yoy_growth_pct;
      retailByBrand.set(r.brand_id, existing);
    }
  }
  const avgYoy = yoyValues.length > 0 ? yoyValues.reduce((a, b) => a + b, 0) / yoyValues.length : null;

  // Quadrant computation
  const quadrant = await computeQuadrant({
    uploadId: opts.uploadId,
    categoryIds: categoryIds.length > 0 ? categoryIds : undefined,
  });

  // Per-brand signal enrichment for the report rows
  const brandIds = quadrant.entries.map((e) => e.brandId);
  const signalsByBrand = await loadBrandSignals(brandIds);

  const buildRow = (e: QuadrantEntry): DeepDiveBrandRow => {
    const retail = retailByBrand.get(e.brandId);
    const sig = signalsByBrand.get(e.brandId) ?? {};
    return {
      brandId: e.brandId,
      brandName: e.brandName,
      brandSlug: sig.slug ?? "",
      socialMomentum: e.socialMomentum,
      retailVelocity: e.retailVelocity,
      retailDollars: retail?.dollars ?? null,
      retailYoyPct: retail?.yoy ?? null,
      tiktokFollowers: sig.tiktokFollowers ?? null,
      igFollowers: sig.igFollowers ?? null,
      amazonStars: sig.amazonStars ?? null,
      amazonReviews: sig.amazonReviews ?? null,
      notInNielsen: !retail || retail.dollars === 0,
    };
  };

  const allRows = quadrant.entries.map(buildRow);

  const byQuadrant: DeepDivePayload["topByQuadrant"] = {
    call_now: [],
    established: [],
    incumbent: [],
    skip: [],
  };
  for (const row of allRows) {
    const e = quadrant.entries.find((q) => q.brandId === row.brandId);
    if (!e) continue;
    byQuadrant[e.quadrant].push(row);
  }
  // Limit each quadrant to top 8 by social momentum
  for (const q of Object.keys(byQuadrant) as Array<keyof typeof byQuadrant>) {
    byQuadrant[q] = byQuadrant[q].sort((a, b) => b.socialMomentum - a.socialMomentum).slice(0, 8);
  }

  const notInRetail = allRows
    .filter((r) => r.notInNielsen && r.socialMomentum >= 50)
    .sort((a, b) => b.socialMomentum - a.socialMomentum)
    .slice(0, 10);

  // Narrative
  const narrative = await generateDeepDiveNarrative({
    categories,
    quadrant,
    callNowTop: byQuadrant.call_now,
    notInRetail,
    totalDollars,
    avgYoy,
  });

  return {
    uploadId: opts.uploadId,
    generatedAt: nowIso(),
    periodStart: upload.period_start,
    periodEnd: upload.period_end,
    categories,
    categoryStats: {
      totalDollars,
      totalUnits,
      brandsInUpload: brandsSet.size,
      avgYoyGrowthPct: avgYoy,
    },
    quadrant,
    topByQuadrant: byQuadrant,
    notInRetail,
    narrative,
  };
}

// =========================================================================
// Per-brand signal loader
// =========================================================================

interface BrandSignals {
  slug?: string;
  tiktokFollowers?: number;
  igFollowers?: number;
  amazonStars?: number;
  amazonReviews?: number;
}

async function loadBrandSignals(brandIds: string[]): Promise<Map<string, BrandSignals>> {
  const db = getAdminSupabase();
  const map = new Map<string, BrandSignals>();
  if (brandIds.length === 0) return map;

  const { data: brandRows } = await db
    .from("brands")
    .select("id, slug")
    .in("id", brandIds);
  for (const b of brandRows ?? []) {
    map.set(b.id, { slug: b.slug });
  }

  // Pull a single snapshot query per (platform, metric) tuple, keyed by
  // latest captured_at. We do this in 4 quick queries rather than N×4.
  const SIGNAL_KEYS: { platform: string; metric: string; field: keyof BrandSignals }[] = [
    { platform: "tiktok", metric: "follower_count", field: "tiktokFollowers" },
    { platform: "instagram", metric: "follower_count", field: "igFollowers" },
    { platform: "amazon", metric: "star_rating", field: "amazonStars" },
    { platform: "amazon", metric: "review_count", field: "amazonReviews" },
  ];

  for (const { platform, metric, field } of SIGNAL_KEYS) {
    const { data } = await db
      .from("snapshots")
      .select("brand_id, value_numeric, captured_at")
      .eq("platform", platform)
      .eq("metric", metric)
      .in("brand_id", brandIds)
      .order("captured_at", { ascending: false });

    const seen = new Set<string>();
    for (const s of data ?? []) {
      if (seen.has(s.brand_id) || s.value_numeric == null) continue;
      seen.add(s.brand_id);
      const entry = map.get(s.brand_id) ?? {};
      (entry as Record<string, unknown>)[field] = s.value_numeric;
      map.set(s.brand_id, entry);
    }
  }
  return map;
}

// =========================================================================
// Narrative generation
// =========================================================================

interface NarrativeInput {
  categories: { displayName: string }[];
  quadrant: QuadrantResult;
  callNowTop: DeepDiveBrandRow[];
  notInRetail: DeepDiveBrandRow[];
  totalDollars: number;
  avgYoy: number | null;
}

async function generateDeepDiveNarrative(input: NarrativeInput): Promise<string | null> {
  try {
    const env = getServerEnv();
    const client = new Anthropic({ apiKey: env.anthropicApiKey });

    const facts: string[] = [];
    const catNames = input.categories.map((c) => c.displayName).join(", ") || "the selected categories";
    facts.push(`Categories covered: ${catNames}`);
    if (input.totalDollars > 0) facts.push(`Total Nielsen sales: $${formatCompactNumber(input.totalDollars)}`);
    if (input.avgYoy != null) facts.push(`Avg category YoY: ${formatPctDelta(input.avgYoy)}`);
    facts.push(`Brands by quadrant: Call Now ${input.quadrant.counts.call_now}, Established ${input.quadrant.counts.established}, Incumbent ${input.quadrant.counts.incumbent}, Skip ${input.quadrant.counts.skip}`);
    if (input.callNowTop.length > 0) {
      facts.push(`Top Call-Now brands: ${input.callNowTop.slice(0, 5).map((b) => `${b.brandName} (momentum ${b.socialMomentum})`).join("; ")}`);
    }
    if (input.notInRetail.length > 0) {
      facts.push(`Strong social presence but absent from Nielsen entirely: ${input.notInRetail.slice(0, 5).map((b) => b.brandName).join(", ")}`);
    }

    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system:
        "You are a category analyst at a consumer-goods rep group. Given facts about " +
        "a category and its quadrant analysis (social momentum vs retail velocity), " +
        "write a 3-4 sentence executive summary for a sales lead. Lead with the " +
        "Call-Now opportunity — name specific brands and say what to do about them. " +
        "Be direct and confident, not academic. No preamble, no markdown headers.",
      messages: [
        { role: "user", content: `Facts:\n${facts.map((f) => `- ${f}`).join("\n")}` },
      ],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return text || null;
  } catch (err) {
    console.warn(`[deep-dive] narrative failed: ${err}`);
    return null;
  }
}

// =========================================================================
// HTML rendering — email-safe + quadrant SVG embedded
// =========================================================================

export function renderDeepDiveHtml(payload: DeepDivePayload): string {
  const appUrl = publicEnv.appUrl.replace(/\/$/, "");
  const catList = payload.categories.map((c) => c.displayName).join(", ") || "all categories";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Monthly Category Deep Dive</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f8fafc;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="720" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 2px rgba(15,23,42,0.06)">

        <!-- Header -->
        <tr><td style="padding:28px 36px 18px 36px;border-bottom:1px solid #e2e8f0">
          <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#94a3b8">Barcode Scout &middot; Monthly Category Deep Dive</p>
          <h1 style="margin:6px 0 0 0;font-size:24px;font-weight:600;color:#0f172a">${escapeHtml(catList)}</h1>
          <p style="margin:6px 0 0 0;font-size:13px;color:#64748b">
            ${escapeHtml(payload.periodStart ?? "")}${payload.periodStart && payload.periodEnd ? " – " : ""}${escapeHtml(payload.periodEnd ?? "")}
            · ${payload.categoryStats.brandsInUpload} brand${payload.categoryStats.brandsInUpload === 1 ? "" : "s"} in upload
          </p>
        </td></tr>

        <!-- Narrative -->
        ${payload.narrative ? `<tr><td style="padding:20px 36px 8px 36px;font-size:14px;color:#334155;line-height:1.55">
          <p style="margin:0">${escapeHtml(payload.narrative)}</p>
        </td></tr>` : ""}

        <!-- Stats strip -->
        <tr><td style="padding:16px 36px 8px 36px">
          ${renderStatsStrip(payload)}
        </td></tr>

        <!-- Quadrant plot -->
        <tr><td style="padding:8px 36px 8px 36px">
          <h2 style="margin:16px 0 8px 0;font-size:15px;font-weight:600;color:#0f172a">Social momentum vs. retail velocity</h2>
          <p style="margin:0 0 12px 0;font-size:12px;color:#64748b">Top-left = Barcode&rsquo;s call-now quadrant: high social, low retail.</p>
          ${renderQuadrantSvg(payload.quadrant)}
        </td></tr>

        ${renderQuadrantSection("📞 Call now", "High social momentum, low retail. Pitch these first.", payload.topByQuadrant.call_now, appUrl, "#16a34a", "#dcfce7")}
        ${renderQuadrantSection("🚨 Not yet in Nielsen", "Strong social signals, absent from retail scan data — the sleepers.", payload.notInRetail, appUrl, "#7c3aed", "#ede9fe")}
        ${renderQuadrantSection("🏆 Established", "High social + high retail. Likely already represented; check.", payload.topByQuadrant.established, appUrl, "#0891b2", "#cffafe")}
        ${renderQuadrantSection("🏛 Incumbent", "Big in retail but social is flat. Deprioritize.", payload.topByQuadrant.incumbent, appUrl, "#64748b", "#f1f5f9")}

        <!-- Footer -->
        <tr><td style="padding:20px 36px 24px 36px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8">
          <p style="margin:0">Generated ${escapeHtml(payload.generatedAt.slice(0, 19).replace("T", " "))} UTC. Reply or ask Barry in-app to drill into any brand.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function renderStatsStrip(payload: DeepDivePayload): string {
  const cells: { label: string; value: string }[] = [
    { label: "Brands", value: String(payload.categoryStats.brandsInUpload) },
    { label: "Total $", value: payload.categoryStats.totalDollars > 0 ? "$" + formatCompactNumber(payload.categoryStats.totalDollars) : "—" },
    { label: "Avg YoY", value: payload.categoryStats.avgYoyGrowthPct != null ? formatPctDelta(payload.categoryStats.avgYoyGrowthPct) : "—" },
    { label: "Call now", value: String(payload.quadrant.counts.call_now) },
    { label: "Not in Nielsen", value: String(payload.notInRetail.length) },
  ];
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f8fafc;border-radius:8px;padding:12px">
    <tr>
      ${cells.map((c) => `<td align="center" style="padding:4px 8px">
        <div style="font-size:18px;font-weight:700;color:#0f172a">${escapeHtml(c.value)}</div>
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:#94a3b8;margin-top:2px">${escapeHtml(c.label)}</div>
      </td>`).join("")}
    </tr>
  </table>`;
}

function renderQuadrantSection(
  title: string,
  blurb: string,
  rows: DeepDiveBrandRow[],
  appUrl: string,
  accent: string,
  accentBg: string
): string {
  if (rows.length === 0) return "";
  return `<tr><td style="padding:20px 36px 8px 36px">
    <h2 style="margin:0 0 4px 0;font-size:15px;font-weight:600;color:${accent}">${title}</h2>
    <p style="margin:0 0 10px 0;font-size:12px;color:#64748b">${escapeHtml(blurb)}</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${accentBg};border-radius:8px;padding:4px">
      ${rows.map((r) => `<tr><td style="padding:10px 12px;border-bottom:1px solid #ffffff80">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
          <td style="font-size:14px;font-weight:600;color:#0f172a">
            ${r.brandSlug ? `<a href="${appUrl}/brand-card/${encodeURIComponent(r.brandSlug)}" style="color:#0f172a;text-decoration:none">${escapeHtml(r.brandName)}</a>` : escapeHtml(r.brandName)}
          </td>
          <td align="right" style="font-size:12px;color:#475569">
            social ${r.socialMomentum} · retail ${r.retailVelocity}
          </td>
        </tr><tr>
          <td colspan="2" style="font-size:11px;color:#64748b;padding-top:2px">
            ${renderBrandSignals(r)}
          </td>
        </tr></table>
      </td></tr>`).join("")}
    </table>
  </td></tr>`;
}

function renderBrandSignals(r: DeepDiveBrandRow): string {
  const parts: string[] = [];
  if (r.tiktokFollowers != null) parts.push(`TT ${formatCompactNumber(r.tiktokFollowers)}`);
  if (r.igFollowers != null) parts.push(`IG ${formatCompactNumber(r.igFollowers)}`);
  if (r.amazonStars != null) {
    parts.push(`Amz ${r.amazonStars.toFixed(1)}★${r.amazonReviews != null ? ` (${formatCompactNumber(r.amazonReviews)})` : ""}`);
  }
  if (r.retailDollars != null && r.retailDollars > 0) {
    parts.push(`Nielsen $${formatCompactNumber(r.retailDollars)}`);
  }
  if (r.retailYoyPct != null) parts.push(`YoY ${formatPctDelta(r.retailYoyPct)}`);
  return parts.join(" · ");
}

/**
 * Inline SVG quadrant plot. Email clients render inline SVG inconsistently
 * (Gmail strips it entirely), so we ALSO show stats above. The SVG is a
 * bonus for clients that do render it (web preview, modern desktop clients).
 */
function renderQuadrantSvg(quadrant: QuadrantResult): string {
  const W = 560;
  const H = 320;
  const PADDING = 40;
  const innerW = W - PADDING * 2;
  const innerH = H - PADDING * 2;
  const QUAD_COLORS: Record<string, string> = {
    call_now: "#16a34a",
    established: "#0891b2",
    incumbent: "#64748b",
    skip: "#94a3b8",
  };

  const points = quadrant.entries
    .slice(0, 50) // cap dot count for legibility
    .map((e) => {
      const x = PADDING + (e.retailVelocity / 100) * innerW;
      const y = H - PADDING - (e.socialMomentum / 100) * innerH;
      const color = QUAD_COLORS[e.quadrant];
      return { x, y, color, label: e.brandName, quadrant: e.quadrant };
    });

  // Midpoint lines at threshold
  const midX = PADDING + (quadrant.highThreshold / 100) * innerW;
  const midY = H - PADDING - (quadrant.highThreshold / 100) * innerH;

  return `<div style="margin:0 0 8px 0">
    <svg width="100%" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px">
      <!-- Axis frame -->
      <rect x="${PADDING}" y="${PADDING}" width="${innerW}" height="${innerH}" fill="none" stroke="#e2e8f0" stroke-width="1" />
      <!-- Midpoint lines -->
      <line x1="${midX}" y1="${PADDING}" x2="${midX}" y2="${H - PADDING}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3 3" />
      <line x1="${PADDING}" y1="${midY}" x2="${W - PADDING}" y2="${midY}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3 3" />
      <!-- Quadrant labels -->
      <text x="${PADDING + 8}" y="${PADDING + 18}" font-size="11" fill="#16a34a" font-weight="600">CALL NOW</text>
      <text x="${W - PADDING - 80}" y="${PADDING + 18}" font-size="11" fill="#0891b2" font-weight="600">ESTABLISHED</text>
      <text x="${PADDING + 8}" y="${H - PADDING - 8}" font-size="11" fill="#94a3b8" font-weight="600">SKIP</text>
      <text x="${W - PADDING - 75}" y="${H - PADDING - 8}" font-size="11" fill="#64748b" font-weight="600">INCUMBENT</text>
      <!-- Axis labels -->
      <text x="${W / 2}" y="${H - 8}" font-size="11" fill="#64748b" text-anchor="middle">Retail velocity →</text>
      <text transform="translate(12 ${H / 2}) rotate(-90)" font-size="11" fill="#64748b" text-anchor="middle">Social momentum →</text>
      <!-- Dots -->
      ${points.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${p.color}" fill-opacity="0.7" stroke="#fff" stroke-width="1"><title>${escapeHtml(p.label)} (${p.quadrant.replace("_", " ")})</title></circle>`).join("")}
    </svg>
  </div>`;
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
