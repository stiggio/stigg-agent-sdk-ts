/**
 * What the shared chat script needs to know about one LLM vendor - and nothing more.
 *
 * The same split the SDK itself makes: a generic runner plus a per-vendor helper. Everything that
 * differs between Anthropic, OpenAI and OpenRouter lives in a helper - which key to read, how to
 * build the client, how to stream a turn, where the usage sits on the response. The script below
 * is identical for all three, which is the point: governing a client is not vendor-specific work.
 */

import type { ChatOf, ClientRecipe, WrappedClient, StiggContext } from '../../../src';

/**
 * A vendor client as `send` receives it: already governed, and already carrying a customer.
 *
 * The second type argument is what `wrap` was given, and it is what decides whether a per-call
 * `stiggContext` still owes a `customerId`. These examples always wrap with one, so a call may
 * override anything or nothing.
 *
 * The third is which paths accept that context, and it is `ChatOf<T>` rather than the default for
 * a reason: the default is the shipped list of *namespaced* paths, and two vendors are gated on
 * one-segment ones - Gemini's `sendMessage` on a chat object, and Ollama's flat `chat`/`generate`.
 * Those are kept out of the global list on purpose, because `chat` is far too common a method name
 * to claim on every object, so naming `ChatOf<T>` here is how an example asks the same question
 * `wrap` asks: given what this client actually looks like, what does it gate?
 */
export type GovernedVendorClient<T extends object> = WrappedClient<T, { customerId: string }, ChatOf<T>>;

/** Plain text turns. Every vendor accepts a string `content`, so the script needs nothing richer. */
export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type ChatReply = {
  /**
   * Whatever the vendor reported, in the vendor's own shape. The script hands it to the SDK's
   * `normalizeUsage` - the same function the wrapper used - so the printed numbers are provably
   * the ones that were metered.
   */
  usage: unknown;
  /** Surfaced when it is not a normal end of turn, e.g. a length cap or a tool call. */
  stopReason?: string;
  /** Which model actually served. Only a gateway knows this differs from what was asked for. */
  servedModel?: string;
};

export type ChatVendor = {
  /** Short id for output and for the run's agent suffix. */
  id: string;
  label: string;
  model: string;
  /** The first name that is set wins; the bare vendor name is the fallback. */
  keyVars: string[];
  /**
   * The built-in mock serves every vendor's wire format on one port, but each SDK appends its own
   * path, so each vendor points at a different prefix of it.
   */
  mockBaseUrl: (base: string) => string;
  createClient: (options: { apiKey: string; baseUrl?: string }) => object;
  /**
   * Streams the reply to stdout and returns what the vendor reported about it.
   *
   * `stiggContext` is the only Stigg-aware thing in any helper, and it is pass-through: whatever
   * the caller hands in goes into the vendor's own parameter object, and the gate lifts it back
   * out before the vendor sees it. Omitted, the call uses the context `wrap` was given.
   */
  send: (client: any, messages: ChatMessage[], system: string, stiggContext?: StiggContext) => Promise<ChatReply>;
  /**
   * An adapter configured differently from the built-in one - a different unit of account, say.
   * Passed to `wrap(client, { recipe })`, so it applies to this client and no other; a vendor
   * the built-ins already recognise from its own shape needs nothing here.
   */
  recipe?: ClientRecipe;
};

/** Reads the first name that is set. Prefixed names win; the bare vendor name is a fallback. */
export function optionalEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}
