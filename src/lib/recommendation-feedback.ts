/**
 * Recommendation feedback — per-rep thumbs up/down on a brand's recommendation.
 *
 * This is an INTERNAL DIAGNOSTIC TOOL for the owner, not a sentiment scoreboard.
 * Its job is to surface where the engine's recommendation/classification/data
 * disagrees with what a rep sees on the ground — so the owner can find the bad
 * recommendations, read the rep's note ("already in 400 Targets", "this is an
 * FBA reseller"), and follow up with that specific rep to learn what the engine
 * is missing. Votes do NOT (yet) feed back into the momentum score — capture
 * now, explore tuning later.
 *
 * Attribution is per-individual on purpose: unlike deprioritize (which defaults
 * to a shared TEAM_SCOPE_ID because its routes don't pass a user), feedback
 * REQUIRES the real auth_user_id from verifyAuthToken. Knowing *who* disagreed
 * is the whole point — the owner wants to go talk to them.
 *
 * Each vote snapshots what the card showed at vote time (recommended_action,
 * momentum_score, brand_type). That anchoring is what turns a vote into a
 * diagnostic: "of the call_now recs reps marked wrong, here's the context."
 *
 * Storage: one row per (brand_id, auth_user_id). Re-voting updates; toggling the
 * same vote off deletes that rep's row (a vote is an opinion, not a historical
 * record we need to retain — and a clean delete keeps "current votes" honest).
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import { nowIso } from "@/lib/utils";

export type Vote = -1 | 1;

export interface FeedbackContext {
  recommendedAction?: string | null;
  momentumScore?: number | null;
  brandType?: string | null;
}

export interface RecordFeedbackInput extends FeedbackContext {
  brandId: string;
  authUserId: string;
  vote: Vote;
  note?: string | null;
}

export interface BrandFeedbackState {
  vote: Vote;
  note: string | null;
  at: string;
}

/**
 * Record (or update) a rep's vote on a brand. Upserts on (brand_id,
 * auth_user_id) so a rep changing their mind replaces their prior vote.
 */
export async function recordFeedback(
  input: RecordFeedbackInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.authUserId) return { ok: false, error: "authUserId required" };
  if (input.vote !== -1 && input.vote !== 1) return { ok: false, error: "vote must be -1 or 1" };

  const db = getAdminSupabase();

  const { data: existing } = await db
    .from("recommendation_feedback")
    .select("id")
    .eq("brand_id", input.brandId)
    .eq("auth_user_id", input.authUserId)
    .maybeSingle();

  const row = {
    brand_id: input.brandId,
    auth_user_id: input.authUserId,
    vote: input.vote,
    recommended_action: input.recommendedAction ?? null,
    momentum_score: input.momentumScore ?? null,
    brand_type: input.brandType ?? null,
    note: typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : null,
    updated_at: nowIso(),
  };

  if (existing) {
    const { error } = await db.from("recommendation_feedback").update(row).eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await db.from("recommendation_feedback").insert(row);
    if (error) return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Clear a rep's vote on a brand (toggle-off). Deletes only that rep's row;
 * other reps' votes on the same brand are untouched.
 */
export async function clearFeedback(
  brandId: string,
  authUserId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!authUserId) return { ok: false, error: "authUserId required" };
  const db = getAdminSupabase();
  const { error } = await db
    .from("recommendation_feedback")
    .delete()
    .eq("brand_id", brandId)
    .eq("auth_user_id", authUserId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * The current rep's own vote on a brand (for showing the active thumb state on
 * the card). Null if this rep hasn't voted.
 */
export async function getFeedbackForBrand(
  brandId: string,
  authUserId: string
): Promise<BrandFeedbackState | null> {
  if (!authUserId) return null;
  const db = getAdminSupabase();
  const { data } = await db
    .from("recommendation_feedback")
    .select("vote, note, updated_at")
    .eq("brand_id", brandId)
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (!data) return null;
  return {
    vote: (data.vote as Vote),
    note: (data.note as string | null) ?? null,
    at: data.updated_at as string,
  };
}

export interface FeedbackListItem {
  id: string;
  brandId: string;
  brandName: string | null;
  brandSlug: string | null;
  voterEmail: string | null;
  vote: Vote;
  note: string | null;
  recommendedAction: string | null;
  momentumScore: number | null;
  brandType: string | null;
  at: string;
}

/**
 * All feedback for the owner's internal review view. Down-votes first (the
 * high-signal disagreements), then newest. Joins brand name/slug and the
 * voter's email so the owner can see who to follow up with.
 */
export async function listFeedback(limit = 200): Promise<FeedbackListItem[]> {
  const db = getAdminSupabase();
  const { data, error } = await db
    .from("recommendation_feedback")
    .select("id, brand_id, auth_user_id, vote, note, recommended_action, momentum_score, brand_type, updated_at")
    .order("vote", { ascending: true }) // -1 (down) before +1 (up)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listFeedback: ${error.message}`);
  const rows = (data ?? []) as Array<{
    id: string;
    brand_id: string;
    auth_user_id: string;
    vote: number;
    note: string | null;
    recommended_action: string | null;
    momentum_score: number | null;
    brand_type: string | null;
    updated_at: string;
  }>;
  if (rows.length === 0) return [];

  // Hydrate brand name/slug.
  const brandIds = [...new Set(rows.map((r) => r.brand_id))];
  const { data: brandRows } = await db
    .from("brands")
    .select("id, name, slug")
    .in("id", brandIds);
  const brandById = new Map(
    ((brandRows ?? []) as Array<{ id: string; name: string | null; slug: string | null }>).map((b) => [b.id, b])
  );

  // Hydrate voter emails via the admin auth API (auth.users isn't directly
  // selectable through PostgREST). De-dupe the lookups.
  const userIds = [...new Set(rows.map((r) => r.auth_user_id))];
  const emailById = new Map<string, string | null>();
  for (const uid of userIds) {
    try {
      const { data: u } = await db.auth.admin.getUserById(uid);
      emailById.set(uid, u?.user?.email ?? null);
    } catch {
      emailById.set(uid, null);
    }
  }

  return rows.map((r) => {
    const b = brandById.get(r.brand_id);
    return {
      id: r.id,
      brandId: r.brand_id,
      brandName: b?.name ?? null,
      brandSlug: b?.slug ?? null,
      voterEmail: emailById.get(r.auth_user_id) ?? null,
      vote: (r.vote as Vote),
      note: r.note,
      recommendedAction: r.recommended_action,
      momentumScore: r.momentum_score,
      brandType: r.brand_type,
      at: r.updated_at,
    };
  });
}
