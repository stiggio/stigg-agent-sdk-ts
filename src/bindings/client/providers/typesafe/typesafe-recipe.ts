/**
 * The TypeSafe recipe - the smallest one here, and worth reading for what it leaves out.
 *
 * TypeSafe is not chat-shaped. One `systemOne` call carries a document and a whole set of typed
 * questions and comes back, once, with every answer and a single usage record. So there is one
 * method to gate, no second call style reaching the wire through it, and no `attachStream`:
 * nothing streams, so there is no later report to accumulate.
 *
 * The metrics are the two the API reports. That was checked against the wire, not inferred from
 * the SDK's types - the response body carries `model`, `answers` and `usage`, and `usage` carries
 * `input_tokens` and `output_tokens` and nothing else. No cache counters, because there is no
 * prompt to cache across turns; no `cost`, because TypeSafe is not a gateway reselling someone
 * else's model.
 */
import {
  COMPUTED_TOTALS,
  TOTAL_TOKENS,
  METRIC_PATHS,
  TYPESAFE_METRICS,
  fromFlatTokenUsage,
  pickMetrics,
  withComputedTotal,
} from '../../../shared/token-usage';
import { estimateUnits, requirePositiveRate } from '../../../shared/estimate';
import { hasMethod } from '../../core/registry';
import { ollamaRecipe } from '../ollama/ollama-recipe';
import type { ClientRecipe, MetricsFor, MetricsOf } from '../../core/types';

export const typesafeRecipe = {
  vendor: 'typesafe',
  metrics: TYPESAFE_METRICS,
  totalTokensMetric: TOTAL_TOKENS,
  /**
   * `systemOne` is the whole surface - unlike Anthropic there is no second call style to prove,
   * because it is the only thing that reaches the wire carrying usage.
   *
   * The exclusion names the one client that collides: `ollama` ships a `systemone` method whose
   * request and response are the *same shape* as this one, so casing would otherwise be the only
   * thing between them. Excluding that client by its own three-marker guard - rather than
   * demanding extra methods here - keeps this recipe claiming anything that exposes `systemOne`,
   * a thin adapter or a test double included, while making the two guards mutually exclusive
   * whatever order a registry consults them in.
   */
  matches: (client) => hasMethod(client, ['systemOne']) && !ollamaRecipe.matches(client),
  methods: [
    {
      path: ['systemOne'],
      // Both views of the call: TypeSafe's own names, which is what gets reported, and the
      // normalized counters. The flat reader covers this shape exactly - the two cache counters
      // it also looks for are absent here, which reads as zero, which is true.
      extractUsage: (result) =>
        result?.usage
          ? {
              // No total is published here either, so one is added up from the two counters
              // that are - disjoint, so the sum is the whole call.
              metrics: withComputedTotal(pickMetrics(result.usage, METRIC_PATHS.typesafe), COMPUTED_TOTALS.typesafe),
              usage: fromFlatTokenUsage(result.usage),
              // Kept whole for an event to carry, the same as every other recipe.
              raw: result.usage,
            }
          : undefined,
    },
  ],
} satisfies ClientRecipe<(typeof TYPESAFE_METRICS)[number]>;

/**
 * A pre-call estimate from the size of the document being asked about.
 *
 * Opt-in, like every estimate here, but note what makes this one different from a chat vendor's:
 * there is no `max_tokens` to read, and the output is not where the money goes. A batch of
 * questions against one document runs input-heavy by a wide margin - the document is sent once
 * and each question adds almost nothing - so the state is the only part worth estimating, and
 * estimating it is unusually reliable because it is already in hand before the call.
 *
 * `charsPerToken` is the usual rough divisor for English prose. Deliberately a floor: an estimate
 * that overshoots denies calls the budget could have afforded, and the ingest that follows
 * corrects the balance either way.
 */
export const estimateFromState = (tokensPerUnit = 1, charsPerToken = 4) => {
  // Its own divisor, refused on the same terms as the rate: a zero here divides inside the
  // reading, which `requestedUnits` would clamp back to one unit just as quietly.
  requirePositiveRate('charsPerToken', charsPerToken);
  return estimateUnits((params: any) => {
    const state = params?.state;
    // Nothing to measure lands on the floor of one unit, like a call that named no ceiling.
    if (state == null) return 0;
    const characters = typeof state === 'string' ? state.length : JSON.stringify(state).length;
    return characters / charsPerToken;
  }, tokensPerUnit);
};

/** One of the metric names TypeSafe reports. */
export type TypeSafeMetric = MetricsOf<typeof typesafeRecipe>;

/** What a mapper reads off a TypeSafe call: those names, each possibly absent. */
export type TypeSafeMetrics = MetricsFor<typeof typesafeRecipe>;
