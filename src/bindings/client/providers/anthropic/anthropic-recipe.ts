/**
 * The Anthropic recipe.
 *
 * Only `messages.create` is gated, because `messages.stream()` routes through it - so one patch
 * covers both call styles, and `stream()` keeps its synchronous signature (callers attach
 * listeners to the returned object before awaiting anything). A denial raised inside the create
 * leg surfaces as a rejection from `finalMessage()`/`done()`, which is where a stream caller
 * already handles failure.
 */
import {
  ANTHROPIC_COMPONENT_METRICS,
  ANTHROPIC_METRICS,
  COMPUTED_TOTALS,
  TOTAL_TOKENS,
  fromFlatTokenUsage,
  pickMetrics,
  withComputedTotal,
} from '../../../shared/token-usage';
import type { Measurement } from '../../../../types';
import { estimateUnits } from '../../../shared/estimate';
import { hasMethod } from '../../core/registry';
import type { ClientRecipe, MetricsFor, MetricsOf } from '../../core/types';
import type { FlatTokenUsage } from '../../../shared/types';

/**
 * The two stream events that carry usage, described structurally rather than imported from
 * `@anthropic-ai/sdk`.
 *
 * Importing the vendor's `RawMessageStreamEvent` would put a devDependency in the emitted `.d.ts`
 * - this recipe is declared with `satisfies`, which keeps the literal type - and the package's
 * whole claim is that importing it pulls in no vendor package. The counters are optional here
 * even where the SDK declares them required: this reads a response off the wire, and the runtime
 * guards in `fromFlatTokenUsage` exist because the wire does not always agree with the types.
 *
 * The remaining members are the events that carry no usage. They are listed so that a comparison
 * against `event.type` is checked against something: the discriminant is the whole mechanism, and
 * a typo in it would silently meter a streamed call at zero.
 */
type AnthropicStreamEvent =
  | { type: 'message_start'; message?: { usage?: FlatTokenUsage | null } | null }
  | { type: 'message_delta'; usage?: FlatTokenUsage | null }
  | { type: 'content_block_delta'; delta?: AnthropicDelta | null }
  | { type: 'content_block_start' | 'content_block_stop' }
  | { type: 'message_stop' | 'ping' | 'error' };

/**
 * The generated pieces of a `content_block_delta`, which are what a stopped stream leaves behind.
 *
 * Text, reasoning and tool arguments are all output Anthropic bills for, so all three count.
 * `signature_delta` does not appear here: it carries a signature over reasoning already counted,
 * not anything the model generated on the customer's behalf.
 */
type AnthropicDelta =
  | { type: 'text_delta'; text?: string | null }
  | { type: 'thinking_delta'; thinking?: string | null }
  | { type: 'input_json_delta'; partial_json?: string | null }
  | { type: 'signature_delta' };

/**
 * Characters per output token, for the one case where the vendor states no count.
 *
 * Approximate on purpose and deliberately not tuned: it is only ever reached for a stream that
 * was abandoned, where the alternative is reporting nothing for text the customer read and the
 * vendor billed. Roughly four characters to a token holds well enough across English prose for
 * the estimate to be the closer of the two answers. Anything reported from it is marked
 * `estimated` so it is never mistaken for a counter Anthropic stated.
 */
const CHARS_PER_OUTPUT_TOKEN = 4;

/** The characters a delta contributed, or 0 for the events that generate nothing. */
function generatedChars(delta: AnthropicDelta | null | undefined): number {
  if (!delta) return 0;
  const produced =
    delta.type === 'text_delta'
      ? delta.text
      : delta.type === 'thinking_delta'
        ? delta.thinking
        : delta.type === 'input_json_delta'
          ? delta.partial_json
          : undefined;
  return typeof produced === 'string' ? produced.length : 0;
}

/**
 * Whether a wire value is a count at all.
 *
 * Whole and non-negative, because a counter that *replaces* another has to be checked before it
 * is trusted: a negative or fractional one is not a token count, and letting it overwrite a real
 * count reads back as zero.
 */
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * The counters a stream has most recently stated - each event replacing what it names, rather
 * than adding to it.
 *
 * Anthropic restates cumulatively. `message_delta.usage.input_tokens` is "the *cumulative* number
 * of input tokens which were used", in the vendor's own words, and the same holds for both cache
 * counters and for `output_tokens`. None of them is a delta despite the event's name, so summing
 * the two events bills every input counter twice.
 *
 * Per counter rather than by replacing the block wholesale, because the two events do not carry
 * the same fields: on older API versions `message_start` is the only one that states the input
 * counts, and a wholesale replace would make the opposite billing error.
 *
 * The key list is {@link ANTHROPIC_COMPONENT_METRICS} rather than one of its own: these are the
 * same four counters under the same four names, and a second list would be free to disagree with
 * the one that decides what gets reported.
 */
function restate(into: FlatTokenUsage, stated: FlatTokenUsage | null | undefined): FlatTokenUsage {
  if (!stated) return into;
  const merged: FlatTokenUsage = { ...into };
  for (const key of ANTHROPIC_COMPONENT_METRICS) {
    const value = stated[key];
    // Only a whole, non-negative number counts as a statement. `null` is how this wire says
    // "not this event", and a malformed or negative one is not a count - letting either through
    // would erase a count an earlier event did state.
    if (isCount(value)) merged[key] = value;
  }
  return merged;
}

/**
 * Accumulates usage across raw stream events: Anthropic sends the input counts on
 * `message_start` and restates them, with the output count, on `message_delta` - so one completed
 * stream produces one measurement rather than one per event.
 */
function observeStream(stream: any, ingest: (measurement: Measurement) => void): void {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return;

  const iterate = stream[Symbol.asyncIterator].bind(stream) as () => AsyncIterable<AnthropicStreamEvent>;
  stream[Symbol.asyncIterator] = async function* gatedIterator() {
    // What the stream has said so far, in the vendor's own shape. Kept flat rather than converted
    // per event: both views of the call - the vendor's names and the normalized counters - are
    // derived from it once at the end, so neither can be accumulated out of step with the other.
    let stated: FlatTokenUsage = {};
    // Whether the stream ever stated a final output count. `message_start` carries a placeholder
    // `output_tokens: 1`, so the presence of the counter says nothing - only `message_delta` does.
    let hasStatedOutputTokens = false;
    // What the stream actually produced, for the case where it never gets to say.
    let chars = 0;
    try {
      for await (const event of iterate()) {
        if (event?.type === 'message_start') stated = restate(stated, event.message?.usage);
        if (event?.type === 'message_delta') {
          stated = restate(stated, event.usage);
          hasStatedOutputTokens ||= typeof event.usage?.output_tokens === 'number';
        }
        if (event?.type === 'content_block_delta') chars += generatedChars(event.delta);
        yield event;
      }
    } finally {
      // Meter what was actually produced, even if the consumer broke out of the loop early.
      //
      // No `raw` here, deliberately, and this is the one vendor that cannot have one: the counters
      // arrive split across `message_start` and `message_delta`, so there is no single usage block
      // on the wire to carry. The Gemini and OpenAI streams each report one whole block and do
      // pass it on; `stated` is this SDK's reconstruction across two events, not an object the
      // stream ever actually sent, so passing it would be a claim about the wire that is not true.
      //
      // A stream the consumer walked away from never reaches `message_delta`, the only event
      // that states a final output count - so without this the text it did produce meters at the
      // placeholder `output_tokens: 1` from `message_start`. The customer read that text and
      // Anthropic billed for generating it, so one token is a hole rather than caution. What it
      // produced is estimated instead, and the measurement says so.
      const estimated = !hasStatedOutputTokens && chars > 0;
      const final = estimated
        ? restate(stated, { output_tokens: Math.max(1, Math.ceil(chars / CHARS_PER_OUTPUT_TOKEN)) })
        : stated;

      ingest({
        metrics: withComputedTotal(pickMetrics(final, ANTHROPIC_COMPONENT_METRICS), COMPUTED_TOTALS.anthropic),
        usage: fromFlatTokenUsage(final),
        ...(estimated ? { estimated: true as const } : {}),
      });
    }
  };
}

export const anthropicRecipe = {
  vendor: 'anthropic',
  metrics: ANTHROPIC_METRICS,
  totalTokensMetric: TOTAL_TOKENS,
  matches: (client) => hasMethod(client, ['messages', 'create']) && hasMethod(client, ['messages', 'stream']),
  methods: [
    {
      // `messages.stream()` reaches the wire through this same method, so gating it here covers
      // both call styles - and leaves `stream()` synchronous, which its callers rely on.
      path: ['messages', 'create'],
      // Both views of the call: what Anthropic called it, which is what gets reported, and the
      // normalized counters a mapper of your own would write against.
      extractUsage: (result) =>
        result?.usage
          ? {
              // Anthropic publishes no total of its own, so one is added up from the four it
              // does publish - which are disjoint, so the sum is the whole call.
              metrics: withComputedTotal(
                pickMetrics(result.usage, ANTHROPIC_COMPONENT_METRICS),
                COMPUTED_TOTALS.anthropic,
              ),
              usage: fromFlatTokenUsage(result.usage),
              // The block as it arrived, for an event to state in full - including the counters
              // this recipe does not name, which a meter can then read without an SDK release.
              raw: result.usage,
            }
          : undefined,
      attachStream: observeStream,
    },
  ],
} satisfies ClientRecipe<(typeof ANTHROPIC_METRICS)[number]>;

/**
 * A pre-call estimate based on the requested output ceiling. Opt-in: the default asks for a
 * single unit, because an estimate that overshoots denies calls the budget could have afforded,
 * and the ingest that follows corrects the balance anyway.
 */
export const estimateFromMaxTokens = (tokensPerUnit = 1) =>
  estimateUnits((params: any) => params?.max_tokens ?? 0, tokensPerUnit);

/** One of the metric names Anthropic reports. */
export type AnthropicMetric = MetricsOf<typeof anthropicRecipe>;

/** What a mapper reads off an Anthropic call: those names, each possibly absent. */
export type AnthropicMetrics = MetricsFor<typeof anthropicRecipe>;
