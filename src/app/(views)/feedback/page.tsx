"use client";

/**
 * Feedback review — the owner's internal diagnostic view.
 *
 * Reps thumbs up/down the recommendation on each brand card. This page collects
 * those votes, down-votes first (the disagreements worth investigating), and
 * shows for each: which brand, which rep, what the engine recommended / scored /
 * classified AT vote time, and the rep's note. The point isn't a score — it's to
 * find where the engine is wrong and to know which rep to go talk to.
 */
import { useEffect, useState, useCallback } from "react";
import { ThumbsUp, ThumbsDown, Loader2, RefreshCw, ExternalLink, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/contexts/auth-context";

interface FeedbackItem {
  id: string;
  brandId: string;
  brandName: string | null;
  brandSlug: string | null;
  voterEmail: string | null;
  vote: 1 | -1;
  note: string | null;
  recommendedAction: string | null;
  momentumScore: number | null;
  brandType: string | null;
  at: string;
}

type Filter = "all" | "down" | "up";

const BRAND_TYPE_LABEL: Record<string, string> = {
  dtc_brand: "DTC",
  retail_brand: "Retail",
  amazon_supplier: "FBA supplier",
  unknown: "Unknown",
};

export default function FeedbackPage() {
  const { token } = useAuth();
  const [items, setItems] = useState<FeedbackItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback/list?limit=300", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
      setItems(data.items as FeedbackItem[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = (items ?? []).filter((i) =>
    filter === "all" ? true : filter === "down" ? i.vote === -1 : i.vote === 1
  );
  const downCount = (items ?? []).filter((i) => i.vote === -1).length;
  const upCount = (items ?? []).filter((i) => i.vote === 1).length;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-700">Internal</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 mt-1">Recommendation feedback</h1>
        <p className="text-sm text-slate-500 mt-1">
          What reps thought of the engine&rsquo;s calls. Down-votes are listed first &mdash; those are
          where a rep&rsquo;s ground truth disagreed with the recommendation, with the context shown at
          the time and their note on what&rsquo;s off. Use it to find weak logic and to know who to ask.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex gap-1 rounded-lg border border-slate-200 p-0.5">
          {(["all", "down", "up"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-xs px-3 py-1.5 rounded ${
                filter === f ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {f === "all" ? "All" : f === "down" ? `Down-votes (${downCount})` : `Up-votes (${upCount})`}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <Button variant="outline" onClick={load} disabled={loading} className="gap-1.5">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Refresh
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && !items && (
        <div className="flex items-center gap-2 text-sm text-slate-500 py-12 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading feedback…
        </div>
      )}

      {items && shown.length === 0 && !loading && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-slate-500">
            No feedback yet{filter !== "all" ? " in this filter" : ""}. Votes from the brand cards show up here.
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {shown.map((item) => {
          const down = item.vote === -1;
          return (
            <Card key={item.id} className={down ? "border-rose-200" : ""}>
              <CardContent className="py-3">
                <div className="flex items-start gap-3">
                  <div
                    className={`mt-0.5 inline-flex items-center justify-center w-7 h-7 rounded-md shrink-0 ${
                      down ? "bg-rose-50 text-rose-600" : "bg-teal-50 text-teal-600"
                    }`}
                  >
                    {down ? <ThumbsDown className="w-3.5 h-3.5" /> : <ThumbsUp className="w-3.5 h-3.5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-900">{item.brandName ?? "(unknown brand)"}</span>
                      {item.brandSlug && (
                        <a
                          href={`/brand-card/${item.brandSlug}`}
                          className="text-teal-700 hover:underline inline-flex items-center gap-0.5 text-xs"
                        >
                          card <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                      <span className="text-xs text-slate-400">·</span>
                      <span className="text-xs text-slate-500">{item.voterEmail ?? "unknown rep"}</span>
                    </div>
                    {/* Context AT vote time — what the engine showed when the rep disagreed */}
                    <div className="flex items-center gap-1.5 flex-wrap mt-1 text-[11px]">
                      {item.recommendedAction && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium uppercase tracking-wide">
                          {item.recommendedAction.replace("_", " ")}
                        </span>
                      )}
                      {item.momentumScore != null && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 tabular-nums">
                          score {item.momentumScore}
                        </span>
                      )}
                      {item.brandType && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                          {BRAND_TYPE_LABEL[item.brandType] ?? item.brandType}
                        </span>
                      )}
                      <span className="text-slate-400">{new Date(item.at).toLocaleDateString()}</span>
                    </div>
                    {item.note && (
                      <p className="mt-1.5 text-sm text-slate-700 bg-slate-50 border border-slate-100 rounded px-2 py-1">
                        &ldquo;{item.note}&rdquo;
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
