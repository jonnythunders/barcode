"use client";

import { use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { RefreshCw, AlertCircle, Search } from "lucide-react";
import { BrandCard as BrandCardView } from "@/components/BrandCard";
import { Button } from "@/components/ui/button";
import type { BrandCard as BrandCardData } from "@/lib/types";

/**
 * Brand Card detail — fetches /api/brand-card/[name] and renders.
 *
 * The slug is what's in the URL, but the underlying API works on brand
 * NAME. We pass `?q=<original name>` from the lookup form so the API gets
 * the human-typed name. If no `q` is present (deep link), we fall back to
 * the slug, prettified.
 */
export default function BrandCardDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const searchParams = useSearchParams();
  const queryName = searchParams.get("q") ?? slug.replace(/-/g, " ");

  const [card, setCard] = useState<BrandCardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchCard = async (forceRefresh: boolean = false) => {
    if (forceRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const url = `/api/brand-card/${encodeURIComponent(queryName)}${forceRefresh ? "?refresh=1" : ""}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      const data: BrandCardData = await res.json();
      setCard(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchCard(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryName]);

  const isNotTracked = Boolean(card && (card as BrandCardData & { notTracked?: boolean }).notTracked);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-4">
      <div className="flex items-center justify-end">
        {!isNotTracked && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchCard(true)}
            disabled={refreshing || loading}
            className="gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </Button>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-slate-900 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {error && (
        <div className="border border-red-200 bg-red-50 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-900">Couldn&apos;t load brand card</p>
            <p className="text-sm text-red-700 mt-1">{error}</p>
          </div>
        </div>
      )}

      {card && isNotTracked && (
        <div className="border border-slate-200 bg-white rounded-2xl px-8 py-12 text-center">
          <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
            <Search className="w-5 h-5 text-slate-400" />
          </div>
          <h2 className="text-xl font-semibold text-slate-900">
            &ldquo;{card.brand.name}&rdquo; isn&apos;t tracked yet
          </h2>
          <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto leading-relaxed">
            Kestrel currently covers the brands surfaced from the latest Amazon and Nielsen
            pull. Browse the ranked list, or ask Barry to compare brands that are in the set.
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <Link href="/discovery">
              <Button size="sm" className="gap-1.5">Browse Discovery</Button>
            </Link>
          </div>
        </div>
      )}

      {card && !isNotTracked && <BrandCardView card={card} />}
    </div>
  );
}
