/**
 * Sentiment analysis layer — PRD §3 calls this "your core value-add."
 *
 * Pulls comments from Reddit (and later TikTok), batches them, sends to
 * Claude with a structured-output prompt asking for an overall score plus
 * named themes. Returns a `SentimentResult` that the Brand Card renders.
 *
 * Why Claude and not a smaller model: we get free-text themes ("smells
 * great" / "price point") in the same call, which a sentiment-classifier-
 * only model can't produce. The cost per Brand Card lookup is small
 * (~$0.01 with Haiku, ~$0.05 with Sonnet) and the quality is materially
 * better.
 *
 * Snapshots written when configured:
 *   - 'derived', 'sentiment_score'   (value_numeric, -1..1)
 *   - 'derived', 'sentiment_themes'  (value_json: {positive, negative, sampleSize})
 *
 * Failure modes:
 *   - Anthropic API down / rate-limited: throw, fetcher_runs records error,
 *     Brand Card renders sentiment block as 'error'.
 *   - Comment sample too small (<5 comments): we still call Claude but flag
 *     sampleSize so the UI can show a low-confidence caveat.
 *   - Model returns malformed JSON: we retry once with a stricter prompt,
 *     then fail.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getServerEnv } from "@/lib/env";
import { withFetcherRun, writeSnapshot, type FetcherRunCtx } from "./fetchers/_base";
import type { FetcherResult } from "@/lib/types";

export interface SentimentResult {
  overallScore: number;                  // -1..1
  label: "very_negative" | "negative" | "mixed" | "positive" | "very_positive";
  positiveThemes: string[];              // short phrases, e.g. "reef-safe formula"
  negativeThemes: string[];              // short phrases, e.g. "price point"
  sampleSize: number;
  confidence: "low" | "medium" | "high"; // derived from sample size
  capturedAt: string;
}

export interface SentimentOptions {
  brandId: string;
  brandName: string;
  comments: string[];                    // already de-duplicated, ≥10 chars each
  // Optional context — model uses this to disambiguate brand name
  // (e.g. "Vacation" the sunscreen vs "vacation" the noun)
  contextHint?: string;
  triggerKind?: "manual" | "cron" | "on_demand";
  // Use 'haiku' for fast/cheap, 'sonnet' for higher fidelity.
  // Default 'haiku' — for ranking purposes the diff is small.
  modelTier?: "haiku" | "sonnet";
}

const MIN_USEFUL_SAMPLE = 5;
const MAX_COMMENTS_PER_CALL = 100;   // Claude can handle more but cost scales linearly

/**
 * Map model tier to a specific model name.
 * See https://docs.claude.com/en/docs/about-claude/models
 */
function modelFor(tier: "haiku" | "sonnet"): string {
  return tier === "haiku" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6";
}

export async function analyzeSentiment(opts: SentimentOptions): Promise<FetcherResult<SentimentResult>> {
  const trigger = opts.triggerKind ?? "on_demand";
  const tier = opts.modelTier ?? "haiku";

  return withFetcherRun(
    {
      fetcherName: "sentiment",
      triggerKind: trigger,
      brandId: opts.brandId,
      metadata: { brandName: opts.brandName, modelTier: tier, sampleSize: opts.comments.length },
    },
    async (ctx: FetcherRunCtx): Promise<SentimentResult> => {
      const env = getServerEnv();
      const client = new Anthropic({ apiKey: env.anthropicApiKey });

      const sample = opts.comments
        .filter((c) => c && c.length >= 10)
        .slice(0, MAX_COMMENTS_PER_CALL);

      if (sample.length === 0) {
        throw new Error("No usable comments provided to analyzeSentiment");
      }

      const result = await callClaudeForSentiment(client, modelFor(tier), opts.brandName, sample, opts.contextHint);

      const confidence: SentimentResult["confidence"] =
        sample.length < MIN_USEFUL_SAMPLE ? "low" : sample.length < 25 ? "medium" : "high";

      const final: SentimentResult = {
        overallScore: clamp(result.overallScore, -1, 1),
        label: labelFromScore(result.overallScore),
        positiveThemes: result.positiveThemes.slice(0, 5),
        negativeThemes: result.negativeThemes.slice(0, 5),
        sampleSize: sample.length,
        confidence,
        capturedAt: new Date().toISOString(),
      };

      // Persist snapshots
      await writeSnapshot({
        brandId: opts.brandId,
        platform: "derived",
        metric: "sentiment_score",
        valueNumeric: final.overallScore,
        valueJson: { sampleSize: final.sampleSize, confidence: final.confidence },
        fetcherRunId: ctx.runId,
      });
      ctx.snapshotsWritten++;

      await writeSnapshot({
        brandId: opts.brandId,
        platform: "derived",
        metric: "sentiment_themes",
        valueJson: {
          positive: final.positiveThemes,
          negative: final.negativeThemes,
          sampleSize: final.sampleSize,
        },
        fetcherRunId: ctx.runId,
      });
      ctx.snapshotsWritten++;

      return final;
    }
  );
}

// =========================================================================
// Claude call
// =========================================================================

interface ParsedSentiment {
  overallScore: number;
  positiveThemes: string[];
  negativeThemes: string[];
}

async function callClaudeForSentiment(
  client: Anthropic,
  model: string,
  brandName: string,
  comments: string[],
  contextHint?: string
): Promise<ParsedSentiment> {
  const systemPrompt = `You are a sentiment analyst for a consumer-goods rep group.
Given a sample of customer comments about a specific brand, return a STRUCTURED
JSON object with three fields:
- "overallScore": number from -1.0 (very negative) to 1.0 (very positive)
- "positiveThemes": array of 3-5 short phrases (under 8 words each) describing what
  customers consistently like. Use the customers' own framing where possible.
- "negativeThemes": array of 0-5 short phrases describing recurring complaints. If
  there aren't real negatives, return an empty array.

Ignore off-topic comments. Ignore obvious bots and one-word reactions ("nice", "ok").
Do NOT invent themes that aren't supported by multiple comments. Do NOT hedge
your overallScore — give your best calibrated estimate.

Respond with ONLY the JSON object, no prose preamble or markdown fences.`;

  const userMessage = [
    `Brand: ${brandName}`,
    contextHint ? `Context: ${contextHint}` : "",
    `Number of comments: ${comments.length}`,
    "",
    "Comments:",
    ...comments.map((c, i) => `[${i + 1}] ${c.replace(/\s+/g, " ").slice(0, 500)}`),
  ]
    .filter(Boolean)
    .join("\n");

  // First attempt
  const tryOnce = async (extraSystemNote?: string): Promise<ParsedSentiment> => {
    const res = await client.messages.create({
      model,
      max_tokens: 600,
      system: systemPrompt + (extraSystemNote ? `\n\n${extraSystemNote}` : ""),
      messages: [{ role: "user", content: userMessage }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return parseSentimentJson(text);
  };

  try {
    return await tryOnce();
  } catch (err) {
    console.warn(`[sentiment] first parse failed (${err}); retrying with stricter instruction`);
    return await tryOnce(
      "STRICT: Your previous response was not valid JSON. Return EXACTLY one JSON object and nothing else."
    );
  }
}

function parseSentimentJson(text: string): ParsedSentiment {
  // Model sometimes wraps in ```json ... ```; strip if present.
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  // Find the outermost {...} in case of any leading prose.
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1) {
    throw new Error(`Model response did not contain a JSON object: ${cleaned.slice(0, 200)}`);
  }
  const json = cleaned.slice(first, last + 1);
  let parsed: { overallScore?: unknown; positiveThemes?: unknown; negativeThemes?: unknown };
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Model response not parseable JSON: ${err}`);
  }
  if (typeof parsed.overallScore !== "number") {
    throw new Error(`Model response missing overallScore`);
  }
  return {
    overallScore: parsed.overallScore,
    positiveThemes: Array.isArray(parsed.positiveThemes)
      ? parsed.positiveThemes.filter((t): t is string => typeof t === "string")
      : [],
    negativeThemes: Array.isArray(parsed.negativeThemes)
      ? parsed.negativeThemes.filter((t): t is string => typeof t === "string")
      : [],
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function labelFromScore(score: number): SentimentResult["label"] {
  if (score <= -0.5) return "very_negative";
  if (score < -0.1) return "negative";
  if (score < 0.1) return "mixed";
  if (score < 0.5) return "positive";
  return "very_positive";
}
