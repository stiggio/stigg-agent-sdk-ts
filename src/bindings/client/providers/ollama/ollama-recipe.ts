/**
 * The Ollama recipe - `ollama`, the self-hosted engine's own client.
 *
 * ## What these numbers mean, which is not what every other recipe's mean
 *
 * Ollama invoices nobody. It is not a provider in the sense the other recipes here are - it bills
 * nothing, and it serves open-weight models it did not make - so there is no vendor dashboard to
 * reconcile against and no `cost` to recover. What is being governed is the customer's **own**
 * capacity: a per-agent or per-team budget over hardware they already pay for. The counters are
 * reported under Ollama's own names anyway, for the same reason as everywhere else - so a meter
 * reads one vocabulary - but nobody should expect them to match an invoice, because there is none.
 *
 * ## Shape
 *
 * The client is **flat**: `chat` and `generate` are methods on the client object itself, not
 * namespaces. Both take `{ stream: true }` to switch mode, so each declares `extractUsage` *and*
 * `attachStream` - a streamed call resolves to an `AbortableAsyncIterator` with no counters on it,
 * `extractUsage` returns undefined, and the wrapper falls through to the stream path. That is the
 * same dual-mode arrangement `openAIRecipe` uses for `chat.completions.create`.
 *
 * The counters sit flat on the response root rather than inside a `usage` object, which is why
 * `raw` here is an explicit projection of the two counters rather than the response. Passing the
 * response would flatten `message.content` - the model's own reply text - into event dimensions.
 *
 * ## What is deliberately not covered
 *
 * `embed` reports `prompt_eval_count` but no `eval_count`: it is a different unit against a
 * different price list, and metering it with a chat recipe reports a number that is wrong rather
 * than missing. `embeddings` (the legacy endpoint) reports no counters at all. `pull`, `push` and
 * `create` move or quantize bytes and report progress, not tokens.
 *
 * `systemone` is declined by name even though it genuinely carries tokens. Its block is
 * `{ input_tokens, output_tokens }` - the identical names `typesafe.systemOne` reports - so gating
 * it here would emit `ollama.systemone` carrying metrics indistinguishable from TypeSafe's for
 * anyone metering on metric names rather than event names. One vocabulary per vendor is worth more
 * than one extra surface; name your own recipe at `wrap(client, { recipe })` if you need it.
 *
 * `webSearch` and `webFetch` are the ones worth knowing about: they are **billable**, they are
 * charged against `OLLAMA_API_KEY` at `ollama.com`, and they ignore `config.host` entirely - so
 * they are invisible to any host-based reasoning about where this client points. They report no
 * token counters, so there is nothing honest for this recipe to meter them with.
 */
import {
  COMPUTED_TOTALS,
  METRIC_PATHS,
  OLLAMA_METRICS,
  TOTAL_TOKENS,
  fromOllamaUsage,
  pickMetrics,
  withComputedTotal,
} from '../../../shared/token-usage';
import { meterStream } from '../../../shared/meter-stream';
import { emptyTokenUsage, type Measurement, type Metrics } from '../../../../types';
import { hasMethod } from '../../core/registry';
import type { OllamaResponse } from './types';
import type { ClientRecipe, MetricsFor, MetricsOf } from '../../core/types';

/**
 * Both views of one response's counters.
 *
 * `raw` is built from the picked metrics rather than from the response, deliberately: the counters
 * are flat on a root that also carries the generated text, and `raw` becomes event dimensions.
 */
function measure(result: OllamaResponse | undefined): Measurement | undefined {
  // Absent, not zero. The declared type says these are always present and the wire disagrees -
  // every intermediate stream chunk omits them - so a response with neither has nothing to report.
  const metrics = pickMetrics(result, METRIC_PATHS.ollama);
  if (Object.keys(metrics).length === 0) return undefined;
  return {
    // Ollama publishes no total, so one is summed from two disjoint counters - the only case where
    // adding them up is the vendor's own arithmetic rather than ours.
    metrics: withComputedTotal(metrics, COMPUTED_TOTALS.ollama!),
    usage: fromOllamaUsage(result),
    raw: { ...metrics },
  };
}

/** A buffered `chat`/`generate`. A streamed call resolves to an iterator and reports nothing here. */
const extractUsage = (result: OllamaResponse | undefined): Measurement | undefined => measure(result);

/** The streamed counterpart: the counters ride the final `done: true` chunk and nothing before it. */
const attachStream = (stream: unknown, ingest: (measurement: Measurement) => void): void => {
  let metrics: Metrics = {};
  let usage = emptyTokenUsage();
  let raw: Record<string, unknown> | undefined;
  meterStream(
    stream,
    (chunk: OllamaResponse) => {
      const measured = measure(chunk);
      if (measured) {
        metrics = measured.metrics ?? {};
        usage = measured.usage ?? emptyTokenUsage();
        raw = measured.raw;
      }
    },
    // A stream that ended before its final chunk reports nothing rather than zeroes: it produced
    // tokens the customer paid for in compute, and a zero would say it produced none.
    () => ingest({ metrics, usage, ...(raw ? { raw } : {}) }),
  );
};

export const ollamaRecipe = {
  vendor: 'ollama',
  metrics: OLLAMA_METRICS,
  totalTokensMetric: TOTAL_TOKENS,
  /**
   * Three markers, not one.
   *
   * `chat` and `generate` are extremely common verbs, and this client has no namespace to make
   * them distinctive - so a two-signal guard would still claim unrelated objects. `ps` is the
   * third because it is specific to a model runner. Not matched on the host: Ollama is
   * self-hosted so there is no fixed hostname, and `proxy: true` leaves `config.host` an empty
   * string, which a truthiness check would miss.
   */
  matches: (client) => hasMethod(client, ['chat']) && hasMethod(client, ['generate']) && hasMethod(client, ['ps']),
  methods: [
    { path: ['chat'] as const, extractUsage, attachStream },
    { path: ['generate'] as const, extractUsage, attachStream },
  ],
} satisfies ClientRecipe<(typeof OLLAMA_METRICS)[number]>;

/** One of the metric names Ollama reports. */
export type OllamaMetric = MetricsOf<typeof ollamaRecipe>;

/** What a mapper reads off an Ollama call: those names, each possibly absent. */
export type OllamaMetrics = MetricsFor<typeof ollamaRecipe>;
