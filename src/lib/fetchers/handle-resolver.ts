/**
 * Handle Resolver — brand name → social handles + Amazon brand string + website.
 *
 * The PRD (§4.2) calls this "the linchpin." Every fetcher downstream depends
 * on having resolved handles. Without auto-resolution, a Brand Card requires
 * a human to manually type handles every time — which defeats the "under 30
 * seconds" promise.
 *
 * V1 strategy (this file):
 *   1. If we already have a `brands` row with handles populated, use it. Done.
 *   2. Check `handle_resolutions` cache — if a recent query for this name
 *      resolved successfully, reuse it.
 *   3. Try deterministic guesses:
 *        - slugify(name) without hyphens (e.g. "Vacation Sunscreen" -> "vacationsunscreen")
 *        - slugify(name) with hyphens
 *        - slugify(name) shortest token (e.g. "vacation")
 *      Return them as candidates with confidence='low' — the caller can
 *      validate via the actual TikTok/Instagram fetchers (which will return
 *      404 for non-existent handles).
 *   4. If all else fails, return an "unresolved" result that the UI renders
 *      as a manual-entry prompt.
 *
 * Deferred (V2+):
 *   - Google Search via SerpAPI / DuckDuckGo HTML scrape with site: operators
 *   - TikTok search API (once we have approved credentials)
 *   - Amazon search-based brand discovery (we already do this in amazon.ts;
 *     we could harvest the brand name back into here)
 *   - LLM-based candidate ranking when multiple options exist
 *
 * The schema's `handle_resolutions` table is designed to log every
 * resolution attempt with its strategy, so when we add auto-resolution
 * later we can backfill old brands without losing the manual overrides.
 *
 * Output contract:
 *   We never return WRONG handles. If we're not sure, we return null with
 *   confidence='low' or 'unresolved' and let the caller decide whether to
 *   try them. False positives (e.g. claiming @vacation on TikTok is the
 *   sunscreen brand when it's actually a travel agency) are worse than
 *   no resolution — they would attribute someone else's follower count to
 *   our brand and pollute the trend lines forever.
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
  // Candidates we considered but didn't pick — useful for the UI's
  // "did you mean..." prompts.
  candidates: {
    tiktok: string[];
    instagram: string[];
  };
  // How we got here, for debugging.
  resolutionLog: ResolutionLogEntry[];
}

export interface ResolutionLogEntry {
  strategy: "db_brands" | "db_cache" | "deterministic_guess" | "unresolved";
  matched: boolean;
  detail?: string;
}

export interface ResolveOptions {
  brandName: string;
  // When set, we update or insert the corresponding `brands` row with the
  // resolved handles. Useful from the Brand Card endpoint; skip when we're
  // just previewing.
  persistToBrandsRow?: boolean;
  // Optional: caller can pre-populate handles to override auto-resolution
  // (e.g. user manually entered them in the UI).
  override?: {
    tiktokHandle?: string | null;
    instagramHandle?: string | null;
    amazonBrand?: string | null;
    websiteUrl?: string | null;
  };
}

/**
 * Main entry point.
 */
export async function resolveBrandHandles(opts: ResolveOptions): Promise<HandleResolution> {
  const name = opts.brandName.trim();
  if (!name) {
    return unresolvedResult("", []);
  }

  const log: ResolutionLogEntry[] = [];
  const db = getAdminSupabase();

  // -------------------------------------------------------------------
  // Strategy 0: explicit override from the caller
  // -------------------------------------------------------------------
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

  // -------------------------------------------------------------------
  // Strategy 1: existing brand row
  // -------------------------------------------------------------------
  const slug = slugify(name);
  const { data: brandRows } = await db
    .from("brands")
    .select("id, name, slug, tiktok_handle, instagram_handle, amazon_brand, website_url")
    .or(`slug.eq.${slug},name.ilike.${name}`)
    .limit(5);

  if (brandRows && brandRows.length > 0) {
    // Prefer exact slug match, then exact (case-insensitive) name match
    const exact =
      brandRows.find((r: { slug: string }) => r.slug === slug) ??
      brandRows.find((r: { name: string }) => r.name.toLowerCase() === name.toLowerCase()) ??
      brandRows[0];

    // Did the row have anything useful?
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
        tiktokHandle: exact.tiktok_handle ?? null,
        instagramHandle: exact.instagram_handle ?? null,
        amazonBrand: exact.amazon_brand ?? null,
        websiteUrl: exact.website_url ?? null,
        confidence: "high",
        candidates: { tiktok: [], instagram: [] },
        resolutionLog: log,
      };
    }
    // Row exists but is empty — fall through and try other strategies,
    // then update this row.
  } else {
    log.push({ strategy: "db_brands", matched: false });
  }

  // -------------------------------------------------------------------
  // Strategy 2: resolutions cache
  // -------------------------------------------------------------------
  const { data: cacheRows } = await db
    .from("handle_resolutions")
    .select("tiktok_handle, instagram_handle, amazon_brand, confidence")
    .ilike("brand_name_query", name)
    .order("created_at", { ascending: false })
    .limit(1);

  if (cacheRows && cacheRows.length > 0) {
    const cached = cacheRows[0];
    const hasAny = cached.tiktok_handle || cached.instagram_handle || cached.amazon_brand;
    log.push({ strategy: "db_cache", matched: hasAny, detail: `cached confidence=${cached.confidence}` });

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
        tiktokHandle: cached.tiktok_handle ?? null,
        instagramHandle: cached.instagram_handle ?? null,
        amazonBrand: cached.amazon_brand ?? null,
        websiteUrl: null,
        confidence: cached.confidence as HandleResolution["confidence"],
        candidates: { tiktok: [], instagram: [] },
        resolutionLog: log,
      };
    }
  } else {
    log.push({ strategy: "db_cache", matched: false });
  }

  // -------------------------------------------------------------------
  // Strategy 3: deterministic guesses (low-confidence candidates)
  // -------------------------------------------------------------------
  const guesses = guessHandlesFromName(name);
  log.push({
    strategy: "deterministic_guess",
    matched: guesses.length > 0,
    detail: `${guesses.length} candidates`,
  });

  // We never auto-commit guesses as resolved handles. We return them as
  // CANDIDATES so the UI can present "Did you mean @vacationsunscreen?"
  // and the TikTok/IG fetcher can attempt a follower lookup to disambiguate.
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
    candidates: {
      tiktok: guesses,
      instagram: guesses,
    },
    resolutionLog: log,
  };
}

// =========================================================================
// Helpers
// =========================================================================

/**
 * Generate plausible handle candidates from a brand name. Order matters —
 * the first returned is the most likely. The caller may try them in order
 * against TikTok/Instagram to disambiguate.
 *
 * Examples:
 *   "Vacation Sunscreen"  -> ["vacationsunscreen", "vacation_sunscreen", "vacation-sunscreen", "vacation"]
 *   "Olipop"              -> ["olipop"]
 *   "MUD\WTR"             -> ["mudwtr", "mud_wtr", "mud-wtr"]
 *   "Liquid I.V."         -> ["liquidiv", "liquid_iv", "liquid-iv", "liquid"]
 */
function guessHandlesFromName(name: string): string[] {
  const sluggy = slugify(name);            // "vacation-sunscreen"
  const compact = sluggy.replace(/-/g, ""); // "vacationsunscreen"
  const underscored = sluggy.replace(/-/g, "_"); // "vacation_sunscreen"
  const firstToken = sluggy.split("-")[0]; // "vacation"
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

/**
 * Find or create the `brands` row for this name. Returns its id and the row.
 * If `persist` is false, we still find existing rows but never insert.
 */
async function ensureBrandRow(
  name: string,
  patch: Partial<{
    tiktokHandle: string | null;
    instagramHandle: string | null;
    amazonBrand: string | null;
    websiteUrl: string | null;
  }>,
  persist: boolean = true
): Promise<{ brandRow: Record<string, unknown> | null; brandId: string | null }> {
  const db = getAdminSupabase();
  const slug = slugify(name);

  // Try to find existing
  const { data: existing } = await db
    .from("brands")
    .select("*")
    .or(`slug.eq.${slug},name.ilike.${name}`)
    .limit(1)
    .maybeSingle();

  if (existing) {
    // Patch in any new handle info we have
    const updates: Record<string, unknown> = {};
    if (patch.tiktokHandle && !existing.tiktok_handle) updates.tiktok_handle = patch.tiktokHandle;
    if (patch.instagramHandle && !existing.instagram_handle) updates.instagram_handle = patch.instagramHandle;
    if (patch.amazonBrand && !existing.amazon_brand) updates.amazon_brand = patch.amazonBrand;
    if (patch.websiteUrl && !existing.website_url) updates.website_url = patch.websiteUrl;

    if (persist && Object.keys(updates).length > 0) {
      await db.from("brands").update(updates).eq("id", existing.id);
    }
    return { brandRow: existing, brandId: existing.id };
  }

  if (!persist) {
    return { brandRow: null, brandId: null };
  }

  // Insert new
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
    .select("*")
    .single();

  if (error || !inserted) {
    throw new Error(`ensureBrandRow: failed to insert "${name}": ${error?.message}`);
  }
  return { brandRow: inserted, brandId: inserted.id };
}

/**
 * Append a row to `handle_resolutions` for the audit trail.
 */
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
