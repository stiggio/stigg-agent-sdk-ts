/**
 * The LiteLLM recipe - a gateway you call, whose cost arrives beside the body rather than in it.
 *
 * LiteLLM Proxy speaks the OpenAI wire format, so `openAIRecipe` already fits it by shape. What
 * that recipe cannot express is the same pair `openrouterRecipe` exists for: the money actually
 * spent, and which deployment actually served after routing. LiteLLM knows both - it prices every
 * call itself - but it reports the cost in a response header, `x-litellm-response-cost`, and never
 * in the body. A body-only extractor cannot see it, which is why `extractUsage` takes the response.
 *
 * That placement has a consequence worth stating plainly, because it is the protocol and not a bug:
 * headers go on the wire before the model has generated anything, so a STREAMED call can never
 * carry a cost. Tokens survive it fine - LiteLLM honours `stream_options: {include_usage: true}`
 * and puts `usage` on the final chunk - so a stream falls back to the token path via
 * `onMissingCost`. Non-streaming bills real spend; streaming bills tokens. The streaming branch
 * below still checks for the header, so the day LiteLLM can send one, this recipe already reads it.
 *
 * All of that applies to a run that bills `cost` - `weightedMetrics(litellmRecipe({ baseUrl }),
 * 'credits', { cost: 1 })`. Bill the token counters instead and the split above stops mattering:
 * one denomination whether or not the call streamed. Either way the recipe is worth naming for a
 * self-hosted proxy, to give it the base URL its matcher cannot guess.
 */
import { meterStream } from '../../../shared/meter-stream';
import { baseUrlOf, withinBaseUrl } from '../../../shared/base-url';
import { openAIRecipe, openAISurface } from '../../providers/openai/openai-recipe';
import { GATEWAY_METRICS, TOTAL_TOKENS, pickMetrics } from '../../../shared/token-usage';
import type { Measurement, TokenUsage, Metrics } from '../../../../types';
import type { LiteLLMRecipeOptions } from './types';
import type { OpenAILikeUsage } from '../../../shared/types';
import type { ClientRecipe, MetricsFor, MetricsOf, MeteredResponse } from '../../core/types';

/** Both OpenAI surfaces plus the price the gateway itself charged. */
type GatewayMetric = (typeof GATEWAY_METRICS)[number];

/** The cost LiteLLM charged for this call, in USD. Non-streaming responses only. */
const COST_HEADER = 'x-litellm-response-cost';
/** The proxy's own id for the call: stable across its retries, which a local step counter is not. */
const CALL_ID_HEADER = 'x-litellm-call-id';

/** Float noise: 0.00108 * 1e6 is 1080.0000000000002, and ceil would bill the extra unit. */
const toUnits = (cost: number, unitsPerDollar: number): number =>
  Math.max(1, Math.ceil(Number((cost * unitsPerDollar).toPrecision(12))));

/** The header is a string on the wire, and absent on every streamed response. */
function costOf(response: MeteredResponse | undefined): number | undefined {
  const raw = response?.headers?.get(COST_HEADER);
  if (raw == null || raw === '') return undefined;
  const cost = Number(raw);
  return Number.isFinite(cost) ? cost : undefined;
}

function measure(
  usage: OpenAILikeUsage | undefined,
  parse: (usage: any) => TokenUsage,
  keys: readonly string[],
  model: string | undefined,
  id: string | undefined,
  response: MeteredResponse | undefined,
  options: Required<Omit<LiteLLMRecipeOptions, 'baseUrl'>>,
): Measurement | undefined {
  if (!usage) return undefined;

  // LiteLLM normalizes every upstream (Anthropic, Bedrock, whatever) to the OpenAI wire format,
  // so the token names are OpenAI's. The cost is the proxy's own, and it rides beside them rather
  // than instead of them - a streamed call simply has no cost to report, because the header goes
  // out before the first token exists.
  const cost = costOf(response);
  const metrics: Metrics = pickMetrics(usage, keys);
  if (cost !== undefined && cost > 0) metrics.cost = toUnits(cost, options.unitsPerDollar);

  return {
    metrics,
    usage: parse(usage),
    // What the proxy stated, before `cost` was scaled into whole units - an event can carry the
    // fraction as it was, which is the honest number and the one that reconciles with the bill.
    //
    // The cost is folded in rather than assumed present: LiteLLM reports it in a header, not in
    // the body, so unlike OpenRouter the response alone carries no trace of it. Taking the body
    // as-is left `metrics.cost` rounded up to whole units as the only record of a price the
    // proxy had stated exactly.
    raw: cost === undefined ? (usage as Record<string, unknown>) : { ...(usage as Record<string, unknown>), cost },
    dimensions: model ? { [options.modelDimension]: model } : undefined,
    // The proxy's own call id wins over the completion id: it is what its spend logs are keyed on,
    // so a replay lines up on both sides of the boundary.
    idempotencyKey: response?.headers?.get(CALL_ID_HEADER) ?? id,
  };
}

/**
 * One recipe covers every upstream. LiteLLM normalizes Anthropic, OpenAI, Bedrock and the rest to
 * the same wire shape, so the response never changes form - `model` is just a field saying which
 * deployment served, which is what makes it worth putting on the ingest as a dimension: the client
 * asked for a model group, and the group is free to resolve to something else.
 */
export function litellmRecipe(options: LiteLLMRecipeOptions = {}): ClientRecipe<GatewayMetric> {
  const resolved: Required<Omit<LiteLLMRecipeOptions, 'baseUrl'>> = {
    estimate: options.estimate ?? (() => 1),
    unitsPerDollar: positiveDenomination(options.unitsPerDollar, 'unitsPerDollar'),
    modelDimension: options.modelDimension ?? 'model',
  };

  return {
    metrics: GATEWAY_METRICS,
    // The OpenAI shape it speaks, so the OpenAI name for the total.
    totalTokensMetric: TOTAL_TOKENS,
    vendor: 'litellm',
    // Shape alone cannot separate this from any other OpenAI-compatible client, so the base URL
    // is the discriminator - it is the one thing that says which gateway is on the other end.
    matches: (client) => openAIRecipe.matches!(client) && isLiteLLM(client, options.baseUrl),
    // Built from the OpenAI recipe's own surfaces, for the same reason as the OpenRouter one: this
    // recipe is matched ahead of it, so a surface it failed to declare would go ungated.
    methods: openAIRecipe.methods.map((base) => {
      const { parse, keys, streamed } = openAISurface(base.path);
      return {
        path: base.path,
        estimate: resolved.estimate,
        extractUsage: (result: any, response?: MeteredResponse) =>
          measure(result?.usage, parse, keys, result?.model, result?.id, response, resolved),
        // Usage arrives once, at the end; `model` and `id` ride every chunk. The response is
        // threaded through even though a real stream's headers carry no cost today - the branch
        // costs nothing and is the whole difference between this being wrong later and right.
        attachStream: (stream: any, ingest: (measurement: Measurement) => void, response?: MeteredResponse) => {
          let usage: OpenAILikeUsage | undefined;
          let model: string | undefined;
          let id: string | undefined;
          meterStream(
            stream,
            (chunk) => {
              const seen = streamed(chunk);
              if (seen) usage = seen;
              if (chunk?.model) model = chunk.model;
              if (chunk?.id) id = chunk.id;
            },
            () => {
              const measurement = measure(usage, parse, keys, model, id, response, resolved);
              if (measurement) ingest(measurement);
            },
          );
        },
      };
    }),
  };
}

/**
 * `baseURL` is a public field on the OpenAI client. Shape cannot answer this and a wrong guess
 * silently changes the unit of account, so the check is narrow on purpose.
 *
 * A LiteLLM proxy is self-hosted, so there is no `openrouter.ai` to look for: the configured
 * `baseUrl` is the only reliable answer, and the hostname guess below is a convenience for the
 * deployments that do say so. A proxy on a host that mentions neither takes the recipe explicitly,
 * via `wrap(client, run, { recipe })`.
 */
function isLiteLLM(client: unknown, baseUrl?: string): boolean {
  const clientBase = baseUrlOf(client);
  if (clientBase === undefined) return false;
  // A prefix match on the raw string lets `.../v1` claim `.../v10`, which is a different
  // deployment with a different price list. `withinBaseUrl` compares the endpoint, one path
  // segment at a time.
  if (baseUrl) return withinBaseUrl(baseUrl, clientBase);
  return clientBase.toLowerCase().includes('litellm');
}

/** One of the metric names LiteLLM reports. */
export type LiteLLMMetric = MetricsOf<ReturnType<typeof litellmRecipe>>;

/** What a mapper reads off a LiteLLM call: those names, each possibly absent. */
export type LiteLLMMetrics = MetricsFor<ReturnType<typeof litellmRecipe>>;

/**
 * The denomination, refused when it cannot divide a price.
 *
 * `NaN` and `Infinity` make `toUnits` produce a value the ingest rejects a call later, and zero or
 * a negative clamps every cost to the floor of 1 - a bill that looks plausible and is not. Both
 * are configuration mistakes worth naming where they were made.
 */
function positiveDenomination(value: number | undefined, name: string): number {
  if (value === undefined) return 1_000_000;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number - got ${value}, which prices every call wrongly.`);
  }
  return value;
}
