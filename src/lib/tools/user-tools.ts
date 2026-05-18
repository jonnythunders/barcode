/**
 * User tools — Adam pattern, Supabase Auth + user_profiles backed.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";

export async function executeGetUserProfile(authUserId: string) {
  const db = getAdminSupabase();
  const { data: profile } = await db
    .from("user_profiles")
    .select("display_name, notes, language")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  // If no profile row yet, return defaults
  if (!profile) {
    return {
      authUserId,
      displayName: null,
      notes: null,
      language: "en",
    };
  }
  return {
    authUserId,
    displayName: profile.display_name,
    notes: profile.notes,
    language: profile.language,
  };
}

export async function executeUpdateUserNotes(authUserId: string, notes: string) {
  const db = getAdminSupabase();
  const { error } = await db
    .from("user_profiles")
    .upsert(
      { auth_user_id: authUserId, notes },
      { onConflict: "auth_user_id" }
    );
  if (error) return { error: error.message };
  return { success: true };
}

export async function executeUpdateUserLanguage(authUserId: string, language: string) {
  if (language !== "en" && language !== "es") {
    return { error: `Unsupported language "${language}". Use 'en' or 'es'.` };
  }
  const db = getAdminSupabase();
  const { error } = await db
    .from("user_profiles")
    .upsert(
      { auth_user_id: authUserId, language },
      { onConflict: "auth_user_id" }
    );
  if (error) return { error: error.message };
  return { success: true, language };
}

export async function executeUpdateUserDisplayName(authUserId: string, displayName: string) {
  const db = getAdminSupabase();
  const { error } = await db
    .from("user_profiles")
    .upsert(
      { auth_user_id: authUserId, display_name: displayName },
      { onConflict: "auth_user_id" }
    );
  if (error) return { error: error.message };
  return { success: true };
}
