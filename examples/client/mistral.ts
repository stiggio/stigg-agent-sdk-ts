/**
 * The Mistral helper.
 *
 * Mistral is not OpenAI-shaped: the method is `chat.complete`, and streaming is a *different
 * method* (`chat.stream`) rather than a flag on the same one. So `wrap()` recognises this client
 * by `chat.complete` plus `chat.stream`, and the event name says which of the two was called.
 *
 * The thing worth watching is the counter names. The API sends `prompt_tokens` on the wire; the
 * generated SDK renames it to `promptTokens` before you ever see it. The recipe reads the
 * camelCase the client hands over and reports the **wire's** snake_case, so one Mistral account
 * reads as one vocabulary whether the application holds this client or an `OpenAI` one pointed at
 * `api.mistral.ai/v1`. The printed usage below is the camelCase object the SDK produced; the
 * metered metrics are the snake_case names - that is not a mismatch, it is the point.
 *
 * Mistral has two call styles this binding cannot reach, and neither is hypothetical:
 * `chatComplete(client, …)` imported from `@mistralai/mistralai/funcs/` bypasses the patched
 * method entirely, and a stream read through `getReader()` rather than `for await` bypasses the
 * metered iterator. This example uses the governed paths - the methods, and `for await`.
 *
 * Run:  yarn example-client-mistral
 */
import { Mistral } from '@mistralai/mistralai';
import { startChat } from './core/chat';
import type { ChatVendor, GovernedVendorClient } from './core/vendor';

export const mistralVendor: ChatVendor = {
  id: 'mistral',
  label: 'Mistral',
  model: process.env.AGENT_SDK_MISTRAL_MODEL ?? 'mistral-small-latest',
  keyVars: ['AGENT_SDK_MISTRAL_API_KEY', 'MISTRAL_API_KEY'],
  // The SDK appends /v1/chat/completions itself, so the mock only needs a prefix to route on.
  mockBaseUrl: (base) => `${base}/mistral`,

  // `serverURL` rather than a `baseURL`: Mistral serves from three regional hosts and lets a
  // single request override the lot, which is also why the recipe matches on shape, not hostname.
  createClient: ({ apiKey, baseUrl }) => new Mistral({ apiKey, ...(baseUrl ? { serverURL: baseUrl } : {}) }),

  async send(client: GovernedVendorClient<Mistral>, messages, system, stiggContext) {
    // A separate method from `complete`, not a flag - and its own event name.
    const stream = await client.chat.stream({
      model: mistralVendor.model,
      messages: [{ role: 'system', content: system }, ...messages],
      maxTokens: 1024,
      stiggContext,
    });

    let text = '';
    let usage: unknown;
    let stopReason: string | undefined;

    // `for await` is the governed path. `EventStream` is also a `ReadableStream`, and taking a
    // reader off it instead would stream fine and meter nothing.
    for await (const event of stream) {
      const chunk = event.data;
      const delta = chunk?.choices?.[0]?.delta?.content;
      // Mistral's delta is a string for plain text, but can be an array of content chunks.
      const piece = typeof delta === 'string' ? delta : Array.isArray(delta) ? '' : '';
      if (piece) {
        text += piece;
        process.stdout.write(piece);
      }
      const finish = chunk?.choices?.[0]?.finishReason;
      if (finish && finish !== 'stop') stopReason = String(finish);
      // One level down, under `data` - and only on the terminating chunk.
      if (chunk?.usage) usage = chunk.usage;
    }

    messages.push({ role: 'assistant', content: text });
    return { usage, stopReason };
  },
};

startChat(mistralVendor);
