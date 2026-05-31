"use client";

/**
 * Handle review queue — borderline ("needs_review") handle resolutions awaiting
 * a human approve/reject.
 *
 * The resolver auto-accepts only unambiguous matches. When a brand name is
 * ambiguous (a near-tie between two accounts, or a decent-but-not-strong best
 * score), it surfaces here instead of silently assigning a possibly-wrong
 * account. Approving writes the chosen handle onto the brand (making it
 * authoritative for future polls); rejecting clears it from the queue without
 * assigning anything. Neither action spends search credits — the corrected
 * handle is picked up by the next scheduled poll or a manual refresh.
 */
import { useEffect, useState, useCallback } from "react";
import { Check, X, Loader2, RefreshCw, ExternalLink, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";

interface ReviewCandidate {
  handle: string;
  score: number | null;
  followerCount: number | null;
}
interface ReviewQueueItem {
  resolutionId: string;
  brandNameQuery: string;
  brandId: string | null;
  brandSlug: string | null;
  currentTiktokHandle: string | null;
  currentInstagramHandle: string | null;
  tiktokSuggestion: string | null;
  instagramSuggestion: string | null;
  tiktokCandidates: ReviewCandidate[];
  instagramCandidates: ReviewCandidate[];
  createdAt: string;
}

function fmtFollowers(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

export default function ReviewPage() {
  const { token } = useAuth();
  const [items, setItems] = useState<ReviewQueueItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Per-item editable handle fields, keyed by resolutionId.
  const [ttById, setTtById] = useState<Record<string, string>>({});
  const [igById, setIgById] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/review/queue?limit=100", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
      const list = data.items as ReviewQueueItem[];
      setItems(list);
      // Seed editable fields with the resolver's suggestions.
      const tt: Record<string, string> = {};
      const ig: Record<string, string> = {};
      for (const it of list) {
        tt[it.resolutionId] = it.tiktokSuggestion ?? "";
        ig[it.resolutionId] = it.instagramSuggestion ?? "";
      }
      setTtById(tt);
      setIgById(ig);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(item: ReviewQueueItem, decision: "approve" | "reject") {
    if (!token) return;
    setBusyId(item.resolutionId);
    setError(null);
    try {
      const body =
        decision === "approve"
          ? {
              resolutionId: item.resolutionId,
              decision,
              tiktokHandle: ttById[item.resolutionId]?.trim() || null,
              instagramHandle: igById[item.resolutionId]?.trim() || null,
            }
          : { resolutionId: item.resolutionId, decision };
      const res = await fetch("/api/review/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Decision failed (${res.status})`);
      // Optimistically drop the item.
      setItems((prev) => (prev ? prev.filter((i) => i.resolutionId !== item.resolutionId) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed");
    } finally {
      setBusyId(null);
    }
  }

  const canApprove = (id: string) => !!(ttById[id]?.trim() || igById[id]?.trim());

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-700">Data quality</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 mt-1">Handle review</h1>
        <p className="text-sm text-slate-500 mt-1">
          Brands where the social-handle search found a plausible but ambiguous match, so it
          held off auto-assigning. Confirm the right account (or reject) — approving makes it
          authoritative for future polls. No search credits are spent here.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={load} disabled={loading} className="gap-1.5">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Refresh
        </Button>
        {items && (
          <span className="text-xs text-slate-500">
            {items.length} {items.length === 1 ? "brand" : "brands"} awaiting review
          </span>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && !items && (
        <div className="flex items-center gap-2 text-sm text-slate-500 py-12 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading review queue…
        </div>
      )}

      {items && items.length === 0 && !loading && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-slate-500">
            <Check className="w-6 h-6 text-teal-600 mx-auto mb-2" />
            Nothing to review. All resolved handles were either auto-accepted with high
            confidence or already actioned.
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {items?.map((item) => {
          const busy = busyId === item.resolutionId;
          return (
            <Card key={item.resolutionId} className={busy ? "opacity-60 pointer-events-none" : ""}>
              <CardContent className="pt-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">{item.brandNameQuery}</h2>
                    {item.brandSlug && (
                      <a
                        href={`/brand-card/${item.brandSlug}`}
                        className="text-xs text-teal-700 hover:underline inline-flex items-center gap-1 mt-0.5"
                      >
                        View brand card <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                  <span className="text-[11px] text-slate-400 whitespace-nowrap">
                    {new Date(item.createdAt).toLocaleDateString()}
                  </span>
                </div>

                <PlatformRow
                  label="TikTok"
                  current={item.currentTiktokHandle}
                  suggestion={item.tiktokSuggestion}
                  candidates={item.tiktokCandidates}
                  value={ttById[item.resolutionId] ?? ""}
                  onChange={(v) => setTtById((s) => ({ ...s, [item.resolutionId]: v }))}
                />
                <PlatformRow
                  label="Instagram"
                  current={item.currentInstagramHandle}
                  suggestion={item.instagramSuggestion}
                  candidates={item.instagramCandidates}
                  value={igById[item.resolutionId] ?? ""}
                  onChange={(v) => setIgById((s) => ({ ...s, [item.resolutionId]: v }))}
                />

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    onClick={() => decide(item, "approve")}
                    disabled={busy || !canApprove(item.resolutionId)}
                    className="gap-1.5 bg-teal-600 hover:bg-teal-700"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Approve
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => decide(item, "reject")}
                    disabled={busy}
                    className="gap-1.5 text-slate-600"
                  >
                    <X className="w-4 h-4" />
                    Reject
                  </Button>
                  {!canApprove(item.resolutionId) && (
                    <span className="text-[11px] text-slate-400">Enter a handle to approve</span>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function PlatformRow(props: {
  label: string;
  current: string | null;
  suggestion: string | null;
  candidates: ReviewCandidate[];
  value: string;
  onChange: (v: string) => void;
}) {
  const { label, current, suggestion, candidates, value, onChange } = props;
  return (
    <div className="border border-slate-100 rounded-lg p-3 bg-slate-50/50">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
        <span className="text-[11px] text-slate-400">
          {current ? (
            <>
              live: <span className="font-mono text-slate-600">@{current}</span>
            </>
          ) : (
            "no handle set"
          )}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-slate-400 text-sm">@</span>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/^@/, ""))}
          placeholder={suggestion ? `${suggestion} (suggested)` : "leave blank to skip"}
          className="font-mono text-sm h-8"
        />
      </div>
      {candidates.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {candidates.map((c) => (
            <button
              key={c.handle}
              onClick={() => onChange(c.handle)}
              className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                value === c.handle
                  ? "border-teal-300 bg-teal-50 text-teal-800"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
              }`}
              title={`score ${c.score?.toFixed(2) ?? "—"} · ${fmtFollowers(c.followerCount)} followers`}
            >
              @{c.handle}
              <span className="text-slate-400 ml-1">{fmtFollowers(c.followerCount)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
