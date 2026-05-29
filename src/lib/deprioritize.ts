/**
 * Deprioritize / dismiss a brand from the weekly to-do, with a reason and an
 * optional note — keeping a historical record while burying it from the list.
 *
 * Built on the existing `prios` table (status: active | completed | dismissed),
 * extended with `reason` + `reason_detail`. We reuse one prio row per
 * (auth_user_id, brand) so re-dismissing updates rather than piling up rows.
 *
 * V1 auth note: the routes don't yet pass the logged-in user, so dismissals are
 * scoped to a single shared pilot id — the owner account. prios.auth_user_id has
 * an FK to auth.users, so this MUST be a real user id, not a synthetic sentinel.
 * The data model is already per-user, so when session wiring reaches these routes
 * this becomes per-salesperson with no schema change — pass the real user id.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";

// Shared pilot scope until per-user session wiring reaches these routes. This
// MUST be a real auth.users id (prios.auth_user_id has an FK to auth.users) —
// a synthetic UUID violates the constraint. Using the owner account
// (jon@youngproducts.ai) as the shared scope for now.
export const TEAM_SCOPE_ID = "0d8c1f49-7f25-4576-aaef-72a3d73531a7";

export type DeprioritizeReason =
  | "not_a_fit"
  | "already_contacted"
  | "not_interested"
  | "timing"
  | "other";

export const DEPRIORITIZE_REASON_LABELS: Record<DeprioritizeReason, string> = {
  not_a_fit: "Not a fit",
  already_contacted: "Already contacted",
  not_interested: "Not interested",
  timing: "Wrong timing",
  other: "Other",
};

export interface DeprioritizeInput {
  brandId: string;
  brandName: string;
  reason: DeprioritizeReason;
  detail?: string;
  authUserId?: string; // defaults to the team scope until per-user auth
}

/**
 * Dismiss a brand. Upserts a single dismissed prio row for this
 * (auth_user_id, brand) pair so it stays a clean historical record.
 */
export async function deprioritizeBrand(input: DeprioritizeInput): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getAdminSupabase();
  const authUserId = input.authUserId ?? TEAM_SCOPE_ID;

  // Is there already a prio row for this brand+user? Reuse it.
  const { data: existing } = await db
    .from("prios")
    .select("id")
    .eq("auth_user_id", authUserId)
    .eq("entity_type", "brand")
    .eq("entity_id", input.brandId)
    .maybeSingle();

  const row = {
    auth_user_id: authUserId,
    title: `${input.brandName} — deprioritized`,
    entity_type: "brand",
    entity_id: input.brandId,
    entity_name: input.brandName,
    status: "dismissed",
    reason: input.reason,
    reason_detail: input.detail ?? null,
  };

  if (existing) {
    const { error } = await db.from("prios").update(row).eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await db.from("prios").insert(row);
    if (error) return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Re-activate (un-dismiss) a brand — restores it to the weekly to-do.
 */
export async function reprioritizeBrand(
  brandId: string,
  authUserId: string = TEAM_SCOPE_ID
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getAdminSupabase();
  const { error } = await db
    .from("prios")
    .update({ status: "active", reason: null, reason_detail: null })
    .eq("auth_user_id", authUserId)
    .eq("entity_type", "brand")
    .eq("entity_id", brandId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Set of brand ids currently dismissed for a scope — used by the weekly report
 * and discovery to bury them from the active list. Returns a Set for O(1) lookup.
 */
export async function getDismissedBrandIds(authUserId: string = TEAM_SCOPE_ID): Promise<Set<string>> {
  const db = getAdminSupabase();
  const { data } = await db
    .from("prios")
    .select("entity_id")
    .eq("auth_user_id", authUserId)
    .eq("entity_type", "brand")
    .eq("status", "dismissed");
  return new Set((data ?? []).map((r: { entity_id: string | null }) => r.entity_id).filter(Boolean) as string[]);
}

/**
 * The dismissal record for one brand (for showing "deprioritized: already
 * contacted" state + an undo on the card). Null if not dismissed.
 */
export async function getDismissalForBrand(
  brandId: string,
  authUserId: string = TEAM_SCOPE_ID
): Promise<{ reason: DeprioritizeReason | null; detail: string | null; at: string } | null> {
  const db = getAdminSupabase();
  const { data } = await db
    .from("prios")
    .select("reason, reason_detail, updated_at, status")
    .eq("auth_user_id", authUserId)
    .eq("entity_type", "brand")
    .eq("entity_id", brandId)
    .eq("status", "dismissed")
    .maybeSingle();
  if (!data) return null;
  return {
    reason: (data.reason as DeprioritizeReason | null) ?? null,
    detail: (data.reason_detail as string | null) ?? null,
    at: data.updated_at as string,
  };
}
