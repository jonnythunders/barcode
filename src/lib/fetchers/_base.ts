/**
 * Shared fetcher infrastructure.
 *
 * Every fetcher (google-trends, amazon, tiktok, etc.) uses these helpers:
 *
 *   - `startFetcherRun()` opens a `fetcher_runs` row before doing work
 *   - `writeSnapshot()` appends to the `snapshots` time-series table
 *   - `finishFetcherRun()` closes the run with status + counts
 *   - `withFetcherRun()` wraps the above into a single try/catch
 *
 * Why this pattern: every external data fetch is observable in the DB.
 * If TikTok blocks us, the `fetcher_runs` row shows `status='error'` with
 * the message; if a metric stops updating, you can see when the last
 * successful run was. This is the audit trail.
 *
 * Fetchers are also expected to:
 *   - Write to `snapshots` so trend lines accumulate
 *   - Return a `FetcherResult<T>` shape that the Brand Card layer can render
 *   - Fail independently — no fetcher should throw past its own boundary
 */
import { getAdminSupabase } from "@/lib/supabase-admin";
import type { FetcherResult, PlatformKind } from "@/lib/types";
import { nowIso } from "@/lib/utils";

export type TriggerKind = "manual" | "cron" | "on_demand";
export type FetcherStatus = "running" | "success" | "partial" | "error";

export interface StartRunOpts {
  fetcherName: string;
  triggerKind: TriggerKind;
  brandId?: string;
  categoryId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Open a new `fetcher_runs` row. Returns the run id; pass it to
 * `writeSnapshot` and `finishFetcherRun`.
 */
export async function startFetcherRun(opts: StartRunOpts): Promise<string> {
  const db = getAdminSupabase();
  const { data, error } = await db
    .from("fetcher_runs")
    .insert({
      fetcher_name: opts.fetcherName,
      trigger_kind: opts.triggerKind,
      brand_id: opts.brandId ?? null,
      category_id: opts.categoryId ?? null,
      status: "running",
      metadata: opts.metadata ?? null,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`startFetcherRun: ${error?.message || "no id returned"}`);
  }
  return data.id;
}

export interface FinishRunOpts {
  status: Exclude<FetcherStatus, "running">;
  snapshotsWritten: number;
  errorMessage?: string;
}

export async function finishFetcherRun(runId: string, opts: FinishRunOpts): Promise<void> {
  const db = getAdminSupabase();
  const { error } = await db
    .from("fetcher_runs")
    .update({
      status: opts.status,
      snapshots_written: opts.snapshotsWritten,
      error_message: opts.errorMessage ?? null,
      finished_at: nowIso(),
    })
    .eq("id", runId);
  if (error) {
    // Log but don't throw — we don't want fetcher_runs bookkeeping
    // to mask a real fetcher result.
    console.error(`[fetchers] finishFetcherRun failed for ${runId}:`, error.message);
  }
}

export interface WriteSnapshotInput {
  brandId: string;
  platform: PlatformKind;
  metric: string;
  valueNumeric?: number | null;
  valueText?: string | null;
  valueJson?: unknown;
  capturedAt?: string;
  sourceUrl?: string;
  fetcherRunId?: string;
}

/**
 * Append a single row to `snapshots`. Never overwrites.
 *
 * Convention: numeric metrics put their value in `value_numeric`. Categorical
 * (e.g. 'verified' / 'not_verified') go in `value_text`. Structured payloads
 * (top videos, time series, etc.) go in `value_json`.
 */
export async function writeSnapshot(input: WriteSnapshotInput): Promise<void> {
  const db = getAdminSupabase();
  const { error } = await db.from("snapshots").insert({
    brand_id: input.brandId,
    platform: input.platform,
    metric: input.metric,
    value_numeric: input.valueNumeric ?? null,
    value_text: input.valueText ?? null,
    value_json: input.valueJson ?? null,
    captured_at: input.capturedAt ?? nowIso(),
    source_url: input.sourceUrl ?? null,
    fetcher_run_id: input.fetcherRunId ?? null,
  });
  if (error) {
    throw new Error(`writeSnapshot(${input.platform}/${input.metric}): ${error.message}`);
  }
}

/**
 * Batch variant — when a single fetch produces many snapshots at once.
 */
export async function writeSnapshots(inputs: WriteSnapshotInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const db = getAdminSupabase();
  const rows = inputs.map((i) => ({
    brand_id: i.brandId,
    platform: i.platform,
    metric: i.metric,
    value_numeric: i.valueNumeric ?? null,
    value_text: i.valueText ?? null,
    value_json: i.valueJson ?? null,
    captured_at: i.capturedAt ?? nowIso(),
    source_url: i.sourceUrl ?? null,
    fetcher_run_id: i.fetcherRunId ?? null,
  }));
  const { error } = await db.from("snapshots").insert(rows);
  if (error) {
    throw new Error(`writeSnapshots(${rows.length} rows): ${error.message}`);
  }
}

export interface FetcherRunCtx {
  runId: string;
  snapshotsWritten: number;
}

/**
 * Wrap a fetcher operation with run bookkeeping + error isolation.
 *
 * The body receives a `ctx` with the run id and a counter — call
 * `ctx.snapshotsWritten++` after each `writeSnapshot` so the run row
 * captures accurate stats.
 *
 * The body's thrown errors are caught; the run is marked 'error' and a
 * `FetcherResult` with `ok:false` is returned. The caller (the Brand
 * Card orchestrator) never has to wrap its own try/catch.
 */
export async function withFetcherRun<T>(
  opts: StartRunOpts,
  body: (ctx: FetcherRunCtx) => Promise<T>
): Promise<FetcherResult<T>> {
  const runId = await startFetcherRun(opts);
  const ctx: FetcherRunCtx = { runId, snapshotsWritten: 0 };
  try {
    const data = await body(ctx);
    await finishFetcherRun(runId, {
      status: "success",
      snapshotsWritten: ctx.snapshotsWritten,
    });
    return { ok: true, data, capturedAt: nowIso() };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await finishFetcherRun(runId, {
      status: "error",
      snapshotsWritten: ctx.snapshotsWritten,
      errorMessage,
    });
    return { ok: false, error: errorMessage, capturedAt: nowIso() };
  }
}

/**
 * Common stub used by fetchers when their credentials are missing.
 * Returns a uniform "not configured" result that the Brand Card layer
 * renders as a greyed-out section.
 */
export function notConfiguredResult<T = never>(reason: string): FetcherResult<T> {
  return {
    ok: false,
    error: `not_configured: ${reason}`,
    capturedAt: nowIso(),
  };
}
