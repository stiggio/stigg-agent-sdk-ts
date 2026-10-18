/**
 * OpenRouter's first-party SDK counts the same tokens under different names.
 *
 * `@openrouter/sdk` is generated from the OpenAPI spec and camelCases every field on the way in,
 * so a response that arrived as `prompt_tokens` reaches the caller as `promptTokens`. Nothing
 * about the call changed - same gateway, same wire format, same bill - only the spelling the
 * parse handed back.
 *
 * That matters more than it looks. A metric name is a **feature id**: it is what the mapper
 * prices and what Stigg meters. If the same gateway reported `prompt_tokens` through one client
 * and `promptTokens` through another, one customer's calls would land on two different features
 * depending on which SDK the application happened to import - and the second of them exists in
 * nobody's catalog, so those calls would report to a feature that cannot be billed.
 *
 * So the spelling is undone here rather than carried through: each reader below returns the
 * OpenAI-shaped object the wire actually carried, and everything downstream - `pickMetrics`,
 * `fromOpenAIUsage`, the metric names in `GATEWAY_METRICS` - is the code that already serves the
 * OpenAI-shaped client, reading the names it already knows. The vendor's own object is still what
 * rides along as `raw`, so an event carries what OpenRouter said, spelled the way OpenRouter
 * spelled it.
 */
import type { OpenRouterSdkChatUsage, OpenRouterSdkResponsesUsage, OpenRouterUsage } from './types';

/** Drops what the SDK models as nullable, so an absent counter stays absent rather than null. */
const num = (value: number | null | undefined): number | undefined => (typeof value === 'number' ? value : undefined);

/**
 * `{ key: value }` when there is a value, and nothing at all when there is not.
 *
 * Absent and zero are different: `pickMetrics` skips a counter that is not a positive number, and
 * a nested detail object that exists with nothing in it reads as a vendor that reported a cache
 * and found none - which is not the same as a vendor that reported no cache at all.
 */
const maybe = <T>(key: string, value: T | undefined): Record<string, T> =>
  value === undefined ? {} : { [key]: value };

/** Nothing, rather than an empty object, when a whole detail group was absent. */
const group = (fields: Record<string, unknown>): Record<string, unknown> | undefined =>
  Object.keys(fields).length > 0 ? fields : undefined;

/**
 * `chat.send` - the Chat Completions shape, camelCased.
 *
 * `cost` keeps its name across both spellings, because it is OpenRouter's own field rather than
 * one inherited from OpenAI, and the generator had no snake_case original to convert.
 */
export function fromSdkChatUsage(usage: OpenRouterSdkChatUsage | null | undefined): OpenRouterUsage | undefined {
  if (!usage) return undefined;
  const promptDetails = group({
    ...maybe('cached_tokens', num(usage.promptTokensDetails?.cachedTokens)),
    ...maybe('cache_write_tokens', num(usage.promptTokensDetails?.cacheWriteTokens)),
  });
  const completionDetails = group({
    ...maybe('reasoning_tokens', num(usage.completionTokensDetails?.reasoningTokens)),
  });
  return {
    ...maybe('prompt_tokens', num(usage.promptTokens)),
    ...maybe('completion_tokens', num(usage.completionTokens)),
    ...maybe('total_tokens', num(usage.totalTokens)),
    ...maybe('cost', num(usage.cost)),
    ...maybe('prompt_tokens_details', promptDetails),
    ...maybe('completion_tokens_details', completionDetails),
  };
}

/**
 * `responses.send` - the Responses API shape, camelCased.
 *
 * The same tokens again under the third set of names this SDK can hand back: `inputTokens` rather
 * than `promptTokens`, with the cache detail one level along. Read with the chat reader it would
 * find none of them and meter the call at zero, which is why the two surfaces get a reader each.
 */
export function fromSdkResponsesUsage(
  usage: OpenRouterSdkResponsesUsage | null | undefined,
): OpenRouterUsage | undefined {
  if (!usage) return undefined;
  const inputDetails = group({
    ...maybe('cached_tokens', num(usage.inputTokensDetails?.cachedTokens)),
    ...maybe('cache_write_tokens', num(usage.inputTokensDetails?.cacheWriteTokens)),
  });
  return {
    ...maybe('input_tokens', num(usage.inputTokens)),
    ...maybe('output_tokens', num(usage.outputTokens)),
    ...maybe('total_tokens', num(usage.totalTokens)),
    ...maybe('cost', num(usage.cost)),
    ...maybe('input_tokens_details', inputDetails),
  };
}
