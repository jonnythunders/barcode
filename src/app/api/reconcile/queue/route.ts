/**
 * GET /api/reconcile/queue
 *
 * Unified reconciliation queue across BOTH Nielsen and SmartScout uploads.
 * Returns brand-name strings that need human review, with candidate matches
 * and the dollar weight behind each decision (so users review high-impact
 * rows first).
 *
 * Strategy:
 *   - For Nielsen: rows where `brand_id IS NULL` (not yet linked).
 *   - For SmartScout: rows aggregated by brand_name_raw where match_confidence
 *     is 'unresolved' or 'low'. We aggregate first because SmartScout rows are
 *     per-subcategory — reviewing 17 "Liquid Death" rows individually is
 *     pointless when they all need the same decision.
 *
 * Each queue item carries:
 *   - source: 'nielsen' | 'smartscout'
 *   - brandNameRaw
 *   - totalSalesDollars: the $ at stake behind this name
 *   - rowCount: how many file rows this represents
 *   - candidates: top 5 matching brands from our DB with confidence scores
 *   - uploadId (for context)
 *
 * Returns up to 100 items, sorted by totalSalesDollars desc.
 */
import { NextResponse } from "next/server";
import { verifyAuthToken, getAdminSupabase } from "@/lib/supabase-admin";
import { slugify } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Candidate {
  brandId: string;
  brandName: string;
  brandSlug: string;
  score: number;
}

interface QueueItem {
  source: "nielsen" | "smartscout";
  uploadId: string;
  uploadFilename: string | null;
  brandNameRaw: string;
  totalSalesDollars: number;
  rowCount: number;
  /** Stable identifier for the action endpoint. For Nielsen we use the row id;
   *  for SmartScout we use the upload_id + brand_name_raw composite (one
   *  decision applies to all that brand's rows in that upload). */
  itemKey: string;
  /** Concrete row ids this decision affects (passed to the action endpoint). */
  rowIds: number[];
  candidates: Candidate[];
}

interface IndexedBrand {
  id: string;
  name: string;
  slug: string;
  nameLower: string;
  nameTokens: string[];
  amazonBrandLower: string | null;
}

const STOPWORDS = new Set([
  "the","a","an","and","or","of","for","by","co","inc","llc","ltd",
  "corp","company","brand","brands","products",
]);

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function scoreAgainstBrands(rawName: string, brandIndex: IndexedBrand[]): Candidate[] {
  const rawLower = rawName.toLowerCase().trim();
  const rawSlug = slugify(rawName);
  const rawTokens = tokenize(rawName);
  if (rawTokens.length === 0) return [];

  const scored: Candidate[] = [];
  for (const b of brandIndex) {
    let score = 0;
    if (b.slug === rawSlug) score = 1.0;
    else if (b.nameLower === rawLower) score = 0.98;
    else if (b.amazonBrandLower === rawLower) score = 0.95;
    else if (rawLower.includes(b.nameLower) && b.nameLower.length >= 4) score = 0.88;
    else if (b.nameLower.includes(rawLower) && rawLower.length >= 4) score = 0.82;
    else {
      const intersection = rawTokens.filter((t) => b.nameTokens.includes(t)).length;
      const union = new Set([...rawTokens, ...b.nameTokens]).size;
      const jaccard = union > 0 ? intersection / union : 0;
      if (jaccard >= 0.5) score = 0.5 + jaccard * 0.3;
      else if (jaccard > 0) score = jaccard * 0.5;
    }
    if (score > 0.3) {
      scored.push({ brandId: b.id, brandName: b.name, brandSlug: b.slug, score: Math.round(score * 1000) / 1000 });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 5);
}

export async function GET(request: Request) {
  try {
    await verifyAuthToken(request);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const sourceFilter = url.searchParams.get("source") as "nielsen" | "smartscout" | null;
  const minDollars = Number(url.searchParams.get("minDollars") ?? "0");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "100"), 500);

  const db = getAdminSupabase();

  // Build the brand index once for both sources.
  const { data: brandsRaw } = await db
    .from("brands")
    .select("id, name, slug, amazon_brand")
    .eq("is_archived", false);
  const brandIndex: IndexedBrand[] = (brandsRaw ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    slug: b.slug,
    nameLower: b.name.toLowerCase(),
    nameTokens: tokenize(b.name),
    amazonBrandLower: b.amazon_brand ? b.amazon_brand.toLowerCase() : null,
  }));

  const items: QueueItem[] = [];

  // ---- Nielsen unresolved rows ----
  if (sourceFilter !== "smartscout") {
    const { data: nielsenRows } = await db
      .from("nielsen_rows")
      .select("id, upload_id, brand_name_raw, sales_dollars, nielsen_uploads!inner(filename)")
      .is("brand_id", null)
      .order("sales_dollars", { ascending: false, nullsFirst: false })
      .limit(500);

    // Group Nielsen rows by (upload_id, brand_name_raw)
    const nielsenAgg = new Map<string, { uploadId: string; filename: string | null; brandNameRaw: string; totalSalesDollars: number; rowCount: number; rowIds: number[] }>();
    for (const r of nielsenRows ?? []) {
      const raw = r.brand_name_raw?.trim();
      if (!raw) continue;
      const key = `${r.upload_id}|||${raw.toLowerCase()}`;
      const existing = nielsenAgg.get(key);
      const dollars = Number(r.sales_dollars) || 0;
      const uploads = r.nielsen_uploads as { filename: string | null } | { filename: string | null }[] | null;
      const filename = Array.isArray(uploads) ? uploads[0]?.filename ?? null : uploads?.filename ?? null;
      if (existing) {
        existing.totalSalesDollars += dollars;
        existing.rowCount += 1;
        existing.rowIds.push(r.id);
      } else {
        nielsenAgg.set(key, {
          uploadId: r.upload_id,
          filename,
          brandNameRaw: raw,
          totalSalesDollars: dollars,
          rowCount: 1,
          rowIds: [r.id],
        });
      }
    }
    for (const a of nielsenAgg.values()) {
      if (a.totalSalesDollars < minDollars) continue;
      items.push({
        source: "nielsen",
        uploadId: a.uploadId,
        uploadFilename: a.filename,
        brandNameRaw: a.brandNameRaw,
        totalSalesDollars: a.totalSalesDollars,
        rowCount: a.rowCount,
        itemKey: `nielsen:${a.uploadId}:${a.brandNameRaw.toLowerCase()}`,
        rowIds: a.rowIds,
        candidates: scoreAgainstBrands(a.brandNameRaw, brandIndex),
      });
    }
  }

  // ---- SmartScout unresolved rows ----
  if (sourceFilter !== "nielsen") {
    const { data: ssRows } = await db
      .from("smartscout_rows")
      .select("id, upload_id, brand_name_raw, trailing_12_months, smartscout_uploads!inner(filename)")
      .is("matched_brand_id", null)
      .or("match_confidence.eq.unresolved,match_confidence.eq.low,match_confidence.is.null")
      .order("trailing_12_months", { ascending: false, nullsFirst: false })
      .limit(2000);

    const ssAgg = new Map<string, { uploadId: string; filename: string | null; brandNameRaw: string; totalSalesDollars: number; rowCount: number; rowIds: number[] }>();
    for (const r of ssRows ?? []) {
      const raw = r.brand_name_raw?.trim();
      if (!raw) continue;
      const key = `${r.upload_id}|||${raw.toLowerCase()}`;
      const dollars = Number(r.trailing_12_months) || 0;
      const uploads = r.smartscout_uploads as { filename: string | null } | { filename: string | null }[] | null;
      const filename = Array.isArray(uploads) ? uploads[0]?.filename ?? null : uploads?.filename ?? null;
      const existing = ssAgg.get(key);
      if (existing) {
        existing.totalSalesDollars += dollars;
        existing.rowCount += 1;
        existing.rowIds.push(r.id);
      } else {
        ssAgg.set(key, {
          uploadId: r.upload_id,
          filename,
          brandNameRaw: raw,
          totalSalesDollars: dollars,
          rowCount: 1,
          rowIds: [r.id],
        });
      }
    }
    for (const a of ssAgg.values()) {
      if (a.totalSalesDollars < minDollars) continue;
      items.push({
        source: "smartscout",
        uploadId: a.uploadId,
        uploadFilename: a.filename,
        brandNameRaw: a.brandNameRaw,
        totalSalesDollars: a.totalSalesDollars,
        rowCount: a.rowCount,
        itemKey: `smartscout:${a.uploadId}:${a.brandNameRaw.toLowerCase()}`,
        rowIds: a.rowIds,
        candidates: scoreAgainstBrands(a.brandNameRaw, brandIndex),
      });
    }
  }

  items.sort((a, b) => b.totalSalesDollars - a.totalSalesDollars);
  return NextResponse.json({
    totalItems: items.length,
    items: items.slice(0, limit),
  });
}
