/**
 * Public surface.
 *
 * Importing this file pulls in no vendor package. The recipes below are exported from here, but
 * each one is duck-typed against the shape a vendor returns rather than written against its SDK,
 * so `@anthropic-ai/sdk`, `openai` and the rest stay out of the dependency tree entirely.
 *
 * What is exported here is the vocabulary, the client, and the seams worth extending: a recipe,
 * a metrics mapper, a `GovernanceEngine`. The implementations behind those seams - the concrete
 * engines, decision construction, config resolution, the metric tables - live in
 * `@stigg/agent-sdk-js/internal`, under a weaker compatibility promise.
 */
export { StiggAgentSDK } from './stigg-agent-sdk';
// The context, which is the whole of the configuration surface: given at `wrap` as the default
// for a client, and again inside any single call's params to override it.
export type { StiggContext } from './core/context';
export type { SessionSummary, HookContext, IngestOptions, SessionHooks } from './core/session';
// What an event carries off the vendor's own usage object, for anyone building the payload by hand.
export { RAW_PREFIX, flattenRaw } from './core/dimensions';

export type { CacheOptions, ErrorContext, NodeSdkClient, StiggAgentSDKOptions } from './config';

export { describeDecision, remedyMessage } from './decision-text';
export { GOVERNANCE_HEADERS, parseGovernanceHeaders } from './headers';
export type { GovernanceHeaders, ParsedGovernanceHeaders } from './headers';
export { consoleLogger, noopLogger } from './logger';
export type { Logger } from './logger';

export {
  EngineError,
  AccessDeniedError,
  GovernanceNotEnabledError,
  isEngineError,
  isAccessDenied,
  isGovernanceNotEnabled,
  looksLikeGovernanceNotEnabled,
} from './errors';

// The engine seam. The interface and the shapes it trades in are public - `test/fake-engine.ts`
// implements this, and so can a caller. The engines that ship are in `./internal`.
export type {
  EngineCapabilities,
  EngineChainNode,
  EngineCheckParams,
  EngineCheckResult,
  EngineReportParams,
  EngineReportResult,
  EngineResolution,
  EntityInput,
  EventIngest,
  EntityPlacement,
  GovernanceEngine,
} from './engine/engine';

export {
  unitsPerTokens,
  vendorMetrics,
  emptyTokenUsage,
  entitlementId,
  entitlementKind,
  entitlementRef,
  toMeasurement,
} from './types';
export type {
  AgentBudget,
  AgentOptions,
  AgentScope,
  ClientGovernance,
  CheckErrorAction,
  ClientOptions,
  DecisionSource,
  DeregisterInput,
  Entitlement,
  AccessDecision,
  Remedy,
  WrappedClient,
  IngestContext,
  IngestMode,
  IngestResult,
  Measurement,
  RegisterInput,
  GatedSurface,
  // Which property paths a wrapped client accepts a context on, given what it looks like. This is
  // what `wrap` computes for a client it detected, so a caller writing the governed type by hand -
  // the examples do - can name the same thing instead of assuming the shipped default covers it.
  ChatOf,
  CallContext,
  TokenUsage,
  Metrics,
  MetricsMapper,
} from './types';

// Bindings: the generic halves only.
export { wrapClient } from './bindings/client/core/wrap-client';
export { createClientRegistry, hasMethod } from './bindings/client/core/registry';
export type {
  ClientRecipe,
  ClientRegistry,
  MethodRecipe,
  MetricsFor,
  MetricsOf,
  MeteredResponse,
} from './bindings/client/core/types';
// The type of `IngestContext.vendor`, which is public and so its vocabulary has to be. Naming the
// shape a proxy observed is the alternative to sniffing it, and a caller cannot name what it
// cannot import.
export type { ObservedVendor } from './bindings/shared/token-usage';
export { anthropicRecipe, estimateFromMaxTokens } from './bindings/client/providers/anthropic/anthropic-recipe';
export type { AnthropicMetric, AnthropicMetrics } from './bindings/client/providers/anthropic/anthropic-recipe';
export { openAIRecipe } from './bindings/client/providers/openai/openai-recipe';
export type { OpenAIMetric, OpenAIMetrics } from './bindings/client/providers/openai/openai-recipe';
// Two recipes for one vendor, because a `GoogleGenAI` client and a `Chat` it created share no
// method - and a chat holds the *unwrapped* models module privately, so wrapping the client alone
// would leave every conversation ungoverned. Wrap the chat as well: `stigg.wrap(ai.chats.create(…))`.
export {
  geminiRecipe,
  geminiChatRecipe,
  estimateFromMaxOutputTokens,
} from './bindings/client/providers/gemini/gemini-recipe';
export type { GeminiMetric, GeminiMetrics } from './bindings/client/providers/gemini/gemini-recipe';
// A default: it reports the same token counters as every other vendor, and adds what only a
// gateway knows - the model that served, the request id, and the `cost` it charged. Billing that
// cost instead of the tokens is a mapper away, and never inferred from a base URL:
// `weightedMetrics(openrouterRecipe(), 'credits', { cost: 1 })`.
export { openrouterRecipe } from './bindings/client/gateways/openrouter/openrouter-recipe';
export type { OpenRouterMetric, OpenRouterMetrics } from './bindings/client/gateways/openrouter/openrouter-recipe';
export type { OpenRouterRecipeOptions } from './bindings/client/gateways/openrouter/types';
// A default too, on the same terms. Its `cost` comes from `x-litellm-response-cost`, which a
// streamed call cannot carry because headers precede the body - so a run billing cost gets
// nothing from a stream. Name it at `wrap(client, { recipe })` to give it your proxy's base URL.
export { litellmRecipe } from './bindings/client/gateways/litellm/litellm-recipe';
export type { LiteLLMMetric, LiteLLMMetrics } from './bindings/client/gateways/litellm/litellm-recipe';
export type { LiteLLMRecipeOptions } from './bindings/client/gateways/litellm/types';
// Built in, and matched by hostname ahead of `openAIRecipe` so its traffic reports as `groq.*`.
// A provider that speaks the OpenAI wire format: same counters, its own vendor name, and one
// surface, because `chat.completions.create` is the only generation endpoint Groq serves.
export { groqRecipe } from './bindings/client/providers/groq/groq-recipe';
export type { GroqMetric, GroqMetrics } from './bindings/client/providers/groq/groq-recipe';
// Built in. Eight generation surfaces over one usage block, reported under the *wire's* names
// rather than the camelCase its generated SDK renames them to - see the recipe for why, and for
// the two call styles it cannot reach (the standalone `funcs/` form, and a stream read by hand).
export { mistralRecipe } from './bindings/client/providers/mistral/mistral-recipe';
export type { MistralMetric, MistralMetrics } from './bindings/client/providers/mistral/mistral-recipe';
// Built in. A self-hosted engine rather than a vendor that bills: `chat` and `generate` are flat
// methods on the client, and the counters they report measure the customer's own capacity, since
// there is no invoice behind them. See the recipe for the surfaces it declines and why.
export { ollamaRecipe } from './bindings/client/providers/ollama/ollama-recipe';
export type { OllamaMetric, OllamaMetrics } from './bindings/client/providers/ollama/ollama-recipe';
// A default too, and the gateway that states no price. Bedrock's client is a command bus rather
// than a method tree, so the recipe gates `send` and reads the command to tell inference from the
// rest of the API; it reports Bedrock's own token counters and no `cost`, because there is none on
// the response to report. See the recipe for what that means for a run that wanted to bill spend.
// Databricks model serving, as two recipes for two payers over one wire. `databricksRecipe` is a
// default, matched on the workspace URL: Foundation Model API traffic, billed to your Databricks
// account in DBUs. `databricksExternalRecipe` is the same wire reaching an endpoint configured
// with your own upstream key, where the upstream provider invoices - it is opt-in because the two
// are indistinguishable from the client and naming it is an assertion about your own workspace,
// not something the SDK detected. Neither reports a `cost`: Databricks states no price on any
// response, on either route. See the recipe header for what a wrong assertion costs.
export { databricksRecipe, databricksExternalRecipe } from './bindings/client/gateways/databricks/databricks-recipe';
export type { DatabricksMetricName, DatabricksMetrics } from './bindings/client/gateways/databricks/databricks-recipe';
export type { DatabricksRecipeOptions } from './bindings/client/gateways/databricks/types';
export { bedrockRecipe } from './bindings/client/gateways/bedrock/bedrock-recipe';
export type { BedrockMetricName, BedrockMetrics } from './bindings/client/gateways/bedrock/bedrock-recipe';
export type { BedrockRecipeOptions } from './bindings/client/gateways/bedrock/types';
// Built in as well. One method, no stream, and two counters - see the recipe for why a
// question-answering API has neither a cache counter nor a cost to report.
// Cloudflare Workers AI - a provider, not a gateway: Cloudflare runs these models on its own GPUs
// and invoices them, and `@cf/<author>/…` names who made the weights rather than who bills. A
// default, matched on `api.cloudflare.com`, covering both the OpenAI-compatible route and the
// `cloudflare` package's own `ai.run`. It reports tokens and no `cost` - Cloudflare bills in
// Neurons and publishes none of them on any response. See the recipe for the streamed `ai.run`
// limitation.
export { cloudflareRecipe } from './bindings/client/gateways/cloudflare/cloudflare-recipe';
export type { CloudflareMetricName, CloudflareMetrics } from './bindings/client/gateways/cloudflare/cloudflare-recipe';
export type { CloudflareRecipeOptions } from './bindings/client/gateways/cloudflare/types';
export { typesafeRecipe, estimateFromState } from './bindings/client/providers/typesafe/typesafe-recipe';
export type { TypeSafeMetric, TypeSafeMetrics } from './bindings/client/providers/typesafe/typesafe-recipe';
export { weightedMetrics } from './bindings/shared/weighted-metrics';
export type { WeightedMetricsOptions } from './bindings/shared/weighted-metrics';

export type { ProxyIngestInput } from './bindings/proxy';
export { normalizedMetrics, normalizeUsage } from './bindings/shared/token-usage';
