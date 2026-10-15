/**
 * The Ollama helper - the one vendor here that bills nobody.
 *
 * Ollama runs on hardware the customer already owns, so there is no invoice behind these numbers
 * and no `cost` on the response. What the budget is protecting is **capacity**: a per-agent or
 * per-team cap on a shared box, enforced before the call rather than reconciled after it. That is
 * the same gate every other example demonstrates; only the thing being rationed differs.
 *
 * Two shape details drive the binding, and both show up here:
 *
 *  - **The client is flat.** `chat` and `generate` are methods on the client object itself, with
 *    no namespace, so the recipe needs three markers (`chat`, `generate`, `ps`) to be sure it is
 *    not claiming some unrelated object with a `chat()` method.
 *  - **The counters are flat too, and absent until the end.** `prompt_eval_count` and
 *    `eval_count` sit on the response root rather than inside a `usage` object, and the server
 *    omits them from every streamed chunk but the last. Ollama's own types declare them required,
 *    which is simply wrong about the wire - a reader trusting that meters each chunk at zero.
 *
 * There is no API key. Set `AGENT_SDK_OLLAMA_HOST` (or `OLLAMA_HOST`) to talk to a real server;
 * with neither set the example runs against the built-in offline mock, which speaks Ollama's
 * newline-delimited JSON and omits the counters from intermediate chunks exactly as the server
 * does.
 *
 * Run:  yarn workspace @stigg/agent-sdk-js run example-client-ollama
 */
import { Ollama } from 'ollama';
import { startChat } from './core/chat';
import { optionalEnv, type ChatVendor, type GovernedVendorClient } from './core/vendor';

/** Ollama's own default, and the one it prints on startup. */
const DEFAULT_HOST = 'http://127.0.0.1:11434';

export const ollamaVendor: ChatVendor = {
  id: 'ollama',
  label: 'Ollama',
  model: process.env.AGENT_SDK_OLLAMA_MODEL ?? 'llama3.3',
  // Self-hosted, so there is no key to find. The *host* is what says "talk to the real thing" -
  // the runner starts the offline mock when none of these is set, which is the behaviour we want.
  keyVars: ['AGENT_SDK_OLLAMA_HOST', 'OLLAMA_HOST'],
  // The SDK appends /api/chat itself, so the mock needs no prefix.
  mockBaseUrl: (base) => base,

  // `host`, not `baseURL`, and read from the environment rather than from `apiKey` - a host is not
  // a credential, and the one the runner would pass is the mock's.
  createClient: ({ baseUrl }) =>
    new Ollama({ host: baseUrl ?? optionalEnv('AGENT_SDK_OLLAMA_HOST', 'OLLAMA_HOST') ?? DEFAULT_HOST }),

  async send(client: GovernedVendorClient<Ollama>, messages, system, stiggContext) {
    // A flag on the same method, not a separate one - so `ollama.chat` is the event either way,
    // and the recipe decides which reader applies by what the call actually returned.
    const stream = await client.chat({
      model: ollamaVendor.model,
      messages: [{ role: 'system', content: system }, ...messages],
      stream: true,
      stiggContext,
    });

    let text = '';
    let usage: unknown;
    let stopReason: string | undefined;

    for await (const chunk of stream) {
      const delta = chunk.message?.content;
      if (delta) {
        text += delta;
        process.stdout.write(delta);
      }
      // Only the final chunk carries these. Read off the root, because there is no `usage` key -
      // and printed from the same two fields the recipe meters.
      if (chunk.done) {
        usage = { prompt_eval_count: chunk.prompt_eval_count, eval_count: chunk.eval_count };
        if (chunk.done_reason && chunk.done_reason !== 'stop') stopReason = chunk.done_reason;
      }
    }

    messages.push({ role: 'assistant', content: text });
    return { usage, stopReason };
  },
};

startChat(ollamaVendor);
