/**
 * Supabase Auth context — equivalent of Adam's Firebase auth-context.
 *
 * Exposes:
 *   - `user`: { id, email } | null
 *   - `loading`: true while we resolve initial session
 *   - `token`: the current access JWT (used as Bearer for /api/* calls)
 *   - `login(email)`: send a magic link (Supabase magic-link flow)
 *   - `loginWithPassword(email, password)`: classic password login
 *   - `logout()`
 *
 * Token lifecycle:
 *   Supabase auto-refreshes the JWT internally; we subscribe to
 *   `onAuthStateChange` to keep our local copy in sync. Every fetch to
 *   /api/* should attach this as `Authorization: Bearer <token>`.
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Session, User as SupabaseUser } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase";

export interface AuthUser {
  id: string;
  email: string | null;
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  token: string | null;
  loginWithPassword: (email: string, password: string) => Promise<void>;
  loginWithMagicLink: (email: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  token: null,
  loginWithPassword: async () => {},
  loginWithMagicLink: async () => {},
  logout: async () => {},
});

function mapUser(u: SupabaseUser | null | undefined): AuthUser | null {
  if (!u) return null;
  return { id: u.id, email: u.email ?? null };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const supabase = getSupabaseClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    // 1. Hydrate from current session on mount
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      const session: Session | null = data.session;
      setUser(mapUser(session?.user));
      setToken(session?.access_token ?? null);
      setLoading(false);
    });

    // 2. Subscribe to future auth state changes (login, refresh, logout)
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setUser(mapUser(session?.user));
      setToken(session?.access_token ?? null);
      setLoading(false);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  const loginWithPassword = useCallback(
    async (email: string, password: string) => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    [supabase]
  );

  const loginWithMagicLink = useCallback(
    async (email: string) => {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: typeof window !== "undefined" ? `${window.location.origin}/dashboard` : undefined,
        },
      });
      if (error) throw error;
    },
    [supabase]
  );

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
  }, [supabase]);

  return (
    <AuthContext.Provider value={{ user, loading, token, loginWithPassword, loginWithMagicLink, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
