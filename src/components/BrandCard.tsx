/**
 * BrandCard — renders a BrandCard JSON as a UI card.
 *
 * Designed to look good standalone (on /brand-card/[slug]) and also to be
 * shareable as a PDF export later. Each platform section is independent:
 * sections with `status !== 'ok'` show a soft-greyed "not configured" or
 * error state without breaking layout.
 */
"use client";

import {
  AlertCircle,
  Check,
  ExternalLink,
  Sparkles,
  Star,
  Eye,
  Heart,
  TrendingUp,
  ShoppingCart,
  Search as SearchIcon,
  MessageCircle,
  Smile,
  RefreshCw,
  Archive,
} from "lucide-react";
import { useState } from "react";
import type { BrandCard as BrandCardData, PlatformBlock } from "@/lib/types";
import { formatCompactNumber, formatPctDelta } from "@/lib/utils";

// Minimum 30-day Reddit mentions before we trust/show a velocity %. Below this,
// the sample is too small for a percentage to mean anything, so we show only
// the raw count + the (qualitatively useful) top threads.
const REDDIT_VELOCITY_MIN_MENTIONS = 5;

type DismissalState = { reason: string | null; detail: string | null; at: string } | null;

export function BrandCard({ card }: { card: BrandCardData & { dismissal?: DismissalState } }) {
  // Defensive: a platform block should always be present, but if a cache write
  // or migration ever drops one, render a clean "not configured" state instead
  // of crashing the whole page on `card.tiktok.followerCount`.
  const emptyBlock: PlatformBlock = { status: "not_configured", capturedAt: card.generatedAt };
  card = {
    ...card,
    tiktok: card.tiktok ?? emptyBlock,
    instagram: card.instagram ?? emptyBlock,
    amazon: card.amazon ?? emptyBlock,
    googleTrends: card.googleTrends ?? emptyBlock,
    reddit: card.reddit ?? emptyBlock,
    sentiment: card.sentiment ?? emptyBlock,
    momentumScore: card.momentumScore ?? { score: null, asOf: card.generatedAt },
  };

  const score = card.momentumScore.score;
  const scoreColor =
    score == null
      ? "text-slate-400"
      : score >= 70
        ? "text-emerald-600"
        : score >= 50
          ? "text-amber-600"
          : "text-slate-500";
  const scoreBg =
    score == null
      ? "bg-slate-100"
      : score >= 70
        ? "bg-emerald-50"
        : score >= 50
          ? "bg-amber-50"
          : "bg-slate-100";
  const actionStyle =
    card.recommendedAction === "call_now"
      ? "bg-emerald-600 text-white"
      : card.recommendedAction === "watch"
        ? "bg-amber-500 text-white"
        : "bg-slate-200 text-slate-600";

  return (
    <div className="space-y-4">
      {/* Preview-build disclosure — sets expectations before any number is read */}
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
        <p className="text-sm text-amber-900">
          <span className="font-semibold">Preview build.</span> Revenue, retail, and growth figures
          are derived from real SmartScout and Nielsen data. Social and sentiment panels show{" "}
          <span className="font-semibold">sample data</span> to illustrate the layer being connected
          next — treat specific social numbers as placeholders, not live metrics.
        </p>
      </div>

      {/* Header */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="bc-rule" aria-hidden="true" />
        <div className="flex items-start justify-between gap-4 px-6 py-5">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-teal-700">Brand Card</p>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900 mt-1">{card.brand.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
              {card.brand.primaryCategory && (
                <span className="inline-flex items-center px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full font-medium">
                  {card.brand.primaryCategory}
                </span>
              )}
              {card.resolved.resolutionConfidence !== "unresolved" && (
                <span>Handles {card.resolved.resolutionConfidence}-confidence</span>
              )}
              {card.partial && (
                <span className="px-2 py-0.5 bg-amber-50 text-amber-700 rounded-full">
                  Partial — some signals missing
                </span>
              )}
              <span>Generated {new Date(card.generatedAt).toLocaleDateString()}</span>
            </div>
          </div>
          <div className="flex flex-col items-center flex-shrink-0">
            <div className={`${scoreBg} ${scoreColor} px-5 py-3 rounded-xl text-center min-w-[108px] border border-current/10`}>
              <p className="text-[9px] font-semibold uppercase tracking-[0.16em] opacity-70">Momentum</p>
              <p className="text-4xl font-bold leading-none mt-0.5 tabular-nums">{score ?? "—"}</p>
              <p className="text-[9px] uppercase tracking-widest opacity-60 mt-1">/ 100</p>
            </div>
            {card.recommendedAction && (
              <span className={`mt-2 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${actionStyle}`}>
                {card.recommendedAction.replace("_", " ")}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-3 border-t border-slate-100">
          <DeprioritizeControl
            brandId={card.brand.id}
            brandName={card.brand.name}
            initialDismissal={card.dismissal ?? null}
          />
        </div>
      </div>

      {/* Commerce hero — the real, sourced numbers we stand behind */}
      {card.commerce && <CommerceHero c={card.commerce} />}

      {/* Narrative */}
      {card.narrative && (
        <div className="relative bg-white border border-slate-200 rounded-xl p-4 pl-5">
          <span className="absolute left-0 top-4 bottom-4 w-[3px] rounded-full bg-teal-500" aria-hidden="true" />
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-teal-700 mb-2">
            <Sparkles className="w-3 h-3" />
            AI Summary
          </div>
          <p className="text-sm text-slate-800 leading-relaxed">{card.narrative}</p>
        </div>
      )}

      {/* Platform grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <PlatformSection
          title="TikTok"
          icon={<Eye className="w-4 h-4" />}
          block={card.tiktok}
          handle={card.resolved.tiktokHandle}
          handleUrl={card.resolved.tiktokHandle ? `https://www.tiktok.com/@${card.resolved.tiktokHandle}` : null}
          rows={[
            ["Followers", formatCompactNumber(card.tiktok.followerCount)],
            ["Videos", formatCompactNumber(card.tiktok.videoCount)],
            ["Engagement", card.tiktok.engagementRate != null ? (card.tiktok.engagementRate * 100).toFixed(1) + "%" : "—"],
            ["Verified", card.tiktok.isVerified == null ? "—" : card.tiktok.isVerified ? "Yes" : "No"],
          ]}
        />
        <PlatformSection
          title="Instagram"
          icon={<Heart className="w-4 h-4" />}
          block={card.instagram}
          handle={card.resolved.instagramHandle}
          handleUrl={card.resolved.instagramHandle ? `https://www.instagram.com/${card.resolved.instagramHandle}/` : null}
          rows={[
            ["Followers", formatCompactNumber(card.instagram.followerCount)],
            ["Posts", formatCompactNumber(card.instagram.postCount)],
          ]}
          trend={card.instagram.followerTrend}
        />
        <PlatformSection
          title="Amazon"
          icon={<ShoppingCart className="w-4 h-4" />}
          block={card.amazon}
          handleUrl={card.amazon.productUrl ?? null}
          rows={[
            ["Stars", card.amazon.starRating != null ? card.amazon.starRating.toFixed(1) : "—"],
            ["Reviews", formatCompactNumber(card.amazon.reviewCount)],
            ["BSR", card.amazon.bsrRank != null ? `#${card.amazon.bsrRank}` : "—"],
            ["Category", card.amazon.bsrCategory ?? "—"],
            ["Bought past month", card.amazon.boughtPastMonth ?? "—"],
          ]}
        />
        <PlatformSection
          title="Google Trends"
          icon={<TrendingUp className="w-4 h-4" />}
          block={card.googleTrends}
          rows={[
            ["YoY change", card.googleTrends.yoyChangePct != null ? formatPctDelta(card.googleTrends.yoyChangePct) : "—"],
            [
              "Latest value",
              card.googleTrends.searchVolumeTrend?.[card.googleTrends.searchVolumeTrend.length - 1]?.value?.toString() ?? "—",
            ],
          ]}
        />
        <PlatformSection
          title="Reddit"
          icon={<MessageCircle className="w-4 h-4" />}
          block={card.reddit}
          headerAction={<RedditRefreshButton brandName={card.brand.name} />}
          rows={
            // Velocity on tiny samples (e.g. 1->2 = "+100%") is noise, so only
            // surface it once mentions clear a meaningful floor. Below that,
            // Reddit reads as a qualitative signal: mention count + top threads.
            (card.reddit.mentionCount ?? 0) >= REDDIT_VELOCITY_MIN_MENTIONS
              ? [
                  ["Mentions (30d)", formatCompactNumber(card.reddit.mentionCount)],
                  ["Velocity", card.reddit.velocity != null ? formatPctDelta(card.reddit.velocity) : "—"],
                  ["Top threads", String(card.reddit.topThreads?.length ?? 0)],
                ]
              : [
                  ["Mentions (30d)", formatCompactNumber(card.reddit.mentionCount)],
                  ["Top threads", String(card.reddit.topThreads?.length ?? 0)],
                ]
          }
        />
        <PlatformSection
          title="Sentiment"
          icon={<Smile className="w-4 h-4" />}
          block={card.sentiment}
          rows={[
            ["Score", card.sentiment.overallScore != null ? card.sentiment.overallScore.toFixed(2) : "—"],
            ["Sample", String(card.sentiment.sampleSize ?? 0)],
          ]}
        >
          {card.sentiment.positiveThemes && card.sentiment.positiveThemes.length > 0 && (
            <div className="mt-2">
              <p className="text-[10px] uppercase tracking-widest text-slate-400 mb-1">Praised for</p>
              <div className="flex flex-wrap gap-1">
                {card.sentiment.positiveThemes.map((t, i) => (
                  <span key={i} className="inline-block px-2 py-0.5 text-[11px] bg-green-50 text-green-800 rounded-full">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
          {card.sentiment.negativeThemes && card.sentiment.negativeThemes.length > 0 && (
            <div className="mt-2">
              <p className="text-[10px] uppercase tracking-widest text-slate-400 mb-1">Complaints</p>
              <div className="flex flex-wrap gap-1">
                {card.sentiment.negativeThemes.map((t, i) => (
                  <span key={i} className="inline-block px-2 py-0.5 text-[11px] bg-red-50 text-red-800 rounded-full">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </PlatformSection>
      </div>

      {/* Top Reddit threads (full-width below grid) */}
      {card.reddit.topThreads && card.reddit.topThreads.length > 0 && (
        <div className="border border-slate-200 rounded-xl">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
            <SearchIcon className="w-4 h-4 text-slate-400" />
            <span className="text-sm font-medium text-slate-900">Top Reddit threads</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {card.reddit.topThreads.map((t, i) => (
              <li key={i} className="px-4 py-2.5">
                <a
                  href={t.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-slate-900 hover:underline flex items-start gap-1"
                >
                  <span className="flex-1">{t.title}</span>
                  <ExternalLink className="w-3 h-3 text-slate-400 mt-0.5 shrink-0" />
                </a>
                <p className="text-xs text-slate-500 mt-0.5">
                  r/{t.subreddit} · {formatCompactNumber(t.upvotes)} upvotes · {formatCompactNumber(t.commentCount)} comments
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Provenance footnote — reinforces the banner */}
      <p className="text-[11px] text-slate-400 px-1 pt-1">
        <span className="text-teal-700">Commerce</span> figures (Amazon &amp; retail) are sourced from
        SmartScout and Nielsen scan data. <span className="text-amber-600">Sample</span> panels
        (TikTok, Instagram, Google Trends, Reddit, sentiment) are representative placeholders shown to
        illustrate the signal layer being connected next.
      </p>
    </div>
  );
}

function CommerceHero({ c }: { c: NonNullable<BrandCardData["commerce"]> }) {
  const fmtUsd = (n?: number) =>
    n == null
      ? "—"
      : n >= 1_000_000
        ? "$" + (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M"
        : n >= 1_000
          ? "$" + (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K"
          : "$" + Math.round(n);
  const inRetail = (c.retailAnnualSales ?? 0) > 0;
  return (
    <div className="rounded-2xl border border-teal-200 bg-white overflow-hidden">
      <div className="px-5 py-2.5 border-b border-teal-100 bg-teal-50/60 flex items-center justify-between">
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-teal-700">
          <Check className="w-3 h-3" />
          Commerce · sourced
        </span>
        {c.sourceLabel && <span className="text-[10px] text-teal-700/70">{c.sourceLabel}</span>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-slate-100">
        <Metric
          label="Amazon sales (TTM)"
          value={fmtUsd(c.amazonAnnualSales)}
          sub={c.amazonYoyGrowthPct != null ? `${c.amazonYoyGrowthPct >= 0 ? "+" : ""}${c.amazonYoyGrowthPct.toFixed(0)}% YoY` : undefined}
          subUp={(c.amazonYoyGrowthPct ?? 0) >= 0}
        />
        <Metric
          label="Amazon units / mo"
          value={c.amazonMonthlyUnits != null ? formatCompactNumber(c.amazonMonthlyUnits) : "—"}
        />
        <Metric
          label="Retail sales (measured)"
          value={inRetail ? fmtUsd(c.retailAnnualSales) : "Not in retail"}
          sub={inRetail && c.retailYoyGrowthPct != null ? `${c.retailYoyGrowthPct >= 0 ? "+" : ""}${c.retailYoyGrowthPct.toFixed(0)}% YoY` : undefined}
          subUp={(c.retailYoyGrowthPct ?? 0) >= 0}
          highlight={!inRetail}
        />
        <Metric label="Retail presence" value={c.retailPresence ?? "—"} />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  subUp,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  subUp?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="px-4 py-3">
      <p className="text-[10px] uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`text-lg font-semibold tabular-nums mt-0.5 ${highlight ? "text-emerald-600" : "text-slate-900"}`}>{value}</p>
      {sub && <p className={`text-xs mt-0.5 ${subUp ? "text-emerald-600" : "text-red-600"}`}>{sub}</p>}
    </div>
  );
}

function PlatformSection({
  title,
  icon,
  block,
  handle,
  handleUrl,
  rows,
  trend,
  children,
  headerAction,
}: {
  title: string;
  icon: React.ReactNode;
  block: PlatformBlock;
  handle?: string | null;
  handleUrl?: string | null;
  rows: [string, string][];
  trend?: { date: string; value: number }[];
  children?: React.ReactNode;
  headerAction?: React.ReactNode;
}) {
  const isSample = block.status === "ok" && block.provenance !== "sourced";
  const statusBadge = (() => {
    if (block.status === "ok") {
      if (block.provenance === "sourced") {
        return (
          <span className="text-[10px] uppercase tracking-widest text-teal-700 flex items-center gap-1">
            <Check className="w-3 h-3" />
            {block.sourceLabel ?? "Sourced"}
          </span>
        );
      }
      // Any "ok" block without explicit sourced provenance is labeled sample,
      // so we never imply a number is live data.
      return (
        <span className="text-[10px] font-semibold uppercase tracking-widest text-amber-600">
          Preview · sample
        </span>
      );
    }
    if (block.status === "not_configured")
      return <span className="text-[10px] uppercase tracking-widest text-slate-400">Not configured</span>;
    if (block.status === "not_found")
      return <span className="text-[10px] uppercase tracking-widest text-slate-400">Not found</span>;
    if (block.status === "skipped")
      return <span className="text-[10px] uppercase tracking-widest text-slate-400">Skipped</span>;
    return (
      <span className="text-[10px] uppercase tracking-widest text-red-500 flex items-center gap-1">
        <AlertCircle className="w-3 h-3" />
        Error
      </span>
    );
  })();

  const dim = block.status !== "ok";

  return (
    <div className={`border rounded-xl ${isSample ? "border-amber-200 bg-amber-50/30" : "border-slate-200 bg-white"} ${dim ? "opacity-70" : ""}`}>
      <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-slate-400">{icon}</span>
          <span className="text-sm font-medium text-slate-900">{title}</span>
          {handle && handleUrl ? (
            <a href={handleUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-slate-400 hover:text-slate-600 hover:underline">
              @{handle}
            </a>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {headerAction}
          {statusBadge}
        </div>
      </div>
      <div className="px-4 py-3">
        {block.status === "ok" ? (
          <>
            <dl className="space-y-1.5">
              {rows.map(([label, value]) => (
                <div key={label} className="flex items-center justify-between text-sm">
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="text-slate-900 font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            {trend && hasMeaningfulTrend(trend) && <Sparkline points={trend} />}
            {children}
          </>
        ) : (
          <p className="text-xs text-slate-500">{block.error || "Not available"}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Tiny SVG sparkline. Just enough to communicate trend direction —
 * we'll swap for Recharts when we want real interactivity.
 */
/** A 2-point or same-week line isn't a trend, it's noise. Require at least 3
 *  real points spanning >= 14 days before we draw a sparkline. As real polling
 *  history accumulates this naturally starts showing; early on it stays hidden
 *  rather than implying a trend we can't yet support. */
function hasMeaningfulTrend(points: { date: string; value: number }[]): boolean {
  if (points.length < 3) return false;
  const first = new Date(points[0].date).getTime();
  const last = new Date(points[points.length - 1].date).getTime();
  return last - first >= 14 * 24 * 60 * 60 * 1000;
}

function Sparkline({ points }: { points: { date: string; value: number }[] }) {
  if (points.length < 2) return null;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 200;
  const h = 32;
  const stepX = w / (points.length - 1);
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${i * stepX} ${h - ((p.value - min) / range) * h}`)
    .join(" ");
  const last = points[points.length - 1].value;
  const first = points[0].value;
  const up = last > first;
  return (
    <div className="mt-3 pt-3 border-t border-slate-100">
      <div className="flex items-center gap-2">
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="flex-shrink-0">
          <path d={d} fill="none" stroke={up ? "#16a34a" : "#dc2626"} strokeWidth={1.5} />
        </svg>
        <div className="flex items-center gap-1 text-[10px]">
          <Star className={`w-3 h-3 ${up ? "text-green-600" : "text-red-600"}`} />
          <span className={up ? "text-green-600" : "text-red-600"}>
            {first} → {last}
          </span>
        </div>
      </div>
    </div>
  );
}


/**
 * Subtle "refresh community context" control for the Reddit panel. Posts to
 * the server-side refresh endpoint, which enforces a per-brand cooldown so
 * this can't be abused into burning credits. Deliberately understated — a
 * small icon+label, not a call-to-action — per the product intent that Reddit
 * is supporting context, refreshed occasionally, not a primary interaction.
 */
function RedditRefreshButton({ brandName }: { brandName: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "cooldown" | "error">("idle");

  async function refresh() {
    if (state === "loading") return;
    setState("loading");
    try {
      const res = await fetch(`/api/brand-card/${encodeURIComponent(brandName)}/refresh-reddit`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState("error");
        return;
      }
      if (data.refreshed === false) {
        setState("cooldown");
        return;
      }
      setState("done");
      // Reload to show the freshly-pulled Reddit data on the card.
      setTimeout(() => window.location.reload(), 600);
    } catch {
      setState("error");
    }
  }

  const label =
    state === "loading" ? "Refreshing…"
      : state === "done" ? "Updated"
      : state === "cooldown" ? "Refreshed recently"
      : state === "error" ? "Try later"
      : "Refresh";

  return (
    <button
      type="button"
      onClick={refresh}
      disabled={state === "loading"}
      title="Pull the latest Reddit community signal for this brand"
      className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-slate-400 hover:text-teal-700 disabled:opacity-50 transition-colors"
    >
      <RefreshCw className={`w-3 h-3 ${state === "loading" ? "animate-spin" : ""}`} />
      {label}
    </button>
  );
}


const DEPRIORITIZE_REASONS: { value: string; label: string }[] = [
  { value: "already_contacted", label: "Already contacted" },
  { value: "not_a_fit", label: "Not a fit" },
  { value: "not_interested", label: "Not interested" },
  { value: "timing", label: "Wrong timing" },
  { value: "other", label: "Other" },
];

/** Lets a user deprioritize a brand (with a reason) so it drops off the weekly
 *  to-do, keeping a historical record. Understated — a quiet link, not a CTA —
 *  and fully reversible via undo. */
function DeprioritizeControl({
  brandId,
  brandName,
  initialDismissal,
}: {
  brandId: string;
  brandName: string;
  initialDismissal: DismissalState;
}) {
  const [dismissal, setDismissal] = useState<DismissalState>(initialDismissal);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  async function dismiss(reason: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/brand/deprioritize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId, brandName, reason }),
      });
      if (res.ok) {
        setDismissal({ reason, detail: null, at: new Date().toISOString() });
        setPicking(false);
      }
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    setBusy(true);
    try {
      const res = await fetch("/api/brand/deprioritize", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId }),
      });
      if (res.ok) setDismissal(null);
    } finally {
      setBusy(false);
    }
  }

  if (dismissal) {
    const label =
      DEPRIORITIZE_REASONS.find((r) => r.value === dismissal.reason)?.label ?? "Deprioritized";
    return (
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-medium">
          Deprioritized · {label}
        </span>
        <button
          type="button"
          onClick={undo}
          disabled={busy}
          className="text-slate-400 hover:text-teal-700 underline disabled:opacity-50"
        >
          undo
        </button>
      </div>
    );
  }

  if (picking) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-slate-500 mr-1">Reason:</span>
        {DEPRIORITIZE_REASONS.map((r) => (
          <button
            key={r.value}
            type="button"
            onClick={() => dismiss(r.value)}
            disabled={busy}
            className="px-2 py-0.5 rounded-full border border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-900 disabled:opacity-50"
          >
            {r.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPicking(false)}
          className="text-slate-400 hover:text-slate-600 ml-1"
        >
          cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPicking(true)}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 transition-colors"
    >
      <Archive className="w-3.5 h-3.5" />
      Deprioritize
    </button>
  );
}
