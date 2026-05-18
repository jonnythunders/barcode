/**
 * Brand reconciliation — map raw Nielsen brand-name strings to canonical
 * `brands.id` values.
 *
 * Nielsen exports brand names with their own conventions: "OLIPOP" (all
 * caps), "Vacation Inc" vs our "Vacation Sunscreen", "Liquid Death Mountain
 * Water" vs our "Liquid Death". We need to:
 *
 *   1. Find probable matches in `brands` for each raw name.
 *   2. Score them — exact slug = 1.0, name contains = 0.85, token overlap
 *      ≥ 50% = 0.6, etc.
 *   3. Auto-link rows with a clear winner (score ≥ 0.85).
 *   4. Leave ambiguous rows unlinked with a candidate list, for the upload
 *      UI to show as "please confirm."
 *   5. Optionally auto-create a brand row for rows with NO match — useful
 *      because a brand showing up in Nielsen but missing from our DB is a
 *      genuinely new entry that deserves a `brands` row.
 *
 * The output never overwrites an already-mapped `brand_id`. Re-running
 * reconciliation on an upload that was previously confirmed is a no-op
 * for the confirmed rows.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { slugify } from "@/lib/utils";

export interface ReconciliationCandidate {
  brandId: string;
  brandName: string;
  brandSlug: string;
  score: number;
}

export interface RowReconciliation {
  rowId: number;
  brandNameRaw: string;
  matched: ReconciliationCandidate | null;
  candidates: ReconciliationCandidate[];   // top 5 alternatives, excluding the matched one
  needsReview: boolean;
}

export interface ReconcileOptions {
  uploadId: string;
  /** Auto-link rows with score >= this. Default 0.85. */
  autoLinkThreshold?: number;
  /** When a raw name has zero candidates, create a new brand row. Default true. */
  autoCreateMissing?: boolean;
  /** When auto-creating, mark these brands as discovered via 'nielsen_upload'. */
}

export interface ReconcileResult {
  totalRows: number;
  autoLinked: number;
  autoCreated: number;
  needsReview: number;
  alreadyLinked: number;
  rowReconciliations: RowReconciliation[];
}

const DEFAULT_AUTO_LINK = 0.85;

export async function reconcileUploadBrands(opts: ReconcileOptions): Promise<ReconcileResult> {
  const db = getAdminSupabase();
  const threshold = opts.autoLinkThreshold ?? DEFAULT_AUTO_LINK;
  const autoCreate = opts.autoCreateMissing ?? true;

  const { data: rows, error } = await db
    .from("nielsen_rows")
    .select("id, brand_name_raw, brand_id")
    .eq("upload_id", opts.uploadId);
  if (error) throw new Error(`reconcileUploadBrands: ${error.message}`);
  if (!rows || rows.length === 0) {
    return { totalRows: 0, autoLinked: 0, autoCreated: 0, needsReview: 0, alreadyLinked: 0, rowReconciliations: [] };
  }

  // Load all brands once — for Barcode's scale (hundreds, not hundreds of
  // thousands) this is the cheapest approach and avoids N round-trips.
  const { data: allBrands } = await db
    .from("brands")
    .select("id, name, slug")
    .eq("is_archived", false);

  const brandIndex = (allBrands ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    slug: b.slug,
    nameLower: b.name.toLowerCase(),
    nameTokens: tokenize(b.name),
  }));

  const result: ReconcileResult = {
    totalRows: rows.length,
    autoLinked: 0,
    autoCreated: 0,
    needsReview: 0,
    alreadyLinked: 0,
    rowReconciliations: [],
  };

  // Track new brands to insert as one batch at the end
  const toCreate: { name: string; rowIds: number[] }[] = [];
  const toCreateBySlug = new Map<string, number>();

  for (const row of rows) {
    // Skip already-linked rows
    if (row.brand_id) {
      result.alreadyLinked++;
      continue;
    }

    const raw = row.brand_name_raw?.trim() ?? "";
    if (!raw) continue;

    const scored = scoreAgainstBrands(raw, brandIndex);
    const top = scored[0];

    const rec: RowReconciliation = {
      rowId: row.id,
      brandNameRaw: raw,
      matched: null,
      candidates: scored.slice(1, 6),
      needsReview: false,
    };

    if (top && top.score >= threshold) {
      // Auto-link
      rec.matched = top;
      await db.from("nielsen_rows").update({ brand_id: top.brandId }).eq("id", row.id);
      result.autoLinked++;
    } else if (top && top.score >= 0.5) {
      // Ambiguous — top candidate exists but not confident enough
      rec.matched = null;
      rec.candidates = scored.slice(0, 5);
      rec.needsReview = true;
      result.needsReview++;
    } else if (autoCreate) {
      // No reasonable match → queue for new-brand creation
      const slug = slugify(raw);
      const existing = toCreateBySlug.get(slug);
      if (existing != null) {
        toCreate[existing].rowIds.push(row.id);
      } else {
        toCreateBySlug.set(slug, toCreate.length);
        toCreate.push({ name: raw, rowIds: [row.id] });
      }
    } else {
      rec.needsReview = true;
      result.needsReview++;
    }

    result.rowReconciliations.push(rec);
  }

  // Batch-insert new brands and link their rows
  for (const item of toCreate) {
    const slug = slugify(item.name);
    // Race-safety: double-check in case parallel reconciliation already created it
    const { data: existing } = await db
      .from("brands")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    let newId: string | null = existing?.id ?? null;
    if (!newId) {
      const { data: inserted, error: insertErr } = await db
        .from("brands")
        .insert({
          name: item.name,
          slug,
          discovery_source: "nielsen_upload",
          is_monitored: true,
        })
        .select("id")
        .single();
      if (insertErr || !inserted) {
        console.warn(`[reconcile] failed to create brand "${item.name}": ${insertErr?.message}`);
        continue;
      }
      newId = inserted.id;
      result.autoCreated++;
    }

    if (newId) {
      // Link all rows pointing at this raw name
      const updateResult = await db
        .from("nielsen_rows")
        .update({ brand_id: newId })
        .in("id", item.rowIds);
      if (updateResult.error) {
        console.warn(`[reconcile] failed to link ${item.rowIds.length} rows: ${updateResult.error.message}`);
      }
    }
  }

  return result;
}

// =========================================================================
// Manual override — confirm a single row → brand mapping
// =========================================================================

export async function setRowBrand(rowId: number, brandId: string): Promise<void> {
  const db = getAdminSupabase();
  const { error } = await db.from("nielsen_rows").update({ brand_id: brandId }).eq("id", rowId);
  if (error) throw new Error(`setRowBrand: ${error.message}`);
}

// =========================================================================
// Scoring
// =========================================================================

interface IndexedBrand {
  id: string;
  name: string;
  slug: string;
  nameLower: string;
  nameTokens: string[];
}

function scoreAgainstBrands(rawName: string, brandIndex: IndexedBrand[]): ReconciliationCandidate[] {
  const rawLower = rawName.toLowerCase().trim();
  const rawSlug = slugify(rawName);
  const rawTokens = tokenize(rawName);
  if (rawTokens.length === 0) return [];

  const scored: ReconciliationCandidate[] = [];
  for (const b of brandIndex) {
    let score = 0;

    // Exact slug match
    if (b.slug === rawSlug) {
      score = 1.0;
    }
    // Exact lowercase name match
    else if (b.nameLower === rawLower) {
      score = 0.98;
    }
    // Raw contains our brand name (e.g. "Liquid Death Mountain Water" contains "Liquid Death")
    else if (rawLower.includes(b.nameLower) && b.nameLower.length >= 4) {
      score = 0.88;
    }
    // Our brand name contains raw (e.g. raw="Olipop", brand="OLIPOP Original")
    else if (b.nameLower.includes(rawLower) && rawLower.length >= 4) {
      score = 0.82;
    }
    // Token overlap — Jaccard
    else {
      const intersection = rawTokens.filter((t) => b.nameTokens.includes(t)).length;
      const union = new Set([...rawTokens, ...b.nameTokens]).size;
      const jaccard = union > 0 ? intersection / union : 0;
      if (jaccard >= 0.5) score = 0.5 + jaccard * 0.3;
      else if (jaccard > 0) score = jaccard * 0.5;
    }

    if (score > 0.3) {
      scored.push({
        brandId: b.id,
        brandName: b.name,
        brandSlug: b.slug,
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "by", "co", "inc", "llc",
  "ltd", "corp", "company", "brand", "brands", "products",
]);
