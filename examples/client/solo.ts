/**
 * The Solo.io helper - Solo Enterprise for agentgateway, bound as a client.
 *
 * Solo's commercial gateway *is* agentgateway: the enterprise distribution of the same open-source
 * project, installed the same way (an `agentgateway-proxy` Gateway in `agentgateway-system`) and
 * serving the same routes. So there is no Solo recipe - `agentgatewayRecipe` governs it, and its
 * calls report under the same `agentgateway.*` event names as the open-source build's. One wire,
 * one reader, one meter. If you need Solo traffic told apart from another agentgateway deployment,
 * that is a dimension on the context (`dimensions: { gateway: 'solo-enterprise' }`), not a vendor.
 *
 * What this example adds beside `example-client-agentgateway` is the gateway's *other* wire: it
 * holds an `Anthropic` client pointed at the gateway rather than an `OpenAI` one, and reports as
 * `agentgateway.messages.create`. That is the client the recipe's registration order exists for -
 * `anthropicRecipe` has no base-URL guard, so without the gateway recipe ahead of it this traffic
 * would be metered as direct Anthropic calls.
 *
 * There is no signup in this SDK's terms - the gateway runs in your cluster under your Solo
 * licence. Port-forward it (`kubectl port-forward deployment/agentgateway-proxy -n
 * agentgateway-system 8080:80`) and set `AGENT_SDK_SOLO_BASE_URL` to its root, e.g.
 * `http://localhost:8080`; its presence is what selects the real gateway. Set
 * `AGENT_SDK_SOLO_API_KEY` only if your gateway enforces API-key auth. With no base URL set the
 * example runs against the built-in offline mock.
 *
 * Run:  yarn example-client-solo
 */
import Anthropic from '@anthropic-ai/sdk';
import { agentgatewayRecipe } from '../../src';
import { startChat } from './core/chat';
import { optionalEnv, type ChatVendor, type GovernedVendorClient } from './core/vendor';

/** The gateway's root - the Anthropic SDK appends `/v1/messages` itself. */
const SOLO_BASE_URL = optionalEnv('AGENT_SDK_SOLO_BASE_URL') ?? 'http://localhost:8080';

export const soloVendor: ChatVendor = {
  id: 'solo',
  label: 'Solo Enterprise for agentgateway',
  // Whatever name the gateway exposes on its Anthropic route. What it resolves to is reported as
  // the served model, which is the drift line the chat prints.
  model: process.env.AGENT_SDK_SOLO_MODEL ?? 'claude-sonnet-5',
  // Self-hosted, so the base URL rather than a key is what says "talk to the real thing".
  keyVars: ['AGENT_SDK_SOLO_BASE_URL'],
  // The SDK appends /v1/messages; the /solo prefix only keeps this example's traffic visibly
  // apart in the shared mock, which answers Messages on any prefix.
  mockBaseUrl: (base) => `${base}/solo`,

  // The agentgateway recipe, because that is what Solo ships. Named, because a self-hosted
  // gateway has no canonical host; given the base URL, detection would pick it too.
  recipe: agentgatewayRecipe({ baseUrl: SOLO_BASE_URL }),

  // The key is read here rather than taken from the runner, which hands over the base URL in its
  // place. A gateway without API-key auth still needs a non-empty string for the client.
  createClient: ({ baseUrl }) =>
    new Anthropic({
      apiKey: optionalEnv('AGENT_SDK_SOLO_API_KEY', 'SOLO_API_KEY') ?? 'no-key',
      baseURL: baseUrl ?? SOLO_BASE_URL,
    }),

  async send(client: GovernedVendorClient<Anthropic>, messages, system, stiggContext) {
    // The same call the Anthropic example makes. `stream()` reaches the wire through the gated
    // `messages.create`, so the gateway recipe meters it from Anthropic's own stream events.
    const stream = client.messages.stream({
      model: soloVendor.model,
      max_tokens: 1024,
      system,
      messages: messages as Anthropic.MessageParam[],
      // Overrides whatever `wrap` was given, for this turn only.
      stiggContext,
    });
    stream.on('text', (text) => process.stdout.write(text));

    const final = await stream.finalMessage();
    messages.push({ role: 'assistant', content: final.content.map((b) => (b.type === 'text' ? b.text : '')).join('') });

    return {
      usage: final.usage,
      // What the gateway actually routed to, which can differ from the name the request used.
      servedModel: final.model,
      stopReason: final.stop_reason === 'end_turn' ? undefined : (final.stop_reason ?? undefined),
    };
  },
};

startChat(soloVendor);
