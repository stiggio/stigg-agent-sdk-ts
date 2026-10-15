/**
 * The Groq helper.
 *
 * This uses Groq's **own** client, `groq-sdk`. The other way to reach Groq is an `OpenAI` client
 * pointed at `https://api.groq.com/openai/v1`, and `groqRecipe` claims that one too - it matches on
 * the hostname, and both clients sit on `api.groq.com`. Either is governed identically; the native
 * one is demonstrated here because it is the route where the interesting part is load-bearing.
 *
 * That interesting part is where the counters live. Groq's streamed chunks carry **no top-level
 * `usage` at all** - `ChatCompletionChunk` does not even declare the field - so the totals arrive
 * under `x_groq.usage` on the final chunk and there is nowhere else to look. There is no
 * `stream_options: { include_usage: true }` to ask for them either: the parameter does not exist in
 * this SDK, and usage simply arrives. So a reader that only checked the chunk root metered every
 * streamed Groq call at nothing, which is the bug `groqRecipe` exists to have fixed.
 *
 * Through the OpenAI-compatible endpoint that read is belt-and-braces - Groq's own spec says
 * `include_usage` populates a root `usage` there as well - which is exactly why the example streams
 * through the native client instead. Here the `x_groq` read is the only thing standing between a
 * real call and a measurement of zero.
 *
 * Two more things worth watching:
 *
 *  - **The event name is `groq.chat.completions.create`**, not `openai.*`. Shape alone cannot tell
 *    these two clients apart - both have `chat.completions.create` - so the hostname is what earns
 *    Groq a vendor name of its own, and a per-provider budget something to filter on.
 *  - **The same field means something else when buffered.** On a non-streamed response
 *    `x_groq.usage` is hardware cache statistics, not tokens. Only the streamed reader consults it.
 *
 * Note the `recipe` below. Against the real API it is matched automatically by hostname; against
 * the built-in offline mock the host is `127.0.0.1`, so the guard rightly declines and the example
 * names it explicitly. That is the same escape hatch any caller has for a Groq deployment behind a
 * proxy or a custom `GROQ_BASE_URL`.
 *
 * Run:  yarn example-client-groq
 */
import Groq from 'groq-sdk';
import { groqRecipe } from '../../src';
import { consumeStream } from './core/openai-stream';
import { startChat } from './core/chat';
import type { ChatVendor, GovernedVendorClient } from './core/vendor';

export const groqVendor: ChatVendor = {
  id: 'groq',
  label: 'Groq',
  model: process.env.AGENT_SDK_GROQ_MODEL ?? 'llama-3.3-70b-versatile',
  keyVars: ['AGENT_SDK_GROQ_API_KEY', 'GROQ_API_KEY'],
  // Only a prefix to route on: unlike the `openai` package, this client builds the whole path
  // itself and appends `/openai/v1/chat/completions` to whatever base it is given.
  mockBaseUrl: (base) => `${base}/groq`,
  // Named rather than detected, only because the mock cannot be on `api.groq.com`. See the header.
  recipe: groqRecipe,

  // No base URL of our own when live: the SDK already defaults to `https://api.groq.com`, which is
  // the hostname the recipe matches on.
  createClient: ({ apiKey, baseUrl }) => new Groq({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) }),

  async send(client: GovernedVendorClient<Groq>, messages, system, stiggContext) {
    const stream = await client.chat.completions.create({
      model: groqVendor.model,
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: 1024,
      stream: true,
      // No `stream_options` here, deliberately - this SDK has no such parameter. The counters are
      // not opted into; they arrive under `x_groq` on the final chunk, and `consumeStream` reads
      // them from there.
      stiggContext,
    });

    const { text, usage, stopReason } = await consumeStream<Groq.CompletionUsage>(stream);

    messages.push({ role: 'assistant', content: text });
    return { usage, stopReason };
  },
};

startChat(groqVendor);
