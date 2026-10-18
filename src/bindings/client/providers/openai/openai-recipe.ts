/**
 * The OpenAI recipe - the second vendor, and the proof that the generic wrapper carries its
 * weight: everything below is response-shape knowledge, with no gate logic repeated.
 *
 * Works against any OpenAI-compatible endpoint, a gateway included. Note that a gateway usually
 * wants the ingest-only gateway binding instead: it sees requests, not runs.
 *
 * ## Why Groq's own field name is read here, when Groq has a recipe of its own
 *
 * `groqRecipe` exists and is matched ahead of this one, so most Groq traffic never reaches here.
 * The `x_groq.usage` read below stays anyway, and deliberately, for two reasons.
 *
 * **It is written once and used twice.** `groqRecipe` builds its methods from these surfaces, the
 * way the OpenRouter and LiteLLM recipes do, so it reads its own counters through this reader
 * rather than carrying a copy. Moving the read into that recipe would duplicate it, not relocate
 * it.
 *
 * **A Groq client the host matcher declines still lands here.** That matcher is narrow on purpose -
 * it compares the hostname, because a wrong guess silently changes who gets billed - so a Groq
 * deployment reached on any other base URL is not claimed by it: `GROQ_BASE_URL` pointed at a
 * regional or staging endpoint, or a corporate proxy in front of `api.groq.com`. Those clients are
 * governed by this recipe, their streamed chunks still carry **no top-level `usage` at all**, and
 * without this fallback every one of them would be wrapped, stamped governed, and metered at
 * nothing. That is the bug this read was added to fix, and it is reachable by configuration alone.
 *
 * Nothing else is affected: a response from any other OpenAI-compatible vendor has no `x_groq`, so
 * the fallback yields `undefined` and the behaviour is exactly what it was.
 *
 * Mind the trap in that field. `x_groq.usage` means token totals on a **streamed** chunk and
 * hardware cache statistics - `dram_cached_tokens`, `sram_cached_tokens` - on a buffered response.
 * Two things keep them apart: only `streamed` consults it at all, and {@link asTokenUsage} refuses
 * a block that names none of the token counters. Without that guard a buffered response would read
 * as all-zero counters with cache statistics riding along as `raw` - a measurement of nothing that
 * looks like data, which is the one failure shape nothing downstream can notice.
 */
import {
  METRIC_PATHS,
  TOTAL_TOKENS,
  OPENAI_CHAT_METRICS,
  OPENAI_METRICS,
  OPENAI_RESPONSES_METRICS,
  fromOpenAIUsage,
  fromResponsesUsage,
  pickMetrics,
} from '../../../shared/token-usage';
import { meterStream } from '../../../shared/meter-stream';
import { emptyTokenUsage, type Measurement, type Metrics } from '../../../../types';
import { hasMethod } from '../../core/registry';
import type { ClientRecipe, MetricsFor, MetricsOf } from '../../core/types';

/**
 * A usage block, or nothing - for the one field that holds something else half the time.
 *
 * Groq's `x_groq.usage` carries the token counters while streaming and hardware cache statistics
 * (`dram_cached_tokens`, `sram_cached_tokens`) when not. Recognised by the counters themselves
 * rather than by which call produced it, so a block naming none of them is declined outright
 * instead of being read as three zeroes.
 */
const asTokenUsage = (usage: any): any =>
  typeof usage?.prompt_tokens === 'number' ||
  typeof usage?.completion_tokens === 'number' ||
  typeof usage?.total_tokens === 'number'
    ? usage
    : undefined;

/**
 * The two surfaces, and where each keeps its usage.
 *
 * Chat Completions and Responses are the same API family with different field names, so the only
 * thing that varies per surface is which extractor reads the counts and where a stream hides them.
 */
const SURFACES = [
  {
    path: ['chat', 'completions', 'create'],
    parse: fromOpenAIUsage,
    keys: METRIC_PATHS.openaiChat,
    metrics: OPENAI_CHAT_METRICS,
    // Reported once, on the final chunk - at the root for OpenAI itself, and under `x_groq` for
    // Groq, whose chunks carry no top-level `usage` at all. See the header on that second read.
    streamed: (chunk: any) => chunk?.usage ?? asTokenUsage(chunk?.x_groq?.usage),
  },
  {
    path: ['responses', 'create'],
    parse: fromResponsesUsage,
    keys: METRIC_PATHS.openaiResponses,
    metrics: OPENAI_RESPONSES_METRICS,
    // Reported on the completion event, which carries the whole response rather than a delta.
    streamed: (chunk: any) => chunk?.response?.usage ?? chunk?.usage,
  },
] as const;

/** The reader for a surface, so a recipe built on top of this one stays in step with it. */
export const openAISurface = (path: readonly string[]) =>
  SURFACES.find((surface) => surface.path.join('.') === path.join('.')) ?? SURFACES[0];

export const openAIRecipe = {
  vendor: 'openai',
  metrics: OPENAI_METRICS,
  totalTokensMetric: TOTAL_TOKENS,
  // Either surface is enough: the recipe governs both, and a client built only for the Responses
  // API has no `chat.completions` to find.
  matches: (client) =>
    hasMethod(client, ['chat', 'completions', 'create']) || hasMethod(client, ['responses', 'create']),
  methods: SURFACES.map(({ path, parse, keys, streamed }) => ({
    path: [...path],
    // What OpenAI called it, which is what gets reported, beside the normalized counters. Note
    // `prompt_tokens` includes the cached tokens reported next to it - the overlap is the
    // vendor's, kept so the numbers reconcile against its own dashboard.
    extractUsage: (result: any) =>
      result?.usage
        ? { metrics: pickMetrics(result.usage, keys), usage: parse(result.usage), raw: result.usage }
        : undefined,
    attachStream: (stream: any, ingest: (measurement: Measurement) => void) => {
      let total = emptyTokenUsage();
      let metrics: Metrics = {};
      // As on the non-streamed path, so a streamed turn states its usage just as fully - the
      // counters this recipe does not name (`total_tokens`, the reasoning-token detail) reach a
      // meter either way rather than only when the caller happened not to stream.
      let raw: Record<string, unknown> | undefined;
      meterStream(
        stream,
        (chunk) => {
          const usage = streamed(chunk);
          // Reported once and whole rather than as deltas, so the last one wins outright - which
          // is also what makes the block safe to keep as it arrived.
          if (usage) {
            total = parse(usage);
            metrics = pickMetrics(usage, keys);
            // Copied, not referenced - it is held until the stream ends, and the chunk it came
            // from belongs to the consumer. See the Gemini recipe for the full reasoning.
            raw = { ...usage };
          }
        },
        // Absent rather than `undefined` when no chunk carried usage - see the Gemini recipe.
        () => ingest({ metrics, usage: total, ...(raw ? { raw } : {}) }),
      );
    },
  })),
} satisfies ClientRecipe<(typeof OPENAI_METRICS)[number]>;

/** One of the metric names OpenAI reports. */
export type OpenAIMetric = MetricsOf<typeof openAIRecipe>;

/** What a mapper reads off an OpenAI call: those names, each possibly absent. */
export type OpenAIMetrics = MetricsFor<typeof openAIRecipe>;
