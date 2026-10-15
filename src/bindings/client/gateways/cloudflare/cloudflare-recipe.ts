/**
 * The Cloudflare recipe - one vendor over two products.
 *
 * **Workers AI** runs open-weight models on Cloudflare's GPUs, reached as `client.ai.run(...)` or
 * as an `OpenAI` client at `api.cloudflare.com`. **AI Gateway** fronts somebody else's provider at
 * `gateway.ai.cloudflare.com/v1/<account>/<gateway>/<provider>` and forwards that provider's body
 * back untouched. One recipe, because one payer: Cloudflare invoices either way, and the vendor is
 * whoever bills. Two vendor names would split one account across two meters.
 *
 * Filed under gateways although Workers AI alone looks provider-shaped - the same shape
 * `groqRecipe` is argued from. That is deliberate: the category follows how a platform is sold,
 * not how it is built. See the positioning section of the `govern-new-platform` skill.
 *
 * Two things follow from the gateway forwarding bodies verbatim, and both surprise people:
 *
 *  - **Two counter vocabularies under one vendor.** `/openai` reports `prompt_tokens` and
 *    `/anthropic` reports `input_tokens`, so a meter watching one misses the other. Nothing is
 *    renamed - a counter has to reconcile against its own upstream's dashboard - so price both,
 *    or use `normalizedMetrics`. `metrics` is the union, which is what `metrics` is defined to be.
 *  - **A cache hit is a free call carrying a full `usage` block.** See {@link isCacheHit}: metered
 *    generically, every hit bills as real usage, and caching is this gateway's headline feature.
 *
 * Neither product states a price anywhere, so no `cost` metric is declared and `cf-aig-log-id`
 * rides as a dimension for out-of-band reconciliation.
 */
import { meterStream } from '../../../shared/meter-stream';
import {
  CLOUDFLARE_METRICS,
  METRIC_PATHS,
  WORKERS_AI_PATHS,
  TOTAL_TOKENS,
  fromOpenAIUsage,
  pickMetrics,
} from '../../../shared/token-usage';
import { baseUrlOf, matchesHost, withinBaseUrl } from '../../../shared/base-url';
import { hasMethod } from '../../core/registry';
import { openAIRecipe, openAISurface } from '../../providers/openai/openai-recipe';
import { anthropicRecipe } from '../../providers/anthropic/anthropic-recipe';
import { toMeasurement, type Measurement } from '../../../../types';
import type { OpenAILikeUsage } from '../../../shared/types';
import type { CloudflareRecipeOptions } from './types';
import type { ClientRecipe, MethodRecipe, MeteredResponse, MetricsFor, MetricsOf } from '../../core/types';

type CloudflareMetric = (typeof CLOUDFLARE_METRICS)[number];

/** Workers AI, both of its routes. */
const CLOUDFLARE_API_HOST = 'api.cloudflare.com';
/** AI Gateway's public endpoint. A custom domain needs `options.baseUrl` instead. */
const GATEWAY_HOST = 'gateway.ai.cloudflare.com';

/** `HIT` means the upstream was never called, so nobody was billed for this. */
const CACHE_STATUS_HEADER = 'cf-aig-cache-status';
/** The gateway's own log record, where its (estimated) cost figure can be read afterwards. */
const LOG_ID_HEADER = 'cf-aig-log-id';
/** Auto Router's choice, which can differ from the model the request named. */
const ROUTED_MODEL_HEADER = 'cf-aig-routed-model';
/** Which fallback step served: `0` is the first provider, anything higher means one failed over. */
const STEP_HEADER = 'cf-aig-step';
/** The gateway's own request id, stable across its retries - unlike a local step counter. */
const REQUEST_ID_HEADER = 'cf-aig-request-id';

const headerOf = (response: MeteredResponse | undefined, name: string): string | undefined => {
  const raw = response?.headers?.get(name);
  return raw == null || raw === '' ? undefined : raw;
};

/**
 * Whether the gateway served this from its cache.
 *
 * Readable on a streamed response as well as a buffered one, unlike a header-borne *cost*: whether
 * the cache will answer is known before any token is produced, so this header is on the wire in
 * time either way. That is the difference between this and `x-litellm-response-cost`, and it is why
 * the streaming branch below checks it rather than giving up.
 *
 * Absent on the Workers AI routes, which have no cache in front of them - so this reads `false`
 * there and the surfaces behave as ordinary metered calls.
 */
const isCacheHit = (response: MeteredResponse | undefined): boolean =>
  headerOf(response, CACHE_STATUS_HEADER)?.toUpperCase() === 'HIT';

/** What only the gateway knows, folded onto whatever the upstream's own reader produced. */
function withGatewayFacts(
  measured: Measurement,
  result: any,
  response: MeteredResponse | undefined,
  modelDimension: string,
): Measurement {
  const dimensions: Record<string, string> = { ...(measured.dimensions as Record<string, string> | undefined) };

  // The model that actually served: the router's own word for it, falling back to whatever the
  // forwarded body said. Anthropic's Messages body carries `model` too, so this works on both wires.
  const served =
    headerOf(response, ROUTED_MODEL_HEADER) ?? (typeof result?.model === 'string' ? result.model : undefined);
  if (served) dimensions[modelDimension] = served;

  // The substitute for a cost metric: the key to the gateway's own record of what this call cost.
  const logId = headerOf(response, LOG_ID_HEADER);
  if (logId) dimensions.cf_aig_log_id = logId;

  // Only when a fallback actually happened. Step `0` is the ordinary case and tagging every event
  // with it would add a dimension to all of them for no information.
  const step = headerOf(response, STEP_HEADER);
  if (step !== undefined && step !== '0') dimensions.cf_aig_step = step;

  return {
    ...measured,
    dimensions: Object.keys(dimensions).length > 0 ? dimensions : undefined,
    idempotencyKey: headerOf(response, REQUEST_ID_HEADER) ?? measured.idempotencyKey ?? result?.id,
  };
}

/** The Workers AI reader: the three counters it states, under its own (OpenAI's) names. */
function measure(
  usage: OpenAILikeUsage | undefined,
  model: string | undefined,
  id: string | undefined,
  modelDimension: string,
  keys: readonly string[] = WORKERS_AI_PATHS,
): Measurement | undefined {
  if (!usage) return undefined;
  return {
    // Anything absent is absent: a model that reported no counters meters nothing rather than a
    // row of zeroes.
    metrics: pickMetrics(usage, keys),
    // The OpenAI reader, because these are the OpenAI counters - and it finds no nested cache
    // detail here, which is correct, because Workers AI sends none.
    usage: fromOpenAIUsage(usage),
    raw: usage as Record<string, unknown>,
    dimensions: model ? { [modelDimension]: model } : undefined,
    idempotencyKey: id,
  };
}

export function cloudflareRecipe(options: CloudflareRecipeOptions = {}): ClientRecipe<CloudflareMetric> {
  const estimate = options.estimate ?? (() => 1);
  const modelDimension = options.modelDimension ?? 'model';

  /**
   * One upstream surface, wrapped.
   *
   * The upstream recipes' own extractors are reused rather than reimplemented, which is the point:
   * AI Gateway forwards the provider's body untouched, so the provider's reader is by definition
   * the right one - and Anthropic's streamed usage in particular accumulates across two event
   * types, which is not logic worth having a second copy of. Off the gateway the wrapper is inert:
   * no `cf-aig-*` header is present, so no cache hit is seen and no gateway dimension is added.
   */
  const surfaceOf = (base: MethodRecipe): MethodRecipe => ({
    // Spread first so anything the base declares and this wrapper does not know about - like
    // `contextArg`, which says where `stiggContext` rides - survives being wrapped. Rebuilding
    // the object field by field silently dropped it.
    ...base,
    path: base.path,
    estimate,
    extractUsage: (result: any, response?: MeteredResponse) => {
      // Nobody was invoiced for a cache hit, so nothing is reported for one. Checked before the
      // body is read at all, because the body of a hit looks exactly like the body of a real call.
      if (isCacheHit(response)) return undefined;
      const measured = base.extractUsage?.(result, response);
      return measured === undefined
        ? undefined
        : withGatewayFacts(toMeasurement(measured), result, response, modelDimension);
    },
    attachStream: base.attachStream
      ? (stream: any, ingest: (measurement: Measurement) => void, response?: MeteredResponse) => {
          // A cached reply can be streamed back too, and the cache header arrives in time to say so.
          // Nothing is attached at all in that case: the consumer's stream is left untouched and no
          // measurement is produced, which is what a free call should report.
          if (isCacheHit(response)) return;

          // A second tap, purely for attribution. The upstream recipes' stream readers carry out
          // counters and nothing else, so without this the streamed path had no `result` to fall
          // back on and a turn with no `cf-aig-routed-model` header lost its model entirely -
          // where the buffered path reads it straight off the body. Each wire states it in its own
          // envelope: Anthropic on `message_start.message`, the Responses API on `response`, Chat
          // Completions at the chunk root. `meterStream` captures what it patches before patching,
          // so stacking two observers is safe and each sees every chunk exactly once.
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
            (measurement) => ingest(withGatewayFacts(toMeasurement(measurement), seen, response, modelDimension)),
            response,
          );
        }
      : undefined,
  });

  /**
   * Chat Completions, which both products answer on - Workers AI's OpenAI-compatible route and the
   * gateway's `/openai` one.
   *
   * Its own reader rather than `openAIRecipe`'s, for one reason: the model has to be tracked
   * across the chunks of a *streamed* turn. The generic reader does not carry it, and off the
   * gateway there is no `cf-aig-routed-model` header to recover it from - so reusing that reader
   * would silently drop model attribution on every streamed Workers AI call. The key list is the
   * full OpenAI one so a gateway-forwarded `cached_tokens` is not dropped either; Workers AI sends
   * none of those, and absent stays absent.
   */
  const chatSurface: MethodRecipe = {
    path: ['chat', 'completions', 'create'],
    extractUsage: (result: any) =>
      measure(result?.usage, result?.model, result?.id, modelDimension, METRIC_PATHS.openaiChat),
    attachStream: (stream: any, ingest: (measurement: Measurement) => void) => {
      let usage: OpenAILikeUsage | undefined;
      let model: string | undefined;
      let id: string | undefined;
      // The OpenAI recipe's own chunk reader, not a copy of it. AI Gateway forwards whatever the
      // upstream sent, and an upstream can hide its usage somewhere other than the chunk root -
      // Groq puts it on `x_groq` and sends no top-level `usage` at all - so reading `chunk.usage`
      // here would meter a streamed Groq call through this gateway at nothing. Borrowing the
      // reader keeps every upstream that recipe learns about working through this one too.
      const readStreamedUsage = openAISurface(['chat', 'completions', 'create']).streamed;
      meterStream(
        stream,
        (chunk) => {
          // Stated once and whole on the final chunk rather than as deltas, so the last wins.
          const streamedUsage = readStreamedUsage(chunk);
          if (streamedUsage) usage = streamedUsage;
          if (chunk?.model) model = chunk.model;
          if (chunk?.id) id = chunk.id;
        },
        () => {
          const measurement = measure(usage, model, id, modelDimension, METRIC_PATHS.openaiChat);
          if (measurement) ingest(measurement);
        },
      );
    },
  };

  /**
   * The `cloudflare` package's own method.
   *
   * Two limits live here rather than in the file header, because they are facts about this method.
   *
   * It resolves to a **bare promise with no response object**, so no `cf-aig-*` header is reachable
   * on this route - cache status included. A Workers AI call made this way through a gateway is
   * metered as an ordinary call even when the gateway served it free. The `OpenAI`-client route
   * has the headers and does not have this gap.
   *
   * And no `attachStream`, deliberately. A streamed `ai.run` resolves to raw SSE bytes
   * rather than parsed chunks, and a reader attached to those would collect nothing and report it
   * as a measurement of zero, which is the one failure shape nothing downstream can notice. Gated
   * and unmetered is the honest outcome, and it is documented rather than discovered.
   */
  const aiRun: MethodRecipe = {
    path: ['ai', 'run'],
    // `ai.run(model, inputs)` - the model is argument 0, so the context rides in argument 1. Left
    // at the default this surface would forward a caller's `stiggContext` to Cloudflare as an
    // unknown input and gate on the wrap-time context instead, which is the quiet kind of wrong.
    contextArg: 1,
    // No model: it was the first argument, and an extractor is handed only the result. No id
    // either - this surface returns neither, so idempotency falls back to the caller's.
    extractUsage: (result: any) => measure(result?.usage, undefined, undefined, modelDimension),
  };

  return {
    vendor: 'cloudflare',
    metrics: CLOUDFLARE_METRICS,
    // Every wire here spells its total `total_tokens` - Anthropic's is computed from its disjoint
    // counters by the reader this reuses, OpenAI's and Workers AI's are stated.
    totalTokensMetric: TOTAL_TOKENS,
    // The host decides, because shape cannot: an `OpenAI` client and an `Anthropic` client pointed
    // at either product look exactly like direct clients. `ai.run` is checked as well as the two
    // shapes because the `cloudflare` package's client has no `chat.completions`.
    matches: (client) => {
      const baseUrl = baseUrlOf(client);
      if (baseUrl === undefined) return false;
      const onCloudflare = options.baseUrl
        ? withinBaseUrl(options.baseUrl, baseUrl)
        : matchesHost(baseUrl, CLOUDFLARE_API_HOST) || matchesHost(baseUrl, GATEWAY_HOST);
      if (!onCloudflare) return false;
      return hasMethod(client, ['ai', 'run']) || openAIRecipe.matches(client) || anthropicRecipe.matches(client);
    },
    // Every wire it serves. A surface left undeclared here is not metered by something else - it is
    // ungated, because this recipe is matched ahead of both of the ones that would have claimed it.
    methods: [
      surfaceOf(chatSurface),
      ...openAIRecipe.methods.filter((m) => m.path.join('.') !== 'chat.completions.create').map(surfaceOf),
      ...anthropicRecipe.methods.map(surfaceOf),
      surfaceOf(aiRun),
    ],
  };
}

/** One of the metric names Cloudflare can report, across every wire it serves. */
export type CloudflareMetricName = MetricsOf<ReturnType<typeof cloudflareRecipe>>;

/** What a mapper reads off a Cloudflare call: those names, each possibly absent. */
export type CloudflareMetrics = MetricsFor<ReturnType<typeof cloudflareRecipe>>;
