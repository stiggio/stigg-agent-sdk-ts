/**
 * The vendor response shapes these converters read.
 *
 * Typed structurally rather than against each vendor's SDK, so the same handful of functions cover
 * a direct client, a gateway response and an orchestrator callback - and adding a provider whose
 * response happens to match costs nothing.
 */
/**
 * A flat `usage` object whose cache counters sit BESIDE the input count rather than inside it.
 *
 * Named for the shape, not for a vendor, because more than one reports it: Anthropic's Messages
 * API and TypeSafe's System One, which carries only the first two. The distinction from the two
 * shapes below is the whole reason this is a separate reader - they spell the same two counters
 * the same way but count their cached tokens *within* the input total, so reading one as the
 * other double-counts in one direction or overstates in the other.
 */
export type FlatTokenUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** OpenAI-compatible `usage` - also what OpenRouter and most gateways return. */
export type OpenAILikeUsage = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  /** The vendor's own total. `prompt_tokens + completion_tokens`; cached tokens are inside the first. */
  total_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null;
};

/**
 * Databricks model serving `usage` - OpenAI's three counters, with Anthropic's spelling for cache.
 *
 * The mixed vocabulary is Databricks' own and is reported verbatim rather than normalised to one
 * side or the other. The first three come back from every serving endpoint; the last three are
 * Foundation Model API extensions and are absent on the external-model route, where the body is
 * whatever the upstream provider's counters normalise to.
 */
export type DatabricksLikeUsage = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  /** Databricks states its own total, so it is read rather than reassembled from the parts. */
  total_tokens?: number | null;
  /** Reasoning models only. */
  reasoning_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/**
 * The same block as above, as `@databricks/sdk-modelservingquery` hands it over.
 *
 * Databricks' own `ExternalModelUsageElement`. The **wire** is the snake_case one above - the
 * generated client's zod schema parses `prompt_tokens` and transforms it to `promptTokens` on the
 * way in, exactly as Mistral's generated client does to `UsageInfo`. So this is a second spelling
 * of one vendor's counters rather than a second set of counters, and it is read through
 * `DATABRICKS_QUERY_METRIC_NAME_MAP` so both spellings report under the wire's names.
 *
 * Three, not six: the cache pair and `reasoning_tokens` have no field on this type at all, so a
 * call made through the first-party client reports the three it can and nothing more. Absent, not
 * zero - and the reason the native surface's metric list is a subset of the recipe's.
 *
 * Written out rather than aliased to {@link MistralLikeUsage}, which it currently matches
 * field-for-field: these are two unrelated vendor contracts that happen to agree today, and
 * collapsing them would make a change on either side look like a change to both.
 */
export type DatabricksQueryLikeUsage = {
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** Databricks states its own total here too, so it is read rather than reassembled. */
  totalTokens?: number | null;
};

/** OpenAI's Responses API `usage` - the same counts as above under different names. */
export type ResponsesLikeUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** The vendor's own total, under the same name the Chat Completions shape uses. */
  total_tokens?: number | null;
  input_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null;
};

/**
 * Bedrock's Converse `usage`. Flat, camelCased, and **disjoint**.
 *
 * AWS is explicit that `inputTokens` counts only the tokens that were neither read from nor
 * written to the cache - "total input tokens = inputTokens + cacheReadInputTokens +
 * cacheWriteInputTokens" - so this shape behaves like Anthropic's and not like OpenAI's, where the
 * cached count nests inside the prompt count. Subtracting here would undercount the call.
 */
export type BedrockLikeUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
};

/** LangChain's `usage_metadata`, as carried on an AIMessage. */
export type LangChainLikeUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  input_token_details?: { cache_read?: number | null; cache_creation?: number | null } | null;
};

/**
 * Gemini's `usageMetadata`, which counts in its own names and overlaps in two directions at once.
 *
 * Both overlaps are quoted from the vendor's own field docs, because each one is a doubled or
 * halved bill if read the other way round:
 *
 * - `promptTokenCount` - "when `cached_content` is set, this **also includes** the number of
 *   tokens in the cached content", so `cachedContentTokenCount` is counted *inside* it, the way
 *   OpenAI nests `cached_tokens` inside `prompt_tokens`.
 * - `totalTokenCount` - "the sum of `prompt_token_count`, `candidates_token_count`,
 *   `tool_use_prompt_token_count`, and `thoughts_token_count`", so the last two sit *beside* the
 *   first two rather than within them. Thinking tokens in particular are billed as output and
 *   are **not** inside `candidatesTokenCount`: a reader that ignores them undercounts the output
 *   of every reasoning model this vendor sells.
 */
export type GeminiLikeUsage = {
  /**
   * The vendor's own total: `promptTokenCount + candidatesTokenCount + toolUsePromptTokenCount +
   * thoughtsTokenCount`, with the cached count already inside the first. Read, never recomputed.
   */
  totalTokenCount?: number | null;
  promptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  cachedContentTokenCount?: number | null;
  thoughtsTokenCount?: number | null;
  toolUsePromptTokenCount?: number | null;
};

/**
 * Mistral's `UsageInfo`, which counts the OpenAI three under camelCase names.
 *
 * The *wire* is snake_case - `prompt_tokens` and the rest - and the generated SDK renames it on
 * the way in, so what a recipe reads here and what it reports are deliberately different strings.
 * See `MISTRAL_METRIC_NAME_MAP` in `token-usage.ts` for the mapping and why it runs in that direction.
 *
 * Every counter is optional because the SDK declares them so: the inbound schema defaults each to
 * zero, which means an absent counter and a genuine zero arrive looking identical. Read them as
 * possibly-missing rather than trusting the declared `number`.
 */
export type MistralLikeUsage = {
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** The vendor's own total. Stated, so it is read rather than recomputed from the two above. */
  totalTokens?: number | null;
};

/**
 * Ollama's counters, which sit **flat on the response root** rather than inside a `usage` object.
 *
 * Every field is optional here even though `ollama`'s own `ChatResponse` declares
 * `prompt_eval_count: number` and `eval_count: number` as required. The server marks the whole
 * `Metrics` struct `omitempty`, so an intermediate stream chunk carries none of them at all and
 * the declared type is simply wrong about it. Trusting it substitutes zeroes for counters that
 * were never sent, which bills a real call at nothing.
 *
 * `prompt_eval_cached_count` exists on the wire and is deliberately **not** read: the SDK does not
 * declare it, and whether it sits inside `prompt_eval_count` or beside it is undocumented. A
 * counter whose overlap direction is unknown cannot be reported without risking a double count.
 */
export type OllamaLikeUsage = {
  prompt_eval_count?: number | null;
  eval_count?: number | null;
};
