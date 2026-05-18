/**
 * Nielsen / deep-dive tools — agent-facing wrappers.
 *
 * Note: file uploads happen through the UI, not chat. Barry can however
 * trigger reconciliation, summarize an upload, or generate a deep dive
 * from an existing upload.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { reconcileUploadBrands, setRowBrand } from "@/lib/nielsen/reconcile";
import { buildMonthlyDeepDive } from "@/lib/nielsen/deep-dive";
import { slugify } from "@/lib/utils";

export async function executeListNielsenUploads(args: { limit?: number }) {
  const db = getAdminSupabase();
  const { data, error } = await db
    .from("nielsen_uploads")
    .select("id, filename, source_kind, period_start, period_end, row_count, created_at")
    .order("created_at", { ascending: false })
    .limit(Math.min(args.limit ?? 10, 50));
  if (error) return { error: error.message };
  return { uploads: data ?? [] };
}

export async function executeReconcileUpload(args: { upload_id: string; auto_create_missing?: boolean }) {
  try {
    const result = await reconcileUploadBrands({
      uploadId: args.upload_id,
      autoCreateMissing: args.auto_create_missing,
    });
    return {
      totalRows: result.totalRows,
      autoLinked: result.autoLinked,
      autoCreated: result.autoCreated,
      needsReview: result.needsReview,
      alreadyLinked: result.alreadyLinked,
      // Strip the per-row list — it can be huge; the UI is the right place for that
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function executeListAmbiguousRows(args: { upload_id: string; limit?: number }) {
  const db = getAdminSupabase();
  const limit = Math.min(args.limit ?? 20, 100);
  const { data, error } = await db
    .from("nielsen_rows")
    .select("id, brand_name_raw, category_name_raw, sales_dollars")
    .eq("upload_id", args.upload_id)
    .is("brand_id", null)
    .limit(limit);
  if (error) return { error: error.message };
  return { rows: data ?? [], count: data?.length ?? 0 };
}

export async function executeConfirmRowBrand(args: { row_id: number; brand_name: string }) {
  const db = getAdminSupabase();
  const slug = slugify(args.brand_name);
  const { data: brand } = await db
    .from("brands")
    .select("id, name")
    .or(`slug.eq.${slug},name.ilike.${args.brand_name}`)
    .maybeSingle();
  if (!brand) return { error: `Brand "${args.brand_name}" not found. Create it first via monitor_brand.` };
  await setRowBrand(args.row_id, brand.id);
  return { success: true, rowId: args.row_id, linkedTo: brand.name };
}

export async function executeGenerateDeepDive(args: { upload_id: string; category_slugs?: string[] }) {
  const db = getAdminSupabase();
  let categoryIds: string[] | undefined;
  if (args.category_slugs && args.category_slugs.length > 0) {
    const { data } = await db.from("categories").select("id, slug").in("slug", args.category_slugs);
    categoryIds = (data ?? []).map((c) => c.id);
  }
  try {
    const payload = await buildMonthlyDeepDive({ uploadId: args.upload_id, categoryIds });
    // Don't return the entire payload — it can be huge. Return a digest.
    return {
      uploadId: payload.uploadId,
      categories: payload.categories.map((c) => c.displayName),
      periodStart: payload.periodStart,
      periodEnd: payload.periodEnd,
      brandsConsidered: payload.categoryStats.brandsInUpload,
      counts: payload.quadrant.counts,
      topCallNow: payload.topByQuadrant.call_now.slice(0, 5).map((b) => ({
        brand: b.brandName,
        social: b.socialMomentum,
        retail: b.retailVelocity,
      })),
      notInRetailTop: payload.notInRetail.slice(0, 5).map((b) => ({
        brand: b.brandName,
        social: b.socialMomentum,
      })),
      narrative: payload.narrative,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unknown error" };
  }
}
