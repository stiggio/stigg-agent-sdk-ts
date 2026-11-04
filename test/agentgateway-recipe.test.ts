/**
 * agentgateway - a self-hosted gateway you call, over two wires, that states no price.
 *
 * These pin what the recipe exists for: that a client pointed at the gateway reports as `agentgateway`
 * rather than as a direct OpenAI or Anthropic call, that the model which actually served is
 * attributed on both wires and on both the buffered and streamed paths, that the base URL decides
 * the match, and that no `cost` is declared for a number no response carries.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentgatewayRecipe } from '../src/bindings/client/gateways/agentgateway/agentgateway-recipe';
import { AGENTGATEWAY_METRICS } from '../src/bindings/shared/token-usage';
import { createClientRegistry } from '../src/bindings/client/core/registry';
import { anthropicRecipe } from '../src/bindings/client/providers/anthropic/anthropic-recipe';
import { openAIRecipe } from '../src/bindings/client/providers/openai/openai-recipe';
import type { ClientRecipe } from '../src/bindings/client/core/types';
import type { Measurement } from '../src/types';

const GATEWAY = 'https://ai.acme.internal/v1';

const openAIClient = (baseURL = GATEWAY) => ({ baseURL, chat: { completions: { create: async () => ({}) } } });
const anthropicClient = (baseURL = GATEWAY) => ({
  baseURL,
  messages: { create: async () => ({}), stream: async () => ({}) },
});

const methodAt = (path: string) => agentgatewayRecipe().methods.find((method) => method.path.join('.') === path)!;

const drive = async (path: string, chunks: any[]) => {
  const seen: Measurement[] = [];
  const iterable: any = {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
  methodAt(path).attachStream?.(iterable, (m) => seen.push(m as Measurement));
  for await (const chunk of iterable) void chunk;
  return seen;
};

describe('what a call through the gateway reports', () => {
  it('declares the union of both wires, and no cost', () => {
    // The gateway is self-hosted and puts no price on any response. Declaring
    // `cost` would type a pricing table against a number that never arrives.
    const union = new Set([...openAIRecipe.metrics, ...anthropicRecipe.metrics]);
    assert.deepEqual([...AGENTGATEWAY_METRICS].sort(), [...union].sort());
    assert.deepEqual([...agentgatewayRecipe().metrics], [...AGENTGATEWAY_METRICS]);
    assert.equal(agentgatewayRecipe().metrics.includes('cost' as never), false);
  });

  it('attributes the model that served on Chat Completions, and keys on the completion id', () => {
    const measured = methodAt('chat.completions.create').extractUsage?.({
      id: 'chatcmpl-1',
      model: 'gpt-5-mini-2025-08-07',
      usage: { prompt_tokens: 50, completion_tokens: 45, total_tokens: 95 },
    }) as Measurement;
    assert.equal(measured.metrics?.total_tokens, 95);
    assert.deepEqual(measured.dimensions, { model: 'gpt-5-mini-2025-08-07' });
    assert.equal(measured.idempotencyKey, 'chatcmpl-1');
  });

  it("reports Anthropic's own counter names on the Messages route", () => {
    const measured = methodAt('messages.create').extractUsage?.({
      id: 'msg-1',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 70, output_tokens: 30, cache_read_input_tokens: 10 },
    }) as Measurement;
    assert.equal(measured.metrics?.input_tokens, 70);
    assert.equal(measured.metrics?.cache_read_input_tokens, 10);
    assert.equal(measured.metrics?.prompt_tokens, undefined);
    assert.deepEqual(measured.dimensions, { model: 'claude-sonnet-5' });
  });

  it('reports nothing for a turn with no usage, rather than a row of zeroes', () => {
    assert.equal(methodAt('chat.completions.create').extractUsage?.({ model: 'gpt-5' }), undefined);
  });

  it('honours a caller-chosen model dimension', () => {
    const method = agentgatewayRecipe({ modelDimension: 'served_model' }).methods[0]!;
    const measured = method.extractUsage?.({
      model: 'gpt-5',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }) as Measurement;
    assert.deepEqual(measured.dimensions, { served_model: 'gpt-5' });
  });
});

describe('streamed attribution on both wires', () => {
  it('keeps the model a Chat Completions stream states on its chunks', async () => {
    const seen = await drive('chat.completions.create', [
      { id: 'c-1', model: 'gpt-5-mini-2025-08-07', choices: [{ delta: { content: 'hi' } }] },
      {
        id: 'c-1',
        model: 'gpt-5-mini-2025-08-07',
        choices: [],
        usage: { prompt_tokens: 50, completion_tokens: 45, total_tokens: 95 },
      },
    ]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.metrics?.total_tokens, 95);
    assert.equal(seen[0]!.dimensions?.model, 'gpt-5-mini-2025-08-07');
  });

  it('keeps the model an Anthropic stream states in message_start', async () => {
    const seen = await drive('messages.create', [
      {
        type: 'message_start',
        message: { id: 'msg-1', model: 'claude-sonnet-5', usage: { input_tokens: 70, output_tokens: 0 } },
      },
      { type: 'message_delta', usage: { output_tokens: 30 } },
      { type: 'message_stop' },
    ]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.dimensions?.model, 'claude-sonnet-5');
    assert.equal(seen[0]!.metrics?.output_tokens, 30);
  });
});

describe('recognising the gateway', () => {
  const matches = (client: unknown, baseUrl?: string) => agentgatewayRecipe({ baseUrl }).matches!(client);

  it('claims both client shapes at the configured base URL', () => {
    assert.equal(matches(openAIClient(), GATEWAY), true);
    assert.equal(matches(anthropicClient(), GATEWAY), true);
  });

  it('declines a neighbouring path, a different host, and a client with neither surface', () => {
    // `.../v10` is a different deployment; a prefix match on the raw string would claim it.
    assert.equal(matches(openAIClient('https://ai.acme.internal/v10'), GATEWAY), false);
    assert.equal(matches(openAIClient('https://api.openai.com/v1'), GATEWAY), false);
    assert.equal(matches({ baseURL: GATEWAY, models: {} }, GATEWAY), false);
  });

  it('falls back to a whole hostname label when no base URL is given', () => {
    assert.equal(matches(anthropicClient('http://agentgateway.agentgateway-system.svc:8080')), true);
    assert.equal(matches(openAIClient('https://agentgateway.acme.internal/v1')), true);
    // Substrings are somebody else's hostname.
    assert.equal(matches(openAIClient('https://myagentgateway.example.com/v1')), false);
    // A hyphenated label counts only when it *starts* with the name - which is the default
    // install's service and namespace - so a name later in the label is somebody else's host.
    assert.equal(matches(openAIClient('http://agentgateway-proxy.agentgateway-system.svc/v1')), true);
    assert.equal(matches(openAIClient('https://my-solo.example.com/v1')), false);
    assert.equal(matches(openAIClient('https://my-agentgateway.example.com/v1')), false);
  });

  it('never guesses on Solo’s or Gloo’s names, which customers pick for their own resources', () => {
    // Each of these is somebody else's endpoint - an Azure resource, a Databricks workspace, a
    // LiteLLM proxy in a Gloo namespace - and claiming it would move its calls out of their meters.
    for (const host of [
      'https://solo-prod.openai.azure.com/openai/v1',
      'https://gloo-x.cloud.databricks.com/serving-endpoints',
      'http://litellm.gloo-system.svc/v1',
      'http://ai-gateway.gloo-system.svc.cluster.local/v1',
    ]) {
      assert.equal(matches(openAIClient(host)), false, host);
    }
    // Solo's and Gloo's builds are named by the base URL instead.
    const solo = 'http://ai-gateway.gloo-system.svc.cluster.local/v1';
    assert.equal(matches(openAIClient(solo), solo), true);
  });

  it('pins the guess’s known false positive, which a configured base URL settles', () => {
    // A whole label is still only a guess: any endpoint with one is claimed. That is the price of
    // a self-hosted gateway with no canonical host, documented rather than discovered - and the
    // configured base URL replaces the guess entirely.
    const lookalike = openAIClient('https://agentgateway.example.com/v1');
    assert.equal(matches(lookalike), true);
    assert.equal(matches(lookalike, GATEWAY), false);
  });
});

describe('where agentgatewayRecipe sits in the default registry', () => {
  // Read from source rather than imported, for the reason `cloudflare-recipe.test.ts` gives.
  const registrations = (): string[] => {
    const src = readFileSync(join(__dirname, '..', 'src', 'stigg-agent-sdk.ts'), 'utf8');
    const list = src.slice(src.indexOf('export const DEFAULT_RECIPES'));
    return [...list.slice(0, list.indexOf('];')).matchAll(/^\s*(\w+Recipe)[,(]/gm)].map((m) => m[1]);
  };

  it('is asked before both recipes that would otherwise claim its clients', () => {
    const order = registrations();
    assert.ok(order.includes('agentgatewayRecipe'), `agentgatewayRecipe is not registered: ${order.join(', ')}`);
    assert.ok(order.indexOf('agentgatewayRecipe') < order.indexOf('anthropicRecipe'), order.join(', '));
    assert.ok(order.indexOf('agentgatewayRecipe') < order.indexOf('openAIRecipe'), order.join(', '));
  });

  it('claims a gateway-hosted Anthropic client when asked first, and loses it when not', () => {
    const client = anthropicClient('http://agentgateway.agentgateway-system.svc:8080');
    const right = createClientRegistry([agentgatewayRecipe(), anthropicRecipe] as ClientRecipe[]);
    assert.equal(right.find(client)?.vendor, 'agentgateway');
    const wrong = createClientRegistry([anthropicRecipe, agentgatewayRecipe()] as ClientRecipe[]);
    assert.equal(wrong.find(client)?.vendor, 'anthropic');
  });
});
