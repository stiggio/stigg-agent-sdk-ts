/**
 * Internal surface - `@stigg/agent-sdk-js/internal`.
 *
 * Everything here is an implementation detail: the concrete engines behind the `GovernanceEngine`
 * seam, the pure functions that build a decision, config resolution, and the metric tables the
 * recipes are written against. It is exported because the tests and anyone extending the SDK need
 * to reach it, and reaching into `dist/` by path is worse than a named door.
 *
 * The contract is weaker than `index.ts`: these names can change in a minor release. Anything you
 * can do from the public barrel, do from there instead.
 */

// The engine seam's implementations. The interface itself is public - see `index.ts`.
export { createGovernanceEngine } from './engine/create-engine';
export type { CreatedEngine, EngineClientOptions } from './engine/create-engine';
export { CompositeEngine } from './engine/composite-engine';
export { NodeSdkEngine } from './engine/node-sdk-engine';
export { RestGovernanceEngine } from './engine/rest-governance-engine';
export { describeResolution } from './engine/engine';
export type { EngineOpSource } from './engine/engine';

// Engine result -> the structured refusal, as pure functions.
export { withDecisionText, policyDecision, remedyFor, toDecision, unenforcedDecision } from './engine/decision';
export type { DecisionContext } from './engine/decision';

// Config resolution: the target and the options, as the transport actually needs them.
export { resolveConfig } from './config';
export type { ResolvedConfig, EngineConfig } from './config';

// Error predicates that describe transport and enablement, not the caller's contract.
export { isTransportFailure, isMeterMismatchError, asEngineError } from './errors';

export { prefixed } from './logger';

// Context resolution: the split that keeps a gated call's own overhead to a property read.
export { noCustomer, overrideContext, resolveContext, isEnforced } from './core/context';
export type { ResolvedContext } from './core/context';
export { GovernanceSession } from './core/session';
export type { SessionDeps } from './core/session';

// What each vendor calls its counters, and where they are read from. A recipe is written against
// these; a consumer reads `recipe.metrics` instead.
export {
  ANTHROPIC_METRICS,
  GEMINI_METRICS,
  MISTRAL_METRICS,
  MISTRAL_METRIC_NAME_MAP,
  OLLAMA_METRICS,
  TYPESAFE_METRICS,
  GATEWAY_METRICS,
  DATABRICKS_METRICS,
  DATABRICKS_QUERY_METRIC_NAME_MAP,
  WORKERS_AI_METRICS,
  OPENAI_CHAT_METRICS,
  OPENAI_METRICS,
  OPENAI_RESPONSES_METRICS,
  METRIC_PATHS,
  metricName,
  metricNamesMatchPaths,
  pickMetrics,
  pickRenamedMetrics,
  addMetrics,
  addTokenUsage,
  fromFlatTokenUsage,
  fromGeminiUsage,
  fromLangChainUsage,
  fromMistralUsage,
  fromOllamaUsage,
  fromOpenAIUsage,
  fromResponsesUsage,
  observedMeasurement,
} from './bindings/shared/token-usage';
export type { ObservedVendor } from './bindings/shared/token-usage';

// The recipes `wrap` matches against when no recipe is named. Exposed so a caller - the examples'
// own offline seeding, above all - can enumerate what this package governs without keeping a
// second copy of the list that silently falls behind each time a vendor is added.
export { DEFAULT_RECIPES } from './stigg-agent-sdk';

export { meterStream } from './bindings/shared/meter-stream';
export { eventNameFor } from './bindings/client/core/types';
