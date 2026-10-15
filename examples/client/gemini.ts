/**
 * The Gemini helper.
 *
 * Same shape as the Anthropic and OpenAI ones, and the same point: what differs between vendors
 * is response parsing, not governance. `stigg.wrap()` recognises this client from its own shape
 * (`models.generateContent`) rather than from anything declared here.
 *
 * This one uses the one-shot surface, `models.generateContentStream`, replaying the conversation
 * on each turn - which is what lets the shared chat script own the history the way it does for
 * every other vendor. Gemini's other surface, `ai.chats.create(...)`, keeps that history for you
 * and has to be wrapped **in its own right**:
 *
 *     const chat = stigg.wrap(ai.chats.create({ model }), { stiggContext });
 *
 * because a `Chat` holds a private reference to the models module it was built from, so a chat
 * created off a wrapped client would call the original and never be gated. See the README.
 *
 * Run:  yarn workspace @stigg/agent-sdk-js run example-client-gemini
 */
import { GoogleGenAI } from '@google/genai';
import { startChat } from './core/chat';
import type { ChatVendor, GovernedVendorClient } from './core/vendor';

export const geminiVendor: ChatVendor = {
  id: 'gemini',
  label: 'Gemini',
  model: process.env.AGENT_SDK_GEMINI_MODEL ?? 'gemini-3.8-flash',
  keyVars: ['AGENT_SDK_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  // The SDK appends /v1beta/models/<model>:generateContent itself, so the mock's root is right.
  mockBaseUrl: (base) => base,

  createClient: ({ apiKey, baseUrl }) =>
    // `httpOptions.baseUrl` is how this SDK is pointed somewhere else - there is no `baseURL`
    // constructor field the way the other two vendors have one.
    new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) }),

  async send(client: GovernedVendorClient<GoogleGenAI>, messages, system, stiggContext) {
    const stream = await client.models.generateContentStream({
      model: geminiVendor.model,
      // Gemini calls the assistant's turns `model`, and every turn is a parts array.
      contents: messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      })),
      // The system prompt is configuration here, not a message in the transcript.
      config: { systemInstruction: system, maxOutputTokens: 1024 },
      // Overrides whatever `wrap` was given, for this turn only. The gate lifts it back out
      // before the vendor's own parameters are ever built.
      stiggContext,
    });

    let text = '';
    let usage: unknown;
    let finishReason: string | undefined;

    for await (const chunk of stream) {
      const piece = chunk.text ?? '';
      if (piece) {
        process.stdout.write(piece);
        text += piece;
      }
      // Every chunk repeats the running totals, so the last one to carry them is the whole turn -
      // which is exactly what the recipe meters. Summing them would bill this several times over.
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      const reason = chunk.candidates?.[0]?.finishReason;
      if (reason) finishReason = reason;
    }

    messages.push({ role: 'assistant', content: text });

    return { usage, stopReason: finishReason === 'STOP' ? undefined : finishReason };
  },
};

startChat(geminiVendor);
