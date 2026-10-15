/**
 * The OpenAI helper.
 *
 * Same shape as the Anthropic one, and that is the point: the difference between the two is
 * response parsing, not governance. `stigg.wrap()` recognises this client by its own shape
 * (`chat.completions.create`) rather than by anything this file declares.
 *
 * Run:  yarn workspace @stigg/agent-sdk-js run example-client-openai
 */
import OpenAI from 'openai';
import { consumeStream } from './core/openai-stream';
import { startChat } from './core/chat';
import type { ChatVendor, GovernedVendorClient } from './core/vendor';

export const openAIVendor: ChatVendor = {
  id: 'openai',
  label: 'OpenAI',
  model: process.env.AGENT_SDK_OPENAI_MODEL ?? 'gpt-5',
  keyVars: ['AGENT_SDK_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  // The SDK appends /chat/completions, so it needs the version prefix on the base.
  mockBaseUrl: (base) => `${base}/v1`,

  createClient: ({ apiKey, baseUrl }) => new OpenAI({ apiKey, baseURL: baseUrl }),

  async send(client: GovernedVendorClient<OpenAI>, messages, system, stiggContext) {
    const stream = await client.chat.completions.create({
      model: openAIVendor.model,
      // OpenAI carries the system prompt as a message; Anthropic takes it as its own field.
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: 1024,
      stream: true,
      // Without this the terminal chunk carries no usage at all, and there is nothing to meter.
      stream_options: { include_usage: true },
      // Overrides whatever `wrap` was given, for this turn only.
      stiggContext,
    });

    const { text, usage, stopReason } = await consumeStream(stream);

    messages.push({ role: 'assistant', content: text });
    return { usage, stopReason };
  },
};

startChat(openAIVendor);
