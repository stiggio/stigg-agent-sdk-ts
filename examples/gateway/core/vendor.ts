/**
 * What differs between one gateway and the next, and nothing else.
 *
 * The same split the client examples make, for the same reason: both gateway scripts were ~72%
 * byte-identical, so every fix to the governance wiring had to be made twice and the second one
 * drifted. Governance is not gateway-specific work; what is gateway-specific is where the money
 * is written down, which id is stable enough to deduplicate a retry - and, since OpenRouter
 * publishes an SDK of its own, what the client object even looks like.
 *
 * That last one is why `turn` exists rather than the script building the call itself. A gateway
 * example that only ever called `chat.completions.create` could govern exactly one kind of client,
 * which quietly made "gateway" mean "OpenAI-compatible client pointed somewhere else" - true of
 * LiteLLM, and not true of the SDK OpenRouter tells you to use.
 */
import type OpenAI from 'openai';
import type { ClientRecipe } from '../../../src';

/** The token breakdown a turn reports, in neither vendor's spelling. */
export type TokenBreakdown = {
  prompt: number;
  /** Already inside `prompt`, as both gateways count it. Printed beside it, never added to it. */
  cached: number;
  completion: number;
  /** Already inside `completion`, the same way. */
  reasoning: number;
};

/** The two places a gateway states what it charged, and how to read each. */
export type CostReading = {
  /** Credits or dollars, as the gateway stated them. Absent when it did not say. */
  cost?: number;
  /** The gateway's own id for this call - stable across its retries, unlike a local counter. */
  idempotencyKey: string;
  servedModel?: string;
  /**
   * Vendor-neutral on purpose. Each client spells these differently - `prompt_tokens` over the
   * wire, `promptTokens` through OpenRouter's own SDK - and the script that prints them should
   * not have to know which client produced the turn it is reporting on.
   */
  tokens?: TokenBreakdown;
};

export type GatewayVendor<TClient extends object = any> = {
  label: string;
  model: string;
  /**
   * This gateway's own agent, as a suffix on the configured demo agent id.
   *
   * Its own, for the reason `agentIdFor` gives: a budget attaches to the agent, so two examples
   * sharing an id means one spends what the other had left. It matters more here than between the
   * chat examples, because these two bill in a different unit entirely - a gateway call is
   * thousands of micro-credits where a chat turn is about one credit - so a gateway sharing the
   * id that `example-setup` seeds at a handful of credits is refused on its first call.
   *
   * Distinct from the client examples' suffixes, which are the bare vendor names: `openrouter` is
   * already the chat example's agent, and this is not that agent.
   */
  agentSuffix: string;
  /** The first name that is set wins; the bare vendor name is the fallback. */
  keyVars: string[];
  /**
   * Whether this gateway has a real identity to call with, when an env var cannot answer that.
   *
   * `keyVars` assumes a credential is a string in the environment, which is true of every gateway
   * here but one. AWS resolves credentials through a chain - environment, shared profile, SSO, web
   * identity, container and instance roles - and on a host using any of the last four there is no
   * variable to find. Deciding by env var there picks the offline mock on a machine that was
   * perfectly able to make the call, and says "No API key found" about an identity that exists.
   *
   * Given, this answers instead of `keyVars`.
   */
  hasCredentials?: () => Promise<boolean>;
  /** Where the real service lives, when a key is present. */
  baseUrl: string;
  /** The mock serves every gateway on one port, so each takes a different prefix of it. */
  mockBaseUrl: (base: string) => string;
  /** The client the example governs - whatever object this gateway is actually called through. */
  createClient: (options: { apiKey: string; baseUrl: string }) => TClient;
  /**
   * The proxy's own client to the upstream, which is a different job and may be a different object.
   *
   * A proxy forwards the request it was handed, so it speaks the wire format rather than any
   * vendor's SDK - and both gateways serve the OpenAI one. Separate from `createClient` because
   * the thing being *governed* is the application's client, and the thing doing the *forwarding*
   * is infrastructure; collapsing them is what made the OpenRouter example look like it had no
   * SDK of its own.
   *
   * Optional, because not every gateway can be fronted this way. The header path forwards the
   * OpenAI wire format, and Bedrock does not speak it - a proxy for Bedrock would have to speak
   * SigV4 and the Converse protocol, which is a different example. Left out, the script says so
   * and runs the half that applies rather than pretending.
   */
  createProxyClient?: (options: { apiKey: string; baseUrl: string }) => OpenAI;
  /** Named explicitly here, because the examples bill the cost rather than the tokens. */
  recipe: (baseUrl: string) => ClientRecipe;
  /**
   * The id the proxy deduplicates a retry by, read off the response it forwarded.
   *
   * The only vendor-specific thing left on that path. The proxy observes the OpenAI wire format
   * whichever gateway is behind it - so the usage it reports is simply `data.usage` - but which
   * id is stable across the *gateway's* own retries is the gateway's business: OpenRouter puts it
   * in the body, LiteLLM in a header.
   */
  proxyIdempotencyKey?: (data: OpenAI.ChatCompletion, headers: Headers) => string;
  /**
   * What this gateway's spend is measured in, as a weighting over the metrics its recipe reports.
   *
   * `{ cost: 1 }` for the two that state a price, which is the whole "bill the money, not the
   * tokens" point. Bedrock states none - its response carries token counters and nothing else -
   * so it bills tokens, and this is where that difference lives rather than in a hidden default
   * that would quietly report nothing for a gateway whose recipe has no `cost` to find.
   */
  billedMetrics: Record<string, number>;
  /**
   * One governed turn, in the client's own API, streamed to stdout.
   *
   * The vendor owns the call because only it knows the shape - where the model goes, what a
   * fallback list is called, how a stream is consumed - and owns the reading because only it
   * knows where the money landed. The script around it is identical either way, which is the
   * point the examples are making.
   */
  turn: (client: TClient, options: { prompt: string; stream: boolean }) => Promise<CostReading>;
  /**
   * Whether this gateway's client can stream a turn. Default true.
   *
   * Not every one can: Databricks' own client accepts `stream: true` but its streamed return type
   * is undocumented, and Cloudflare's `ai.run` hands back raw SSE bytes with no usage in them. A
   * helper that ignored the runner's streamed pass would simply issue a second buffered request
   * and ingest it - two calls billed where the output claims one. Said out loud and skipped, for
   * the same reason an absent `createProxyClient` is.
   */
  streams?: boolean;
  /**
   * Budget, in whatever unit the recipe reports. These examples bill `cost`, and both gateways
   * price a call in fractions - so the meter is fine-grained enough not to round every call up to
   * one, and the budget is sized in those units rather than in calls.
   */
  budget: number;
};

/** Reads the first name that is set. Prefixed names win; the bare vendor name is a fallback. */
export function optionalEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}
