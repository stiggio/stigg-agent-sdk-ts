/**
 * The Cloudflare Workers AI helper.
 *
 * This uses Cloudflare's **own** client, the `cloudflare` package, whose inference method is
 * `ai.run(model, inputs)`. The other way to reach Workers AI is an `OpenAI` client pointed at
 * `https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`, and `workersAiRecipe` claims that one
 * too - it matches on the hostname, and both clients sit on `api.cloudflare.com`. Either is
 * governed; the native one is demonstrated here because it is the route where the limitations are
 * load-bearing, and they are the thing worth seeing.
 *
 * **Workers AI is a provider, not a gateway.** Cloudflare runs these models on its own GPUs and
 * invoices them to your Cloudflare account, which is the test that decides the category here. The
 * `@cf/<author>/<model>` ids look like a reseller's catalogue and are not one: `<author>` is who
 * made the weights, not who bills for running them.
 *
 * Three things to watch, each an absence rather than a gap:
 *
 *  - **No cost, and no neurons.** Cloudflare bills Workers AI in Neurons and states none of them on
 *    any response. So the turn below meters tokens, and `cost` is absent rather than zero.
 *  - **No model dimension on this route.** The model is `ai.run`'s first *argument* and the result
 *    echoes nothing back, so there is no served model to attribute. Nothing is lost that matters -
 *    Workers AI does not route, so what was asked for is what ran - but a meter that wants the
 *    model can have it from the context, which is what `dimensions` below is doing.
 *  - **This turn does NOT stream.** Asked for a stream, `ai.run` hands back the raw SSE byte stream
 *    rather than parsed chunks, so there is no `usage` block anywhere to read and the recipe
 *    attaches no reader rather than one that would report a zero. Buffered is the route that
 *    meters, so this example is buffered - and it is the only client example here that is. To
 *    stream Workers AI and still meter it, use the OpenAI-compatible route.
 *
 * Note the `recipe` below. Against the real API it is matched automatically by hostname; against
 * the built-in offline mock the host is `127.0.0.1`, so the guard rightly declines and the example
 * names it explicitly - the same escape hatch any caller has for a non-public endpoint.
 *
 * Run:  yarn workspace @stigg/agent-sdk-js run example-client-workers-ai
 */
import '../shared/load-env';
import Cloudflare from 'cloudflare';
import { cloudflareRecipe } from '../../src';
import { startGateway } from './core/gateway';
import { optionalEnv } from './core/vendor';
import type { CostReading, GatewayVendor } from './core/vendor';

/** Required by every `ai.run` call - it is part of the path, not the body. */
const ACCOUNT_ID = process.env.AGENT_SDK_CLOUDFLARE_ACCOUNT_ID ?? 'offline-mock-account';

/** `ai.run` states the three OpenAI counters when it states any, and may state none at all. */
const readTokens = (usage: any): CostReading['tokens'] =>
  usage
    ? {
        prompt: usage.prompt_tokens ?? 0,
        // Workers AI sends neither, and the printed line says zero rather than inventing one.
        cached: 0,
        completion: usage.completion_tokens ?? 0,
        reasoning: 0,
      }
    : undefined;

export const cloudflareGateway: GatewayVendor<Cloudflare> = {
  label: 'Cloudflare',
  agentSuffix: 'gateway-cloudflare',
  model: process.env.AGENT_SDK_CLOUDFLARE_MODEL ?? '@cf/meta/llama-3.1-8b-instruct',
  keyVars: ['AGENT_SDK_CLOUDFLARE_API_KEY', 'CLOUDFLARE_API_TOKEN'],

  baseUrl: optionalEnv('AGENT_SDK_CLOUDFLARE_BASE_URL') ?? 'https://api.cloudflare.com/client/v4',
  // This client builds the rest of the path itself, appending `/accounts/<id>/ai/run/<model>`.
  mockBaseUrl: (base) => `${base}/cloudflare/client/v4`,

  createClient: ({ apiKey, baseUrl }) => new Cloudflare({ apiToken: apiKey, baseURL: baseUrl }),

  // No `createProxyClient`: the header path forwards the OpenAI wire format, and `ai.run` is not
  // it. Fronting Workers AI that way would mean a proxy speaking Cloudflare's own path shape,
  // which is a different example - so the script runs the half that applies and says so.

  // Named rather than detected, only because the mock cannot be on `api.cloudflare.com`. Against
  // the real endpoint the hostname matches it without being told, as it does for AI Gateway.
  recipe: (baseUrl) => cloudflareRecipe({ baseUrl }),

  /**
   * Tokens, because there is no price to bill.
   *
   * Neither Cloudflare product states a cost on any response: Workers AI publishes no Neuron
   * count, and AI Gateway's figure lives in its own log, is an estimate, and is zero on a cache
   * hit. So this is sized like the Bedrock and Databricks helpers rather than the two gateways
   * that bill `cost` in fractions.
   */
  // See the header: this client has no usable streamed form, so the runner skips that pass
  // rather than letting this helper issue a second buffered request and bill it twice.
  streams: false,

  billedMetrics: { total_tokens: 1 },

  async turn(client, { prompt }) {
    // Buffered, never streamed - and that is a fact about this surface rather than a shortcut
    // here. A streamed `ai.run` hands back raw SSE bytes rather than parsed chunks, so there is no
    // usage block to read; the recipe attaches no stream reader to it for the same reason.
    const result: any = await (client as any).ai.run(cloudflareGateway.model, {
      account_id: ACCOUNT_ID,
      messages: [{ role: 'user' as const, content: prompt }],
      max_tokens: 300,
    });

    const text: string = result?.response ?? '(no content)';
    process.stdout.write(`${text}\n`);

    return {
      // No cost anywhere, and none invented.
      cost: undefined,
      // The model, because the response cannot state it: `ai.run` took it as the first argument
      // and echoes nothing back. Workers AI does not route, so asked-for is what ran.
      servedModel: cloudflareGateway.model,
      // This surface returns no id of its own, so the turn has none to deduplicate on.
      idempotencyKey: '',
      // `usage` is optional on this result type, and a model that reported none meters nothing
      // rather than zeroes - which is what the printed line will show when it is absent.
      tokens: readTokens(result?.usage),
    };
  },

  /** Tokens rather than micro-credits, so this is sized like the Bedrock helper's. */
  budget: 2_000,
};

startGateway(cloudflareGateway);
