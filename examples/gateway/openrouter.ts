/**
 * The OpenRouter gateway helper, through OpenRouter's own SDK.
 *
 * OpenRouter is a gateway you *call*: a hosted service that routes to whichever upstream can
 * serve, and states on the response both what it charged and who actually served. Note what is
 * not here - no check, no ingest, no proxy. Those live in the shared script, because none of
 * them are OpenRouter-specific.
 *
 * What *is* OpenRouter-specific is the client. This one is `@openrouter/sdk`, OpenRouter's own,
 * which its docs recommend over pointing an OpenAI client at the gateway. The client example next
 * door does the latter deliberately, so the pair covers both ways in: the gateway serves the
 * OpenAI wire format, and governing it does not depend on which client speaks that format.
 *
 * Two things follow from this SDK that are worth knowing at the call site:
 *
 *   - The fallback list is a typed field. `models` is in the request type here, because the SDK is
 *     generated from OpenRouter's own spec; through `openai-node` it is an untyped extra that the
 *     gateway happens to accept.
 *   - The counters come back camelCased - `promptTokens`, not `prompt_tokens`. The recipe reads
 *     them back under the wire's names before anything meters them, so one call reports one set of
 *     metric names whichever client made it. See `sdk-usage.ts` for why that is not cosmetic.
 *
 * Run:  yarn example-gateway-openrouter
 */
import '../shared/load-env';
import OpenAI from 'openai';
import { OpenRouter } from '@openrouter/sdk';
import { openrouterRecipe } from '../../src';
import { startGateway } from './core/gateway';
import type { CostReading, GatewayVendor } from './core/vendor';

/** What the first-party SDK hands back, in its own spelling. */
type SdkUsage = {
  promptTokens?: number | null;
  completionTokens?: number | null;
  cost?: number | null;
  promptTokensDetails?: { cachedTokens?: number | null } | null;
  completionTokensDetails?: { reasoningTokens?: number | null } | null;
};

const FALLBACK_MODELS = (process.env.AGENT_SDK_OPENROUTER_FALLBACK_MODELS ?? 'anthropic/claude-sonnet-5,openai/gpt-5')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MODEL = process.env.AGENT_SDK_OPENROUTER_MODEL ?? 'anthropic/claude-opus-5';

const n = (value: number | null | undefined): number => (typeof value === 'number' ? value : 0);

/** The vendor's own numbers, in the neutral shape the shared script prints. */
const readTokens = (usage: SdkUsage | undefined): CostReading['tokens'] =>
  usage
    ? {
        prompt: n(usage.promptTokens),
        cached: n(usage.promptTokensDetails?.cachedTokens),
        completion: n(usage.completionTokens),
        reasoning: n(usage.completionTokensDetails?.reasoningTokens),
      }
    : undefined;

export const openRouterGateway: GatewayVendor<OpenRouter> = {
  label: 'OpenRouter',
  agentSuffix: 'gateway-openrouter',
  model: MODEL,
  keyVars: ['AGENT_SDK_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
  baseUrl: 'https://openrouter.ai/api/v1',
  // The mock's URL names the vendor, so the built-in adapter matches it either way.
  mockBaseUrl: (base) => `${base}/openrouter.ai/api/v1`,

  // `serverURL` rather than `baseURL`: this client is generated from the spec and takes the
  // server it talks to as configuration, with the attribution headers as named options rather
  // than a `defaultHeaders` bag.
  createClient: ({ apiKey, baseUrl }) =>
    new OpenRouter({
      apiKey,
      serverURL: baseUrl,
      httpReferer: 'https://github.com/stiggio/stigg-sdk',
      appTitle: 'stigg-agent-sdk-examples',
    }),

  // The proxy forwards the OpenAI wire format it was handed, so it holds an OpenAI client - the
  // one place in this file where that is the right object, and the reason it is a separate hook.
  createProxyClient: ({ apiKey, baseUrl }) => new OpenAI({ apiKey, baseURL: baseUrl }),

  recipe: () => openrouterRecipe({}),

  // OpenRouter states its id in the body, so the proxy reads it there rather than off a header.
  proxyIdempotencyKey: (data) => data.id,

  async turn(client, { prompt, stream }) {
    const sent = await client.chat.send({
      chatRequest: {
        model: MODEL,
        // Typed, unlike through `openai-node`: the fallback list is a field on OpenRouter's own
        // request rather than an untyped extra the gateway happens to accept. It may route to any
        // of them, which is what makes the served model worth reporting as a dimension.
        models: FALLBACK_MODELS,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 300,
        ...(stream
          ? // OpenRouter sends usage on a streamed call only when asked. Without this the stream
            // ends with nothing to meter and the recipe reports the call as free.
            { stream: true as const, streamOptions: { includeUsage: true } }
          : {}),
      },
    });

    // `send` is overloaded on the literal type of `stream`, which only narrows for a request
    // written out at the call site - and this one is assembled, because whether to stream is an
    // argument. So the narrowing happens here instead, on what actually came back: a completion
    // is an object with the usage on it, a stream is something to iterate.
    if (!(Symbol.asyncIterator in sent)) {
      console.log(sent.choices?.[0]?.message?.content ?? '(no content)');
      const usage = sent.usage as SdkUsage | undefined;
      // OpenRouter writes the money in the body, so there are no headers to consult - which is
      // just as well, because this SDK hands back the parsed result and not the response it came
      // in on. LiteLLM, next door, is the case where that distinction costs something.
      return {
        cost: usage?.cost ?? undefined,
        servedModel: sent.model,
        idempotencyKey: sent.id,
        tokens: readTokens(usage),
      };
    }

    // `for await` is how the SDK documents consuming a stream, and it is the path the recipe
    // meters: the `EventStream` it resolves to is a `ReadableStream`, so a caller reaching for
    // `getReader()` instead would walk around the wrapper.
    let servedModel: string | undefined;
    let id = '';
    let usage: SdkUsage | undefined;
    for await (const chunk of sent) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) process.stdout.write(delta);
      if (chunk.model) servedModel = chunk.model;
      if (chunk.id) id = chunk.id;
      // Usage arrives once, on the last chunk - the recipe meters when the stream ends.
      if (chunk.usage) usage = chunk.usage as SdkUsage;
    }
    process.stdout.write('\n');
    return { cost: usage?.cost ?? undefined, servedModel, idempotencyKey: id, tokens: readTokens(usage) };
  },

  /**
   * `openrouterRecipe` scales the fractional credits it charged into whole micro-credits, because
   * Stigg ingests whole units and rounding every call up to 1 would bill a flat rate. Against the
   * mock a call is roughly a thousand of them, so this is a budget for a handful of calls.
   */
  // Bill the credits the gateway charged, which is the only number that reconciles with it.
  billedMetrics: { cost: 1 },

  budget: 25_000,
};

startGateway(openRouterGateway);
