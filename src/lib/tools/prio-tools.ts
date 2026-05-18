/**
 * Prio tools — per-user priorities. Adam pattern, Postgres-backed.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import type { Prio, PrioStatus } from "@/lib/types";

function mapPrio(r: Record<string, unknown>): Prio {
  return {
    id: r.id as string,
    authUserId: r.auth_user_id as string,
    title: r.title as string,
    entityType: (r.entity_type as string | null) ?? null,
    entityId: (r.entity_id as string | null) ?? null,
    entityName: (r.entity_name as string | null) ?? null,
    status: r.status as PrioStatus,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function executeGetPrios(authUserId: string) {
  const db = getAdminSupabase();
  const { data, error } = await db
    .from("prios")
    .select("*")
    .eq("auth_user_id", authUserId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return { error: error.message };
  return { prios: (data ?? []).map(mapPrio) };
}

export async function executeCreatePrio(
  authUserId: string,
  data: { title: string; entityType?: string; entityId?: string; entityName?: string }
) {
  const db = getAdminSupabase();
  const { data: row, error } = await db
    .from("prios")
    .insert({
      auth_user_id: authUserId,
      title: data.title,
      entity_type: data.entityType ?? null,
      entity_id: data.entityId ?? null,
      entity_name: data.entityName ?? null,
      status: "active",
    })
    .select("*")
    .single();
  if (error) return { error: error.message };
  return { success: true, prio: mapPrio(row) };
}

export async function executeUpdatePrioStatus(
  authUserId: string,
  prioId: string,
  status: "completed" | "dismissed"
) {
  const db = getAdminSupabase();
  // Validate ownership before update
  const { data: existing } = await db
    .from("prios")
    .select("auth_user_id")
    .eq("id", prioId)
    .maybeSingle();
  if (!existing) return { error: `Priority "${prioId}" not found` };
  if (existing.auth_user_id !== authUserId) return { error: "Not your priority" };

  const { error } = await db.from("prios").update({ status }).eq("id", prioId);
  if (error) return { error: error.message };
  return { success: true, prioId, status };
}
