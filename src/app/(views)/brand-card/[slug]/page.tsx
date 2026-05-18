"use client";

import { use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RefreshCw, AlertCircle } from "lucide-react";
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

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-4">
      <div className="flex items-center justify-end">
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

      {card && <BrandCardView card={card} />}
    </div>
  );
}
