"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/contexts/auth-context";
import { getSupabaseClient } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkles, ArrowRight } from "lucide-react";

interface BrandRow {
  id: string;
  name: string;
  slug: string;
  is_monitored: boolean;
  notes: string | null;
  momentumScore: number | null;
}

interface SnapshotRow {
  brand_id: string;
  value_numeric: number | null;
}

/**
 * Dashboard — overview screen.
 *
 * Three sections:
 *   1. Top brands by latest Momentum Score
 *   2. Recently added brands (discovery feed teaser)
 *   3. Quick hints — "ask Barry to look up a brand"
 *
 * Pulls directly from Supabase via the anon client (RLS-gated). When we
 * tighten RLS for role-based access we'll need to add a server-side
 * `/api/dashboard` endpoint; for now this is fine.
 */
export default function DashboardPage() {
  const { user } = useAuth();
  const [topBrands, setTopBrands] = useState<BrandRow[]>([]);
  const [recent, setRecent] = useState<BrandRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const supabase = getSupabaseClient();

    (async () => {
      const { data: brands } = await supabase
        .from("brands")
        .select("id, name, slug, is_monitored, notes, created_at")
        .eq("is_archived", false)
        .order("created_at", { ascending: false })
        .limit(50);

      if (!brands) return;

      // Pull latest momentum scores in one shot
      const ids = brands.map((b) => b.id);
      const { data: snaps } = await supabase
        .from("snapshots")
        .select("brand_id, value_numeric, captured_at")
        .eq("platform", "derived")
        .eq("metric", "momentum_score")
        .in("brand_id", ids)
        .order("captured_at", { ascending: false });

      // Most-recent per brand
      const latestByBrand = new Map<string, number | null>();
      for (const s of (snaps ?? []) as SnapshotRow[]) {
        if (!latestByBrand.has(s.brand_id)) latestByBrand.set(s.brand_id, s.value_numeric);
      }

      const enriched: BrandRow[] = brands.map((b) => ({
        id: b.id,
        name: b.name,
        slug: b.slug,
        is_monitored: b.is_monitored,
        notes: b.notes,
        momentumScore: latestByBrand.get(b.id) ?? null,
      }));

      if (!mounted) return;
      const top = [...enriched]
        .filter((b) => b.momentumScore != null)
        .sort((a, b) => (b.momentumScore ?? 0) - (a.momentumScore ?? 0))
        .slice(0, 8);
      setTopBrands(top);
      setRecent(enriched.slice(0, 8));
      setLoading(false);
    })();

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
      <div>
        <p className="text-xs uppercase tracking-widest text-slate-400">Dashboard</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 mt-1">
          Welcome back{user?.email ? `, ${user.email.split("@")[0]}` : ""}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Ask Barry (the chat panel on the left) to look up a brand, compare a few, or queue a report.
        </p>
      </div>

      {/* Top brands */}
      <Card>
        <CardHeader className="flex items-center justify-between flex-row">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-500" />
            Top brands by momentum
          </CardTitle>
          <Link href="/discovery" className="text-xs text-slate-500 hover:text-slate-900 flex items-center gap-1">
            See all <ArrowRight className="w-3 h-3" />
          </Link>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-slate-400">Loading...</p>
          ) : topBrands.length === 0 ? (
            <p className="text-sm text-slate-500">
              No momentum scores yet. Run <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">npm run poll-once</code>{" "}
              to capture an initial round of signals.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 -mx-5">
              {topBrands.map((b) => (
                <li key={b.id} className="px-5 py-2.5 flex items-center justify-between hover:bg-slate-50 transition-colors">
                  <Link href={`/brand-card/${b.slug}`} className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">{b.name}</p>
                    {b.notes && <p className="text-xs text-slate-500 truncate">{b.notes}</p>}
                  </Link>
                  <div className="flex-shrink-0 text-right">
                    <p
                      className={`text-lg font-bold ${
                        (b.momentumScore ?? 0) >= 70
                          ? "text-green-600"
                          : (b.momentumScore ?? 0) >= 50
                            ? "text-amber-600"
                            : "text-slate-500"
                      }`}
                    >
                      {b.momentumScore}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Recent brands */}
      <Card>
        <CardHeader>
          <CardTitle>Recently added brands</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-slate-400">Loading...</p>
          ) : recent.length === 0 ? (
            <p className="text-sm text-slate-500">
              No brands yet. Run <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">npm run seed</code>{" "}
              to add starter brands.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 -mx-5">
              {recent.map((b) => (
                <li key={b.id} className="px-5 py-2.5">
                  <Link href={`/brand-card/${b.slug}`} className="block">
                    <p className="text-sm font-medium text-slate-900">{b.name}</p>
                    {b.notes && <p className="text-xs text-slate-500 truncate">{b.notes}</p>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
