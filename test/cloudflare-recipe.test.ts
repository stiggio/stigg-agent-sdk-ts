/**
 * Workers AI - a provider reached two ways, and the three things it will not tell you.
 *
 * It is a provider rather than a gateway because Cloudflare runs the models and invoices them;
 * `@cf/<author>/…` names who made the weights, not who bills. These pin that one vendor covers
 * both clients, that the counter list is Workers AI's three rather than the OpenAI set it
 * resembles, and that the absences - no cost, no neurons, no model on `ai.run` - are declared
 * rather than filled in with zeroes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cloudflareRecipe } from '../src/bindings/client/gateways/cloudflare/cloudflare-recipe';
import { CLOUDFLARE_METRICS, WORKERS_AI_PATHS } from '../src/bindings/shared/token-usage';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClientRegistry } from '../src/bindings/client/core/registry';
import { anthropicRecipe } from '../src/bindings/client/providers/anthropic/anthropic-recipe';
import type { ClientRecipe } from '../src/bindings/client/core/types';
import type { Measurement, Metrics } from '../src/types';

const CF_API = 'https://api.cloudflare.com/client/v4';
const OPENAI_ROUTE = 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1';

const USAGE = { prompt_tokens: 31, completion_tokens: 64, total_tokens: 95 };

/** The `cloudflare` package's client, as the real one is shaped - see the recipe header. */
const sdkClient = (baseURL = CF_API) => ({ baseURL, ai: { run: async () => ({}) } });

/** An `OpenAI` client pointed at the OpenAI-compatible route. */
const openAIClient = (baseURL = OPENAI_ROUTE) => ({
  baseURL,
  chat: { completions: { create: async () => ({}) } },
});

const methodAt = (path: string) => cloudflareRecipe().methods.find((method) => method.path.join('.') === path)!;

describe('what a Workers AI response reports', () => {
  it('reports its three counters and declares no more than those', () => {
    const measured = methodAt('chat.completions.create').extractUsage?.({
      usage: USAGE,
      model: '@cf/meta/llama-3.1-8b-instruct',
    });
    assert.deepEqual(Object.keys((measured as { metrics: Metrics }).metrics).sort(), [
      'completion_tokens',
      'prompt_tokens',
      'total_tokens',
    ]);
    // The Workers AI route still reports exactly its own three; `metrics` is wider because it is
    // the union across every wire this one recipe serves, which is what `metrics` is defined to be.
    assert.deepEqual([...WORKERS_AI_PATHS], ['prompt_tokens', 'completion_tokens', 'total_tokens']);
    assert.deepEqual([...cloudflareRecipe().metrics], [...CLOUDFLARE_METRICS]);
  });

  it('declares no cost and no neuron count, because no response carries either', () => {
    // Cloudflare bills Neurons and publishes none of them. Converting tokens to Neurons needs a
    // price table this package does not hold, and must not guess at.
    assert.equal(cloudflareRecipe().metrics.includes('cost' as never), false);
    assert.equal(cloudflareRecipe().metrics.includes('neurons' as never), false);
  });

  it("declares both wires' cache counters, because AI Gateway forwards either one", () => {
    // Wider than the Workers AI route alone needs. The gateway passes the upstream body through
    // untouched, so `/openai` can send `cached_tokens` and `/anthropic` the two Anthropic-spelled
    // ones - and a counter a surface can report has to be declared or no catalog can price it.
    // A Workers AI call still sends none of them, and absent stays absent.
    assert.equal(cloudflareRecipe().metrics.includes('cached_tokens' as never), true);
    assert.equal(cloudflareRecipe().metrics.includes('cache_read_input_tokens' as never), true);
    assert.equal(cloudflareRecipe().metrics.includes('cache_creation_input_tokens' as never), true);
  });

  it('reports nothing for a turn whose usage was absent, which the type says it may be', () => {
    // `usage` is optional on the binding's own result type.
    assert.equal(methodAt('ai.run').extractUsage?.({ response: 'hello' }), undefined);
  });

  it('attributes the model on the route that states one', () => {
    const measured = methodAt('chat.completions.create').extractUsage?.({
      usage: USAGE,
      model: '@cf/meta/llama-3.1-8b-instruct',
    });
    assert.deepEqual((measured as Measurement).dimensions, { model: '@cf/meta/llama-3.1-8b-instruct' });
  });

  it('attributes no model on ai.run, where the model was an argument', () => {
    // Nothing is lost that matters: Workers AI does not route, so asked-for is what ran.
    const measured = methodAt('ai.run').extractUsage?.({ response: 'hi', usage: USAGE });
    assert.equal((measured as Measurement).dimensions, undefined);
    assert.equal((measured as Measurement).metrics?.total_tokens, 95);
  });
});

describe('recognising a Cloudflare client', () => {
  const matches = (client: unknown, baseUrl?: string) => cloudflareRecipe({ baseUrl }).matches!(client);

  it('claims the cloudflare package’s own client, whose method is ai.run', () => {
    assert.equal(matches(sdkClient()), true);
  });

  it('claims an OpenAI client on the OpenAI-compatible route', () => {
    assert.equal(matches(openAIClient()), true);
  });

  it('declines either shape on somebody else’s host', () => {
    // The host is checked first precisely because shape alone would claim every
    // OpenAI-compatible client there is.
    assert.equal(matches(openAIClient('https://api.openai.com/v1')), false);
    assert.equal(matches(sdkClient('https://api.example.com/v4')), false);
  });

  it('declines a lookalike domain', () => {
    assert.equal(matches(openAIClient('https://api.cloudflare.com.attacker.net/ai/v1')), false);
  });

  it('claims the AI Gateway host too, because one account is billed for both products', () => {
    // Two products, one payer, one vendor name. Splitting them would put one account's traffic
    // under two names depending on which Cloudflare product it went through.
    assert.equal(matches(openAIClient('https://gateway.ai.cloudflare.com/v1/acct/gw/openai')), true);
  });

  it('declines a client with neither surface on it', () => {
    assert.equal(matches({ baseURL: CF_API, zones: {} }), false);
  });
});

describe('the surfaces it declares', () => {
  it('covers both clients under one vendor, because one account is billed either way', () => {
    assert.equal(cloudflareRecipe().vendor, 'cloudflare');
    assert.deepEqual(
      cloudflareRecipe().methods.map((method) => method.path.join('.')),
      ['chat.completions.create', 'responses.create', 'messages.create', 'ai.run'],
    );
  });

  it('attaches no stream reader to ai.run, rather than one that would report zero', () => {
    // A streamed `ai.run` hands back raw SSE bytes, not parsed chunks. A reader attached to those
    // would collect nothing and ingest a measurement of zero - the one failure shape nothing
    // downstream can notice. Gated and unmetered is the honest outcome; see the recipe header.
    assert.equal(methodAt('ai.run').attachStream, undefined);
    assert.notEqual(methodAt('chat.completions.create').attachStream, undefined);
  });

  it('meters a streamed OpenAI-route turn from the final chunk', async () => {
    const chunks = [
      { id: 'cf-1', model: '@cf/meta/llama-3.1-8b-instruct', choices: [{ delta: { content: 'hi' } }] },
      { id: 'cf-1', model: '@cf/meta/llama-3.1-8b-instruct', choices: [{ delta: {} }], usage: USAGE },
    ];
    const seen: Measurement[] = [];
    const iterable: any = {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) yield chunk;
      },
    };
    methodAt('chat.completions.create').attachStream?.(iterable, (m) => seen.push(m as Measurement));
    for await (const chunk of iterable) void chunk;

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.metrics?.total_tokens, 95);
    assert.deepEqual(seen[0]!.dimensions, { model: '@cf/meta/llama-3.1-8b-instruct' });
  });
});

describe('what the gateway headers decide', () => {
  const chat = () => methodAt('chat.completions.create');
  const headers = (h: Record<string, string>) =>
    ({ headers: { get: (k: string) => h[k.toLowerCase()] ?? null } }) as any;
  const USAGE_BLOCK = { prompt_tokens: 50, completion_tokens: 45, total_tokens: 95 };

  it('meters nothing for a cache hit, because nobody was billed for it', () => {
    // The cached body carries a full `usage` block, which is exactly why this has to be checked
    // before the body is read: billing it would charge for a call the upstream never saw.
    const measured = chat().extractUsage?.(
      { usage: USAGE_BLOCK, model: '@cf/x' },
      headers({ 'cf-aig-cache-status': 'HIT' }),
    );
    assert.equal(measured, undefined);
  });

  it('meters a miss normally, so the skip is not just "never report"', () => {
    const measured: any = chat().extractUsage?.(
      { usage: USAGE_BLOCK, model: '@cf/x' },
      headers({ 'cf-aig-cache-status': 'MISS' }),
    );
    assert.equal(measured?.metrics?.total_tokens, 95);
  });

  it('attaches no stream reader to a cached stream, leaving the consumer untouched', async () => {
    const seen: Measurement[] = [];
    const iterable: any = {
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [], usage: USAGE_BLOCK };
      },
    };
    chat().attachStream?.(iterable, (m) => seen.push(m as Measurement), headers({ 'cf-aig-cache-status': 'HIT' }));
    for await (const chunk of iterable) void chunk;
    assert.equal(seen.length, 0);
  });

  it('carries the routed model and the log id, which is what stands in for a cost', () => {
    const measured: any = chat().extractUsage?.(
      { usage: USAGE_BLOCK, model: 'asked-for' },
      headers({ 'cf-aig-routed-model': 'actually-served', 'cf-aig-log-id': 'log-1', 'cf-aig-step': '2' }),
    );
    assert.equal(measured.dimensions.model, 'actually-served');
    assert.equal(measured.dimensions.cf_aig_log_id, 'log-1');
    assert.equal(measured.dimensions.cf_aig_step, '2');
  });

  it('meters a streamed upstream that hides its usage off the chunk root', async () => {
    // Groq behind this gateway sends no top-level `usage` at all - its counters ride `x_groq` on
    // the final chunk. Reading only `chunk.usage` here would meter every streamed Groq call at
    // nothing, which is what `openAIRecipe` already handles and this must not regress.
    const chunks = [
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [], x_groq: { usage: { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 } } },
    ];
    const seen: Measurement[] = [];
    const iterable: any = {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) yield chunk;
      },
    };
    chat().attachStream?.(iterable, (m) => seen.push(m as Measurement));
    for await (const chunk of iterable) void chunk;

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.metrics?.total_tokens, 1000);
  });
});

describe('where cloudflareRecipe sits in the default registry', () => {
  // Read from source rather than imported: pulling in `DEFAULT_RECIPES` loads the engine, and the
  // order is a property of the declaration anyway. `module-boundaries.test.ts` asserts on source
  // text for the same reason - some contracts are not reachable at runtime from here.
  const registrations = (): string[] => {
    const src = readFileSync(join(__dirname, '..', 'src', 'stigg-agent-sdk.ts'), 'utf8');
    const list = src.slice(src.indexOf('export const DEFAULT_RECIPES'));
    return [...list.slice(0, list.indexOf('];')).matchAll(/^\s*(\w+Recipe)[,(]/gm)].map((m) => m[1]);
  };

  it('is asked before anthropicRecipe, which would otherwise claim a gateway client', () => {
    // AI Gateway forwards the upstream body untouched, so an `Anthropic` client pointed at it is
    // an Anthropic client by shape and only the hostname says otherwise - and `anthropicRecipe`
    // has no base-URL guard. Asked first it claims the client and meters gateway traffic as
    // direct Anthropic traffic.
    const order = registrations();
    assert.ok(order.includes('cloudflareRecipe'), `cloudflareRecipe is not registered: ${order.join(', ')}`);
    assert.ok(
      order.indexOf('cloudflareRecipe') < order.indexOf('anthropicRecipe'),
      `cloudflareRecipe must precede anthropicRecipe, got: ${order.join(', ')}`,
    );
    assert.ok(
      order.indexOf('cloudflareRecipe') < order.indexOf('openAIRecipe'),
      `cloudflareRecipe must precede openAIRecipe, got: ${order.join(', ')}`,
    );
  });

  it('claims a gateway-hosted Anthropic client when asked first, and loses it when not', () => {
    // Both halves, because this is an ordering guarantee rather than a mutual exclusion: the two
    // recipes genuinely both match this client, so the second assertion is what the first is for.
    const anthropicAtGateway = {
      baseURL: 'https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic',
      messages: { create: () => undefined, stream: () => undefined },
    };
    const right = createClientRegistry([cloudflareRecipe(), anthropicRecipe] as ClientRecipe[]);
    assert.equal(right.find(anthropicAtGateway)?.vendor, 'cloudflare');

    const wrong = createClientRegistry([anthropicRecipe, cloudflareRecipe()] as ClientRecipe[]);
    assert.equal(wrong.find(anthropicAtGateway)?.vendor, 'anthropic');
  });
});

describe('where ai.run keeps its context', () => {
  it('declares the second argument, because the model is the first', () => {
    // `ai.run(model, inputs)`. Left at the default the wrapper would read the model string,
    // find no `stiggContext` on it, gate on the wrap-time context, and forward the caller's
    // override to Cloudflare as an unknown input - wrong in both directions, and silently.
    assert.equal(methodAt('ai.run').contextArg, 1);
    assert.equal(methodAt('chat.completions.create').contextArg, undefined);
  });
});

describe('streamed attribution across the wires the gateway forwards', () => {
  const drive = async (path: string, chunks: any[], response?: any) => {
    const seen: Measurement[] = [];
    const iterable: any = {
      [Symbol.asyncIterator]: async function* () {
        for (const c of chunks) yield c;
      },
    };
    methodAt(path).attachStream?.(iterable, (m) => seen.push(m as Measurement), response);
    for await (const c of iterable) void c;
    return seen;
  };

  it('keeps the model an Anthropic stream states in message_start', async () => {
    // No `cf-aig-routed-model` header here, which is the ordinary case for a gateway route that
    // did not go through Auto Router. The buffered path reads `result.model`; before this the
    // streamed path had nothing to read and the turn lost its model entirely.
    const seen = await drive('messages.create', [
      {
        type: 'message_start',
        message: { id: 'msg-1', model: 'claude-sonnet-4-6', usage: { input_tokens: 70, output_tokens: 0 } },
      },
      { type: 'message_delta', usage: { output_tokens: 30 } },
      { type: 'message_stop' },
    ]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.dimensions?.model, 'claude-sonnet-4-6');
  });

  it('still prefers the routed model when the gateway states one', async () => {
    const seen = await drive(
      'messages.create',
      [
        {
          type: 'message_start',
          message: { id: 'msg-1', model: 'asked-for', usage: { input_tokens: 70, output_tokens: 0 } },
        },
        { type: 'message_delta', usage: { output_tokens: 30 } },
      ],
      { headers: { get: (k: string) => (k.toLowerCase() === 'cf-aig-routed-model' ? 'actually-served' : null) } },
    );
    assert.equal(seen[0]!.dimensions?.model, 'actually-served');
  });
});
