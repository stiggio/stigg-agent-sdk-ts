/**
 * The OpenRouter helper - a gateway you call, bound as a client.
 *
 * Worth being precise about, because the gateway example next door says a gateway can only ingest:
 * that is about a proxy running *out of process*, which sees requests and not runs. Calling
 * OpenRouter yourself is an ordinary client call, so it gates in-process like any other.
 *
 * What changes is what gets read. `openAIRecipe` fits this client by shape, but it projects the
 * response down to four token counters - and that drops the two things only a gateway knows:
 * which model actually served after fallback routing, and the gateway's own request id.
 * `openrouterRecipe` keeps both, and is recognised by base URL without being named here.
 *
 * It still meters TOKENS, through the same `usageMapper` as every other client example, so the
 * per-agent numbers here can be read beside theirs. The recipe also reports the credits
 * OpenRouter actually charged; billing those instead is a mapper away -
 * `weightedMetrics(openrouterRecipe(), 'credits', { cost: 1 })` - and the gateway example does
 * exactly that, rather than mixing a second denomination into this one.
 *
 * Run:  yarn workspace @stigg/agent-sdk-js run example-client-openrouter
 */
import OpenAI from 'openai';
import { consumeStream } from './core/openai-stream';
import { startChat } from './core/chat';
import type { ChatVendor, GovernedVendorClient } from './core/vendor';
import { openrouterRecipe } from '../../src';
import type { StiggContext } from '../../src';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const FALLBACK_MODELS = (process.env.AGENT_SDK_OPENROUTER_FALLBACK_MODELS ?? 'anthropic/claude-sonnet-5,openai/gpt-5')
  .split(',')
  .map((slug) => slug.trim())
  .filter(Boolean);

// OpenRouter extends the OpenAI usage object with the credits it actually charged, and accepts a
// `models` fallback array that openai-node does not type. Widening here keeps the call site typed.
type OpenRouterUsage = OpenAI.CompletionUsage & { cost?: number };
type OpenRouterParams<T> = T & { models?: string[]; stiggContext?: StiggContext };

export const openRouterVendor: ChatVendor = {
  id: 'openrouter',
  label: 'OpenRouter',
  model: process.env.AGENT_SDK_OPENROUTER_MODEL ?? 'anthropic/claude-opus-5',
  keyVars: ['AGENT_SDK_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
  // The mock's URL names the vendor it stands in for, but only in the path - the host is
  // 127.0.0.1, and the recipe matches on the host precisely so that `openrouter.ai.example.com`
  // cannot claim to be the gateway. So the offline client needs the recipe named, below.
  mockBaseUrl: (base) => `${base}/openrouter.ai/api/v1`,

  // Named rather than detected. Against the real gateway the base URL is enough and this is
  // simply what detection would have chosen; offline it is the difference between metering the
  // gateway's own `cost` and the served-model dimension, and falling through to the plain OpenAI
  // recipe, which reads neither. No budget of its own: this agent sits on the same scale as its
  // neighbours.
  recipe: openrouterRecipe(),

  createClient: ({ apiKey, baseUrl }) =>
    new OpenAI({
      apiKey,
      baseURL: baseUrl ?? OPENROUTER_BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/stiggio/stigg-sdk',
        'X-OpenRouter-Title': 'stigg-agent-sdk-examples',
      },
    }),

  async send(client: GovernedVendorClient<OpenAI>, messages, system, stiggContext) {
    const params: OpenRouterParams<OpenAI.ChatCompletionCreateParamsStreaming> = {
      model: openRouterVendor.model,
      models: FALLBACK_MODELS,
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: 1024,
      stream: true,
      stream_options: { include_usage: true },
      // Overrides whatever `wrap` was given, for this turn only.
      stiggContext,
    };
    const stream = await client.chat.completions.create(params);

    const { text, usage, servedModel, stopReason } = await consumeStream<OpenRouterUsage>(stream);

    messages.push({ role: 'assistant', content: text });
    if (usage?.cost !== undefined) {
      // Printed so the ingest line beside it is legible: that unit count is this number, scaled.
      console.log(`\n  [cost] ${usage.cost} credits charged by the gateway`);
    }
    return { usage, servedModel, stopReason };
  },
};

startChat(openRouterVendor);
