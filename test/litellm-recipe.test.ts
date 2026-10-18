/**
 * The LiteLLM recipe, and the constraint that shapes it.
 *
 * A gateway you call knows two things a token counter cannot recover: what the call really cost,
 * and which deployment actually served. LiteLLM knows both - but it writes the cost into a
 * response header, not the body, and headers go on the wire before the model has produced a
 * token. So the same recipe bills real spend on a non-streaming call and falls back to tokens on
 * a streamed one. These tests pin both halves, and the seam that lets a recipe see a header at all.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { litellmRecipe } from '../src/bindings/client/gateways/litellm/litellm-recipe';
import type { LiteLLMRecipeOptions } from '../src/bindings/client/gateways/litellm/types';

import { openAIRecipe } from '../src/bindings/client/providers/openai/openai-recipe';
import { openrouterRecipe } from '../src/bindings/client/gateways/openrouter/openrouter-recipe';
import { createClientRegistry } from '../src/bindings/client/core/registry';
import { wrapClient } from '../src/bindings/client/core/wrap-client';
import { FakeEngine, type FakeEngineOptions } from './fake-engine';
import { newRun } from './session-harness';

/** As in the OpenRouter cases: the spend meter is opt-in, and the recipe defaults to tokens. */
const costRecipe = (options: LiteLLMRecipeOptions = {}) => litellmRecipe({ ...options });

const BASE_URL = 'http://litellm.internal:4000/v1';
const COST = 0.00108;
const CALL_ID = 'chatcmpl-call-9f2';
const USAGE = {
  prompt_tokens: 21,
  completion_tokens: 39,
  prompt_tokens_details: { cached_tokens: 7 },
};

/** Headers as the transport hands them over: string values, and absent reads as null. */
const headersOf = (values: Record<string, string>) => ({
  get: (name: string) => values[name.toLowerCase()] ?? null,
});

/**
 * An OpenAI-shaped client pointed at a LiteLLM proxy.
 *
 * `headers` is the whole point: the body it returns carries no cost field, because a real proxy's
 * never does. A streamed call is given no cost header, which is what a real one omits.
 */
function fakeProxy(response: any, headers: Record<string, string> = {}) {
  return {
    baseURL: BASE_URL,
    chat: {
      completions: {
        create(params: any) {
          const data = params.stream
            ? {
                [Symbol.asyncIterator]: async function* () {
                  yield { id: response.id, model: response.model, choices: [{ delta: { content: 'hi' } }] };
                  yield { id: response.id, model: response.model, choices: [{ delta: {} }], usage: response.usage };
                },
              }
            : response;
          const promise: any = Promise.resolve(data);
          promise.withResponse = async () => ({ data, response: { status: 200, headers: headersOf(headers) } });
          return promise;
        },
      },
    },
  };
}

const completion = (usage: any = USAGE) => ({
  id: 'chatcmpl-body-id',
  // A model group resolves to a concrete deployment: what served, not what was asked for.
  model: 'gpt-5-2025-08-07',
  usage,
});

const priced = (cost: number = COST) => ({
  'x-litellm-response-cost': String(cost),
  'x-litellm-call-id': CALL_ID,
});

function harness(options: FakeEngineOptions = { usageLimit: null }) {
  const engine = new FakeEngine(options);
  const run = newRun({
    engine,
    dimensions: { agentId: 'agent-1', teamId: 'team-eng' },
    ingestMode: 'sync',
    checkErrorAction: 'deny',
  });
  return { engine, run };
}

describe('litellmRecipe', () => {
  it('bills the dollars the proxy charged, from a header the body never carries', async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeProxy(completion(), priced()), costRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'gpt-5' });
    await run.drain();

    // 0.00108 USD in micro-dollars. The token path would have said 1 - a 1000x difference, and
    // the wrong number, because the mapper cannot see a price that never entered the body.
    assert.equal(engine.metricsSeen.at(-1)?.cost, 1080);
  });

  it('keeps the exact price in `raw`, where only the rounded metric used to survive', () => {
    const measured = costRecipe().methods[0].extractUsage?.(completion(), { headers: headersOf(priced()) });

    // `raw` is the vendor block an event carries, and it is built from the response body - which
    // for this proxy never holds the cost. So the ceil'd `metrics.cost` was the only record of a
    // fraction the proxy had stated exactly, and nothing downstream could reconcile the bill.
    assert.equal((measured as { raw: Record<string, unknown> }).raw.cost, COST);
    assert.equal((measured as { metrics: { cost: number } }).metrics.cost, 1080);
  });

  it('leaves `raw` as the body when the proxy priced nothing, rather than inventing a zero', () => {
    const measured = costRecipe().methods[0].extractUsage?.(completion(), { headers: headersOf({}) });

    assert.equal('cost' in (measured as { raw: Record<string, unknown> }).raw, false);
  });

  it('survives float noise rather than billing an extra unit for it', async () => {
    const { engine, run } = harness();
    // 0.000123 * 1e6 is 123.00000000000001 in IEEE 754, so a naive ceil would charge 124.
    const client = wrapClient(fakeProxy(completion(), priced(0.000123)), costRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'gpt-5' });
    await run.drain();
    assert.equal(engine.metricsSeen.at(-1)?.cost, 123);
  });

  it('never bills zero for a call that did cost something', async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeProxy(completion(), priced(0.0000004)), costRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'gpt-5' });
    await run.drain();
    assert.equal(engine.metricsSeen.at(-1)?.cost, 1);
  });

  it('attributes the spend to the deployment that actually served, so routing drift is visible', async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeProxy(completion(), priced()), costRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'gpt-5' });
    await run.drain();

    assert.deepEqual(engine.dimensionsSeen[0], {
      agentId: 'agent-1',
      teamId: 'team-eng',
      // Asked for the group `gpt-5`, served by a pinned deployment - merged over the run's own.
      model: 'gpt-5-2025-08-07',
    });
  });

  it("keys on the proxy's call id, so its retry cannot double-charge", async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeProxy(completion(), priced()), costRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'gpt-5' });
    await client.chat.completions.create({ model: 'gpt-5' });
    await run.drain();

    assert.equal(engine.reports, 2, 'both were sent');
    assert.equal(engine.metricsSeen.at(-1)?.cost, 1080, 'the second was a replay of the same proxy call');
    // The header wins over the body id: it is what the proxy's own spend logs are keyed on.
    // One key per metric, all derived from the proxy's own call id.
    assert.deepEqual(
      [...engine.seenKeys].map((key) => key.split(':')[0]),
      [CALL_ID, CALL_ID, CALL_ID, CALL_ID],
      'not a local step counter',
    );
  });

  it('falls back to the completion id when the proxy sends no call id', async () => {
    const { engine, run } = harness();
    const headers = { 'x-litellm-response-cost': String(COST) };
    const client = wrapClient(fakeProxy(completion(), headers), costRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'gpt-5' });
    await run.drain();

    assert.deepEqual([...new Set([...engine.seenKeys].map((key) => key.split(':')[0]))], ['chatcmpl-body-id']);
  });

  it('reports a stream without a cost, because the header went out before the first token', async () => {
    const { engine, run } = harness();
    // No cost header at all - exactly what a real streamed LiteLLM response omits.
    const client = wrapClient(
      fakeProxy(completion(), { 'x-litellm-call-id': CALL_ID }),
      costRecipe(),
      run.session,
      run.context,
    );
    const stream: any = await client.chat.completions.create({ model: 'gpt-5', stream: true });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const chunk of stream) {
      // drain it; the recipe meters when the stream ends
    }
    await run.drain();

    assert.equal(engine.reports, 1, 'metered once, when the stream completed');
    // The tokens were always there; only the cost is missing, so the key simply is not sent.
    assert.equal(engine.metricsSeen.at(-1)?.prompt_tokens, 21, 'the proxy still stated its tokens');
    assert.equal(engine.metricsSeen.at(-1)?.cost, undefined, 'and no cost was invented for it');
    assert.equal(engine.dimensionsSeen[0]?.model, 'gpt-5-2025-08-07', 'still attributed to what served');
  });

  it('bills a stream in dollars if the proxy ever does send the header', async () => {
    const { engine, run } = harness();
    // Forward-compatible: LiteLLM cannot do this today (BerriAI/litellm#12689). The branch exists
    // so the day it can, this recipe is already right rather than quietly still billing tokens.
    const client = wrapClient(fakeProxy(completion(), priced()), costRecipe(), run.session, run.context);
    const stream: any = await client.chat.completions.create({ model: 'gpt-5', stream: true });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const chunk of stream) {
      // drain it
    }
    await run.drain();

    assert.equal(engine.reports, 1);
    assert.equal(engine.metricsSeen.at(-1)?.cost, 1080);
  });

  it('reports the tokens even when no cost came back - they are different features', async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeProxy(completion(), {}), costRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'gpt-5' });
    await run.drain();

    // Different features, so neither is conditional on the other.
    assert.equal(engine.reports, 1);
    assert.equal(engine.metricsSeen.at(-1)?.completion_tokens, 39);
    assert.equal(engine.metricsSeen.at(-1)?.cost, undefined);
  });

  it('takes the denomination it is given', async () => {
    const { engine, run } = harness();
    const client = wrapClient(
      fakeProxy(completion(), priced()),
      costRecipe({ unitsPerDollar: 1000 }),
      run.session,
      run.context,
    );
    await client.chat.completions.create({ model: 'gpt-5' });
    await run.drain();
    assert.equal(engine.metricsSeen.at(-1)?.cost, 2, 'ceil(1.08) milli-dollars');
  });

  it('reports tokens when the transport exposes no response at all', async () => {
    const { engine, run } = harness();
    // A client whose promise has no withResponse(): the wrapper passes no response, so there is
    // no header to read. Falling back is the only honest answer; throwing would break the call.
    const bare: any = {
      baseURL: BASE_URL,
      chat: { completions: { create: () => Promise.resolve(completion()) } },
    };
    const client = wrapClient(bare, costRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'gpt-5' });
    await run.drain();

    // No response means no header, so no cost - but the body's own counters are untouched.
    assert.equal(engine.metricsSeen.at(-1)?.completion_tokens, 39, 'the tokens the body stated');
    assert.equal(engine.metricsSeen.at(-1)?.cost, undefined, 'and nothing invented for the cost');
  });

  it('still gates before the request leaves - the thing the header path cannot do', async () => {
    const { engine, run } = harness({ usageLimit: 0 });
    const client = wrapClient(fakeProxy(completion(), priced()), costRecipe(), run.session, run.context);
    await assert.rejects(() => client.chat.completions.create({ model: 'gpt-5' }) as any);
    assert.equal(engine.reports, 0, 'no spend was attempted');
  });
});

describe('litellmRecipe detection', () => {
  const create = () => undefined;
  const liteLLMClient = () => ({ baseURL: BASE_URL, chat: { completions: { create } } });
  const openRouterClient = () => ({ baseURL: 'https://openrouter.ai/api/v1', chat: { completions: { create } } });
  const openAIClient = () => ({ baseURL: 'https://api.openai.com/v1', chat: { completions: { create } } });

  it('claims its own proxy and leaves every other OpenAI-shaped client alone', () => {
    const registry = createClientRegistry([costRecipe({ baseUrl: BASE_URL }), openrouterRecipe(), openAIRecipe]);
    assert.equal(registry.find(liteLLMClient())?.vendor, 'litellm');
    assert.equal(registry.find(openRouterClient())?.vendor, 'openrouter');
    assert.equal(registry.find(openAIClient())?.vendor, 'openai');
  });

  it('recognises a proxy that says so in its hostname, when given no base URL', () => {
    // The convenience path: a deployment at litellm.<company> needs no configuration to match.
    assert.equal(costRecipe().matches?.(liteLLMClient()), true);
  });

  it('does not claim a client by shape alone - that would change the unit of account by guess', () => {
    const recipe = costRecipe();
    assert.equal(recipe.matches?.({ chat: { completions: { create } } }), false, 'no baseURL to go on');
    assert.equal(recipe.matches?.(openAIClient()), false);
    assert.equal(recipe.matches?.(openRouterClient()), false);
    assert.equal(recipe.matches?.(undefined), false);
  });

  it('matches only the configured proxy once one is named', () => {
    // A self-hosted proxy on an unremarkable hostname: the base URL is the only reliable answer.
    const recipe = costRecipe({ baseUrl: 'https://ai.acme.internal' });
    assert.equal(recipe.matches?.({ baseURL: 'https://ai.acme.internal/v1', chat: { completions: { create } } }), true);
    assert.equal(recipe.matches?.(liteLLMClient()), false, 'a different proxy is not this one');
  });
});
