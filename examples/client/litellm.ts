/**
 * The LiteLLM helper - a proxy you host, bound as a client.
 *
 * Same shape as the OpenRouter helper next door, and for the same reason: a gateway you *call*
 * hands its response back into this process, so it gates in-process like any other client. The
 * difference is where the money is written down. OpenRouter puts the credits it charged on the
 * response body; LiteLLM puts the dollars it charged in a response header, which `litellmRecipe`
 * reads into a `cost` metric and attributes to the deployment that served.
 *
 * This example meters TOKENS, the recipe's default, so its turns read in the same denomination as
 * the Anthropic and OpenAI ones. The recipe is still named, because a self-hosted proxy has no
 * well-known host for the matcher to recognise - what it adds here is the deployment that served
 * and the proxy's own call id, not a change of unit.
 *
 * There is a second reason this screen would not show spend anyway, worth knowing rather than
 * hiding: the chat STREAMS, and a header is on the wire before the first token exists, so a
 * streamed LiteLLM call cannot carry its cost at all. To watch real spend billed, run the gateway
 * example, which makes the same request both ways and prints the two numbers side by side:
 *
 *   yarn example-gateway-litellm
 *
 * Run:  yarn example-client-litellm
 */
import OpenAI from 'openai';
import { litellmRecipe } from '../../src';
import { consumeStream } from './core/openai-stream';
import { startChat } from './core/chat';
import type { ChatVendor, GovernedVendorClient } from './core/vendor';

/** A LiteLLM proxy is self-hosted; this is its own default port, not a service anyone runs for you. */
const LITELLM_BASE_URL = process.env.AGENT_SDK_LITELLM_BASE_URL ?? 'http://localhost:4000';

export const liteLLMVendor: ChatVendor = {
  id: 'litellm',
  label: 'LiteLLM',
  // A model GROUP from the proxy's own config. What it resolves to is the proxy's business, which
  // is exactly why the recipe records what actually served rather than what was asked for.
  model: process.env.AGENT_SDK_LITELLM_MODEL ?? 'gpt-5',
  keyVars: ['AGENT_SDK_LITELLM_API_KEY', 'LITELLM_API_KEY'],
  // The SDK appends /chat/completions; the /litellm prefix is only how the shared mock tells this
  // wire format from the OpenRouter one, since both end in the same path.
  mockBaseUrl: (base) => `${base}/litellm/v1`,

  // Opt-in, like every spend meter. Handing it the base URL is what lets it recognise the client
  // unaided: there is no litellm.com to look for, so a self-hosted proxy has to say where it is.
  recipe: litellmRecipe({ baseUrl: LITELLM_BASE_URL }),

  createClient: ({ apiKey, baseUrl }) => new OpenAI({ apiKey, baseURL: baseUrl ?? `${LITELLM_BASE_URL}/v1` }),

  async send(client: GovernedVendorClient<OpenAI>, messages, system, stiggContext) {
    const stream = await client.chat.completions.create({
      model: liteLLMVendor.model,
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: 1024,
      stream: true,
      // Without this the terminal chunk carries no usage at all. The cost is a separate question:
      // no request option can put it here, because the headers went out before generation began.
      stream_options: { include_usage: true },
      // Overrides whatever `wrap` was given, for this turn only.
      stiggContext,
    });

    const { text, usage, servedModel, stopReason } = await consumeStream(stream);

    messages.push({ role: 'assistant', content: text });
    return { usage, servedModel, stopReason };
  },
};

startChat(liteLLMVendor);
