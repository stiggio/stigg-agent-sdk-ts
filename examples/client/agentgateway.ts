/**
 * The agentgateway helper - the open-source AI gateway (or a build on it: Solo.io's enterprise
 * edition, Gloo AI Gateway), bound as a client.
 *
 * Same shape as the LiteLLM helper next door, and for the same reason: a gateway you *call* hands
 * its response back into this process, so it gates in-process like any other client. The gateway
 * is self-hosted - a proxy in your own cluster - so there is no public host for the matcher
 * to recognise, and the recipe is named here with the base URL it should claim.
 *
 * What the recipe adds over `openAIRecipe` is not a price - the gateway is self-hosted and
 * states none on any response - but a vendor name of its own, so the turns
 * report as `agentgateway.chat.completions.create` rather than passing for direct OpenAI traffic, and the
 * model that actually served. The gateway is free to resolve what you asked for - an alias, a
 * provider prefix, a failover priority group - to something else, and the drift line below says so.
 *
 * It meters TOKENS, like every other client example, so its turns read in the same denomination.
 *
 * The same gateway also answers on the Anthropic Messages wire. An `Anthropic` client pointed at it
 * is governed by the same recipe and reports `agentgateway.messages.create`; it is not shown here because
 * the chat script is one client per vendor, and the OpenAI wire is the one most gateways expose.
 *
 * Calling the gateway with plain `fetch` rather than an SDK? See `example-gateway-agentgateway`,
 * which governs the same calls through `stigg.wrapFetch`.
 *
 * There is no signup. Set `AGENT_SDK_AGENTGATEWAY_BASE_URL` to your gateway's OpenAI route to talk to the
 * real thing - its presence is what selects it, the way `AGENT_SDK_OLLAMA_HOST` does for Ollama -
 * and `AGENT_SDK_AGENTGATEWAY_API_KEY` only if your gateway enforces API-key auth. With no base URL set the
 * example runs against the built-in offline mock.
 *
 * Run:  yarn example-client-agentgateway
 */
import OpenAI from 'openai';
import { agentgatewayRecipe } from '../../src';
import { consumeStream } from './core/openai-stream';
import { startChat } from './core/chat';
import { optionalEnv, type ChatVendor, type GovernedVendorClient } from './core/vendor';

/** A port-forwarded agentgateway on its default listener. Self-hosted, so nobody runs this for you. */
const AGENTGATEWAY_BASE_URL = optionalEnv('AGENT_SDK_AGENTGATEWAY_BASE_URL') ?? 'http://localhost:8080/v1';

export const agentgatewayVendor: ChatVendor = {
  id: 'agentgateway',
  label: 'agentgateway',
  // Whatever name your gateway exposes - an exact model, a wildcard match, or an alias of your own.
  // What it resolves to is the gateway's business, which is why the recipe records what served.
  model: process.env.AGENT_SDK_AGENTGATEWAY_MODEL ?? 'gpt-5-mini',
  // Self-hosted, so the base URL rather than a key is what says "talk to the real thing" - the
  // runner starts the offline mock when it is unset.
  keyVars: ['AGENT_SDK_AGENTGATEWAY_BASE_URL'],
  // The SDK appends /chat/completions; the /agentgateway prefix is only how the shared mock tells this
  // wire format from the other OpenAI-shaped ones, since they all end in the same path.
  mockBaseUrl: (base) => `${base}/agentgateway/v1`,

  // Named, because a self-hosted gateway has no canonical host. Given the base URL, the matcher
  // would claim this client unaided too - naming it just makes the choice visible here.
  recipe: agentgatewayRecipe({ baseUrl: AGENTGATEWAY_BASE_URL }),

  // The key is read here rather than taken from the runner, which hands over the base URL in its
  // place. A gateway without API-key auth still needs a non-empty string for the OpenAI client.
  createClient: ({ baseUrl }) =>
    new OpenAI({
      apiKey: optionalEnv('AGENT_SDK_AGENTGATEWAY_API_KEY', 'AGENTGATEWAY_API_KEY') ?? 'no-key',
      baseURL: baseUrl ?? AGENTGATEWAY_BASE_URL,
    }),

  async send(client: GovernedVendorClient<OpenAI>, messages, system, stiggContext) {
    const stream = await client.chat.completions.create({
      model: agentgatewayVendor.model,
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: 1024,
      stream: true,
      // Without this the terminal chunk carries no usage at all, and a streamed turn meters
      // nothing. The gateway forwards the option to the upstream like any other field.
      stream_options: { include_usage: true },
      // Overrides whatever `wrap` was given, for this turn only.
      stiggContext,
    });

    const { text, usage, servedModel, stopReason } = await consumeStream(stream);

    messages.push({ role: 'assistant', content: text });
    return { usage, servedModel, stopReason };
  },
};

startChat(agentgatewayVendor);
