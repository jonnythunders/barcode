/**
 * POST /api/smartscout/upload — SmartScout monthly Amazon-velocity ingestion.
 *
 * Multipart form:
 *   - file: the .xlsx export from SmartScout (the "Data" sheet is canonical)
 *   - autoReconcile: (optional) '1' to immediately reconcile + write snapshots
 *   - minTtmSales: (optional) ignore brands below this TTM threshold (default $500k)
 *
 * Returns:
 *   - uploadId
 *   - rowCount
 *   - categories present (helps confirm the right export was uploaded)
 *   - reconcileSummary (if autoReconcile=1)
 *
 * The upload row + per-subcategory rows persist regardless of reconcile —
 * the reconcile UI (#7) can be run later to fix matching errors.
 *
 * Note: SmartScout's full export is ~50MB / 325k rows across all categories.
 * Vercel's default body limit (4.5MB) is too small. Set the route's
 * `bodyParser` config OR upload to Supabase Storage first and pass an URL.
 * For the pilot we keep the simple direct-upload path; larger refreshes
 * will need the storage flow.
 */
import { NextResponse } from "next/server";
import { verifyAuthToken, getAdminSupabase } from "@/lib/supabase-admin";
import { parseSmartScoutFile } from "@/lib/smartscout/ingest";
import { reconcileSmartScoutUpload } from "@/lib/smartscout/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;     // SmartScout parse + reconcile can take a minute on large files

export async function POST(request: Request) {
  let authUserId: string;
  try {
    const auth = await verifyAuthToken(request);
    authUserId = auth.authUserId;
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Multipart form expected" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "'file' field required" }, { status: 400 });
  }

  const autoReconcile = form.get("autoReconcile") === "1";
  const minTtmRaw = form.get("minTtmSales");
  const minTtmSales = typeof minTtmRaw === "string" && minTtmRaw.length > 0
    ? Number(minTtmRaw)
    : undefined;

  // Parse the file
  let parsed: ReturnType<typeof parseSmartScoutFile>;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    parsed = parseSmartScoutFile(buffer, file.name);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Parse failed" },
      { status: 400 }
    );
  }

  const db = getAdminSupabase();

  // Insert the upload header.
  const { data: uploadRow, error: uploadErr } = await db
    .from("smartscout_uploads")
    .insert({
      filename: file.name,
      uploaded_by: authUserId,
      row_count: parsed.rowCount,
      period_label: parsed.periodLabel,
      metadata: {
        categories: parsed.categories.slice(0, 25),
        total_categories: parsed.categories.length,
      },
    })
    .select("id")
    .single();
  if (uploadErr || !uploadRow) {
    return NextResponse.json({ error: uploadErr?.message ?? "Insert failed" }, { status: 500 });
  }

  // Insert rows in chunks of 500. SmartScout exports are big — 325k rows on
  // the full April dump — so chunked inserts keep memory + the supabase
  // client's request size reasonable.
  const rowsToInsert = parsed.rows.map((r) => ({
    upload_id: uploadRow.id,
    brand_name_raw: r.brandName,
    main_category: r.mainCategory,
    primary_subcategory: r.primarySubcategory,
    est_monthly_revenue: r.estMonthlyRevenue,
    trailing_12_months: r.trailing12Months,
    est_monthly_sales: r.estMonthlySales,
    one_month_growth: r.oneMonthGrowth,
    twelve_month_growth: r.twelveMonthGrowth,
    raw_row: r.raw,
  }));

  const CHUNK = 500;
  for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
    const slice = rowsToInsert.slice(i, i + CHUNK);
    const { error } = await db.from("smartscout_rows").insert(slice);
    if (error) {
      console.error(`[smartscout/upload] row insert chunk ${i} failed: ${error.message}`);
      return NextResponse.json(
        { error: `Row insert failed at chunk ${i}: ${error.message}`, uploadId: uploadRow.id },
        { status: 500 }
      );
    }
  }

  let reconcileSummary: Awaited<ReturnType<typeof reconcileSmartScoutUpload>> | null = null;
  if (autoReconcile) {
    reconcileSummary = await reconcileSmartScoutUpload({
      uploadId: uploadRow.id,
      rows: parsed.rows,
      minTtmSales,
    });
  }

  return NextResponse.json({
    uploadId: uploadRow.id,
    filename: file.name,
    rowCount: parsed.rowCount,
    periodLabel: parsed.periodLabel,
    categoryCount: parsed.categories.length,
    topCategories: parsed.categories.slice(0, 10),
    reconcileSummary,
  });
}
