/**
 * What this package promises, and what it only lends out.
 *
 * The split between `src/index.ts` and `src/internal.ts` is two lists describing one decision, and
 * two lists drift. Once published these are a compatibility contract: a symbol that slips into the
 * public barrel is one nobody can take back, and one that silently falls out breaks a caller who
 * had every right to it. So the contract is asserted here rather than reviewed by eye.
 *
 * Runtime exports only - a type-only export has nothing to inspect at runtime, and the typecheck
 * over `src`, `test` and `examples` is already the guard for those.
 *
 * The lists grow as the stacked PRs add bindings. When a change here is deliberate, update the
 * list: that edit is the point, making a wider public surface something somebody chose, in a diff.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as publicSurface from '../src';
import * as internalSurface from '../src/internal';
import * as langchainSurface from '../src/integrations/langchain';

/** Everything a consumer may `import { … } from '@stigg/agent-sdk-js'`. */
const PUBLIC = [
  'EngineError',
  'GOVERNANCE_HEADERS',
  'AccessDeniedError',
  'GovernanceNotEnabledError',
  'RAW_PREFIX',
  'StiggAgentSDK',
  'anthropicRecipe',
  'consoleLogger',
  'createClientRegistry',
  'databricksRecipe',
  'databricksExternalRecipe',
  'unitsPerTokens',
  'describeDecision',
  'emptyTokenUsage',
  'entitlementId',
  'entitlementKind',
  'entitlementRef',
  'estimateFromMaxOutputTokens',
  'estimateFromMaxTokens',
  'estimateFromState',
  'flattenRaw',
  'geminiChatRecipe',
  'geminiRecipe',
  'groqRecipe',
  'hasMethod',
  'isEngineError',
  'isAccessDenied',
  'isGovernanceNotEnabled',
  'bedrockRecipe',
  'litellmRecipe',
  'looksLikeGovernanceNotEnabled',
  'mistralRecipe',
  'noopLogger',
  'normalizeUsage',
  'normalizedMetrics',
  'STIGG_TRACER_NAME',
  'ollamaRecipe',
  'openAIRecipe',
  'openrouterRecipe',
  'parseGovernanceHeaders',
  'remedyMessage',
  'toMeasurement',
  'typesafeRecipe',
  'vendorMetrics',
  'weightedMetrics',
  'wrapClient',
  'cloudflareRecipe',
];

/** Reachable as `@stigg/agent-sdk-js/internal`, under a weaker promise. */
const INTERNAL = [
  'ANTHROPIC_METRICS',
  'CompositeEngine',
  'DEFAULT_RECIPES',
  'GEMINI_METRICS',
  'MISTRAL_METRICS',
  'MISTRAL_METRIC_NAME_MAP',
  'OLLAMA_METRICS',
  'GovernanceSession',
  'DATABRICKS_METRICS',
  'DATABRICKS_QUERY_METRIC_NAME_MAP',
  'WORKERS_AI_METRICS',
  'GATEWAY_METRICS',
  'METRIC_PATHS',
  'NodeSdkEngine',
  'OPENAI_CHAT_METRICS',
  'OPENAI_METRICS',
  'OPENAI_RESPONSES_METRICS',
  'RestGovernanceEngine',
  'TYPESAFE_METRICS',
  'addMetrics',
  'addTokenUsage',
  'asEngineError',
  'createGovernanceEngine',
  'describeResolution',
  'eventNameFor',
  'fromFlatTokenUsage',
  'fromGeminiUsage',
  'fromLangChainUsage',
  'fromMistralUsage',
  'fromOllamaUsage',
  'fromOpenAIUsage',
  'fromResponsesUsage',
  'isMeterMismatchError',
  'isTransportFailure',
  'meterStream',
  'metricName',
  'metricNamesMatchPaths',
  'observedMeasurement',
  'pickMetrics',
  'pickRenamedMetrics',
  'policyDecision',
  'prefixed',
  'remedyFor',
  'resolveConfig',
  'resolveContext',
  'overrideContext',
  'noCustomer',
  'isEnforced',
  'toDecision',
  'unenforcedDecision',
  'withDecisionText',
];

describe('the published surface', () => {
  it('exports exactly what the public barrel promises', () => {
    assert.deepEqual(Object.keys(publicSurface).sort(), [...PUBLIC].sort());
  });

  it('exports exactly what the internal entry point lends out', () => {
    assert.deepEqual(Object.keys(internalSurface).sort(), [...INTERNAL].sort());
  });

  // `@stigg/agent-sdk-js/langchain`: the handler, and what a catch block needs beside it. The
  // errors are the main entry's own objects re-exported, so `instanceof` agrees across the two.
  it('exports exactly what the LangChain entry point promises', () => {
    assert.deepEqual(Object.keys(langchainSurface).sort(), [
      'AccessDeniedError',
      'CUSTOMER_METADATA_KEY',
      'StiggLangChainCallbackHandler',
      'isAccessDenied',
    ]);
    assert.equal(langchainSurface.AccessDeniedError, publicSurface.AccessDeniedError);
  });

  it('keeps the two entry points disjoint', () => {
    const both = PUBLIC.filter((name) => INTERNAL.includes(name));
    assert.deepEqual(both, [], 'a symbol exported from both is a name with two compatibility promises');
  });

  /**
   * `describe` is the global in node:test, Vitest, Jest and Mocha. Exported from a barrel, a
   * consumer's `import * as sdk` in a test file shadows their own runner.
   */
  it('exports nothing that collides with a test runner global', () => {
    const reserved = ['describe', 'it', 'test', 'before', 'after', 'beforeEach', 'afterEach'];
    const clashes = Object.keys(publicSurface).filter((name) => reserved.includes(name));
    assert.deepEqual(clashes, []);
  });
});

/**
 * What the vocabulary is called, asserted rather than reviewed by eye.
 *
 * The public types are named for what a reader does with them. `Governance` survives only where it
 * names the platform capability this SDK consumes - the wire headers and the account-state error -
 * because those are the thing that has to be enabled on the account, and calling them anything
 * else would hide that.
 */
describe('the published vocabulary', () => {
  it('carries no type named after the platform capability', () => {
    // The four that were: a type named for governance teaches an internal capability to someone
    // whose problem is charging for agent usage. If one comes back, it comes back deliberately.
    const governanceNamed = Object.keys(publicSurface).filter(
      (name) => name.startsWith('Governance') || name.startsWith('Governed'),
    );
    assert.deepEqual(governanceNamed, ['GovernanceNotEnabledError']);
  });

  it('keeps `Governance` where it names the platform feature rather than this SDK', () => {
    assert.ok(PUBLIC.includes('GOVERNANCE_HEADERS'));
    assert.ok(PUBLIC.includes('GovernanceNotEnabledError'));
  });
});
