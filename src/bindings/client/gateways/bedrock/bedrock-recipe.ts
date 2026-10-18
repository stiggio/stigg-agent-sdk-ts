/**
 * The Bedrock recipe - a gateway whose client is a command bus, and which never states a price.
 *
 * Bedrock is the third shape of "gateway" these bindings cover, and it differs from the other two
 * in both halves:
 *
 *   - **The client is not a method tree.** `openai-node` and `@openrouter/sdk` hang a method off a
 *     namespace - `chat.completions.create`, `chat.send` - and a recipe names that path. The AWS
 *     SDK has exactly one method, `send`, and the operation is the *argument*: `send(new
 *     ConverseCommand(...))`. So the gated path is `['send']` and the recipe has to look at what
 *     it was handed, because the same method also lists async invocations and fetches guardrails,
 *     and gating those would charge a budget for calls that spend nothing.
 *
 *   - **There is no cost on the response.** OpenRouter writes the credits it charged into the
 *     body; LiteLLM prices every call and puts dollars in a header. Bedrock reports tokens and
 *     stops - the price lives in the AWS bill, not in the response - so a run that wants to bill
 *     real spend cannot do it here, and one that wants to meter tokens is served exactly as well
 *     as anywhere else. `metrics` says so by having no `cost` in it, rather than by reporting a
 *     zero that a mapper would happily multiply.
 *
 * There is no served-model dimension either, and that absence is also a fact about Bedrock rather
 * than an omission: it does not route. You name a model id and that model answers, so there is no
 * drift between what was asked for and what served, and nothing for a dimension to tell you.
 */
import { meterStream } from '../../../shared/meter-stream';
import { BEDROCK_METRICS, BEDROCK_PATHS, fromBedrockUsage, pickMetrics } from '../../../shared/token-usage';
import type { Measurement } from '../../../../types';
import type { BedrockLikeUsage } from '../../../shared/types';
import type { BedrockRecipeOptions } from './types';
import type { ClientRecipe, MetricsFor, MetricsOf } from '../../core/types';

type BedrockMetric = (typeof BEDROCK_METRICS)[number];

/** The service a command belongs to, as the AWS SDK's own schema spells it. */
const BEDROCK_SERVICE = 'com.amazonaws.bedrockruntime';

/**
 * The two operations that run inference through the Converse API, and so the two worth gating.
 *
 * `InvokeModel` is inference too, and is deliberately not here: its request and response bodies
 * are the *upstream vendor's* - Anthropic's shape for a Claude model, Amazon's for a Nova one - so
 * one reader cannot meter them, and a recipe that gated the call while measuring nothing would
 * report every one of them as a metering failure. An application on `InvokeModel` wants a recipe
 * per upstream; an application on Converse gets one that works for every model Bedrock serves.
 */
const METERED_OPERATIONS = new Set(['Converse', 'ConverseStream']);

/**
 * Which AWS operation a command object is for.
 *
 * Read off the SDK's own serialization schema - `[version, service, operation, http]` - rather
 * than from the class name, because a class name is the first thing a bundler rewrites and this
 * decides whether a call is gated at all. The constructor name is the fallback for an SDK version
 * that shapes the schema differently, where being approximately right beats refusing to gate.
 */
function operationOf(command: unknown): { service?: string; operation?: string } {
  const schema = (command as { schema?: unknown })?.schema;
  if (Array.isArray(schema) && typeof schema[1] === 'string' && typeof schema[2] === 'string') {
    return { service: schema[1], operation: schema[2] };
  }
  const name = (command as { constructor?: { name?: string } })?.constructor?.name;
  return typeof name === 'string' && name.endsWith('Command') ? { operation: name.slice(0, -'Command'.length) } : {};
}

/** True for a call this recipe must leave alone - anything that is not Converse inference. */
function isNotMetered(command: unknown): boolean {
  const { service, operation } = operationOf(command);
  if (service !== undefined && service !== BEDROCK_SERVICE) return true;
  return !operation || !METERED_OPERATIONS.has(operation);
}

/** Tokens from one Converse response, under Bedrock's own names. */
function measure(usage: BedrockLikeUsage | undefined, requestId: string | undefined): Measurement | undefined {
  if (!usage) return undefined;
  return {
    metrics: pickMetrics(usage, BEDROCK_PATHS),
    usage: fromBedrockUsage(usage),
    raw: usage as Record<string, unknown>,
    // AWS's own request id, which is stable across the SDK's retries - and the SDK retries by
    // default, so a local counter would bill the same answer more than once.
    idempotencyKey: requestId,
  };
}

/**
 * One recipe for every model Bedrock serves.
 *
 * Converse normalizes Anthropic, Nova, Llama and the rest to one request and one response, so the
 * usage block never changes shape - which is the whole reason this can be a single recipe rather
 * than one per upstream vendor.
 */
export function bedrockRecipe(options: BedrockRecipeOptions = {}): ClientRecipe<BedrockMetric> {
  const estimate = options.estimate ?? (() => 1);

  return {
    vendor: 'bedrock',
    metrics: BEDROCK_METRICS,
    totalTokensMetric: 'totalTokens',
    // The client's own configuration names the service, which is what separates this from every
    // other AWS v3 client - they all have `send`, and none of the rest are inference. Data rather
    // than a class name, for the same reason `operationOf` prefers the schema.
    matches: (client) => {
      const config = (client as { config?: Record<string, unknown> })?.config;
      if (!config || typeof (client as { send?: unknown })?.send !== 'function') return false;
      return config.defaultSigningName === 'bedrock' && typeof config.serviceId === 'string';
    },
    methods: [
      {
        path: ['send'],
        estimate,
        // The operation rides in the argument, so this is where a non-inference call is let
        // through ungated rather than charged for.
        passthrough: (command) => isNotMetered(command),
        // A streamed Converse resolves to `{ stream, $metadata }` - the usage is not on the
        // response at all, so this returns nothing and `attachStream` takes it from there.
        extractUsage: (result: any) =>
          result?.stream ? undefined : measure(result?.usage, result?.$metadata?.requestId),
        /**
         * ConverseStream puts its usage in a `metadata` event at the end, so the stream has to be
         * run to the end to know what the call cost - the same bargain every streaming binding
         * makes.
         *
         * The iterable is `result.stream`, not `result`: AWS hands back an envelope with the
         * stream hanging off it, where the other SDKs hand back the stream itself. Metering the
         * envelope would patch an object nobody iterates and report nothing, with no error.
         */
        attachStream: (result: any, ingest: (measurement: Measurement) => void) => {
          const requestId = result?.$metadata?.requestId;
          let usage: BedrockLikeUsage | undefined;
          meterStream(
            result?.stream,
            (event) => {
              if (event?.metadata?.usage) usage = event.metadata.usage;
            },
            () => {
              const measurement = measure(usage, requestId);
              if (measurement) ingest(measurement);
            },
          );
        },
      },
    ],
  };
}

/** One of the metric names Bedrock reports. */
export type BedrockMetricName = MetricsOf<ReturnType<typeof bedrockRecipe>>;

/** What a mapper reads off a Bedrock call: those names, each possibly absent. */
export type BedrockMetrics = MetricsFor<ReturnType<typeof bedrockRecipe>>;
