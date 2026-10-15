/**
 * A price per metric, as the mapper a run reports through.
 *
 * Writing one by hand is a reduce over a record and three details that are easy to miss: Stigg
 * rejects fractions, a turn that measured nothing must report nothing rather than a zero, and a
 * counter the response omitted is absent rather than zero. This gets all three right once.
 */
import type { MetricsMapper, Metrics } from '../../types';
import type { ClientRecipe } from '../client/core/types';

export type WeightedMetricsOptions = {
  /**
   * How many weighted units make one of `target`. Defaults to 1, so a weight reads as the price
   * of one unit of that metric: `output_tokens: 0.5` is half a credit per output token.
   *
   * Set it when the weights are easier to write per thousand than per one - `per: 1000` with
   * `output_tokens: 5` prices five credits per thousand output tokens.
   */
  per?: number;
};

/**
 * Prices what a vendor reported into one metric of your own.
 *
 * The weights are keyed to the recipe's own metric names, so a typo does not compile. Naming one
 * is optional: a metric with no weight is free, and a table that prices nothing meters nothing.
 *
 * ```ts
 * // Half a credit per output token, a whole one per input token, cache reads free.
 * metrics: weightedMetrics(anthropicRecipe, 'data_credit', {
 *   input_tokens: 1,
 *   output_tokens: 0.5,
 * })
 * ```
 *
 * Prices what the vendor actually said, under its own names. For one vocabulary across several
 * vendors, `normalizedMetrics` reports the four neutral counters instead.
 */
export function weightedMetrics<M extends string>(
  recipe: ClientRecipe<M>,
  target: string,
  weights: Partial<Record<M, number>>,
  options: WeightedMetricsOptions = {},
): MetricsMapper {
  const per = options.per && options.per > 0 ? options.per : 1;
  // The one thing this cannot report its way out of: an empty target is a feature id of `''`,
  // which nothing downstream rejects - the value is validated, the key is not - so the turn
  // reports to a feature that does not exist and the budget never moves.
  if (!target.trim()) {
    throw new Error('weightedMetrics needs a target to price into - an empty one reports to no feature.');
  }
  // Deduplicated, because the reducer walks the declaration: a recipe listing a name twice would
  // charge for it twice, which is the one direction a meter must not be wrong in.
  const priced = [...new Set(recipe.metrics)];

  return ({ metrics }) => {
    if (!metrics) return {};
    // An unpriced metric is free rather than an error, so a table names only what it charges for.
    const weighted = priced.reduce((sum, name) => sum + (metrics[name] ?? 0) * (weights[name] ?? 0), 0);
    // Nothing measured is not the same as nothing owed: report no metric at all, which the run
    // counts as the no-op ingest it is rather than as a report of zero.
    if (weighted <= 0) return {};
    // Reported as it came out of the weights. A credit currency takes fractions, so a turn worth
    // a fifth of a unit costs a fifth - rounding here would be this SDK's arithmetic on someone
    // else's price. A feature is the exception, since `POST /api/v1/usage` takes integers: choose
    // `per` so the weights divide, or round in a mapper of your own.
    return { [target]: weighted / per } as Metrics;
  };
}
