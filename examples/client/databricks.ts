/**
 * The Databricks helper - a workspace reached with an `OpenAI` client, bound as a client.
 *
 * This is the route the Databricks docs themselves show: point an `OpenAI` client at
 * `<workspace>/serving-endpoints` and call `chat.completions.create`. So the wiring below is the
 * LiteLLM helper's wiring unchanged, and everything that differs is a fact about Databricks.
 *
 * **The request does not say what model will answer.** This is the one to watch the output for,
 * and it is most of why `databricksRecipe` exists. `model` on the way out is a serving *endpoint*
 * name the customer invented - `"prod-chat"` is a legal one - and nothing in the request says
 * whether it fronts DBRX, a Llama that Databricks hosts, or somebody's OpenAI account. `model` on
 * the way back is what actually served, so the `served` line the shared script prints is doing
 * real work here rather than echoing what was asked for.
 *
 * **No cost, on either route.** No Databricks response carries a price - not in the body, not in
 * a header. DBUs land in `system.billing.usage` and external-model spend in
 * `system.ai_gateway.external_model_spend`, both asynchronously. So there is no `cost` metric to
 * meter and this chat meters tokens, which is what every other client example here meters anyway.
 *
 * **There is a second client, and it is next door.** `@databricks/sdk-modelservingquery` reaches
 * the same endpoints through one method, `client.query(...)`, and is governed by this same recipe
 * as `databricks.query`. It cannot stream, so it is not what a chat REPL wants; the gateway
 * example drives it:
 *
 *   yarn example-gateway-databricks
 *
 * ## Asserting the external-model route
 *
 * Databricks invoices two ways through one hostname, one path and one wire, and nothing on the
 * client side distinguishes them - so which recipe to name is an assertion about your own
 * workspace rather than something the SDK can detect:
 *
 *   AGENT_SDK_DATABRICKS_EXTERNAL=1 yarn example-client-databricks
 *
 * That flips the recipe to `databricksExternalRecipe()` and the events to `databricks-external.*`.
 * Everything else is identical, which is the point: the response is the same response, and the
 * vendor name is the only durable record of which route you said it was.
 *
 * Run:  yarn example-client-databricks
 */
import OpenAI from 'openai';
import { databricksExternalRecipe, databricksRecipe } from '../../src';
import { consumeStream } from './core/openai-stream';
import { startChat } from './core/chat';
import { optionalEnv, type ChatVendor, type GovernedVendorClient } from './core/vendor';

/** Which of the two payers this run is asserting. See the header. */
const EXTERNAL = process.env.AGENT_SDK_DATABRICKS_EXTERNAL === '1';

/**
 * A workspace URL plus the serving path, unless the configured URL already names it.
 *
 * The matcher wants both halves - the three public host families are every Databricks API there
 * is, most of which are not inference - so a workspace URL copied from a browser address bar
 * needs the path appending or nothing matches.
 */
const withServingPath = (base: string): string => {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith('/serving-endpoints') ? trimmed : `${trimmed}/serving-endpoints`;
};

/**
 * Customer-specific, with no default that could possibly be right: a workspace hostname names one
 * customer's workspace. Absent, the shared script runs this against the offline mock.
 */
const DATABRICKS_BASE_URL = withServingPath(
  optionalEnv('AGENT_SDK_DATABRICKS_BASE_URL', 'DATABRICKS_HOST') ?? 'http://localhost:8080',
);

/** Databricks extends the OpenAI usage block with Anthropic's cache names, flat rather than nested. */
type DatabricksUsage = OpenAI.CompletionUsage & {
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
};

export const databricksVendor: ChatVendor = {
  id: 'databricks',
  label: EXTERNAL ? 'Databricks (external models)' : 'Databricks',
  // A Foundation Model API endpoint, which exists in every workspace without being created. An
  // external-model endpoint is one you configured, so there is no default worth guessing.
  model: process.env.AGENT_SDK_DATABRICKS_MODEL ?? 'databricks-claude-sonnet-4-6',
  keyVars: ['AGENT_SDK_DATABRICKS_API_KEY', 'DATABRICKS_TOKEN'],
  // The SDK appends /chat/completions; the /databricks prefix is only how the shared mock tells
  // this wire format from the OpenRouter and LiteLLM ones, since all three end in the same path.
  mockBaseUrl: (base) => `${base}/databricks/serving-endpoints`,

  /**
   * Named explicitly, for two reasons rather than the usual one.
   *
   * A workspace hostname is customer-specific, so offline - where the mock's host is 127.0.0.1 -
   * there is nothing for the matcher to recognise and this is the difference between metering the
   * served model and falling through to the plain OpenAI recipe. And which of the two recipes is
   * correct is a thing only the operator of the workspace knows.
   */
  recipe: EXTERNAL
    ? databricksExternalRecipe({ baseUrl: DATABRICKS_BASE_URL })
    : databricksRecipe({ baseUrl: DATABRICKS_BASE_URL }),

  createClient: ({ apiKey, baseUrl }) => new OpenAI({ apiKey, baseURL: baseUrl ?? DATABRICKS_BASE_URL }),

  async send(client: GovernedVendorClient<OpenAI>, messages, system, stiggContext) {
    const stream = await client.chat.completions.create({
      model: databricksVendor.model,
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: 1024,
      stream: true,
      // `include_usage` defaults off and Databricks honours it. Without it the stream states no
      // counters at all and the turn meters nothing - absent, not zero.
      stream_options: { include_usage: true },
      // Overrides whatever `wrap` was given, for this turn only.
      stiggContext,
    });

    const { text, usage, servedModel, stopReason } = await consumeStream<DatabricksUsage>(stream);

    messages.push({ role: 'assistant', content: text });
    // Printed beside the counters rather than added to them: whether Databricks counts these
    // inside `prompt_tokens` is undocumented, so summing them could double-count. The recipe
    // reports all six verbatim and leaves the same decision to whoever prices them.
    if (usage?.cache_read_input_tokens || usage?.reasoning_tokens) {
      console.log(
        `\n  [detail] cache_read=${usage.cache_read_input_tokens ?? 0} reasoning=${usage.reasoning_tokens ?? 0}`,
      );
    }
    return { usage, servedModel, stopReason };
  },
};

startChat(databricksVendor);
