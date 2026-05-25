"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Supabase login page. Supports two modes:
 *   - Magic link (default — passwordless)
 *   - Password (toggle via the "use password" link)
 *
 * For Barcode's small internal team, password is probably what they want
 * day-to-day. Magic link is included as the friendlier first-time flow.
 */
export default function LoginPage() {
  const { loginWithPassword, loginWithMagicLink } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<"password" | "magic">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      if (mode === "password") {
        await loginWithPassword(email, password);
        router.push("/dashboard");
      } else {
        await loginWithMagicLink(email);
        setSuccess("Check your inbox — magic link sent.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bc-page-texture">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/kestrel-mark.png" alt="Kestrel" className="h-12 w-12 object-contain" />
            <div className="text-left leading-none">
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">Barcode</h1>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-700 mt-1">Kestrel</p>
            </div>
          </div>
          <p className="text-sm text-slate-500 mt-3">Find the brands worth calling.</p>
        </div>
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-xl border border-slate-200 p-6 space-y-4 shadow-sm"
        >
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1">
              Email
            </label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@barcode.com"
              required
            />
          </div>
          {mode === "password" && (
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">
                Password
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required={mode === "password"}
              />
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {success && <p className="text-sm text-green-600">{success}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading
              ? mode === "magic"
                ? "Sending link..."
                : "Signing in..."
              : mode === "magic"
                ? "Send magic link"
                : "Sign in"}
          </Button>
          <div className="text-center">
            <button
              type="button"
              onClick={() => {
                setMode(mode === "password" ? "magic" : "password");
                setError("");
                setSuccess("");
              }}
              className="text-xs text-slate-500 hover:text-slate-900 transition-colors"
            >
              {mode === "password" ? "Use magic link instead" : "Use password instead"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
