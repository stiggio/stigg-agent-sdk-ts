/**
 * The OpenRouter recipe - a gateway you call rather than one you operate.
 *
 * OpenRouter speaks the OpenAI wire format, so `openAIRecipe` already fits it by shape. What that
 * recipe cannot express is the two things a gateway knows and a client-side wrapper cannot: the
 * credits it actually charged (`usage.cost`) and which model actually served after fallback
 * routing (`response.model`). Both are on the response, and both are dropped by a projection down
 * to four token counters - so this recipe bills the real number and attributes it to the model
 * that earned it.
 *
 * It is registered by default, because reading a response is not a pricing decision. It reports
 * what the gateway stated - the same token counters `openAIRecipe` would, plus `cost` and the
 * model that served - and what any of that is worth is the run's mapper to decide:
 * `weightedMetrics(openrouterRecipe(), 'credits', { cost: 1 })` bills the money and ignores the
 * tokens. The SDK must not infer that from a base URL, which is why it is not inferred at all.
 *
 * The other topology - a proxy you run yourself, fronting services that may not even be Node -
 * has no client object to wrap and stays with the ingest-only gateway binding.
 */
import { meterStream } from '../../../shared/meter-stream';
import { openAIRecipe, openAISurface } from '../../providers/openai/openai-recipe';
import {
  GATEWAY_METRICS,
  METRIC_PATHS,
  TOTAL_TOKENS,
  fromOpenAIUsage,
  fromResponsesUsage,
  pickMetrics,
} from '../../../shared/token-usage';
import { hasMethod } from '../../core/registry';
import { baseUrlOf, matchesHost } from '../../../shared/base-url';
import { fromSdkChatUsage, fromSdkResponsesUsage } from './sdk-usage';
import type { Measurement, TokenUsage, Metrics } from '../../../../types';
import type { OpenRouterRecipeOptions, OpenRouterUsage } from './types';
import type { ClientRecipe, MethodRecipe, MetricsFor, MetricsOf } from '../../core/types';

/** Both OpenAI surfaces plus the price the gateway itself charged. */
type GatewayMetric = (typeof GATEWAY_METRICS)[number];

/** Float noise: 0.00108 * 1e6 is 1080.0000000000002, and ceil would bill the extra unit. */
const toUnits = (cost: number, unitsPerCredit: number): number =>
  Math.max(1, Math.ceil(Number((cost * unitsPerCredit).toPrecision(12))));

/**
 * Tokens and cost, from one response.
 *
 * A gateway states both, they are different features, and reporting both is what lets one meter
 * the tokens and the other the money.
 *
 * OpenRouter writes the money in the body, which is why a streamed call can still be billed on it:
 * the usage object arrives on the last chunk, cost included, provided the request asked for usage
 * (`stream_options.include_usage`, or `streamOptions.includeUsage` through the first-party SDK).
 * A caller who does not ask gets a stream that states nothing, and the key is then absent rather
 * than substituted - billing a guess is the one thing a cost-truth adapter must not do. LiteLLM is
 * the gateway that genuinely cannot state it, because its cost rides a header that went out before
 * the first token existed.
 */
function measure(
  usage: OpenRouterUsage | undefined,
  parse: (usage: any) => TokenUsage,
  keys: readonly string[],
  model: string | undefined,
  id: string | undefined,
  options: Required<OpenRouterRecipeOptions>,
  /**
   * What the vendor itself stated, when that is not the object being read.
   *
   * The first-party SDK hands back camelCased counters, which are translated to the wire's own
   * spelling before anything meters them - but an event should carry what OpenRouter said, not
   * what this file rewrote it to, so the original rides along unchanged.
   */
  stated?: Record<string, unknown>,
): Measurement | undefined {
  if (!usage) return undefined;

  const cost = usage.cost;
  const metrics: Metrics = pickMetrics(usage, keys);
  // `cost` is the gateway's own field name, so it obeys the same rule as every other metric.
  if (typeof cost === 'number' && cost > 0) metrics.cost = toUnits(cost, options.unitsPerCredit);

  return {
    metrics,
    usage: parse(usage),
    // What the gateway stated, before `cost` was scaled into whole units - an event can carry the
    // fraction as it was, which is the honest number and the one that reconciles with the bill.
    raw: stated ?? (usage as Record<string, unknown>),
    // The gateway's own request id: stable across its retries, which a local step counter is not.
    dimensions: model ? { [options.modelDimension]: model } : undefined,
    idempotencyKey: id,
  };
}

/**
 * The first-party SDK's two surfaces, built the same way the OpenAI-shaped ones are.
 *
 * `@openrouter/sdk` is generated from the OpenAPI spec, so it shares nothing with `openai-node`
 * but the service behind it: the method is `chat.send` rather than `chat.completions.create`, the
 * request nests under `chatRequest`, and the counters come back camelCased. Only the last of
 * those reaches a meter, and `sdk-usage.ts` undoes it so both clients report the same metric
 * names for the same call.
 *
 * `responses.send` is here for the reason the comment on `methods` gives: a surface this recipe
 * declines to declare is not metered by something else, it is simply ungated - and a client this
 * recipe claims to govern must not have a billable method left open on it.
 */
function sdkSurfaces(resolved: Required<OpenRouterRecipeOptions>): MethodRecipe[] {
  const surfaces = [
    { path: ['chat', 'send'] as const, read: fromSdkChatUsage, parse: fromOpenAIUsage, keys: METRIC_PATHS.openaiChat },
    {
      path: ['responses', 'send'] as const,
      read: fromSdkResponsesUsage,
      parse: fromResponsesUsage,
      keys: METRIC_PATHS.openaiResponses,
    },
  ];

  return surfaces.map(({ path, read, parse, keys }) => {
    /** The vendor's own object translated, with the original kept for the event to carry. */
    const measureSdk = (usage: unknown, model: string | undefined, id: string | undefined) =>
      measure(read(usage as any), parse, keys, model, id, resolved, usage as Record<string, unknown>);

    return {
      path: [...path],
      estimate: resolved.estimate,
      extractUsage: (result: any) => measureSdk(result?.usage, result?.model, result?.id),
      // A streamed call resolves to an `EventStream`, which is a `ReadableStream` subclass: async
      // iterable, and with no `next`/`return` of its own for `meterStream` to patch. So the
      // metered path is `for await`, which is how the SDK documents consuming one. A caller who
      // takes `getReader()` instead bypasses the wrapper - the same hole every streaming binding
      // has, and the reason the non-streamed surface is the one the example leans on.
      attachStream: (stream: any, ingest: (measurement: Measurement) => void) => {
        let usage: unknown;
        let model: string | undefined;
        let id: string | undefined;
        meterStream(
          stream,
          (chunk) => {
            // Usage arrives once, on the last chunk; `model` and `id` ride every one of them.
            if (chunk?.usage) usage = chunk.usage;
            if (chunk?.model) model = chunk.model;
            if (chunk?.id) id = chunk.id;
          },
          () => {
            const measurement = measureSdk(usage, model, id);
            if (measurement) ingest(measurement);
          },
        );
      },
    };
  });
}

/**
 * One recipe covers every upstream. OpenRouter normalizes Anthropic, OpenAI and the rest to the
 * same wire shape, so the response never changes form - `model` is just a field saying who served.
 *
 * It also covers both ways of reaching OpenRouter from Node: the OpenAI SDK pointed at the
 * gateway's base URL, and OpenRouter's own `@openrouter/sdk`. Those are different objects with
 * different method names reporting the same call, and a recipe that governed only the first would
 * meter nothing at all for an application that took OpenRouter's own documented advice.
 */
export function openrouterRecipe(options: OpenRouterRecipeOptions = {}): ClientRecipe<GatewayMetric> {
  const resolved: Required<OpenRouterRecipeOptions> = {
    estimate: options.estimate ?? (() => 1),
    unitsPerCredit: positiveDenomination(options.unitsPerCredit, 'unitsPerCredit'),
    modelDimension: options.modelDimension ?? 'model',
  };

  return {
    metrics: GATEWAY_METRICS,
    // The OpenAI shape it speaks, so the OpenAI name for the total.
    totalTokensMetric: TOTAL_TOKENS,
    vendor: 'openrouter',
    // Two clients, recognised two different ways - see each guard for why they cannot share one.
    // The OpenAI-shaped client is OpenAI-shaped, so only its base URL says which gateway it talks
    // to; OpenRouter's own SDK is unmistakable by shape and may legitimately point anywhere.
    matches: (client) => (openAIRecipe.matches!(client) && isOpenRouter(client)) || isOpenRouterSdk(client),
    // Built from the OpenAI recipe's own surfaces. A gateway speaks that API, so the methods worth
    // governing are the same ones - and because this recipe is matched ahead of it, any surface it
    // failed to declare would be left ungated rather than falling through.
    methods: [
      ...openAIRecipe.methods.map((base): MethodRecipe => {
        const { parse, keys, streamed } = openAISurface(base.path);
        return {
          path: base.path,
          estimate: resolved.estimate,
          extractUsage: (result: any) => measure(result?.usage, parse, keys, result?.model, result?.id, resolved),
          // Usage arrives once, at the end; `model` and `id` ride every chunk.
          attachStream: (stream: any, ingest: (measurement: Measurement) => void) => {
            let usage: OpenRouterUsage | undefined;
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
                const measurement = measure(usage, parse, keys, model, id, resolved);
                if (measurement) ingest(measurement);
              },
            );
          },
        };
      }),
      ...sdkSurfaces(resolved),
    ],
  };
}

/**
 * `baseURL` is a public field on the OpenAI client. Shape cannot answer this and a wrong guess
 * silently changes the unit of account, so the check is narrow on purpose: an OpenRouter-compatible
 * endpoint on another host takes the recipe explicitly, via `wrap(client, run, { recipe })`.
 */
function isOpenRouter(client: unknown): boolean {
  const baseUrl = baseUrlOf(client);
  // The host, not a substring of the URL: `openrouter.ai.example.com` is somebody else's domain,
  // and claiming it would meter an unrelated client as a gateway.
  return baseUrl !== undefined && matchesHost(baseUrl, 'openrouter.ai');
}

/**
 * Whether this is OpenRouter's own SDK client, which carries no base URL to recognise it by.
 *
 * The OpenAI-shaped client is identified by where it points, because its shape says only
 * "OpenAI-compatible" and half the industry is. This one is the opposite: `chat.send` is not a
 * shape anyone else has, and the namespaces beside it - `credits`, `generations`, the gateway's
 * own billing and routing APIs - are OpenRouter's product rather than an API style someone could
 * implement by accident. So shape is the whole discriminator here, and there is no URL to check:
 * an application may point the SDK at a proxy, which is still OpenRouter's SDK and still speaks
 * its format.
 *
 * `in` rather than a property read, because every namespace on that client is a lazy getter that
 * constructs a sub-client - and merely asking whether a recipe fits must not build three of them.
 */
function isOpenRouterSdk(client: unknown): boolean {
  if (!client || typeof client !== 'object') return false;
  if (!hasMethod(client, ['chat', 'send']) && !hasMethod(client, ['responses', 'send'])) return false;
  return 'credits' in client && 'generations' in client;
}

/** One of the metric names OpenRouter reports. */
export type OpenRouterMetric = MetricsOf<ReturnType<typeof openrouterRecipe>>;

/** What a mapper reads off an OpenRouter call: those names, each possibly absent. */
export type OpenRouterMetrics = MetricsFor<ReturnType<typeof openrouterRecipe>>;

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
