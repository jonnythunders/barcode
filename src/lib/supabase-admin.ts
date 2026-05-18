/**
 * Server-side Supabase admin client (service-role key).
 *
 * Equivalent to Adam's `firebase-admin.ts`. Bypasses RLS — never import
 * this from client components.
 *
 * Two helpers exposed:
 *   - `getAdminSupabase()` — lazy singleton, used everywhere server-side
 *   - `verifyAuthToken(request)` — pulls the Bearer token off an incoming
 *      request and returns { authUserId } if valid. Used in /api/chat and
 *      anywhere else that needs to know who's calling.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "./env";

let _admin: SupabaseClient | null = null;

export function getAdminSupabase(): SupabaseClient {
  if (_admin) return _admin;
  const env = getServerEnv();
  _admin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: { "x-application-name": "barcode-server" },
    },
  });
  return _admin;
}

/**
 * Verify the `Authorization: Bearer <jwt>` header from an incoming Request.
 * Throws if missing or invalid. Returns the auth user's id on success.
 *
 * The agent's chat endpoint and any user-scoped API route should call this.
 */
export async function verifyAuthToken(request: Request): Promise<{ authUserId: string; email: string | undefined }> {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }
  const jwt = header.slice("Bearer ".length).trim();
  if (!jwt) throw new Error("Empty bearer token");

  const supabase = getAdminSupabase();
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data.user) {
    throw new Error(`Auth verification failed: ${error?.message || "no user"}`);
  }
  return { authUserId: data.user.id, email: data.user.email };
}

/**
 * Verify the cron secret header used by Vercel Cron endpoints.
 * Throws on mismatch. Use at the top of every /api/cron/* route.
 */
export function verifyCronSecret(request: Request): void {
  const env = getServerEnv();
  if (!env.cronSecret) {
    throw new Error("CRON_SECRET not configured");
  }
  const header = request.headers.get("Authorization");
  const expected = `Bearer ${env.cronSecret}`;
  if (header !== expected) {
    throw new Error("Invalid cron auth");
  }
}
