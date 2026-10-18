/**
 * The Databricks helper - a gateway that states no price, and cannot say who it billed.
 *
 * This helper drives Databricks' **own** client, `@databricks/sdk-modelservingquery`, whose whole
 * surface is `client.query(...)`. The `OpenAI`-client route against the same workspace is in
 * `examples/client/databricks.ts`; one recipe governs both, which is the thing worth seeing - the
 * event name is `databricks.query` here and `databricks.chat.completions.create` there, and the
 * counters reconcile because the camelCase this client reports is mapped back to the wire's names.
 *
 * Two things differ from the other helpers here, and both are facts about Databricks rather than
 * gaps in this example.
 *
 * **No cost, on either route.** Like Bedrock and unlike the other two helpers in this directory,
 * no Databricks response carries a price - not in the body, not in a header. DBUs land in
 * `system.billing.usage` and external-model spend in `system.ai_gateway.external_model_spend`,
 * both asynchronously. So this example meters **tokens**, and `billedMetrics` is where that shows.
 *
 * **The request does not say what model answered.** This is the one worth watching the output for.
 * `name` on the way out is a serving *endpoint* name the customer chose; `model` on the way back
 * is what actually served. The "served" line below is therefore doing real work here, where in the
 * Bedrock helper it always matches what was asked for.
 *
 * **It does not stream.** The native client accepts `stream: true`, but its streamed return type
 * is undocumented - so there is no shape to read counters off with any confidence, and a reader
 * that guessed would report zero rather than nothing. The streamed half of this story is on the
 * OpenAI route, in the client example.
 *
 * ## Running the external-model route
 *
 * Databricks invoices two ways through one hostname, one path and one wire, and nothing on the
 * client side distinguishes them - so which recipe to name is an assertion about your own
 * workspace, not something the SDK can detect. Both are exercised from this one file:
 *
 *   AGENT_SDK_DATABRICKS_EXTERNAL=1 yarn example-gateway-databricks
 *
 * That flips the recipe to `databricksExternalRecipe()` and the events to
 * `databricks-external.*`. Everything else is identical, which is the point: the response is the
 * same response, and the vendor name is the only durable record of which route you said it was.
 *
 * Run:  yarn example-gateway-databricks
 */
import '../shared/load-env';
import OpenAI from 'openai';
import { ModelServingQueryClient } from '@databricks/sdk-modelservingquery/v1';
import { newPatCredentials } from '@databricks/sdk-auth/credentials';
import { databricksExternalRecipe, databricksRecipe } from '../../src';
import { startGateway } from './core/gateway';
import { optionalEnv } from './core/vendor';
import type { CostReading, GatewayVendor } from './core/vendor';

/** Which of the two payers this run is asserting. See the header. */
const EXTERNAL = process.env.AGENT_SDK_DATABRICKS_EXTERNAL === '1';

/**
 * A workspace URL plus the serving path, unless the configured URL already names it.
 *
 * The matcher wants both halves - the host families are every Databricks API there is - so a
 * workspace URL copied from a browser address bar needs the path appending or nothing matches.
 */
const withServingPath = (base: string): string => {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith('/serving-endpoints') ? trimmed : `${trimmed}/serving-endpoints`;
};

/**
 * The workspace host, recovered from the serving URL the runner hands around.
 *
 * `baseUrl` here carries the serving path because that is what the OpenAI client and the recipe's
 * matcher both want. The native client wants the workspace root instead - it appends
 * `/api/serving-endpoints/<name>/invocations` itself - so the suffix comes back off for it.
 */
const workspaceHostOf = (baseUrl: string): string =>
  baseUrl.replace(/\/(serving-endpoints|ai-gateway\/mlflow\/v1)\/?$/, '');

/** The native client camelCases what the wire spells in snake_case. The recipe maps it back; this prints it. */
const readNativeTokens = (usage: any): CostReading['tokens'] =>
  usage
    ? {
        prompt: usage.promptTokens ?? 0,
        cached: 0,
        completion: usage.completionTokens ?? 0,
        reasoning: 0,
      }
    : undefined;

/**
 * Stands in for a workspace URL that was never configured.
 *
 * Reached only when a credential is present but neither `AGENT_SDK_DATABRICKS_BASE_URL` nor
 * `DATABRICKS_HOST` is - a misconfiguration rather than an offline run. It fails the request
 * instead of sending a Databricks token somewhere it was not meant to go.
 */
const UNCONFIGURED_HOST = 'https://databricks-workspace-not-configured.invalid';

export const databricksGateway: GatewayVendor<ModelServingQueryClient> = {
  label: EXTERNAL ? 'Databricks (external models)' : 'Databricks',
  agentSuffix: 'gateway-databricks',
  // A Foundation Model API endpoint, which exists in every workspace without being created. An
  // external-model endpoint is one you configured, so there is no default worth guessing.
  model: process.env.AGENT_SDK_DATABRICKS_MODEL ?? 'databricks-claude-sonnet-4-6',
  keyVars: ['AGENT_SDK_DATABRICKS_API_KEY', 'DATABRICKS_TOKEN'],
  // Customer-specific, with no default that could possibly be right - a workspace hostname names
  // one customer's workspace. Absent, the script runs against the offline mock.
  // No default that could be right: a workspace hostname names one customer's workspace. The
  // fallback is deliberately unreachable rather than `localhost` - with a token set and no
  // workspace configured, the runner would otherwise send an authenticated query to whatever
  // happens to be listening on a local port. Absent a token the mock answers and this is unused.
  baseUrl: withServingPath(optionalEnv('AGENT_SDK_DATABRICKS_BASE_URL', 'DATABRICKS_HOST') ?? UNCONFIGURED_HOST),
  mockBaseUrl: (base) => `${base}/databricks/serving-endpoints`,

  /**
   * Databricks' **own** client, which is the point of this helper.
   *
   * The OpenAI-client route is shown in `examples/client/databricks.ts`; this one exists to prove
   * the same recipe governs `client.query(...)`, a method no OpenAI client has. Note what the
   * matcher cannot use here: this object exposes no `baseURL`, so the recipe recognises it by its
   * `query` method plus a user-agent naming the package - see the recipe header.
   */
  createClient: ({ apiKey, baseUrl }) =>
    new ModelServingQueryClient({
      host: workspaceHostOf(baseUrl),
      // Explicit rather than the default chain, because the offline mock is not a real workspace
      // and no ambient credential could point at it.
      credentials: newPatCredentials(apiKey),
    }),
  // Still an OpenAI client, and deliberately: a proxy forwards the wire format it was handed, and
  // that is the OpenAI one. The governed client above is the application's; this is infrastructure.
  createProxyClient: ({ apiKey, baseUrl }) => new OpenAI({ baseURL: baseUrl, apiKey }),

  // Named explicitly for two reasons. A workspace hostname is customer-specific, so the matcher is
  // handed the URL the client was built with - and which of the two recipes is correct is a thing
  // only the operator of the workspace knows.
  recipe: (baseUrl) => (EXTERNAL ? databricksExternalRecipe({ baseUrl }) : databricksRecipe({ baseUrl })),

  // The completion id. Databricks publishes no proxy-level request id the way LiteLLM does, so
  // there is nothing stabler to reach for.
  proxyIdempotencyKey: (data) => data.id,

  /**
   * Tokens, because there is no cost to bill. `billedMetrics` naming `cost` here would weight a
   * metric the recipe does not report and meter every call at nothing.
   *
   * `total_tokens` is Databricks' own figure, read rather than computed - which matters more here
   * than elsewhere, because whether the cache counters sit inside `prompt_tokens` is undocumented
   * and a computed total could double-count. Price the total or the breakdown, never both.
   */
  // See the header: this client has no usable streamed form, so the runner skips that pass
  // rather than letting this helper issue a second buffered request and bill it twice.
  streams: false,

  billedMetrics: { total_tokens: 1 },

  async turn(client, { prompt }) {
    // Buffered, never streamed. The native client accepts `stream: true` but its streamed return
    // type is undocumented, so there is no shape to read counters off with any confidence - and a
    // reader that guessed would report zero rather than nothing. Streaming belongs on the OpenAI
    // route, which `examples/client/databricks.ts` shows.
    //
    // `clientRequestId` and `usageContext` are the two things this client can do that an OpenAI
    // client cannot: Databricks records both in its own inference and usage tables. So the same
    // attribution lands on both sides - Stigg meters the call, and the Databricks usage table can
    // be grouped by the same customer without anyone building a second logging path.
    const requestId = `req-${Math.random().toString(16).slice(2, 10)}`;
    const response = await client.query({
      name: databricksGateway.model,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 300,
      clientRequestId: requestId,
      usageContext: { feature: 'agent-sdk-example' },
    } as any);

    console.log(response.choices?.[0]?.message?.content ?? '(no content)');

    return {
      // Nothing to read. Stated here as `undefined` rather than left out, because "this gateway
      // publishes no price" is the fact this helper exists to show.
      cost: undefined,
      // The endpoint config's own name for what answered, which is what this surface states.
      servedModel: response.model,
      // The id we *sent*, not the one the response invented. The client retries internally on a
      // lost response and resends this same value, so it is the key that survives a retry -
      // `response.id` is minted per response and would make a retry look like a new call. It is
      // also what Databricks records, so both sides deduplicate on one key.
      idempotencyKey: requestId,
      tokens: readNativeTokens(response.usage),
    };
  },

  /** Tokens rather than micro-credits, so this is sized like the Bedrock helper's rather than the other two. */
  budget: 2_000,
};

startGateway(databricksGateway);
