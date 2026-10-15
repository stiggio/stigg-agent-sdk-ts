/**
 * The LiteLLM gateway helper.
 *
 * LiteLLM is the same topology with the money in a different place: a self-hosted proxy that
 * reports what a call cost in a response *header* rather than in the body. That is the one real
 * difference, and it has a consequence worth seeing - a header precedes the body, so a streamed
 * call cannot carry a cost at all and falls back to tokens.
 *
 * Self-hosted also means no well-known host to recognise, which is why this recipe is handed the
 * base URL its matcher cannot guess.
 *
 * **Why this one still builds an OpenAI client**, when the OpenRouter helper next door builds its
 * vendor's own: because for a LiteLLM proxy that *is* the vendor's own. LiteLLM publishes no JS
 * client for its proxy and documents `openai-node` with `baseURL` pointed at it, which is what
 * this does. The two near-misses are worth naming so nobody has to re-check them:
 *
 *   - `litellm` on npm is a community reimplementation of LiteLLM's *router* (it calls providers
 *     directly), not a client for a proxy, and it was last published in January 2024.
 *   - `@litellm/agent-sdk` is BerriAI's own, but it is for their managed-agents product -
 *     `Agent`/`Session` against a control plane - and exposes no chat completions, so there is no
 *     cost header for it to read.
 *
 * So the client here is deliberate rather than un-updated. What changed with OpenRouter is that a
 * first-party client exists there; the vendor hook that let it change is the point, not the swap.
 *
 * Run:  yarn workspace @stigg/agent-sdk-js run example-gateway-litellm
 */
import '../shared/load-env';
import OpenAI from 'openai';
import { litellmRecipe } from '../../src';
import { startGateway } from './core/gateway';
import type { CostReading, GatewayVendor } from './core/vendor';

const COST_HEADER = 'x-litellm-response-cost';

/** The OpenAI usage object in the neutral shape the shared script prints. */
const readTokens = (usage: OpenAI.CompletionUsage | undefined): CostReading['tokens'] =>
  usage
    ? {
        prompt: usage.prompt_tokens,
        cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
        completion: usage.completion_tokens,
        reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
      }
    : undefined;

/** Appends LiteLLM's API version unless the configured URL already names it. */
const withApiVersion = (base: string): string => {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
};

export const liteLLMGateway: GatewayVendor = {
  label: 'LiteLLM',
  agentSuffix: 'gateway-litellm',
  model: process.env.AGENT_SDK_LITELLM_MODEL ?? 'gpt-5',
  keyVars: ['AGENT_SDK_LITELLM_API_KEY', 'LITELLM_API_KEY'],
  // Self-hosted, so this is LiteLLM's own default port rather than a service anyone runs for you.
  // `/v1` only when it is not already there: a proxy URL is usually copied from LiteLLM's own
  // output, which includes it, and `/v1/v1` is a 404 that reads like a credentials problem.
  baseUrl: withApiVersion(process.env.AGENT_SDK_LITELLM_BASE_URL ?? 'http://localhost:4000'),
  mockBaseUrl: (base) => `${base}/litellm/v1`,

  // The documented client for a LiteLLM proxy - see the note at the top of this file.
  createClient: ({ apiKey, baseUrl }) => new OpenAI({ baseURL: baseUrl, apiKey }),
  // The same object, and here that is not a coincidence: a LiteLLM proxy is reached through an
  // OpenAI client either way, so the governed client and the forwarding one are built alike.
  // OpenRouter is where the two diverge, because only there is the governed one something else.
  createProxyClient: ({ apiKey, baseUrl }) => new OpenAI({ baseURL: baseUrl, apiKey }),

  // No well-known host to match on, so the matcher is given the URL the client was built with.
  recipe: (baseUrl) => litellmRecipe({ baseUrl }),

  // The proxy's own call id, stable across its retries - and it too rides a header.
  proxyIdempotencyKey: (data, headers) => headers.get('x-litellm-call-id') ?? data.id,

  async turn(client, { prompt, stream }) {
    const base = {
      model: liteLLMGateway.model,
      max_tokens: 300,
      messages: [{ role: 'user' as const, content: prompt }],
    };

    if (stream) {
      const chunks = await client.chat.completions.create({ ...base, stream: true });
      let servedModel: string | undefined;
      let id = '';
      let usage: OpenAI.CompletionUsage | undefined;
      for await (const chunk of chunks) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) process.stdout.write(delta);
        if (chunk.model) servedModel = chunk.model;
        if (chunk.id) id = chunk.id;
        // Usage arrives once, on the last SSE chunk - the recipe meters when the stream ends.
        if (chunk.usage) usage = chunk.usage;
      }
      process.stdout.write('\n');
      // A streamed call carries no cost here at all: the header went out before the first token
      // existed, so there is nothing to bill but tokens. This is the difference the file is about.
      return { servedModel, idempotencyKey: id, tokens: readTokens(usage) };
    }

    // The money is in a header, which is the whole reason this asks for the response and not just
    // the body - and the reason the streamed branch above has no cost to report.
    const { data, response } = await client.chat.completions.create(base).withResponse();
    console.log(data.choices[0]?.message?.content ?? '(no content)');
    const cost = response.headers.get(COST_HEADER);
    return {
      cost: cost === null ? undefined : Number(cost),
      servedModel: data.model,
      idempotencyKey: response.headers.get('x-litellm-call-id') ?? data.id,
      tokens: readTokens(data.usage),
    };
  },

  /** Micro-dollars, for the same reason OpenRouter's is micro-credits: whole units, tiny prices. */
  // Bill the dollars the proxy priced, for the non-streamed calls that carry them.
  billedMetrics: { cost: 1 },

  budget: 25_000,
};

startGateway(liteLLMGateway);
