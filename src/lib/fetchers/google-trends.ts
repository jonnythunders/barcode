/**
 * Google Trends fetcher.
 *
 * Uses the `google-trends-api` npm package, which is the Node equivalent
 * of Python's pytrends. No auth required. Returns interest-over-time
 * (0–100 normalized) plus related queries.
 *
 * Snapshots written per call:
 *   - platform='google_trends', metric='search_volume_latest' (value_numeric: latest weekly value 0-100)
 *   - platform='google_trends', metric='search_volume_yoy_pct' (value_numeric: change vs same week last year)
 *   - platform='google_trends', metric='interest_over_time' (value_json: full series)
 *
 * Failure modes:
 *   - The package occasionally returns HTML when Google rate-limits us.
 *     We detect that and surface as an error.
 *   - Some brand names are too generic to be useful (e.g. "Vacation" alone).
 *     For those we expect noise; callers can filter by checking if the
 *     trend is suspiciously flat at 0 or noisy.
 */
import googleTrends from "google-trends-api";
import { withFetcherRun, writeSnapshot, type FetcherRunCtx } from "./_base";
import type { FetcherResult, TrendPoint } from "@/lib/types";

export interface GoogleTrendsResult {
  keyword: string;
  series: TrendPoint[];           // weekly points over the lookback
  latestValue: number | null;     // last point in `series`
  yoyChangePct: number | null;    // (latest - same-week-last-year) / same-week-last-year
  averageValue: number | null;    // mean over the window
  geo: string;
  capturedAt: string;
}

export interface GoogleTrendsOptions {
  brandId: string;
  keyword: string;                // brand name or category keyword
  geo?: string;                   // ISO country, default 'US'
  lookbackDays?: number;          // default 365
  triggerKind?: "manual" | "cron" | "on_demand";
}

interface RawInterestPoint {
  time: string;                   // unix seconds as string
  value: number[];                // array of values, one per keyword (we send one)
  formattedTime: string;
  formattedAxisTime: string;
  hasData: boolean[];
}

/**
 * Fetch Google Trends data and persist snapshots.
 */
export async function fetchGoogleTrends(opts: GoogleTrendsOptions): Promise<FetcherResult<GoogleTrendsResult>> {
  const geo = opts.geo ?? "US";
  const lookbackDays = opts.lookbackDays ?? 365;
  const trigger = opts.triggerKind ?? "on_demand";

  return withFetcherRun(
    {
      fetcherName: "google_trends",
      triggerKind: trigger,
      brandId: opts.brandId,
      metadata: { keyword: opts.keyword, geo, lookbackDays },
    },
    async (ctx: FetcherRunCtx): Promise<GoogleTrendsResult> => {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

      // google-trends-api returns a JSON string. We parse defensively because
      // when Google rate-limits, it returns HTML instead.
      const raw = await googleTrends.interestOverTime({
        keyword: opts.keyword,
        startTime,
        endTime,
        geo,
      });

      let parsed: { default?: { timelineData?: RawInterestPoint[] } };
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Most common cause: Google returned a "sorry, unusual traffic" HTML
        // page instead of the JSON we expected.
        throw new Error("Google Trends returned non-JSON (likely rate-limited). Try again later or reduce lookback.");
      }

      const timeline = parsed?.default?.timelineData ?? [];
      if (timeline.length === 0) {
        throw new Error(`No timeline data for keyword "${opts.keyword}" in ${geo}`);
      }

      const series: TrendPoint[] = timeline.map((p) => ({
        date: new Date(Number(p.time) * 1000).toISOString(),
        value: p.value[0] ?? 0,
      }));

      const latestValue = series[series.length - 1]?.value ?? null;
      const averageValue =
        series.length > 0
          ? series.reduce((sum, p) => sum + p.value, 0) / series.length
          : null;

      // YoY: compare latest point to the point ~52 weeks back (or earliest if
      // we don't have a year of data yet).
      let yoyChangePct: number | null = null;
      if (latestValue != null && series.length >= 26) {
        // Find a point ~52 weeks ago. If we have less than 52 weeks, fall back
        // to the earliest point we have.
        const yearAgoIdx = Math.max(0, series.length - 52);
        const yearAgo = series[yearAgoIdx].value;
        if (yearAgo > 0) {
          yoyChangePct = (latestValue - yearAgo) / yearAgo;
        }
      }

      // Persist snapshots
      await writeSnapshot({
        brandId: opts.brandId,
        platform: "google_trends",
        metric: "search_volume_latest",
        valueNumeric: latestValue,
        capturedAt: undefined,
        sourceUrl: `https://trends.google.com/trends/explore?q=${encodeURIComponent(opts.keyword)}&geo=${geo}`,
        fetcherRunId: ctx.runId,
      });
      ctx.snapshotsWritten++;

      if (yoyChangePct != null) {
        await writeSnapshot({
          brandId: opts.brandId,
          platform: "google_trends",
          metric: "search_volume_yoy_pct",
          valueNumeric: yoyChangePct,
          fetcherRunId: ctx.runId,
        });
        ctx.snapshotsWritten++;
      }

      await writeSnapshot({
        brandId: opts.brandId,
        platform: "google_trends",
        metric: "interest_over_time",
        valueJson: { series, geo, keyword: opts.keyword, lookbackDays },
        fetcherRunId: ctx.runId,
      });
      ctx.snapshotsWritten++;

      return {
        keyword: opts.keyword,
        series,
        latestValue,
        yoyChangePct,
        averageValue,
        geo,
        capturedAt: new Date().toISOString(),
      };
    }
  );
}
