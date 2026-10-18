/**
 * The Anthropic helper.
 *
 * Note what is *not* here: no check, no ingest, no mention of a budget. The client is built and
 * a turn is streamed exactly as it would be without Stigg - `stigg.wrap()` and `run.start()` in
 * the shared script are the whole integration.
 *
 * Run:  yarn example-client-anthropic
 */
import Anthropic from '@anthropic-ai/sdk';
import { startChat } from './core/chat';
import type { ChatVendor, GovernedVendorClient } from './core/vendor';

export const anthropicVendor: ChatVendor = {
  id: 'anthropic',
  label: 'Anthropic',
  model: process.env.AGENT_SDK_ANTHROPIC_MODEL ?? 'claude-opus-5',
  keyVars: ['AGENT_SDK_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
  // The SDK appends /v1/messages itself, so the mock's root is the right base.
  mockBaseUrl: (base) => base,

  createClient: ({ apiKey, baseUrl }) => new Anthropic({ apiKey, baseURL: baseUrl }),

  async send(client: GovernedVendorClient<Anthropic>, messages, system, stiggContext) {
    // `stream()` stays synchronous and the listener is attached before anything is awaited -
    // the wrapper gates the `messages.create` leg underneath, so this call site is untouched.
    const stream = client.messages.stream({
      model: anthropicVendor.model,
      max_tokens: 1024,
      system,
      messages: messages as Anthropic.MessageParam[],
      // Overrides whatever `wrap` was given, for this turn only. `stream()` reaches the wire
      // through the gated `messages.create`, so the context arrives there and is stripped.
      stiggContext,
    });
    stream.on('text', (text) => process.stdout.write(text));

    // A refusal surfaces here, as a rejection - which is where a stream caller already handles failure.
    const final = await stream.finalMessage();
    messages.push({ role: 'assistant', content: final.content.map((b) => (b.type === 'text' ? b.text : '')).join('') });

    return {
      usage: final.usage,
      stopReason: final.stop_reason === 'end_turn' ? undefined : (final.stop_reason ?? undefined),
    };
  },
};

startChat(anthropicVendor);
