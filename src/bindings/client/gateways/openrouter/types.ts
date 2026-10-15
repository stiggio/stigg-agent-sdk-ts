import type { OpenAILikeUsage } from '../../../shared/types';

/** OpenRouter extends the OpenAI usage object with the credits it actually charged. */
export type OpenRouterUsage = OpenAILikeUsage & {
  cost?: number | null;
  /**
   * The Responses-API counters, for the one client that can report either shape.
   *
   * `@openrouter/sdk` reaches both of OpenRouter's surfaces, and they count the same tokens under
   * different names - so the object a reader hands back may carry one set or the other. Optional
   * on both sides rather than a union, because the reader that produced it already knows which
   * surface it read, and the metric list it is picked with is the surface's own.
   */
  input_tokens?: number | null;
  output_tokens?: number | null;
  input_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null;
};

/**
 * What `@openrouter/sdk` hands back for `chat.send`, in the SDK's own spelling.
 *
 * Declared structurally rather than imported from `@openrouter/sdk`: the package is a devDependency
 * of the examples, and a recipe that imported its types would make it a dependency of the SDK
 * itself - every consumer installing a client they may not use. Only the counters are named here,
 * which is all a meter reads; see `sdk-usage.ts` for why the spelling is undone rather than kept.
 */
export type OpenRouterSdkChatUsage = {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  cost?: number | null;
  promptTokensDetails?: { cachedTokens?: number | null; cacheWriteTokens?: number | null } | null;
  completionTokensDetails?: { reasoningTokens?: number | null } | null;
};

/** The same, for `responses.send` - the Responses API's names, camelCased the same way. */
export type OpenRouterSdkResponsesUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cost?: number | null;
  inputTokensDetails?: { cachedTokens?: number | null; cacheWriteTokens?: number | null } | null;
  outputTokensDetails?: { reasoningTokens?: number | null } | null;
};

export type OpenRouterRecipeOptions = {
  /**
   * How much to ask permission for before the call.
   *
   * The default asks for 1 - "is there any budget left at all?" - and lets the ingest afterwards
   * settle the balance. Billing tokens, the gap that leaves is about one call's worth of units.
   * Billing `cost` it is not: a call priced in micro-credits is thousands of units, so a run with
   * one unit left passes the gate and then spends far past it.
   *
   * Nothing here can price a call the gateway has not priced yet, so closing that gap needs a
   * ceiling only the caller knows - `max_tokens` against a rate they are willing to assume. Give
   * one and the gate asks for it; leave it and the overshoot is bounded by a single call, which
   * is the trade the default makes everywhere else.
   */
  estimate?: (params: any) => number;
  /**
   * Units per credit. OpenRouter charges fractional credits and Stigg ingests whole units, so the
   * meter has to be denominated in something small enough not to round every call up to 1. The
   * default is micro-credits; set it to match however the Stigg currency is defined.
   */
  unitsPerCredit?: number;
  /** Dimension the served model is attributed to, so routing drift is visible in Stigg. */
  modelDimension?: string;
};
