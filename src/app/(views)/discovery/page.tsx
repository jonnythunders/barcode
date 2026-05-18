"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkles } from "lucide-react";

interface DiscoveredBrand {
  id: string;
  name: string;
  slug: string;
  discovery_source: string;
  first_seen_at: string;
  notes: string | null;
  momentumScore: number | null;
  primary_category_id: string | null;
}

interface SnapshotRow {
  brand_id: string;
  value_numeric: number | null;
}

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  tiktok_hashtag: { label: "TikTok hashtag", color: "bg-pink-50 text-pink-700" },
  amazon_top100: { label: "Amazon Top 100", color: "bg-orange-50 text-orange-700" },
  reddit_mention: { label: "Reddit mention", color: "bg-red-50 text-red-700" },
  shopify_bestseller: { label: "Shopify bestseller", color: "bg-emerald-50 text-emerald-700" },
  exploding_topics: { label: "Exploding Topics", color: "bg-purple-50 text-purple-700" },
  nielsen_upload: { label: "Nielsen upload", color: "bg-blue-50 text-blue-700" },
  manual: { label: "Manual", color: "bg-slate-100 text-slate-700" },
};

/**
 * Discovery feed — brands recently surfaced by the crawlers.
 *
 * Shows non-manual discoveries from the last 30 days, ranked by momentum
 * desc with nulls last. Each entry links to the brand card.
 */
export default function DiscoveryPage() {
  const [brands, setBrands] = useState<DiscoveredBrand[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = getSupabaseClient();
    const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    (async () => {
      const { data: raw } = await supabase
        .from("brands")
        .select("id, name, slug, discovery_source, first_seen_at, notes, primary_category_id")
        .eq("is_archived", false)
        .neq("discovery_source", "manual")
        .gte("first_seen_at", sinceIso)
        .order("first_seen_at", { ascending: false })
        .limit(100);

      if (!raw) {
        setLoading(false);
        return;
      }

      const ids = raw.map((b) => b.id);
      const { data: snaps } =
        ids.length > 0
          ? await supabase
              .from("snapshots")
              .select("brand_id, value_numeric, captured_at")
              .eq("platform", "derived")
              .eq("metric", "momentum_score")
              .in("brand_id", ids)
              .order("captured_at", { ascending: false })
          : { data: [] };

      const latestByBrand = new Map<string, number | null>();
      for (const s of (snaps ?? []) as SnapshotRow[]) {
        if (!latestByBrand.has(s.brand_id)) latestByBrand.set(s.brand_id, s.value_numeric);
      }

      const enriched: DiscoveredBrand[] = raw.map((b) => ({
        id: b.id,
        name: b.name,
        slug: b.slug,
        discovery_source: b.discovery_source,
        first_seen_at: b.first_seen_at,
        notes: b.notes,
        momentumScore: latestByBrand.get(b.id) ?? null,
        primary_category_id: b.primary_category_id,
      }));

      enriched.sort((a, b) => (b.momentumScore ?? -1) - (a.momentumScore ?? -1));
      setBrands(enriched);
      setLoading(false);
    })();
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
      <div>
        <p className="text-xs uppercase tracking-widest text-slate-400">Discovery</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 mt-1">
          Brands found by the crawlers
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Last 30 days. Sorted by latest Momentum Score. Click any row for the full Brand Card.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-500" />
            Recent discoveries
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-slate-400">Loading...</p>
          ) : brands.length === 0 ? (
            <p className="text-sm text-slate-500">
              Nothing yet. Once <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">/api/cron/weekly-poll</code>{" "}
              runs (or you hit it manually with the CRON_SECRET), discovered brands will land here.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 -mx-5">
              {brands.map((b) => {
                const src = SOURCE_LABELS[b.discovery_source] ?? SOURCE_LABELS.manual;
                return (
                  <li key={b.id} className="px-5 py-3 hover:bg-slate-50 transition-colors">
                    <Link href={`/brand-card/${b.slug}`} className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-slate-900 truncate">{b.name}</p>
                          <span className={`text-[10px] uppercase tracking-widest px-2 py-0.5 rounded-full ${src.color}`}>
                            {src.label}
                          </span>
                        </div>
                        {b.notes && <p className="text-xs text-slate-500 truncate mt-0.5">{b.notes}</p>}
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          First seen {new Date(b.first_seen_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        {b.momentumScore != null ? (
                          <p
                            className={`text-lg font-bold ${
                              b.momentumScore >= 70
                                ? "text-green-600"
                                : b.momentumScore >= 50
                                  ? "text-amber-600"
                                  : "text-slate-500"
                            }`}
                          >
                            {b.momentumScore}
                          </p>
                        ) : (
                          <p className="text-xs text-slate-400">No score yet</p>
                        )}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
