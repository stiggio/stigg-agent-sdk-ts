/**
 * The Mistral recipe - `@mistralai/mistralai`, the Speakeasy-generated client.
 *
 * ## What is covered
 *
 * Every surface that burns tokens and reports them the same way: `chat.complete`, `chat.stream`,
 * `chat.parse`, `chat.parseStream`, `fim.complete`, `fim.stream`, `agents.complete` and
 * `agents.stream`. Eight methods, one extractor - `FIMCompletionResponse` and
 * `ChatCompletionResponse` both carry `usage: UsageInfo`, `ParsedChatCompletionResponse` is a
 * `ChatCompletionResponse` with its choices retyped, and all four streamed methods resolve to the
 * same `EventStream<CompletionEvent>`. That was read off the SDK's own types, not assumed.
 *
 * Each is its own event name, because a meter filtering on one sees nothing from the others.
 * `chat.parse` in particular is **not** a wrapper over `chat.complete`: it reaches the wire itself,
 * so leaving it out would ship a billable path that looks governed.
 *
 * ## What is deliberately not covered
 *
 * `beta.conversations.*` is declined by name. It reports `ConversationUsageInfo` - the three
 * counters plus `connectorTokens` and a per-connector map - which is a second vocabulary, and an
 * event name is permanent once a customer's meter filters on it. Gating it with this extractor
 * would read the three it shares and silently drop the connector spend, which is the shape of
 * error this file exists to avoid. It wants its own recipe and its own metric list.
 *
 * Also not covered, each counting in units these token metrics do not describe: `embeddings.create`
 * (tokens, but of a different kind and against a different price list), `ocr.process` (whose
 * `usageInfo` is `pagesProcessed`, a page count), `audio.transcriptions.*` (`promptAudioSeconds`),
 * `classifiers.*`, `files.*`, `batch.*` and v2's `workflows.*`. Meter one by naming your own
 * recipe at `wrap(client, { recipe })`.
 *
 * ## Two gaps a caller should know about
 *
 * **The standalone functions bypass this entirely.** Every method also exists as a tree-shakable
 * function taking the client as its first argument - `chatComplete(client, request)` from
 * `@mistralai/mistralai/funcs/chatComplete.js`. Those do not go through the patched method, so a
 * call made that way is neither gated nor metered while `wrap()` reports success. Mistral ships an
 * `SDKHooks` seam that would catch both forms, and it is deliberately not used: holding its
 * `HookContext` means importing the vendor package into `src/`, which `module-boundaries.test.ts`
 * forbids outright. A recipe here is data - method paths and duck-typed extractors - and that is
 * what lets `src/index.ts` export every binding with no vendor SDK at runtime. So this is a real
 * limit rather than an oversight: call the methods, not the funcs.
 *
 * **A stream read through `getReader()` is not metered.** `EventStream` extends `ReadableStream`
 * *and* overrides `[Symbol.asyncIterator]`, so `meterStream` patches the iterator in place and the
 * documented `for await` is covered. A consumer that takes a reader instead bypasses it, and the
 * stream is the caller's own object - it cannot be swapped for a metered copy without breaking
 * `instanceof`. Stated here rather than left to be discovered.
 */
import {
  MISTRAL_METRICS,
  MISTRAL_METRIC_NAME_MAP,
  TOTAL_TOKENS,
  fromMistralUsage,
  pickRenamedMetrics,
} from '../../../shared/token-usage';
import { meterStream } from '../../../shared/meter-stream';
import { emptyTokenUsage, type Measurement, type Metrics } from '../../../../types';
import { hasMethod } from '../../core/registry';
import type { MistralLikeUsage } from '../../../shared/types';
import type { MistralCompletionEvent, MistralCompletionResponse } from './types';
import type { ClientRecipe, MetricsFor, MetricsOf } from '../../core/types';

/**
 * Both views of one usage block: Mistral's counters under the wire's names, and the normalized
 * four a mapper of your own would read.
 *
 * `raw` is the renamed projection rather than the object the SDK handed over, so an event's
 * `raw.*` dimensions agree with its metrics - and so the same account reports the same strings
 * whether the application holds a `Mistral` client or an `OpenAI` one pointed at its base URL.
 */
function measure(usage: MistralLikeUsage | null | undefined): Measurement | undefined {
  if (!usage) return undefined;
  const metrics = pickRenamedMetrics(usage, MISTRAL_METRIC_NAME_MAP);
  // Nothing readable in it - an absent counter is absent, not zero, so there is no measurement to
  // report rather than one that says the call cost nothing.
  if (Object.keys(metrics).length === 0) return undefined;
  return { metrics, usage: fromMistralUsage(usage), raw: { ...metrics } };
}

/** Reads the buffered response every gated `complete`/`parse` surface returns. */
const extractUsage = (result: MistralCompletionResponse | undefined): Measurement | undefined => measure(result?.usage);

/** The streamed counterpart, whose counters arrive once and a level down, under `data`. */
const attachStream = (stream: unknown, ingest: (measurement: Measurement) => void): void => {
  let metrics: Metrics = {};
  let usage = emptyTokenUsage();
  let raw: Record<string, unknown> | undefined;
  meterStream(
    stream,
    (chunk: MistralCompletionEvent) => {
      // Stated whole on the terminating chunk rather than as deltas, so the last one wins.
      const measured = measure(chunk?.data?.usage);
      if (measured) {
        metrics = measured.metrics ?? {};
        usage = measured.usage ?? emptyTokenUsage();
        raw = measured.raw;
      }
    },
    // Absent rather than an empty object when no chunk carried usage, as the other recipes do.
    () => ingest({ metrics, usage, ...(raw ? { raw } : {}) }),
  );
};

/** The surfaces, and whether each one streams. */
const SURFACES = [
  { path: ['chat', 'complete'] as const, streams: false },
  { path: ['chat', 'stream'] as const, streams: true },
  { path: ['chat', 'parse'] as const, streams: false },
  { path: ['chat', 'parseStream'] as const, streams: true },
  { path: ['fim', 'complete'] as const, streams: false },
  { path: ['fim', 'stream'] as const, streams: true },
  { path: ['agents', 'complete'] as const, streams: false },
  { path: ['agents', 'stream'] as const, streams: true },
];

export const mistralRecipe = {
  vendor: 'mistral',
  metrics: MISTRAL_METRICS,
  // Mistral states its own total, so it is read rather than summed from the parts.
  totalTokensMetric: TOTAL_TOKENS,
  // Two signals, because `complete` on its own is far too common a verb to claim. An `OpenAI`
  // client pointed at `api.mistral.ai/v1` has neither of these - it speaks `chat.completions.
  // create` and is governed by `openAIRecipe` as `openai.*`, which the README spells out.
  matches: (client) => hasMethod(client, ['chat', 'complete']) && hasMethod(client, ['chat', 'stream']),
  methods: SURFACES.map(({ path, streams }) =>
    streams ? { path: [...path], attachStream } : { path: [...path], extractUsage },
  ),
} satisfies ClientRecipe<(typeof MISTRAL_METRICS)[number]>;

/** One of the metric names Mistral reports. */
export type MistralMetric = MetricsOf<typeof mistralRecipe>;

/** What a mapper reads off a Mistral call: those names, each possibly absent. */
export type MistralMetrics = MetricsFor<typeof mistralRecipe>;
