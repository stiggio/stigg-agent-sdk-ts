/**
 * A Vercel AI SDK model's usage, as this SDK reports it.
 *
 * The counters overlap the way OpenAI's do - `input_tokens` already counts the cache - so a meter can
 * price cached input at its own rate. The normalized `usage` a mapper reads is disjoint.
 */
import type { Measurement, Metrics, TokenUsage } from '../../../types';

export const VERCEL_AI_METRICS = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'total_tokens',
] as const;

/** One of the metric names a Vercel AI SDK model reports. */
export type VercelAIMetric = (typeof VERCEL_AI_METRICS)[number];

/** What a mapper reads off a Vercel AI SDK call: those names, each possibly absent. */
export type VercelAIMetrics = Partial<Record<VercelAIMetric, number>>;

/** `LanguageModelV3Usage` and `V4` alike: `inputTokens.total` includes the cache. */
export type ModelUsage = {
  inputTokens?: { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens?: { total?: number };
  raw?: unknown;
};

/** Roughly, for a stopped stream only - the Anthropic recipe's estimate too. */
const CHARS_PER_OUTPUT_TOKEN = 4;

/** One call's usage, or undefined when the model stated no counter - not a call that cost nothing. */
export function measurementOf(usage: ModelUsage | undefined, responseId?: string): Measurement | undefined {
  const input = usage?.inputTokens?.total;
  const output = usage?.outputTokens?.total;
  if (input === undefined && output === undefined) return undefined;

  const cacheRead = usage?.inputTokens?.cacheRead;
  const cacheWrite = usage?.inputTokens?.cacheWrite;
  const metrics = numbersOnly({
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: (input ?? 0) + (output ?? 0),
  });
  const tokenUsage: TokenUsage = {
    input: usage?.inputTokens?.noCache ?? Math.max(0, (input ?? 0) - (cacheRead ?? 0) - (cacheWrite ?? 0)),
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheCreate: cacheWrite ?? 0,
  };
  const raw = usage?.raw;
  return {
    metrics,
    usage: tokenUsage,
    ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? { raw: raw as Record<string, unknown> } : {}),
    ...(input === undefined || output === undefined ? { incomplete: 'the model stated only part of its usage' } : {}),
    // The provider's own id, so a retried step that replays a reply is one report.
    ...(responseId ? { idempotencyKey: responseId } : {}),
  };
}

/** A stream stopped before stating usage: its output, estimated from the text. Its input is unknown. */
export function estimated(chars: number): Measurement {
  const output = chars > 0 ? Math.max(1, Math.ceil(chars / CHARS_PER_OUTPUT_TOKEN)) : 0;
  return {
    metrics: output ? { output_tokens: output, total_tokens: output } : {},
    usage: { input: 0, output, cacheRead: 0, cacheCreate: 0 },
    ...(output ? { estimated: true as const } : {}),
    incomplete: 'the stream ended before the model stated its usage',
  };
}

function numbersOnly(stated: Record<string, number | undefined>): Metrics {
  const metrics: Metrics = {};
  for (const [name, value] of Object.entries(stated)) {
    if (typeof value === 'number' && Number.isFinite(value)) metrics[name] = value;
  }
  return metrics;
}
