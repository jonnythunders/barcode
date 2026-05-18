/**
 * Browser Supabase client (anon key).
 *
 * Use this in client components and contexts (matches Adam's `firebase.ts`
 * pattern). RLS policies enforce what the anon/auth user can read.
 *
 * For server-side data access, use `supabase-admin.ts` instead.
 */
import { createBrowserClient } from "@supabase/ssr";
import { publicEnv } from "./env";

export function getSupabaseClient() {
  return createBrowserClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey);
}
