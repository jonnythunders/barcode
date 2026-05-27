/**
 * POST /api/smartscout/reconcile
 *
 * Run brand-matching + write snapshots for an existing smartscout upload.
 * Used when the user adjusted brand handles or added new monitored brands
 * after the original upload, and wants to re-run matching without uploading
 * the file again.
 *
 * Body (JSON):
 *   { uploadId: string, minTtmSales?: number }
 */
import { NextResponse } from "next/server";
import { verifyAuthToken, getAdminSupabase } from "@/lib/supabase-admin";
import { reconcileSmartScoutUpload } from "@/lib/smartscout/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    await verifyAuthToken(request);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }

  let body: { uploadId?: string; minTtmSales?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body expected" }, { status: 400 });
  }

  const uploadId = body.uploadId;
  if (!uploadId) {
    return NextResponse.json({ error: "uploadId required" }, { status: 400 });
  }

  // Hydrate the raw rows from the DB and re-run reconcile.
  const db = getAdminSupabase();
  const { data: rows, error } = await db
    .from("smartscout_rows")
    .select("brand_name_raw, main_category, primary_subcategory, est_monthly_revenue, trailing_12_months, est_monthly_sales, one_month_growth, twelve_month_growth, raw_row")
    .eq("upload_id", uploadId);
  if (error) {
    return NextResponse.json({ error: `Failed to load rows: ${error.message}` }, { status: 500 });
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({ error: `No rows found for upload ${uploadId}` }, { status: 404 });
  }

  const summary = await reconcileSmartScoutUpload({
    uploadId,
    rows: rows.map((r) => ({
      brandName: r.brand_name_raw,
      mainCategory: r.main_category,
      primarySubcategory: r.primary_subcategory,
      estMonthlyRevenue: r.est_monthly_revenue,
      trailing12Months: r.trailing_12_months,
      estMonthlySales: r.est_monthly_sales,
      oneMonthGrowth: r.one_month_growth,
      twelveMonthGrowth: r.twelve_month_growth,
      raw: r.raw_row as Record<string, unknown>,
    })),
    minTtmSales: body.minTtmSales,
  });

  return NextResponse.json({ ok: true, summary });
}
