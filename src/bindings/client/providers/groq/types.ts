/**
 * Groq's own additions to the OpenAI wire format, typed structurally.
 *
 * No import from `groq-sdk` - `module-boundaries.test.ts` would fail on one. Nothing here is
 * imported by the recipe: the counters are read through the OpenAI surfaces, which `groqRecipe`
 * reuses. These exist as the written record of two things that are easy to get wrong, and the
 * guard that acts on the first of them lives in `openai-recipe.ts` as `asTokenUsage`.
 */
import type { OpenAILikeUsage } from '../../../shared/types';

/**
 * `x_groq`, whose `usage` means **two different things** depending on the call.
 *
 * On a streamed chunk it is the request's token totals, sent only in the final chunk - Groq's
 * streamed chunks carry no top-level `usage` field at all, so this is the only place the counters
 * appear unless `stream_options: { include_usage: true }` was sent. On a buffered response it is
 * hardware cache statistics instead, which are not token counts and must never be read as any.
 *
 * Reading the second as the first reports a call that cost real tokens as three zeroes with cache
 * statistics attached, which is data-shaped and wrong rather than merely missing.
 */
export type GroqStreamedXGroq = {
  id?: string | null;
  seed?: number | null;
  error?: string | null;
  usage?: OpenAILikeUsage | null;
  usage_breakdown?: GroqUsageBreakdown | null;
};

/** The same key on a buffered response: Groq's request id, and cache statistics, never tokens. */
export type GroqBufferedXGroq = {
  id?: string | null;
  usage?: { dram_cached_tokens?: number | null; sram_cached_tokens?: number | null } | null;
};

/**
 * Per-model token usage, for a request that consumed more than one model.
 *
 * Groq's compound systems route a single call through several models and report each one's tokens
 * separately - top level when buffered, under `x_groq` when streamed. It is **not metered**, and
 * cannot be with the shapes this SDK has: `Metrics` is a flat `Record<string, number>` and a
 * `Measurement` carries one `dimensions` object, so there is nowhere to put two models' counts
 * without attributing both to one of them. The call's own `usage` is the request total and is what
 * gets reported, which is the honest number; the split is simply not recoverable here.
 */
export type GroqUsageBreakdown = {
  models?: Array<{ model?: string; usage?: OpenAILikeUsage | null }> | null;
};
