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
} from "lucide-react";
import type { BrandCard as BrandCardData, PlatformBlock } from "@/lib/types";
import { formatCompactNumber, formatPctDelta } from "@/lib/utils";

export function BrandCard({ card }: { card: BrandCardData }) {
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
      </div>

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
          rows={[
            ["Mentions (30d)", formatCompactNumber(card.reddit.mentionCount)],
            ["Velocity", card.reddit.velocity != null ? formatPctDelta(card.reddit.velocity) : "—"],
            ["Top threads", String(card.reddit.topThreads?.length ?? 0)],
          ]}
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

      {/* Provenance footnote */}
      <p className="text-[11px] text-slate-400 px-1 pt-1">
        Amazon &amp; retail figures derived from Amazon and Nielsen scan data. Social and sentiment
        signals are representative sample data for this preview.
      </p>
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
}: {
  title: string;
  icon: React.ReactNode;
  block: PlatformBlock;
  handle?: string | null;
  handleUrl?: string | null;
  rows: [string, string][];
  trend?: { date: string; value: number }[];
  children?: React.ReactNode;
}) {
  const statusBadge = (() => {
    if (block.status === "ok") return null;
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
    <div className={`border border-slate-200 rounded-xl bg-white ${dim ? "opacity-70" : ""}`}>
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
        {statusBadge ?? (
          <span className="text-[10px] uppercase tracking-widest text-green-600 flex items-center gap-1">
            <Check className="w-3 h-3" />
            OK
          </span>
        )}
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
            {trend && trend.length > 1 && <Sparkline points={trend} />}
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
