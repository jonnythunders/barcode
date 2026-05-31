/**
 * Handle review queue.
 *
 * The search-based resolver (handle-resolver.ts) auto-accepts only "high"
 * confidence matches (strong absolute score AND a clear margin over the
 * runner-up). Borderline matches — a decent score but an ambiguous name, e.g.
 * a near-tie between two accounts — are returned for the current fetch but
 * NOT baked into the brands row; they're logged to `handle_resolutions` so a
 * human can confirm or correct them. This module surfaces those for review.
 *
 * IMPORTANT — what a "needs review" row actually looks like on disk:
 * The resolver collapses the search-level "needs_review" verdict down to the
 * stored confidence "low" before persisting (see logResolution in
 * handle-resolver.ts), and "low" ALSO covers fully-unresolved misses. So we
 * cannot just list confidence='low' rows — most of those are dead misses with
 * no usable candidate. The real signal lives in resolution_log: a genuine
 * review candidate has tiktok.confidence === "needs_review" or
 * instagram.confidence === "needs_review" WITH a `best` candidate handle.
 * We filter on exactly that.
 *
 * Decisions never delete data (matches the app's no-permanent-deletion
 * posture). Approve writes the chosen handle(s) onto the brands row — which is
 * what the resolver's Strategy-1 reads as high-confidence thereafter — and
 * logs a confidence:"manual" resolution as an audit trail. Reject logs a
 * confidence:"manual" resolution with null handles, so the queue (which only
 * looks at the LATEST resolution per brand-name) stops surfacing it.
 */
import { getAdminSupabase } from "./supabase-admin";
import { nowIso } from "./utils";

export interface ReviewCandidate {
  handle: string;
  score: number | null;
  followerCount: number | null;
}

export interface ReviewQueueItem {
  /** Latest resolution row id for this brand-name query. */
  resolutionId: string;
  brandNameQuery: string;
  brandId: string | null;
  brandSlug: string | null;
  /** Handles currently on the brands row (what's live right now). */
  currentTiktokHandle: string | null;
  currentInstagramHandle: string | null;
  /** The resolver's best borderline guesses, with alternates for the dropdown. */
  tiktokSuggestion: string | null;
  instagramSuggestion: string | null;
  tiktokCandidates: ReviewCandidate[];
  instagramCandidates: ReviewCandidate[];
  createdAt: string;
}

interface ResolutionRow {
  id: string;
  brand_name_query: string;
  brand_id: string | null;
  tiktok_handle: string | null;
  instagram_handle: string | null;
  confidence: string | null;
  resolution_log: ResolutionLogShape | null;
  created_at: string;
}

interface PlatformLog {
  confidence?: "high" | "needs_review" | "unresolved";
  best?: { handle: string; score?: number; followerCount?: number } | null;
  candidates?: Array<{ handle: string; score?: number; followerCount?: number }>;
}
interface ResolutionLogShape {
  strategy?: string;
  tiktok?: PlatformLog;
  instagram?: PlatformLog;
}

function toCandidates(p: PlatformLog | undefined): ReviewCandidate[] {
  if (!p?.candidates) return [];
  return p.candidates.slice(0, 5).map((c) => ({
    handle: c.handle,
    score: typeof c.score === "number" ? c.score : null,
    followerCount: typeof c.followerCount === "number" ? c.followerCount : null,
  }));
}

/** True when this resolution actually has a borderline match worth a human look. */
function isReviewable(log: ResolutionLogShape | null): boolean {
  if (!log) return false;
  const tt = log.tiktok;
  const ig = log.instagram;
  const ttReview = tt?.confidence === "needs_review" && !!tt?.best?.handle;
  const igReview = ig?.confidence === "needs_review" && !!ig?.best?.handle;
  return ttReview || igReview;
}

/**
 * List brands awaiting handle review. Reads recent low-confidence resolutions,
 * keeps only the LATEST per brand-name query, filters to genuine review
 * candidates, and joins current brands-row handles so the reviewer can see
 * what's live vs. what's suggested.
 */
export async function listReviewQueue(limit = 100): Promise<ReviewQueueItem[]> {
  const db = getAdminSupabase();

  // Pull a generous window of recent low-confidence rows (newest first) so we
  // can collapse to latest-per-query in app code. "manual" rows are how a
  // human decision is recorded; if the latest row for a query is "manual", the
  // brand has already been actioned and must NOT reappear — so we include
  // manual rows in the window and let the latest-wins pass drop actioned ones.
  const { data, error } = await db
    .from("handle_resolutions")
    .select(
      "id, brand_name_query, brand_id, tiktok_handle, instagram_handle, confidence, resolution_log, created_at"
    )
    .in("confidence", ["low", "manual"])
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) throw new Error(`listReviewQueue: ${error.message}`);
  const rows = (data ?? []) as ResolutionRow[];

  // Latest-wins per normalized brand-name query.
  const latestByQuery = new Map<string, ResolutionRow>();
  for (const r of rows) {
    const key = r.brand_name_query.trim().toLowerCase();
    if (!latestByQuery.has(key)) latestByQuery.set(key, r); // first seen = newest
  }

  const items: ReviewQueueItem[] = [];
  for (const r of latestByQuery.values()) {
    // If the newest row is a human decision, it's been actioned — skip.
    if (r.confidence === "manual") continue;
    if (!isReviewable(r.resolution_log)) continue;

    const tt = r.resolution_log?.tiktok;
    const ig = r.resolution_log?.instagram;

    items.push({
      resolutionId: r.id,
      brandNameQuery: r.brand_name_query,
      brandId: r.brand_id,
      brandSlug: null, // hydrated below
      currentTiktokHandle: null,
      currentInstagramHandle: null,
      tiktokSuggestion: tt?.confidence === "needs_review" ? tt?.best?.handle ?? null : null,
      instagramSuggestion: ig?.confidence === "needs_review" ? ig?.best?.handle ?? null : null,
      tiktokCandidates: toCandidates(tt),
      instagramCandidates: toCandidates(ig),
      createdAt: r.created_at,
    });
    if (items.length >= limit) break;
  }

  // Hydrate current brands-row handles + slug for the items we kept.
  const brandIds = items.map((i) => i.brandId).filter((x): x is string => !!x);
  if (brandIds.length > 0) {
    const { data: brandRows } = await db
      .from("brands")
      .select("id, slug, tiktok_handle, instagram_handle")
      .in("id", brandIds);
    const byId = new Map(
      ((brandRows ?? []) as Array<{
        id: string;
        slug: string | null;
        tiktok_handle: string | null;
        instagram_handle: string | null;
      }>).map((b) => [b.id, b])
    );
    for (const item of items) {
      if (item.brandId && byId.has(item.brandId)) {
        const b = byId.get(item.brandId)!;
        item.brandSlug = b.slug;
        item.currentTiktokHandle = b.tiktok_handle;
        item.currentInstagramHandle = b.instagram_handle;
      }
    }
  }

  return items;
}

export interface ReviewDecisionInput {
  resolutionId: string;
  decision: "approve" | "reject";
  /** For approve: the handles the human confirmed (either/both, or none). */
  tiktokHandle?: string | null;
  instagramHandle?: string | null;
}

export interface ReviewDecisionResult {
  ok: boolean;
  error?: string;
  brandId?: string | null;
  appliedTiktok?: string | null;
  appliedInstagram?: string | null;
}

function normalizeHandle(h: string | null | undefined): string | null {
  if (!h) return null;
  const t = h.trim().replace(/^@/, "");
  return t.length > 0 ? t : null;
}

/**
 * Apply a human review decision.
 *  - approve: write the confirmed handle(s) onto the brands row (only fills
 *    fields the human supplied; leaves others as-is), then log a "manual"
 *    resolution as the audit record + queue-suppression marker.
 *  - reject: log a "manual" resolution with null handles. Nothing is written to
 *    the brands row; the queue stops surfacing it because latest-per-query is
 *    now a manual decision. Never deletes the original row.
 *
 * Does NOT re-poll. The brands row is now authoritative, so the next scheduled
 * poll (or a manual ?recompute / refresh) picks up the corrected handle. We
 * deliberately avoid firing a credit-spending fetch here.
 */
export async function applyReviewDecision(input: ReviewDecisionInput): Promise<ReviewDecisionResult> {
  const db = getAdminSupabase();

  const { data: resRow, error: resErr } = await db
    .from("handle_resolutions")
    .select("id, brand_name_query, brand_id")
    .eq("id", input.resolutionId)
    .maybeSingle();
  if (resErr) return { ok: false, error: resErr.message };
  if (!resRow) return { ok: false, error: "resolution not found" };

  const row = resRow as { id: string; brand_name_query: string; brand_id: string | null };
  const tt = normalizeHandle(input.tiktokHandle);
  const ig = normalizeHandle(input.instagramHandle);

  if (input.decision === "approve") {
    if (!tt && !ig) {
      return { ok: false, error: "approve requires at least one handle" };
    }
    if (row.brand_id) {
      const updates: Record<string, string> = {};
      if (tt) updates.tiktok_handle = tt;
      if (ig) updates.instagram_handle = ig;
      if (Object.keys(updates).length > 0) {
        const { error: upErr } = await db.from("brands").update(updates).eq("id", row.brand_id);
        if (upErr) return { ok: false, error: `brands update: ${upErr.message}` };
      }
    }
    const { error: logErr } = await db.from("handle_resolutions").insert({
      brand_name_query: row.brand_name_query,
      brand_id: row.brand_id,
      tiktok_handle: tt,
      instagram_handle: ig,
      amazon_brand: null,
      confidence: "manual",
      resolution_log: { strategy: "manual_review", decision: "approve", reviewedAt: nowIso() },
    });
    if (logErr) return { ok: false, error: `audit log: ${logErr.message}` };
    return { ok: true, brandId: row.brand_id, appliedTiktok: tt, appliedInstagram: ig };
  }

  // reject
  const { error: logErr } = await db.from("handle_resolutions").insert({
    brand_name_query: row.brand_name_query,
    brand_id: row.brand_id,
    tiktok_handle: null,
    instagram_handle: null,
    amazon_brand: null,
    confidence: "manual",
    resolution_log: { strategy: "manual_review", decision: "reject", reviewedAt: nowIso() },
  });
  if (logErr) return { ok: false, error: `audit log: ${logErr.message}` };
  return { ok: true, brandId: row.brand_id, appliedTiktok: null, appliedInstagram: null };
}
