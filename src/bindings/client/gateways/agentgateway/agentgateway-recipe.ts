/**
 * The agentgateway recipe - the open-source AI gateway (and the builds on it: Solo.io's enterprise
 * edition, Gloo AI Gateway), a gateway you call that states no price.
 *
 * Its OpenAI routes fit `openAIRecipe` by shape and its Anthropic route fits `anthropicRecipe`, so
 * the recipe has to justify itself, and it does on two counts:
 *
 *  - **A vendor name of its own.** Without this, traffic through the gateway meters as `openai.*`
 *    or `anthropic.*` - indistinguishable from a direct call, so no meter and no per-provider
 *    budget can tell the gateway's traffic apart. Worse on the Anthropic wire: `anthropicRecipe`
 *    has no base-URL guard, so an `Anthropic` client pointed here would be claimed by it and
 *    reported as direct Anthropic traffic.
 *  - **The model that actually served.** The gateway can rewrite the model a request named - an
 *    alias, a provider prefix, a failover priority group - and the response body names the one
 *    that answered. The bare recipes drop it; this one attributes it.
 *
 * One vendor across every wire, because the gateway is one deployment whichever client reached it,
 * and the wire is already in the event name (`agentgateway.chat.completions.create` against
 * `agentgateway.messages.create`). The gateway translates where it needs to, so each route reports
 * in the vocabulary of the wire it answered on - OpenAI's names on the OpenAI routes, Anthropic's
 * on Messages - and `metrics` is the union, which is what `metrics` is defined to be.
 *
 * No `cost`, and that is the defining fact rather than an oversight. The gateway is self-hosted and
 * states no price on any response; whatever the upstream charged is invoiced by the upstream, out
 * of band. Never declare a metric the platform cannot report.
 *
 * Self-hosted, so there is no public hostname to recognise. The base URL handed to
 * `agentgatewayRecipe({ baseUrl })` is the reliable discriminator; without one the matcher falls
 * back to a guess on the hostname - see {@link isAgentgateway} for what it claims.
 *
 * The same surfaces govern raw HTTP too: `stigg.wrapFetch` routes a request by its path to the
 * method here that names it, so a `fetch` to the gateway is metered by exactly these readers.
 */
import { meterStream } from '../../../shared/meter-stream';
import { AGENTGATEWAY_METRICS, TOTAL_TOKENS } from '../../../shared/token-usage';
import { baseUrlOf, hostOf, withinBaseUrl } from '../../../shared/base-url';
import { openAIRecipe } from '../../providers/openai/openai-recipe';
import { anthropicRecipe } from '../../providers/anthropic/anthropic-recipe';
import { toMeasurement, type Measurement } from '../../../../types';
import type { AgentgatewayRecipeOptions } from './types';
import type { ClientRecipe, MethodRecipe, MeteredResponse, MetricsFor, MetricsOf } from '../../core/types';

type AgentgatewayMetric = (typeof AGENTGATEWAY_METRICS)[number];

/**
 * The name that identifies the gateway in an ordinary deployment: the Kubernetes service or
 * namespace (`agentgateway-proxy.agentgateway-system.svc`) or a hostname an operator chose to say
 * so with (`agentgateway.acme.internal`). A dot-separated label matches when it *is* this name or
 * *starts with* it and a hyphen - which is how a default install names both its service and its
 * namespace. Never a substring or a later segment: `myagentgateway` and `my-agentgateway` are
 * somebody else's host.
 *
 * Only this one. `solo` and `gloo` are words a customer picks for their own resources
 * (`solo-prod.openai.azure.com`, `litellm.gloo-system.svc`), and this recipe sits ahead of
 * LiteLLM, Databricks and OpenAI - so guessing on them would move those calls to `agentgateway.*`
 * and out of the meters counting them. Solo's and Gloo's builds name the gateway by `baseUrl`.
 */
const HOST_LABEL = 'agentgateway';

/** What only the gateway knows, folded onto whatever the wire's own reader produced. */
function withGatewayFacts(measured: Measurement, result: any, modelDimension: string): Measurement {
  const served = typeof result?.model === 'string' ? result.model : undefined;
  return {
    ...measured,
    dimensions: served
      ? { ...(measured.dimensions as Record<string, string> | undefined), [modelDimension]: served }
      : measured.dimensions,
    // The upstream's completion id, carried back through the gateway. It is what a replayed
    // response repeats, which a local step counter cannot be.
    idempotencyKey: measured.idempotencyKey ?? (typeof result?.id === 'string' ? result.id : undefined),
  };
}

export function agentgatewayRecipe(options: AgentgatewayRecipeOptions = {}): ClientRecipe<AgentgatewayMetric> {
  const estimate = options.estimate ?? (() => 1);
  const modelDimension = options.modelDimension ?? 'model';

  /**
   * One wire's surface, wrapped.
   *
   * The wire recipes' own extractors are reused rather than reimplemented: the gateway answers in
   * that wire's shape, so that wire's reader is by definition the right one - and Anthropic's
   * streamed usage in particular accumulates across two event types, which is not logic worth
   * having a second copy of.
   */
  const surfaceOf = (base: MethodRecipe): MethodRecipe => ({
    // Spread first so anything the base declares and this wrapper does not know about - like
    // `contextArg` - survives being wrapped.
    ...base,
    estimate,
    extractUsage: (result: any, response?: MeteredResponse) => {
      const measured = base.extractUsage?.(result, response);
      return measured === undefined ? undefined : withGatewayFacts(toMeasurement(measured), result, modelDimension);
    },
    attachStream: base.attachStream
      ? (stream: any, ingest: (measurement: Measurement) => void, response?: MeteredResponse) => {
          // A second tap, purely for attribution: the wire readers carry out counters and nothing
          // else. Each wire states the model in its own envelope - Anthropic on
          // `message_start.message`, the Responses API on `response`, Chat Completions at the chunk
          // root. `meterStream` captures what it patches before patching, so two observers each
          // see every chunk exactly once.
          let seen: { model?: string; id?: string } = {};
          meterStream(
            stream,
            (chunk: any) => {
              const envelope = chunk?.message ?? chunk?.response ?? chunk;
              if (envelope?.model) seen = { ...seen, model: envelope.model };
              if (envelope?.id) seen = { ...seen, id: envelope.id };
            },
            () => {},
          );

          base.attachStream!(
            stream,
            (measurement) => ingest(withGatewayFacts(toMeasurement(measurement), seen, modelDimension)),
            response,
          );
        }
      : undefined,
  });

  return {
    vendor: 'agentgateway',
    metrics: AGENTGATEWAY_METRICS,
    // Every wire here spells its total `total_tokens` - Anthropic's is computed from its disjoint
    // counters by the reader this reuses, OpenAI's is stated.
    totalTokensMetric: TOTAL_TOKENS,
    // The base URL decides, because shape cannot: an `OpenAI` client and an `Anthropic` client
    // pointed at the gateway look exactly like direct clients.
    matches: (client) =>
      isAgentgateway(client, options.baseUrl) && (openAIRecipe.matches(client) || anthropicRecipe.matches(client)),
    // Every wire it serves. A surface left undeclared here is not metered by something else - it
    // is ungated, because this recipe is matched ahead of both of the ones that would have claimed
    // it.
    methods: [...openAIRecipe.methods.map(surfaceOf), ...anthropicRecipe.methods.map(surfaceOf)],
  };
}

/**
 * `baseURL` is a public field on both clients. Shape cannot answer this and a wrong guess silently
 * changes which vendor an event names, so the check is narrow on purpose.
 *
 * Given a `baseUrl`, the endpoint is compared one path segment at a time, so `.../v1` cannot claim
 * `.../v10`. Without one, the hostname is split on dots and claimed only when a label is, or starts
 * with, `agentgateway-` - the name a default install puts in its service and namespace.
 * An unrelated endpoint whose hostname carries one of those labels is claimed too and reports
 * under `agentgateway.*`; name `recipe: openAIRecipe` (or `anthropicRecipe`) at `wrap` to settle it.
 */
function isAgentgateway(client: unknown, baseUrl?: string): boolean {
  const clientBase = baseUrlOf(client);
  if (clientBase === undefined) return false;
  if (baseUrl) return withinBaseUrl(baseUrl, clientBase);
  return hostOf(clientBase)
    .split('.')
    .some((label) => label.split('-')[0] === HOST_LABEL);
}

/** One of the metric names agentgateway can report, across every wire it serves. */
export type AgentgatewayMetricName = MetricsOf<ReturnType<typeof agentgatewayRecipe>>;

/** What a mapper reads off a call through agentgateway: those names, each possibly absent. */
export type AgentgatewayMetrics = MetricsFor<ReturnType<typeof agentgatewayRecipe>>;
