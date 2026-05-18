/**
 * Discovery base — shared utilities for "find brands we don't know about."
 *
 * Discovery sources find candidate brand names from external signals (TikTok
 * hashtag pages, Amazon top-100, Reddit, Shopify bestsellers). Each source
 * produces `DiscoveryCandidate[]`. This file is the deduper + persister.
 *
 * The flow per candidate:
 *   1. Slugify name. Check `brands` table.
 *      - If present and `is_monitored=true`: skip (we already know it).
 *      - If present and archived: skip (we explicitly excluded it).
 *      - If present but unmonitored: re-enable monitoring + bump `first_seen_at`.
 *   2. If new: insert with `discovery_source` set to the source kind.
 *      Don't try to fetch the Brand Card here — that's the weekly poll's
 *      job and would balloon discovery into N parallel full-fetches.
 *   3. Log everything in `fetcher_runs` for observability.
 *
 * Key invariant: discovery NEVER deletes brands and NEVER overwrites
 * existing handles. If a discovery source mis-attributes (e.g. a TikTok
 * account named after a category, not a brand), the false positive sits
 * in the discovery feed for a human to review/archive.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { slugify } from "@/lib/utils";
import type { DiscoverySource } from "@/lib/types";

export interface DiscoveryCandidate {
  /** Brand name as it appears at the source. */
  name: string;
  /** Optional: handles already extracted (e.g. a TikTok hashtag page already gave us the handle). */
  tiktokHandle?: string;
  instagramHandle?: string;
  websiteUrl?: string;
  amazonBrand?: string;
  /** Optional: which category we found this in. Drives primary_category_id. */
  categoryId?: string;
  /** Source URL for the audit trail. */
  sourceUrl?: string;
  /** Free-form notes ("Top post in #healthysnacks with 4.2M views"). */
  notes?: string;
}

export interface DiscoveryResult {
  newCount: number;
  reActivatedCount: number;
  skippedCount: number;
  insertedBrandIds: string[];
}

/**
 * Persist a batch of discovery candidates. Idempotent: a candidate that
 * already maps to an active brand is a no-op.
 */
export async function persistCandidates(
  candidates: DiscoveryCandidate[],
  source: DiscoverySource
): Promise<DiscoveryResult> {
  const db = getAdminSupabase();
  const result: DiscoveryResult = {
    newCount: 0,
    reActivatedCount: 0,
    skippedCount: 0,
    insertedBrandIds: [],
  };

  // Dedupe by slug within the batch — multiple hashtag posts often point
  // at the same brand and we don't want to insert it twice.
  const seenSlugs = new Set<string>();
  const dedupedCandidates: { candidate: DiscoveryCandidate; slug: string }[] = [];
  for (const c of candidates) {
    const name = c.name.trim();
    if (!name) continue;
    const slug = slugify(name);
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    dedupedCandidates.push({ candidate: c, slug });
  }

  for (const { candidate, slug } of dedupedCandidates) {
    // Check existing brand by slug
    const { data: existing } = await db
      .from("brands")
      .select("id, is_monitored, is_archived")
      .eq("slug", slug)
      .maybeSingle();

    if (existing) {
      if (existing.is_archived) {
        result.skippedCount++;
        continue;
      }
      if (existing.is_monitored) {
        result.skippedCount++;
        continue;
      }
      // Brand exists but not monitored — re-enable
      await db.from("brands").update({ is_monitored: true }).eq("id", existing.id);
      result.reActivatedCount++;
      continue;
    }

    // New brand — insert with handle hints + source
    const { data: inserted, error } = await db
      .from("brands")
      .insert({
        name: candidate.name.trim(),
        slug,
        tiktok_handle: candidate.tiktokHandle ?? null,
        instagram_handle: candidate.instagramHandle ?? null,
        website_url: candidate.websiteUrl ?? null,
        amazon_brand: candidate.amazonBrand ?? null,
        primary_category_id: candidate.categoryId ?? null,
        discovery_source: source,
        notes: candidate.notes ?? null,
        is_monitored: true,
      })
      .select("id")
      .single();

    if (error || !inserted) {
      // Most common cause: unique slug race condition. Skip silently —
      // the other path will have created the row.
      console.warn(`[discovery] insert failed for "${candidate.name}": ${error?.message}`);
      result.skippedCount++;
      continue;
    }

    result.newCount++;
    result.insertedBrandIds.push(inserted.id);
  }

  return result;
}

/**
 * Filter candidates by min name length and against an obvious-non-brand
 * stoplist. Crawlers should call this before persisting — saves DB churn.
 *
 * The stoplist is small and conservative. We'd rather let a few duds through
 * (a human can archive them) than block real brands. False negatives are far
 * cheaper than false positives.
 */
const NON_BRAND_STOPLIST = new Set([
  "tiktok", "instagram", "youtube", "facebook", "twitter", "reddit", "amazon",
  "shopify", "viral", "fyp", "foryou", "foryoupage", "trending", "explore",
  "shop", "store", "official", "page", "post", "creator", "influencer",
  "review", "reviews", "video", "videos", "live", "ad", "ads", "advert",
  "deal", "deals", "sale", "shopnow", "linkinbio", "linkbio",
]);

export function filterPlausibleBrandNames(candidates: DiscoveryCandidate[]): DiscoveryCandidate[] {
  return candidates.filter((c) => {
    const lower = c.name.trim().toLowerCase();
    if (lower.length < 3 || lower.length > 60) return false;
    if (NON_BRAND_STOPLIST.has(lower)) return false;
    // Reject if 100% non-alphanumeric or all digits
    if (!/[a-z]/i.test(lower)) return false;
    // Reject obvious hashtag fragments like "snacktok"
    if (/tok$/i.test(lower) && lower.length <= 10) return false;
    return true;
  });
}
