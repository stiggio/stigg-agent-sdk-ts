/**
 * Turning a vendor's own request parameters into "how many units should this call ask for".
 *
 * Every vendor states a ceiling for the answer it is about to generate, under its own name -
 * `max_tokens`, `config.maxOutputTokens`, a document whose length stands in for one - and what
 * happens to that number afterwards is identical: divide by the rate, round up, never ask for
 * less than one. Only the reading differs, so only the reading stays with the recipe.
 *
 * All of these are opt-in. The default asks for a single unit, because an estimate that
 * overshoots denies calls the budget could have afforded, and the ingest that follows corrects
 * the balance anyway.
 */

/**
 * Refuses a rate that cannot divide, where it is configured rather than where it is used.
 *
 * Zero divides to `Infinity` and a negative to less than one; `requestedUnits` in the wrapper
 * clamps both back to asking for a single unit, so a misconfigured rate would gate on nothing and
 * never say so. Failing here makes that a startup error instead of a quiet one, per call, forever.
 */
export function requirePositiveRate(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number - got ${value}, which estimates every call wrongly.`);
  }
}

/**
 * The shared half: a rate, a reading, and the arithmetic between them.
 *
 * `read` returns the vendor's ceiling in tokens, or 0 where the call named none - which lands on
 * the same floor of one unit rather than needing a case of its own.
 */
export function estimateUnits(read: (params: any) => number, tokensPerUnit: number): (params: any) => number {
  requirePositiveRate('tokensPerUnit', tokensPerUnit);
  return (params: any): number => Math.max(1, Math.ceil(read(params) / tokensPerUnit));
}
