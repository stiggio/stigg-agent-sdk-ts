/**
 * The Groq recipe - a provider that speaks the OpenAI wire format.
 *
 * Groq invoices the customer directly and runs the weights on its own hardware. Its model ids are
 * sometimes namespaced (`meta-llama/llama-4-scout-17b-16e-instruct`, `openai/gpt-oss-120b`) but
 * that prefix is the model's *author*, not a route to someone else's API - no upstream maker is in
 * the billing path. So: a provider, not a gateway, and there is no `cost` on the response to
 * recover, only tokens and timings.
 *
 * ## What this buys over `openAIRecipe`
 *
 * Shape alone cannot tell Groq from any other OpenAI-compatible endpoint - a `groq-sdk` client and
 * an `OpenAI` client both have `chat.completions.create` - so the hostname is the discriminator,
 * the same way `isOpenRouter` works. What the dedicated recipe adds is a vendor name of its own:
 * `groq.chat.completions.create` rather than `openai.chat.completions.create`, so a raw-events
 * meter and a per-provider budget can tell Groq traffic apart without the caller having to attach
 * a dimension by hand. The counters themselves are the OpenAI ones, under the OpenAI names.
 *
 * Both routes land here, which is the point of matching on the host rather than the client: the
 * native `groq-sdk` defaults to `https://api.groq.com`, and an `OpenAI` client is pointed at
 * `https://api.groq.com/openai/v1`. Same hostname, so one guard claims both.
 *
 * ## One surface, deliberately
 *
 * Only `chat.completions.create` is gated, because it is the only generation surface Groq serves.
 * `groq-sdk` exposes `chat`, `completions` (an empty namespace holding a type), `embeddings`,
 * `audio`, `models`, `batches` and `files` - there is no `responses` module, and Groq's API has no
 * Responses endpoint for an `OpenAI` client to reach either.
 *
 * That is a departure from the OpenRouter and LiteLLM recipes, which declare *both* OpenAI
 * surfaces precisely because they are matched ahead of `openAIRecipe` and an undeclared surface
 * would be left ungated. The reasoning does not carry over here: the surface those recipes are
 * protecting is a billable one, and `responses.create` on a client pointed at Groq is unreachable -
 * it answers 404. Declaring it would publish `groq.responses.create`, an event name that can never
 * fire, and event names are permanent once a customer's meter filters on them.
 *
 * Not gated, and billable: `audio.transcriptions`/`translations` (charged by audio duration) and
 * `embeddings` (a different price list). Meter one by naming your own recipe at
 * `wrap(client, { recipe })`.
 *
 * ## Where the counters are
 *
 * Buffered, at `response.usage` - a clean OpenAI shape. Streamed, at `x_groq.usage` on the final
 * chunk, because Groq's chunks carry no top-level `usage` of their own. Both reads come from the
 * OpenAI surfaces this recipe reuses, so there is one implementation of each; see
 * `openai-recipe.ts` for why that read lives there and `./types.ts` for the shapes, including the
 * per-model `usage_breakdown` this SDK cannot express and does not meter.
 */
import { OPENAI_CHAT_METRICS, TOTAL_TOKENS } from '../../../shared/token-usage';
import { openAIRecipe } from '../openai/openai-recipe';
import { baseUrlOf, matchesHost } from '../../../shared/base-url';
import type { ClientRecipe, MetricsFor, MetricsOf } from '../../core/types';

/** The one surface Groq serves, as the OpenAI recipe addresses it. */
const CHAT_PATH = ['chat', 'completions', 'create'] as const;

/**
 * `baseURL` is a public field on both clients that reach Groq, and the only thing that says which
 * vendor is on the other end.
 *
 * Narrow on purpose, exactly as `isOpenRouter` is: the host, not a substring, because
 * `api.groq.com.example.com` is somebody else's domain and claiming it would meter an unrelated
 * client as Groq. A Groq deployment on another base URL - `GROQ_BASE_URL` set to a regional
 * endpoint, or a proxy in front of it - is not claimed here and is governed by `openAIRecipe`
 * instead, which still reads its streamed counters. Name this recipe at
 * `wrap(client, { recipe: groqRecipe })` to attribute such a client to Groq explicitly.
 */
function isGroq(client: unknown): boolean {
  const baseUrl = baseUrlOf(client);
  return baseUrl !== undefined && matchesHost(baseUrl, 'api.groq.com');
}

export const groqRecipe = {
  vendor: 'groq',
  // The OpenAI chat counters, under the OpenAI names - Groq reports that block verbatim. The
  // timings beside it (`queue_time`, `prompt_time`, ...) are floats and are not metrics.
  metrics: OPENAI_CHAT_METRICS,
  totalTokensMetric: TOTAL_TOKENS,
  matches: (client) => openAIRecipe.matches(client) && isGroq(client),
  // Built from the OpenAI recipe's own chat surface, so the extractor and the streamed reader -
  // including the `x_groq` fallback - have one implementation shared with it rather than a copy.
  methods: openAIRecipe.methods
    .filter((method) => method.path.join('.') === CHAT_PATH.join('.'))
    .map((method) => ({ ...method, path: [...CHAT_PATH] })),
} satisfies ClientRecipe<(typeof OPENAI_CHAT_METRICS)[number]>;

/** One of the metric names Groq reports. */
export type GroqMetric = MetricsOf<typeof groqRecipe>;

/** What a mapper reads off a Groq call: those names, each possibly absent. */
export type GroqMetrics = MetricsFor<typeof groqRecipe>;
