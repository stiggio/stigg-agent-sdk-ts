export type LiteLLMRecipeOptions = {
  /**
   * How much to ask permission for before the call, in whatever unit `meter` bills.
   *
   * The default asks for 1 - "is there any budget left at all?" - and lets the ingest afterwards
   * settle the balance. Billing tokens, the gap that leaves is about one call's worth of units.
   * Billing `cost` it is not: a call priced in micro-dollars is thousands of units, so a run with
   * one unit left passes the gate and then spends far past it.
   *
   * Nothing here can price a call the gateway has not priced yet, so closing that gap needs a
   * ceiling only the caller knows - `max_tokens` against a rate they are willing to assume. Give
   * one and the gate asks for it; leave it and the overshoot is bounded by a single call, which
   * is the trade the default makes everywhere else.
   */
  estimate?: (params: any) => number;
  /**
   * Units per dollar. LiteLLM reports fractional USD and Stigg ingests whole units, so the meter
   * has to be denominated in something small enough not to round every call up to 1. The default
   * is micro-dollars; set it to match however the Stigg currency is defined.
   */
  unitsPerDollar?: number;
  /** Dimension the served model is attributed to, so routing drift is visible in Stigg. */
  modelDimension?: string;
  /**
   * The proxy this recipe is for. A LiteLLM deployment is self-hosted, so unlike a public gateway
   * there is no fixed host to recognise - without this, `matches` can only fall back to a narrow
   * guess at the hostname. Give it the same base URL the client was built with.
   */
  baseUrl?: string;
};
