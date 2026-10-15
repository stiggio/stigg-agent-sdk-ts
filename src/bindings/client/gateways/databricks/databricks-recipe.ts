/**
 * The Databricks recipes - one platform, two payers, and no price on either.
 *
 * Databricks speaks the OpenAI wire, so `openAIRecipe` fits both clients by shape. What it cannot
 * express is identity: on `/serving-endpoints` the `model` argument is a serving *endpoint* name
 * the customer invented, so `"prod-chat"` may front DBRX, a hosted Llama, or somebody's OpenAI
 * account - and metered generically it reports as `openai.*` with no dimensions at all. The
 * response's `model` is what recovers that, and putting it on the ingest is most of why these
 * recipes exist.
 *
 * ## Two recipes, because two parties are invoiced
 *
 * Foundation Model APIs are billed by Databricks in DBUs (`databricksRecipe`). An endpoint
 * configured with your own OpenAI or Anthropic key is billed by that upstream
 * (`databricksExternalRecipe`).
 *
 * **Nothing in the request or response tells them apart** - same host, same path, same wire. The
 * difference lives in server-side endpoint config, so the split is not detected, it is *asserted*
 * by naming the second recipe at `wrap`. Assert wrong and nothing throws: DBU traffic lands on
 * your upstream meter, or upstream traffic on your Databricks one. The event name is the only
 * durable record of which you asserted, which is why these are two vendors and not one vendor
 * with a dimension - a meter filter can drop a dimension.
 *
 * Only `databricksRecipe` is registered by default; an assertion nobody made is not a default.
 *
 * ## No cost, on either route
 *
 * Databricks states no price on any response, body or header. DBUs reconcile into
 * `system.billing.usage` and external spend into `system.ai_gateway.external_model_spend`, both
 * asynchronously. So `metrics` has no `cost` rather than a zero a mapper would multiply.
 *
 * `extractUsage` never sees request parameters, so the endpoint *asked for* cannot be recorded -
 * only the model that answered. Add it yourself where it matters:
 * `stiggContext: { dimensions: { endpoint: 'prod-chat' } }`.
 *
 * ## Two clients, one recipe
 *
 * An `OpenAI` client at the workspace (`chat.completions.create`, `responses.create`, matched on
 * the URL) and `@databricks/sdk-modelservingquery`, whose entire surface is `client.query(...)`
 * (`databricks.query`, matched on client shape - see {@link isDatabricksQueryClient} for why, and why its
 * failure mode is a loud throw).
 *
 * One Databricks account is billed whichever the application imported, so they share a vendor and
 * differ only in event name. The native client is generated and hands the caller `promptTokens`
 * where the wire said `prompt_tokens`, so it reads through `DATABRICKS_QUERY_METRIC_NAME_MAP` and
 * reports the wire's names - otherwise one workspace would produce two feature ids from a choice
 * that has nothing to do with billing. It reports three counters and no cache pair, absent rather
 * than zero, and does not stream: `query` resolves to a parsed body whose schema rejects SSE.
 */
import { meterStream } from '../../../shared/meter-stream';
import { openAIRecipe, openAISurface } from '../../providers/openai/openai-recipe';
import {
  DATABRICKS_METRICS,
  DATABRICKS_PATHS,
  DATABRICKS_RESPONSES_PATHS,
  DATABRICKS_QUERY_METRIC_NAME_MAP,
  TOTAL_TOKENS,
  fromDatabricksQueryUsage,
  fromDatabricksUsage,
  pickMetrics,
  pickRenamedMetrics,
} from '../../../shared/token-usage';
import { baseUrlOf, matchesAnyHost, pathOf, withinBaseUrl } from '../../../shared/base-url';
import { hasMethod } from '../../core/registry';
import type { Measurement, Metrics } from '../../../../types';
import type { DatabricksLikeUsage, DatabricksQueryLikeUsage } from '../../../shared/types';
import type { DatabricksRecipeOptions } from './types';
import type { ClientRecipe, MetricsFor, MetricsOf, MeteredResponse } from '../../core/types';

type DatabricksMetric = (typeof DATABRICKS_METRICS)[number];

/**
 * The three public workspace families, one per cloud.
 *
 * None is more canonical than the others, which is the difference from a single-host gateway like
 * OpenRouter: the matcher needs the set. A PrivateLink or custom-DNS workspace is in none of them
 * and supplies `baseUrl` instead.
 */
const WORKSPACE_HOSTS = ['cloud.databricks.com', 'azuredatabricks.net', 'gcp.databricks.com'] as const;

/**
 * The two paths a serving endpoint is reached on.
 *
 * `/serving-endpoints` is the classic route; `/ai-gateway/mlflow/v1` is the newer Unity Gateway
 * one. Checked as well as the host because the host families above are shared with every other
 * Databricks API - a workspace URL alone says "Databricks", not "inference".
 */
const SERVING_PATHS = ['/serving-endpoints', '/ai-gateway/mlflow/v1'] as const;

/**
 * Which served model answered, from wherever this deployment put it.
 *
 * `served-model-name` is documented as a response header and *also* appears in the body - the
 * official JS client parses it off the payload, the REST reference calls it a header - so both are
 * read rather than betting on one. It names the served entity behind a traffic-split endpoint,
 * which is a finer thing than `model`, so it rides as its own dimension when present instead of
 * overwriting the model identity.
 */
function servedEntity(result: any, response: MeteredResponse | undefined): string | undefined {
  const fromBody = result?.['served-model-name'] ?? result?.served_model_name ?? result?.servedModelName;
  if (typeof fromBody === 'string' && fromBody !== '') return fromBody;
  const fromHeader = response?.headers?.get('served-model-name');
  return fromHeader == null || fromHeader === '' ? undefined : fromHeader;
}

function measure(
  usage: DatabricksLikeUsage | undefined,
  model: string | undefined,
  id: string | undefined,
  served: string | undefined,
  modelDimension: string,
  keys: readonly string[] = DATABRICKS_PATHS,
): Measurement | undefined {
  if (!usage) return undefined;

  // Databricks' own six names, verbatim. The first three are always there; the cache pair and
  // `reasoning_tokens` are Foundation Model API extensions, and `pickMetrics` drops what a given
  // endpoint did not report rather than reporting it as a zero.
  const metrics: Metrics = pickMetrics(usage, keys);
  const dimensions: Record<string, string> = {};
  if (model) dimensions[modelDimension] = model;
  // A finer fact than the model, and only some endpoints have one: which served entity behind a
  // traffic split answered. Absent for every endpoint that is not split, which is most of them.
  if (served && served !== model) dimensions.served_model_name = served;

  return {
    metrics,
    usage: fromDatabricksUsage(usage),
    raw: usage as Record<string, unknown>,
    dimensions: Object.keys(dimensions).length > 0 ? dimensions : undefined,
    // The completion id. Databricks publishes no proxy-level request id on the response the way
    // LiteLLM does, so this is the best stable key available - it is what a replayed response
    // would carry again.
    idempotencyKey: id,
  };
}

/**
 * The first-party client's one surface. One segment, which is why it is kept out of `GatedPath` -
 * see `DatabricksGatedPath` in `src/types.ts`.
 */
const QUERY_PATH = ['query'] as const;

/**
 * The marker that makes `query` safe to claim: the user agent this SDK builds at construction.
 *
 * `'sdk-js-' + pkgJson.name.replace(/^@[^/]+\/sdk-/, '')`, so the string names the package.
 */
const QUERY_CLIENT_MARKER = 'sdk-js-modelservingquery';

/**
 * Whether this is `@databricks/sdk-modelservingquery`'s client.
 *
 * Both halves are required. `query` alone is a database client - every Postgres, MySQL, Snowflake
 * and BigQuery client has one, and claiming them would meter a database call as `databricks.query`.
 * The marker alone is not callable.
 *
 * The awkward part is that this client publishes nothing else: its `.d.ts` declares exactly one
 * public member, and `options`, `logger`, `userAgent` and `config` are all `private`. So any second
 * marker is a field the SDK does not publish. `userAgent` is the one chosen because the constructor
 * sets it unconditionally; `config` was rejected because it is memoised lazily and is `undefined`
 * until the first request, so a fresh client would not match.
 *
 * A future version renaming that field breaks the match, and that cost is acceptable only because
 * of how it fails: no recipe matches, and `wrap()` throws naming what it supports - loudly, before
 * one call is metered. Nothing else here claims a bare `query` client, so there is no recipe to
 * fall through to and no silent mismeter. A caller who hits it names the recipe instead.
 *
 * The false-positive direction is the silent one, and it is closed: the marker names the package,
 * so a wrong claim needs an object exposing `query` *and* advertising this exact SDK.
 *
 * Note the two routes are matched on different evidence, deliberately. The OpenAI route is a base
 * URL, because its client shape says nothing; the native route is shape, because its host sits in
 * a private field that is often unset anyway - Databricks resolves it from `~/.databrickscfg` or
 * `DATABRICKS_HOST`. So an `options.baseUrl` given for the OpenAI route does not constrain this
 * one; there would be nothing to compare against.
 */
function isDatabricksQueryClient(client: unknown): boolean {
  if (!hasMethod(client, QUERY_PATH)) return false;
  const agent = (client as { userAgent?: unknown }).userAgent;
  return typeof agent === 'string' && agent.includes(QUERY_CLIENT_MARKER);
}

/**
 * What a `query` response is worth, projected rather than passed through.
 *
 * `raw` is built from the renamed counters and **never** from the response, for a harder reason
 * than Ollama's. `created` is a `bigint`, and `JSON.stringify` throws outright on one - "Do not
 * know how to serialize a BigInt" - so letting the response reach `raw` or a dimension would not
 * flatten a reply into event dimensions the way Ollama's would, it would fail the ingest. The
 * counters are projected explicitly and nothing else crosses.
 */
function measureQuery(result: any, modelDimension: string): Measurement | undefined {
  const usage = result?.usage as DatabricksQueryLikeUsage | undefined;
  if (!usage) return undefined;
  // Read camelCase, report the wire's snake_case - so this surface and the OpenAI one above
  // produce the same feature ids for the same workspace. The whole point of the map.
  const metrics: Metrics = pickRenamedMetrics(usage, DATABRICKS_QUERY_METRIC_NAME_MAP);
  if (Object.keys(metrics).length === 0) return undefined;

  const dimensions: Record<string, string> = {};
  const model = typeof result?.model === 'string' ? result.model : undefined;
  if (model) dimensions[modelDimension] = model;
  // The same served entity the OpenAI route reads off `served-model-name`; this client exposes it
  // camelCased, which `servedEntity` already looks for.
  const served = servedEntity(result, undefined);
  if (served && served !== model) dimensions.served_model_name = served;
  // Which of the four workloads behind this one method ran. See the file header.
  if (typeof result?.object === 'string' && result.object !== '') dimensions.response_object = result.object;

  return {
    metrics,
    usage: fromDatabricksQueryUsage(usage),
    raw: { ...metrics },
    dimensions: Object.keys(dimensions).length > 0 ? dimensions : undefined,
    // The completion id, as on the OpenAI route. A string here; `created` beside it is the bigint
    // and is deliberately never read.
    idempotencyKey: typeof result?.id === 'string' ? result.id : undefined,
  };
}

/**
 * One factory, two vendors.
 *
 * The recipes are identical in everything but the name they report under, because the traffic
 * genuinely is identical - see the header. Sharing the body is the point: a divergence between
 * them would be a claim about a difference the wire does not contain.
 */
function databricksRecipeFor(vendor: string, options: DatabricksRecipeOptions): ClientRecipe<DatabricksMetric> {
  const estimate = options.estimate ?? (() => 1);
  const modelDimension = options.modelDimension ?? 'model';

  return {
    vendor,
    metrics: DATABRICKS_METRICS,
    // The OpenAI shape it speaks, so the OpenAI name for the total - and Databricks states one,
    // so it is read rather than computed. Which matters more than usual here: the cache counters
    // may or may not sit inside `prompt_tokens`, so a computed total could double-count.
    totalTokensMetric: TOTAL_TOKENS,
    // Two clients, two kinds of evidence - see the file header. The first-party client is known by
    // its own shape; an OpenAI client's shape says nothing, so for that route the base URL is the
    // discriminator. Neither can separate the two Databricks *routes* from each other - that is
    // the caller's assertion, not a detection.
    matches: (client) =>
      isDatabricksQueryClient(client) || (openAIRecipe.matches!(client) && isDatabricks(client, options.baseUrl)),
    // Built from the OpenAI recipe's own surfaces, for the same reason as the OpenRouter and
    // LiteLLM ones: this recipe is matched ahead of it, so a surface it failed to declare would go
    // ungated rather than being metered by something else.
    methods: [
      // The first-party client. No `attachStream`: `query` has no streamed form - see the header.
      {
        path: QUERY_PATH,
        estimate,
        extractUsage: (result: any) => measureQuery(result, modelDimension),
      },
      // The OpenAI-wire surfaces, built from the OpenAI recipe's own list.
      ...openAIRecipe.methods.map((base) => {
        const { streamed } = openAISurface(base.path);
        // Chat Completions and Responses spell the same counters differently, so each surface
        // reads its own list. Sharing one would leave a Responses call reporting `total_tokens`
        // alone, with no breakdown under it.
        const keys = base.path.join('.') === 'responses.create' ? DATABRICKS_RESPONSES_PATHS : DATABRICKS_PATHS;
        return {
          path: base.path,
          estimate,
          extractUsage: (result: any, response?: MeteredResponse) =>
            measure(result?.usage, result?.model, result?.id, servedEntity(result, response), modelDimension, keys),
          // Usage arrives once, at the end, and only when the caller asked for it: Databricks honours
          // `stream_options: {include_usage: true}` and defaults it off. A caller who does not ask
          // gets a stream that states nothing, and the metrics are then absent rather than zero.
          attachStream: (stream: any, ingest: (measurement: Measurement) => void, response?: MeteredResponse) => {
            let usage: DatabricksLikeUsage | undefined;
            let model: string | undefined;
            let id: string | undefined;
            meterStream(
              stream,
              (chunk) => {
                // Last write wins. Databricks' own docs disagree with themselves about whether usage
                // rides every chunk or only the final one, so this reads it wherever it appears and
                // keeps the last - which is correct under either reading.
                const seen = streamed(chunk);
                if (seen) usage = seen;
                // The Responses API nests its completion event - `{ response: { id, model, usage } }`
                // - where Chat Completions puts all three at the chunk root. `streamed()` already
                // reaches through for usage; the model and the id are read off the same envelope so
                // a streamed Responses turn keeps its attribution and its idempotency key instead
                // of falling back to a generated one.
                const payload = chunk?.response ?? chunk;
                if (payload?.model) model = payload.model;
                if (payload?.id) id = payload.id;
              },
              () => {
                const measurement = measure(usage, model, id, servedEntity({}, response), modelDimension, keys);
                if (measurement) ingest(measurement);
              },
            );
          },
        };
      }),
    ],
  };
}

/**
 * Databricks-hosted inference - Foundation Model APIs, billed to your Databricks account in DBUs.
 *
 * Registered by default and matched on the workspace URL, because reading a richer response is not
 * a pricing decision anyone needs to opt into. What it adds over `openAIRecipe` is a vendor name
 * and the model that answered, which on this platform is the only thing that says what an endpoint
 * name meant.
 */
export const databricksRecipe = (options: DatabricksRecipeOptions = {}): ClientRecipe<DatabricksMetric> =>
  databricksRecipeFor('databricks', options);

/**
 * The external-model route - Databricks proxies, your upstream provider invoices.
 *
 * Not registered by default: which route an endpoint serves is server-side configuration, so this
 * is the caller asserting something about their own workspace rather than the SDK detecting it.
 * Name it at `wrap(client, { recipe: databricksExternalRecipe() })`, and see the file header for
 * what a wrong assertion costs.
 *
 * `databricks-external` rather than something further from `databricks`: the two sort together in
 * a meter list, which is what you want when you are reading one account's traffic split across
 * them, and `external` is Databricks' own word - an endpoint of this kind is configured under an
 * `external_model` block.
 */
export const databricksExternalRecipe = (options: DatabricksRecipeOptions = {}): ClientRecipe<DatabricksMetric> =>
  databricksRecipeFor('databricks-external', options);

/**
 * Whether this client points at a Databricks serving endpoint.
 *
 * Given a `baseUrl`, that endpoint and anything beneath it - nothing weaker, because a prefix
 * match on the raw string lets `.../v1` claim `.../v10`.
 *
 * Without one, the guess is narrow on purpose and needs *both* halves: one of the three public
 * workspace host families, and one of the two serving paths. The host alone is every Databricks
 * API there is, most of which are not inference and must not be claimed; the path alone would let
 * any unrelated service that happens to expose `/serving-endpoints` be metered as Databricks. A
 * PrivateLink workspace satisfies neither half and takes `baseUrl`.
 */
function isDatabricks(client: unknown, baseUrl?: string): boolean {
  const clientBase = baseUrlOf(client);
  if (clientBase === undefined) return false;
  if (baseUrl) return withinBaseUrl(baseUrl, clientBase);
  if (!matchesAnyHost(clientBase, WORKSPACE_HOSTS)) return false;
  const path = pathOf(clientBase);
  return SERVING_PATHS.some((serving) => path === serving || path.startsWith(`${serving}/`));
}

/** One of the metric names Databricks reports. */
export type DatabricksMetricName = MetricsOf<ReturnType<typeof databricksRecipe>>;

/** What a mapper reads off a Databricks call: those names, each possibly absent. */
export type DatabricksMetrics = MetricsFor<ReturnType<typeof databricksRecipe>>;
