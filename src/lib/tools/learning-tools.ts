/**
 * Learning tools — Adam pattern, Postgres-backed.
 *
 * Stores agent memory in the `learnings` table (single global list, like
 * Adam's `config/adam.learnings`). When we add real role-based scoping
 * later we can attribute learnings per user or per category.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";

export async function executeSaveLearning(content: string) {
  const text = (content || "").trim();
  if (!text) return { error: "Learning content required" };
  if (text.length > 2000) return { error: "Learning too long (max 2000 chars)" };

  const db = getAdminSupabase();
  // Avoid duplicates (exact-match)
  const { data: existing } = await db
    .from("learnings")
    .select("id")
    .eq("content", text)
    .maybeSingle();
  if (existing) return { success: true, alreadyExists: true, id: existing.id };

  const { data, error } = await db
    .from("learnings")
    .insert({ content: text })
    .select("id")
    .single();
  if (error) return { error: error.message };
  return { success: true, id: data.id };
}

export async function executeRemoveLearning(content: string) {
  const text = (content || "").trim();
  if (!text) return { error: "Learning content required" };

  const db = getAdminSupabase();
  // Match exact, then case-insensitive partial as fallback
  const { data: exact } = await db
    .from("learnings")
    .select("id")
    .eq("content", text)
    .maybeSingle();
  if (exact) {
    await db.from("learnings").delete().eq("id", exact.id);
    return { success: true, removed: text };
  }
  // Partial match — useful when the agent didn't quote exactly
  const { data: partial } = await db
    .from("learnings")
    .select("id, content")
    .ilike("content", `%${text}%`)
    .limit(1)
    .maybeSingle();
  if (partial) {
    await db.from("learnings").delete().eq("id", partial.id);
    return { success: true, removed: partial.content };
  }
  return { error: `No learning matched "${text}"` };
}

export async function executeGetLearnings() {
  const db = getAdminSupabase();
  const { data, error } = await db
    .from("learnings")
    .select("id, content, created_at")
    .order("created_at", { ascending: false });
  if (error) return { error: error.message };
  return { learnings: data ?? [] };
}
