/**
 * Handle Resolver — brand name → social handles + Amazon brand string + website.
 *
 * V1 strategy (this file):
 *   1. If we already have a `brands` row with handles populated, use it.
 *   2. Check `handle_resolutions` cache — reuse a recent successful resolution.
 *   3. Generate deterministic handle candidates from the brand name (slugified
 *      variants). Returned as low-confidence candidates — the caller validates
 *      them via the actual TikTok/IG fetchers.
 *   4. Return "unresolved" with candidates if all else fails.
 *
 * Output contract: we never commit WRONG handles. If uncertain we return
 * candidates with confidence='unresolved' and let the caller decide.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { nowIso, slugify } from "@/lib/utils";

export interface HandleResolution {
  brandId: string | null;
  brandName: string;
  tiktokHandle: string | null;
  instagramHandle: string | null;
  amazonBrand: string | null;
  websiteUrl: string | null;
  confidence: "high" | "medium" | "low" | "manual" | "unresolved";
  candidates: {
    tiktok: string[];
    instagram: string[];
  };
  resolutionLog: ResolutionLogEntry[];
}

export interface ResolutionLogEntry {
  strategy: "db_brands" | "db_cache" | "deterministic_guess" | "unresolved";
  matched: boolean;
  detail?: string;
}

export interface ResolveOptions {
  brandName: string;
  persistToBrandsRow?: boolean;
  override?: {
    tiktokHandle?: string | null;
    instagramHandle?: string | null;
    amazonBrand?: string | null;
    websiteUrl?: string | null;
  };
}

/** Minimal shape we expect back from the brands table. */
interface BrandRow {
  id: string;
  name: string;
  slug: string;
  tiktok_handle: string | null;
  instagram_handle: string | null;
  amazon_brand: string | null;
  website_url: string | null;
}

interface EnsureResult {
  brandRow: BrandRow | null;
  brandId: string | null;
}

// =========================================================================
// Main entry
// =========================================================================

export async function resolveBrandHandles(opts: ResolveOptions): Promise<HandleResolution> {
  const name = opts.brandName.trim();
  if (!name) return unresolvedResult("", []);

  const log: ResolutionLogEntry[] = [];
  const db = getAdminSupabase();

  // --- Strategy 0: explicit override ---
  if (
    opts.override &&
    (opts.override.tiktokHandle ||
      opts.override.instagramHandle ||
      opts.override.amazonBrand ||
      opts.override.websiteUrl)
  ) {
    const { brandRow, brandId } = await ensureBrandRow(name, opts.override, opts.persistToBrandsRow);
    await logResolution(db, name, brandId, opts.override, "manual", { strategy: "override" });
    return {
      brandId,
      brandName: brandRow?.name ?? name,
      tiktokHandle: opts.override.tiktokHandle ?? null,
      instagramHandle: opts.override.instagramHandle ?? null,
      amazonBrand: opts.override.amazonBrand ?? null,
      websiteUrl: opts.override.websiteUrl ?? null,
      confidence: "manual",
      candidates: { tiktok: [], instagram: [] },
      resolutionLog: [{ strategy: "db_brands", matched: true, detail: "manual override" }],
    };
  }

  // --- Strategy 1: existing brand row ---
  const slug = slugify(name);
  const { data: brandRows } = await db
    .from("brands")
    .select("id, name, slug, tiktok_handle, instagram_handle, amazon_brand, website_url")
    .or(`slug.eq.${slug},name.ilike.${name}`)
    .limit(5);

  if (brandRows && brandRows.length > 0) {
    const rows = brandRows as BrandRow[];
    const exact =
      rows.find((r) => r.slug === slug) ??
      rows.find((r) => r.name.toLowerCase() === name.toLowerCase()) ??
      rows[0];

    const hasAny =
      exact.tiktok_handle || exact.instagram_handle || exact.amazon_brand || exact.website_url;
    log.push({
      strategy: "db_brands",
      matched: true,
      detail: hasAny ? "row has populated handles" : "row exists but handles empty",
    });

    if (hasAny) {
      return {
        brandId: exact.id,
        brandName: exact.name,
        tiktokHandle: exact.tiktok_handle,
        instagramHandle: exact.instagram_handle,
        amazonBrand: exact.amazon_brand,
        websiteUrl: exact.website_url,
        confidence: "high",
        candidates: { tiktok: [], instagram: [] },
        resolutionLog: log,
      };
    }
  } else {
    log.push({ strategy: "db_brands", matched: false });
  }

  // --- Strategy 2: resolutions cache ---
  const { data: cacheRows } = await db
    .from("handle_resolutions")
    .select("tiktok_handle, instagram_handle, amazon_brand, confidence")
    .ilike("brand_name_query", name)
    .order("created_at", { ascending: false })
    .limit(1);

  if (cacheRows && cacheRows.length > 0) {
    const cached = cacheRows[0] as {
      tiktok_handle: string | null;
      instagram_handle: string | null;
      amazon_brand: string | null;
      confidence: string | null;
    };
    const hasAny = cached.tiktok_handle || cached.instagram_handle || cached.amazon_brand;
    log.push({ strategy: "db_cache", matched: !!hasAny, detail: `cached confidence=${cached.confidence}` });

    if (hasAny && cached.confidence && cached.confidence !== "low") {
      const { brandRow, brandId } = await ensureBrandRow(
        name,
        {
          tiktokHandle: cached.tiktok_handle,
          instagramHandle: cached.instagram_handle,
          amazonBrand: cached.amazon_brand,
        },
        opts.persistToBrandsRow
      );
      return {
        brandId,
        brandName: brandRow?.name ?? name,
        tiktokHandle: cached.tiktok_handle,
        instagramHandle: cached.instagram_handle,
        amazonBrand: cached.amazon_brand,
        websiteUrl: null,
        confidence: cached.confidence as HandleResolution["confidence"],
        candidates: { tiktok: [], instagram: [] },
        resolutionLog: log,
      };
    }
  } else {
    log.push({ strategy: "db_cache", matched: false });
  }

  // --- Strategy 3: deterministic guesses (low-confidence candidates) ---
  const guesses = guessHandlesFromName(name);
  log.push({
    strategy: "deterministic_guess",
    matched: guesses.length > 0,
    detail: `${guesses.length} candidates`,
  });

  const { brandRow, brandId } = await ensureBrandRow(name, {}, opts.persistToBrandsRow);
  await logResolution(db, name, brandId, {}, "low", { strategy: "deterministic_guess", candidates: guesses });

  return {
    brandId,
    brandName: brandRow?.name ?? name,
    tiktokHandle: null,
    instagramHandle: null,
    amazonBrand: null,
    websiteUrl: null,
    confidence: "unresolved",
    candidates: { tiktok: guesses, instagram: guesses },
    resolutionLog: log,
  };
}

// =========================================================================
// Helpers
// =========================================================================

function guessHandlesFromName(name: string): string[] {
  const sluggy = slugify(name);
  const compact = sluggy.replace(/-/g, "");
  const underscored = sluggy.replace(/-/g, "_");
  const firstToken = sluggy.split("-")[0];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of [compact, underscored, sluggy, firstToken]) {
    if (c && c.length >= 2 && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

async function ensureBrandRow(
  name: string,
  patch: Partial<{
    tiktokHandle: string | null;
    instagramHandle: string | null;
    amazonBrand: string | null;
    websiteUrl: string | null;
  }>,
  persist: boolean = true
): Promise<EnsureResult> {
  const db = getAdminSupabase();
  const slug = slugify(name);

  const { data: existing } = await db
    .from("brands")
    .select("id, name, slug, tiktok_handle, instagram_handle, amazon_brand, website_url")
    .or(`slug.eq.${slug},name.ilike.${name}`)
    .limit(1)
    .maybeSingle();

  if (existing) {
    const row = existing as BrandRow;
    const updates: Record<string, unknown> = {};
    if (patch.tiktokHandle && !row.tiktok_handle) updates.tiktok_handle = patch.tiktokHandle;
    if (patch.instagramHandle && !row.instagram_handle) updates.instagram_handle = patch.instagramHandle;
    if (patch.amazonBrand && !row.amazon_brand) updates.amazon_brand = patch.amazonBrand;
    if (patch.websiteUrl && !row.website_url) updates.website_url = patch.websiteUrl;

    if (persist && Object.keys(updates).length > 0) {
      await db.from("brands").update(updates).eq("id", row.id);
    }
    return { brandRow: row, brandId: row.id };
  }

  if (!persist) return { brandRow: null, brandId: null };

  const { data: inserted, error } = await db
    .from("brands")
    .insert({
      name,
      slug,
      tiktok_handle: patch.tiktokHandle ?? null,
      instagram_handle: patch.instagramHandle ?? null,
      amazon_brand: patch.amazonBrand ?? null,
      website_url: patch.websiteUrl ?? null,
      discovery_source: "manual",
      first_seen_at: nowIso(),
    })
    .select("id, name, slug, tiktok_handle, instagram_handle, amazon_brand, website_url")
    .single();

  if (error || !inserted) {
    throw new Error(`ensureBrandRow: failed to insert "${name}": ${error?.message}`);
  }
  return { brandRow: inserted as BrandRow, brandId: inserted.id };
}

async function logResolution(
  db: ReturnType<typeof getAdminSupabase>,
  query: string,
  brandId: string | null,
  handles: {
    tiktokHandle?: string | null;
    instagramHandle?: string | null;
    amazonBrand?: string | null;
  },
  confidence: "high" | "medium" | "low" | "manual",
  extraLog: Record<string, unknown>
): Promise<void> {
  await db.from("handle_resolutions").insert({
    brand_name_query: query,
    brand_id: brandId,
    tiktok_handle: handles.tiktokHandle ?? null,
    instagram_handle: handles.instagramHandle ?? null,
    amazon_brand: handles.amazonBrand ?? null,
    confidence,
    resolution_log: extraLog,
  });
}

function unresolvedResult(name: string, log: ResolutionLogEntry[]): HandleResolution {
  return {
    brandId: null,
    brandName: name,
    tiktokHandle: null,
    instagramHandle: null,
    amazonBrand: null,
    websiteUrl: null,
    confidence: "unresolved",
    candidates: { tiktok: [], instagram: [] },
    resolutionLog: log.concat([{ strategy: "unresolved", matched: false }]),
  };
}
