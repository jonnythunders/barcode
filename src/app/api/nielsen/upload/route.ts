/**
 * POST /api/nielsen/upload — Nielsen/IRI/Circana file ingestion.
 *
 * Multipart form:
 *   - file: the CSV/TSV/XLSX file
 *   - manualMapping: (optional) JSON string with column overrides
 *   - autoReconcile: (optional) '1' to immediately run reconciliation
 *
 * Returns:
 *   - upload row id
 *   - detected mapping + confidence
 *   - row count
 *   - reconciliation summary (if autoReconcile=1)
 *
 * The upload row + rows live in the DB even if reconciliation hasn't
 * happened — the UI lets the user confirm the mapping + run
 * reconciliation in a second step.
 */
import { NextResponse } from "next/server";
import { verifyAuthToken, getAdminSupabase } from "@/lib/supabase-admin";
import { parseNielsenFile, type NielsenFieldKey } from "@/lib/nielsen/ingest";
import { reconcileUploadBrands } from "@/lib/nielsen/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  // Parse manual mapping override (if any)
  let manualMapping: Partial<Record<NielsenFieldKey, string>> | undefined;
  const mappingRaw = form.get("manualMapping");
  if (typeof mappingRaw === "string" && mappingRaw.length > 0) {
    try {
      manualMapping = JSON.parse(mappingRaw);
    } catch {
      return NextResponse.json({ error: "manualMapping must be valid JSON" }, { status: 400 });
    }
  }

  const autoReconcile = form.get("autoReconcile") === "1";

  // Parse the file
  let parsed: ReturnType<typeof parseNielsenFile>;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    parsed = parseNielsenFile(buffer, file.name, manualMapping);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Parse failed" },
      { status: 400 }
    );
  }

  const db = getAdminSupabase();

  // Insert the upload header
  const { data: uploadRow, error: uploadErr } = await db
    .from("nielsen_uploads")
    .insert({
      filename: file.name,
      uploaded_by: authUserId,
      source_kind: parsed.mapping.sourceKind,
      row_count: parsed.rowCount,
      column_mapping: { fields: parsed.mapping.fields, confidence: parsed.mapping.confidence, allHeaders: parsed.mapping.allHeaders },
    })
    .select("id")
    .single();
  if (uploadErr || !uploadRow) {
    return NextResponse.json({ error: uploadErr?.message ?? "Insert failed" }, { status: 500 });
  }

  // Insert rows in chunks of 500
  const rowsToInsert = parsed.normalizedRows.map((r) => ({
    upload_id: uploadRow.id,
    brand_name_raw: r.brandNameRaw,
    category_name_raw: r.categoryNameRaw,
    sales_dollars: r.salesDollars,
    sales_units: r.salesUnits,
    period_label: r.periodLabel,
    yoy_growth_pct: r.yoyGrowthPct,
    raw_row: r.rawRow,
  }));

  const CHUNK = 500;
  for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
    const slice = rowsToInsert.slice(i, i + CHUNK);
    const { error } = await db.from("nielsen_rows").insert(slice);
    if (error) {
      console.error(`[nielsen/upload] row insert chunk ${i} failed: ${error.message}`);
      return NextResponse.json(
        {
          error: `Row insert failed at chunk ${i}: ${error.message}`,
          uploadId: uploadRow.id,
        },
        { status: 500 }
      );
    }
  }

  // Optionally reconcile right away
  let reconcileSummary: Awaited<ReturnType<typeof reconcileUploadBrands>> | null = null;
  if (autoReconcile) {
    reconcileSummary = await reconcileUploadBrands({ uploadId: uploadRow.id });
  }

  return NextResponse.json({
    uploadId: uploadRow.id,
    filename: file.name,
    rowCount: parsed.rowCount,
    sourceKind: parsed.mapping.sourceKind,
    headerRowIndex: parsed.mapping.headerRowIndex,
    mapping: {
      fields: parsed.mapping.fields,
      confidence: parsed.mapping.confidence,
      allHeaders: parsed.mapping.allHeaders,
    },
    periodLabel: parsed.periodLabel,
    reconcileSummary,
  });
}
