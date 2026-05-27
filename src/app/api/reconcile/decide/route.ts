/**
 * POST /api/reconcile/decide
 *
 * Commit a user's reconciliation decision. Three action types:
 *
 *   { source, rowIds, action: "link", brandId }
 *       → set matched_brand_id on each row to brandId.
 *
 *   { source, rowIds, action: "create", newBrandName, monitored?: boolean }
 *       → insert a new brand row, then link rows to it.
 *
 *   { source, rowIds, action: "skip" }
 *       → mark rows as match_confidence='manual_skip' so the queue stops
 *         showing them, but don't link to any brand.
 *
 * For SmartScout, linking also writes fresh `smartscout/*` snapshots to the
 * matched brand so the dashboard updates immediately.
 *
 * For Nielsen, linking updates `nielsen_rows.brand_id` only — there's no
 * snapshot equivalent because Nielsen rows ARE the snapshot.
 */
import { NextResponse } from "next/server";
import { verifyAuthToken, getAdminSupabase } from "@/lib/supabase-admin";
import { writeSnapshot } from "@/lib/fetchers/_base";
import { nowIso, slugify } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DecisionBody {
  source: "nielsen" | "smartscout";
  rowIds: number[];
  action: "link" | "create" | "skip";
  brandId?: string;
  newBrandName?: string;
  monitored?: boolean;
}

export async function POST(request: Request) {
  try {
    await verifyAuthToken(request);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }

  let body: DecisionBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body expected" }, { status: 400 });
  }

  const { source, rowIds, action } = body;
  if (!source || !rowIds || rowIds.length === 0 || !action) {
    return NextResponse.json({ error: "source, rowIds, and action are required" }, { status: 400 });
  }
  if (source !== "nielsen" && source !== "smartscout") {
    return NextResponse.json({ error: "source must be 'nielsen' or 'smartscout'" }, { status: 400 });
  }

  const db = getAdminSupabase();
  const tableName = source === "nielsen" ? "nielsen_rows" : "smartscout_rows";
  const brandIdCol = source === "nielsen" ? "brand_id" : "matched_brand_id";

  // ---- Resolve brand id ----
  let brandId: string | null = null;
  let brandCreated = false;

  if (action === "link") {
    if (!body.brandId) {
      return NextResponse.json({ error: "brandId required for action='link'" }, { status: 400 });
    }
    // Verify the brand exists
    const { data: b } = await db.from("brands").select("id, name").eq("id", body.brandId).maybeSingle();
    if (!b) {
      return NextResponse.json({ error: `Brand ${body.brandId} not found` }, { status: 404 });
    }
    brandId = body.brandId;
  } else if (action === "create") {
    if (!body.newBrandName) {
      return NextResponse.json({ error: "newBrandName required for action='create'" }, { status: 400 });
    }
    const slug = slugify(body.newBrandName);
    // Race-safety: check if a brand with this slug already exists.
    const { data: existing } = await db
      .from("brands")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (existing) {
      brandId = existing.id;
    } else {
      const { data: inserted, error: insertErr } = await db
        .from("brands")
        .insert({
          name: body.newBrandName,
          slug,
          discovery_source: source === "smartscout" ? "manual" : "nielsen_upload",
          is_monitored: body.monitored !== false,
        })
        .select("id")
        .single();
      if (insertErr || !inserted) {
        return NextResponse.json({ error: `Failed to create brand: ${insertErr?.message}` }, { status: 500 });
      }
      brandId = inserted.id;
      brandCreated = true;
    }
  } else if (action === "skip") {
    // No brand assignment — just mark to keep these out of the queue.
  } else {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  // ---- Apply the decision to the rows ----
  const updatePayload: Record<string, unknown> = action === "skip"
    ? source === "smartscout"
      ? { match_confidence: "manual_skip", reconciled_at: nowIso() }
      : { /* nielsen has no skip column; we set brand_id to a sentinel? No — leave null but mark via a future column */ }
    : source === "smartscout"
      ? { matched_brand_id: brandId, match_confidence: "manual", reconciled_at: nowIso() }
      : { [brandIdCol]: brandId };

  // For Nielsen + skip we need a workaround: there's no match_confidence column
  // on nielsen_rows. We store the skip intent in a comment on the upload.
  // Simpler: just refuse 'skip' for Nielsen for now (the rows stay in the
  // queue but the user can filter by minDollars to hide low-value ones).
  if (source === "nielsen" && action === "skip") {
    return NextResponse.json(
      { error: "Skip not yet supported for Nielsen rows. Link to an existing brand or create a new one." },
      { status: 400 }
    );
  }

  if (Object.keys(updatePayload).length > 0) {
    const { error: updateErr } = await db.from(tableName).update(updatePayload).in("id", rowIds);
    if (updateErr) {
      return NextResponse.json({ error: `Update failed: ${updateErr.message}` }, { status: 500 });
    }
  }

  // ---- SmartScout: write fresh commerce snapshots for the matched brand ----
  let snapshotsWritten = 0;
  if (source === "smartscout" && brandId && action !== "skip") {
    snapshotsWritten = await writeSmartScoutSnapshotsForRows(brandId, rowIds);
  }

  return NextResponse.json({
    ok: true,
    action,
    brandId,
    brandCreated,
    rowsUpdated: rowIds.length,
    snapshotsWritten,
  });
}

// =========================================================================
// SmartScout snapshot helper (mirrors reconcile.ts's logic for a single brand)
// =========================================================================

async function writeSmartScoutSnapshotsForRows(brandId: string, rowIds: number[]): Promise<number> {
  const db = getAdminSupabase();

  // Load the rows we just linked and aggregate them.
  const { data: rows, error } = await db
    .from("smartscout_rows")
    .select("upload_id, trailing_12_months, est_monthly_sales, twelve_month_growth, primary_subcategory")
    .in("id", rowIds);
  if (error || !rows || rows.length === 0) return 0;

  const uploadId = rows[0].upload_id;
  let ttm = 0;
  let monthlyUnits = 0;
  let weightedGrowthNumer = 0;
  let weightedGrowthDenom = 0;
  const subcategories = new Set<string>();
  for (const r of rows) {
    const t = Number(r.trailing_12_months) || 0;
    ttm += t;
    monthlyUnits += Number(r.est_monthly_sales) || 0;
    const w = Math.max(t, 0);
    if (r.twelve_month_growth != null && w > 0) {
      weightedGrowthNumer += Number(r.twelve_month_growth) * w;
      weightedGrowthDenom += w;
    }
    if (r.primary_subcategory) subcategories.add(r.primary_subcategory);
  }

  const yoyGrowthDecimal = weightedGrowthDenom > 0 ? weightedGrowthNumer / weightedGrowthDenom : null;
  const yoyGrowthPct = yoyGrowthDecimal != null ? Math.round(yoyGrowthDecimal * 1000) / 10 : null;
  const valueJson = {
    source: "smartscout" as const,
    upload_id: uploadId,
    subcategories: Array.from(subcategories).slice(0, 8),
    row_count: rows.length,
    via: "manual_reconcile",
  };
  const now = nowIso();

  let count = 0;
  await writeSnapshot({
    brandId, platform: "smartscout", metric: "annual_revenue",
    valueNumeric: Math.round(ttm), valueJson, capturedAt: now,
  });
  count++;
  if (yoyGrowthPct != null) {
    await writeSnapshot({
      brandId, platform: "smartscout", metric: "yoy_growth_pct",
      valueNumeric: yoyGrowthPct, valueJson, capturedAt: now,
    });
    count++;
  }
  if (monthlyUnits > 0) {
    await writeSnapshot({
      brandId, platform: "smartscout", metric: "monthly_units",
      valueNumeric: Math.round(monthlyUnits), valueJson, capturedAt: now,
    });
    count++;
  }
  return count;
}
