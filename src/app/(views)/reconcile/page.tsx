"use client";

/**
 * Reconciliation queue — surfaces unmatched brand-name rows from BOTH
 * Nielsen and SmartScout uploads, sorted by $ at stake.
 *
 * For each item, the user can:
 *   - Link to an existing brand (auto-suggested via candidates)
 *   - Create a new brand
 *   - Skip (SmartScout only — Nielsen rows stay in the queue)
 *
 * The high-dollar items are the ones worth reviewing: if 6 high-revenue
 * brands show up unmatched, the engine's "Established / Skip" list is
 * incomplete and the demo loses credibility. Mid-revenue items get
 * batch-processed; long-tail can be ignored via the minDollars filter.
 */
import { useEffect, useState, useCallback } from "react";
import { Check, AlertCircle, Loader2, Search, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";

interface Candidate {
  brandId: string;
  brandName: string;
  brandSlug: string;
  score: number;
}

interface QueueItem {
  source: "nielsen" | "smartscout";
  uploadId: string;
  uploadFilename: string | null;
  brandNameRaw: string;
  totalSalesDollars: number;
  rowCount: number;
  itemKey: string;
  rowIds: number[];
  candidates: Candidate[];
}

type SourceFilter = "all" | "nielsen" | "smartscout";

const SOURCE_LABEL: Record<"nielsen" | "smartscout", string> = {
  nielsen: "Nielsen",
  smartscout: "SmartScout",
};

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${Math.round(n)}`;
}

export default function ReconcilePage() {
  const { token } = useAuth();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [totalItems, setTotalItems] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [minDollars, setMinDollars] = useState(100_000);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [createNameByKey, setCreateNameByKey] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (sourceFilter !== "all") params.set("source", sourceFilter);
      if (minDollars > 0) params.set("minDollars", String(minDollars));
      params.set("limit", "100");
      const res = await fetch(`/api/reconcile/queue?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
      setItems(data.items);
      setTotalItems(data.totalItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [token, sourceFilter, minDollars]);

  useEffect(() => { void load(); }, [load]);

  async function decide(item: QueueItem, action: "link" | "create" | "skip", brandId?: string, newBrandName?: string) {
    if (!token) return;
    setBusyKey(item.itemKey);
    try {
      const res = await fetch("/api/reconcile/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          source: item.source,
          rowIds: item.rowIds,
          action,
          brandId,
          newBrandName,
          monitored: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Decision failed (${res.status})`);
      // Optimistically remove the item from the list.
      setItems((prev) => prev ? prev.filter((i) => i.itemKey !== item.itemKey) : prev);
      setTotalItems((t) => Math.max(0, t - 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-700">Data</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 mt-1">
          Reconciliation queue
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Brand names from your Nielsen and SmartScout uploads that didn&rsquo;t auto-match to
          monitored brands. Sorted by the dollars at stake. Resolve the high-revenue ones
          first &mdash; those are the matches that change a brand&rsquo;s placement on the
          dashboard.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1 rounded-lg border border-slate-200 p-0.5">
              {(["all", "nielsen", "smartscout"] as SourceFilter[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setSourceFilter(s)}
                  className={`text-xs px-3 py-1.5 rounded ${
                    sourceFilter === s
                      ? "bg-slate-900 text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {s === "all" ? "All sources" : SOURCE_LABEL[s]}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">Min $ at stake:</span>
              <select
                value={minDollars}
                onChange={(e) => setMinDollars(Number(e.target.value))}
                className="text-xs border border-slate-200 rounded px-2 py-1.5 bg-white"
              >
                <option value="0">No minimum</option>
                <option value="10000">$10K</option>
                <option value="100000">$100K</option>
                <option value="1000000">$1M</option>
                <option value="10000000">$10M</option>
              </select>
            </div>
            <div className="flex-1" />
            <Button variant="outline" onClick={load} disabled={loading} className="gap-1.5">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Refresh
            </Button>
          </div>
          {totalItems > 0 && (
            <p className="text-xs text-slate-500 mt-3">
              {totalItems} brand name{totalItems === 1 ? "" : "s"} need review
              {items && items.length < totalItems && <> (showing top {items.length})</>}
            </p>
          )}
          {error && (
            <div className="mt-3 border border-red-200 bg-red-50 rounded-lg p-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {items && items.length === 0 && !loading && (
        <Card>
          <CardContent className="py-12 text-center">
            <Check className="w-8 h-8 text-green-600 mx-auto mb-3" />
            <p className="text-sm font-medium text-slate-700">Nothing to reconcile.</p>
            <p className="text-xs text-slate-500 mt-1">
              Either everything matched automatically, or no uploads have run yet. Try lowering the
              minimum dollar threshold to see smaller items.
            </p>
          </CardContent>
        </Card>
      )}

      {items?.map((item) => {
        const busy = busyKey === item.itemKey;
        const draftName = createNameByKey[item.itemKey] ?? item.brandNameRaw;
        return (
          <Card key={item.itemKey}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">{item.brandNameRaw}</CardTitle>
                  <p className="text-xs text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-widest ${
                      item.source === "smartscout"
                        ? "bg-teal-50 text-teal-700"
                        : "bg-indigo-50 text-indigo-700"
                    }`}>
                      {SOURCE_LABEL[item.source]}
                    </span>
                    <span>{item.rowCount} row{item.rowCount === 1 ? "" : "s"}</span>
                    {item.uploadFilename && <span>&middot; {item.uploadFilename}</span>}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold tabular-nums">{formatUsd(item.totalSalesDollars)}</p>
                  <p className="text-[10px] uppercase tracking-widest text-slate-400">at stake</p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {item.candidates.length > 0 && (
                <div className="space-y-1.5 mb-3">
                  <p className="text-[10px] uppercase tracking-widest text-slate-400">Suggested matches</p>
                  {item.candidates.map((c) => (
                    <button
                      key={c.brandId}
                      disabled={busy}
                      onClick={() => decide(item, "link", c.brandId)}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-slate-200 hover:border-teal-300 hover:bg-teal-50/40 transition disabled:opacity-50 disabled:cursor-not-allowed text-left"
                    >
                      <span className="text-sm text-slate-700">{c.brandName}</span>
                      <span className="flex items-center gap-2">
                        <span className={`text-[10px] uppercase tracking-widest px-2 py-0.5 rounded-full ${
                          c.score >= 0.85
                            ? "bg-green-50 text-green-700"
                            : c.score >= 0.6
                              ? "bg-amber-50 text-amber-700"
                              : "bg-slate-100 text-slate-600"
                        }`}>
                          {(c.score * 100).toFixed(0)}% match
                        </span>
                        <Check className="w-4 h-4 text-slate-400" />
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {item.candidates.length === 0 && (
                <p className="text-xs text-slate-500 mb-3 italic">
                  No similar brands found in the monitored set.
                </p>
              )}
              <div className="border-t border-slate-100 pt-3 flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-2 flex-1 min-w-[280px]">
                  <Input
                    value={draftName}
                    onChange={(e) =>
                      setCreateNameByKey((prev) => ({ ...prev, [item.itemKey]: e.target.value }))
                    }
                    placeholder="New brand name"
                    className="text-sm flex-1"
                    disabled={busy}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => decide(item, "create", undefined, draftName)}
                    disabled={busy || !draftName.trim()}
                    className="gap-1.5"
                  >
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                    Create + monitor
                  </Button>
                </div>
                {item.source === "smartscout" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => decide(item, "skip")}
                    disabled={busy}
                    className="text-slate-500 gap-1"
                  >
                    <X className="w-3 h-3" />
                    Skip
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
