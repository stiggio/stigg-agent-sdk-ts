/**
 * The OpenRouter recipe, and the contract widening it needed.
 *
 * A gateway you call knows two things a token counter cannot recover: the credits it actually
 * charged, and which model actually served after fallback routing. The point of these tests is
 * that both survive the trip into Stigg - as the ingested value, and as a dimension on it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openrouterRecipe } from '../src/bindings/client/gateways/openrouter/openrouter-recipe';
import type { OpenRouterRecipeOptions } from '../src/bindings/client/gateways/openrouter/types';

import { openAIRecipe } from '../src/bindings/client/providers/openai/openai-recipe';
import { createClientRegistry } from '../src/bindings/client/core/registry';
import { wrapClient } from '../src/bindings/client/core/wrap-client';
import { FakeEngine, type FakeEngineOptions } from './fake-engine';
import { newRun } from './session-harness';

/**
 * These cases are all about the spend meter, which is opt-in - the recipe defaults to tokens, so
 * that the gateway's richer response can be read without changing the unit of account.
 */
const costRecipe = (options: OpenRouterRecipeOptions = {}) => openrouterRecipe({ ...options });

const COST = 0.00108;
const USAGE = {
  prompt_tokens: 21,
  completion_tokens: 39,
  prompt_tokens_details: { cached_tokens: 7 },
};

/** An OpenAI-shaped client pointed at OpenRouter, returning what that gateway really returns. */
function fakeGateway(response: any) {
  return {
    baseURL: 'https://openrouter.ai/api/v1',
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
          promise.withResponse = async () => ({ data, response: { status: 200 } });
          return promise;
        },
      },
    },
  };
}

const completion = (usage: any = { ...USAGE, cost: COST }) => ({
  id: 'gen-abc123',
  model: 'anthropic/claude-sonnet-5',
  usage,
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

describe('openrouterRecipe', () => {
  it('bills the credits the gateway charged, not the tokens it happened to use', async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeGateway(completion()), costRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'anthropic/claude-opus-5' });
    await run.drain();

    // 0.00108 credits in micro-credits. The token path would have said 1 - a 1000x difference,
    // and the wrong number, because the mapper cannot know what the gateway actually charged.
    assert.equal(engine.metricsSeen.at(-1)?.cost, 1080);
  });

  it('survives float noise rather than billing an extra unit for it', async () => {
    const { engine, run } = harness();
    // 0.000123 * 1e6 is 123.00000000000001 in IEEE 754, so a naive ceil would charge 124 - an
    // overcharge on every call whose cost lands on one of these values.
    const client = wrapClient(
      fakeGateway(completion({ ...USAGE, cost: 0.000123 })),
      costRecipe(),
      run.session,
      run.context,
    );
    await client.chat.completions.create({ model: 'x' });
    await run.drain();
    assert.equal(engine.metricsSeen.at(-1)?.cost, 123);
  });

  it('never bills zero for a call that did cost something', async () => {
    const { engine, run } = harness();
    // Sub-micro-credit spend still rounds up to one unit: free calls would be a leak.
    const client = wrapClient(
      fakeGateway(completion({ ...USAGE, cost: 0.0000004 })),
      costRecipe(),
      run.session,
      run.context,
    );
    await client.chat.completions.create({ model: 'x' });
    await run.drain();
    assert.equal(engine.metricsSeen.at(-1)?.cost, 1);
  });

  it('attributes the spend to the model that actually served, so routing drift is visible', async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeGateway(completion()), costRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'anthropic/claude-opus-5' });
    await run.drain();

    assert.deepEqual(engine.dimensionsSeen[0], {
      agentId: 'agent-1',
      teamId: 'team-eng',
      // Requested opus, served sonnet - the per-call dimension is merged over the run's own.
      model: 'anthropic/claude-sonnet-5',
    });
  });

  it("keys on the gateway's request id, so its retry cannot double-charge", async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeGateway(completion()), costRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'x' });
    await client.chat.completions.create({ model: 'x' });
    await run.drain();

    assert.equal(engine.reports, 2, 'both were sent');
    assert.equal(engine.metricsSeen.at(-1)?.cost, 1080, 'the second was a replay of the same gateway request');
    // One key per metric, all derived from the gateway's own request id.
    assert.deepEqual(
      [...new Set([...engine.seenKeys].map((key) => key.split(':')[0]))],
      ['gen-abc123'],
      'not a local step counter',
    );
  });

  it('meters a stream once, when it completes, with the cost and model off its chunks', async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeGateway(completion()), costRecipe(), run.session, run.context);
    const stream: any = await client.chat.completions.create({ model: 'x', stream: true });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const chunk of stream) {
      // drain it; the recipe meters when the stream ends
    }
    await run.drain();

    assert.equal(engine.reports, 1);
    assert.equal(engine.metricsSeen.at(-1)?.cost, 1080);
    assert.equal(engine.dimensionsSeen[0]?.model, 'anthropic/claude-sonnet-5');
  });

  it('omits the cost when the response carries none - BYOK reports none', async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeGateway(completion(USAGE)), costRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'x' });
    await run.drain();

    // Tokens and cost are different features, so a missing cost is a missing key rather than a
    // fallback to something else: they are different features, neither conditional on the other.
    assert.equal(engine.reports, 1);
    assert.equal(engine.metricsSeen.at(-1)?.completion_tokens, 39, 'the gateway still stated its tokens');
    assert.equal(engine.metricsSeen.at(-1)?.cost, undefined);
  });

  it('takes the denomination it is given', async () => {
    const { engine, run } = harness();
    const client = wrapClient(
      fakeGateway(completion()),
      costRecipe({ unitsPerCredit: 1000 }),
      run.session,
      run.context,
    );
    await client.chat.completions.create({ model: 'x' });
    await run.drain();
    assert.equal(engine.metricsSeen.at(-1)?.cost, 2, 'ceil(1.08) milli-credits');
  });

  it('still gates before the request leaves - the thing the header path cannot do', async () => {
    const { engine, run } = harness({ usageLimit: 0 });
    const client = wrapClient(fakeGateway(completion()), costRecipe(), run.session, run.context);
    await assert.rejects(() => client.chat.completions.create({ model: 'x' }) as any);
    assert.equal(engine.reports, 0, 'no spend was attempted');
  });
});

describe('openrouterRecipe detection', () => {
  const openRouterClient = () => ({ baseURL: 'https://openrouter.ai/api/v1', chat: { completions: { create() {} } } });
  const openAIClient = () => ({ baseURL: 'https://api.openai.com/v1', chat: { completions: { create() {} } } });

  it('wins for an OpenRouter client and leaves every other OpenAI client alone', () => {
    // Registered ahead of the bare OpenAI adapter, which is the order the SDK itself uses.
    const registry = createClientRegistry([costRecipe(), openAIRecipe]);
    assert.equal(registry.find(openRouterClient())?.vendor, 'openrouter');
    assert.equal(registry.find(openAIClient())?.vendor, 'openai');
  });

  it('does not claim a client by shape alone - that would change the unit of account by guess', () => {
    const recipe = costRecipe();
    assert.equal(recipe.matches?.({ chat: { completions: { create() {} } } }), false, 'no baseURL to go on');
    assert.equal(recipe.matches?.(openAIClient()), false);
    assert.equal(recipe.matches?.(undefined), false);
  });
});

describe('openrouterRecipe reports what the gateway stated, tokens and money alike', () => {
  it("sends the token counts under the gateway's own names, like every other vendor", async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeGateway(completion()), openrouterRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'anthropic/claude-sonnet-4' });
    await run.drain();
    // The body is OpenAI-shaped whatever served it, so these are OpenAI's names.
    assert.equal(engine.metricsSeen.at(-1)?.prompt_tokens, 21);
    assert.equal(engine.metricsSeen.at(-1)?.completion_tokens, 39);
  });

  it('still reads what only the gateway knows - the model that served, and its request id', async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeGateway(completion()), openrouterRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'anthropic/claude-sonnet-4' });
    await run.drain();
    assert.equal(engine.dimensionsSeen.at(-1)?.model, completion().model);
    assert.equal(
      [...engine.seenKeys].every((key) => key.startsWith(completion().id)),
      true,
      'keyed on the gateway, not runId:step',
    );
  });

  it('bills the money beside them, from the same response', async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeGateway(completion()), openrouterRecipe(), run.session, run.context);
    await client.chat.completions.create({ model: 'anthropic/claude-sonnet-4' });
    await run.drain();
    assert.equal(engine.metricsSeen.at(-1)?.cost, 1080);
  });
});

describe('asking for the right amount before a cost-metered call', () => {
  it('asks for 1 by default, which is what the token meter is sized for', () => {
    const [method] = openrouterRecipe().methods;
    assert.equal(method.estimate?.({ max_tokens: 4096 }), 1);
  });

  it('asks for what the caller says a call might cost, which only they can know', () => {
    // A ceiling the caller is willing to assume: max_tokens against a rate they picked.
    const recipe = openrouterRecipe({ estimate: (params) => params.max_tokens ?? 1 });
    const [method] = recipe.methods;
    assert.equal(method.estimate?.({ max_tokens: 4096 }), 4096);
  });

  it('applies it to every surface, not just chat completions', () => {
    const recipe = openrouterRecipe({ estimate: () => 7 });
    assert.deepEqual(
      recipe.methods.map((m) => m.estimate?.({})),
      recipe.methods.map(() => 7),
    );
  });
});

/**
 * The other client: OpenRouter's own `@openrouter/sdk`, which is what its docs tell you to use.
 *
 * Generated from the OpenAPI spec, so it shares nothing with `openai-node` but the service behind
 * it - `chat.send` rather than `chat.completions.create`, and counters camelCased on the way in.
 * The recipe used to govern only the OpenAI-shaped client, which meant an application following
 * OpenRouter's own advice got a client that metered nothing and said so nowhere.
 */

/**
 * The same call as `USAGE`, in the SDK's own spelling - field for field, deliberately.
 *
 * The parity test below compares what the two clients report, so any counter present in one
 * fixture and absent from the other would fail it for the fixture's reasons rather than the
 * code's. Richer payloads are exercised by the raw and Responses cases further down.
 */
const SDK_USAGE = {
  promptTokens: 21,
  completionTokens: 39,
  cost: COST,
  promptTokensDetails: { cachedTokens: 7 },
};

/**
 * A stand-in for the first-party client, shaped the way the real one is.
 *
 * The lazy namespace getters matter: every sub-client on `OpenRouter` is one, so a guard that
 * read the properties instead of testing for them would construct three sub-clients just to
 * decide whether a recipe fits. `credits` and `generations` throw here to keep that honest.
 */
function fakeOpenRouterSdk(response: any, path: 'chat' | 'responses' = 'chat') {
  const send = (params: any) => {
    const streaming = params?.chatRequest?.stream ?? params?.responsesRequest?.stream;
    if (!streaming) return Promise.resolve(response);
    return Promise.resolve({
      [Symbol.asyncIterator]: async function* () {
        yield { id: response.id, model: response.model, choices: [{ delta: { content: 'hi' } }] };
        yield { id: response.id, model: response.model, choices: [{ delta: {} }], usage: response.usage };
      },
    });
  };
  const client: any = {
    [path]: { send },
    get credits() {
      throw new Error('a recipe guard must not construct sub-clients');
    },
    get generations() {
      throw new Error('a recipe guard must not construct sub-clients');
    },
  };
  return client;
}

const sdkCompletion = (usage: any = SDK_USAGE) => ({
  id: 'gen-sdk123',
  model: 'anthropic/claude-sonnet-5',
  usage,
});

describe('openrouterRecipe against the first-party SDK', () => {
  it('recognises the client by shape, since it carries no base URL to recognise it by', () => {
    assert.equal(openrouterRecipe().matches?.(fakeOpenRouterSdk(sdkCompletion())), true);
  });

  it('does not claim an unrelated client that happens to have a chat.send', () => {
    // `chat.send` alone is somebody else's API; the OpenRouter namespaces beside it are the point.
    assert.equal(openrouterRecipe().matches?.({ chat: { send: () => undefined } }), false);
  });

  it('reports the same metric names as the wire-shaped client, for the same call', async () => {
    const wire = harness();
    const wireClient = wrapClient(fakeGateway(completion()), costRecipe(), wire.run.session, wire.run.context);
    await wireClient.chat.completions.create({ model: 'x' });
    await wire.run.drain();

    const sdk = harness();
    const sdkClient = wrapClient(fakeOpenRouterSdk(sdkCompletion()), costRecipe(), sdk.run.session, sdk.run.context);
    await sdkClient.chat.send({ chatRequest: { model: 'x' } });
    await sdk.run.drain();

    // A metric name is a feature id. The same call through two clients must land on one feature,
    // or half an application's traffic reports to a name nobody's catalog has heard of.
    assert.deepEqual(
      Object.keys(sdk.engine.metricsSeen.at(-1) ?? {}).sort(),
      Object.keys(wire.engine.metricsSeen.at(-1) ?? {}).sort(),
    );
    assert.equal(sdk.engine.metricsSeen.at(-1)?.cost, 1080);
    assert.equal(sdk.engine.metricsSeen.at(-1)?.prompt_tokens, 21);
    assert.equal(sdk.engine.metricsSeen.at(-1)?.cached_tokens, 7);
  });

  it('attributes the spend to the model that served, as it does for the other client', async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeOpenRouterSdk(sdkCompletion()), costRecipe(), run.session, run.context);
    await client.chat.send({ chatRequest: { model: 'anthropic/claude-opus-5' } });
    await run.drain();
    assert.equal(engine.dimensionsSeen.at(-1)?.model, 'anthropic/claude-sonnet-5');
  });

  it('meters a streamed call once, when the stream ends', async () => {
    const { engine, run } = harness();
    const client = wrapClient(fakeOpenRouterSdk(sdkCompletion()), costRecipe(), run.session, run.context);
    const stream = await client.chat.send({ chatRequest: { model: 'x', stream: true } });
    for await (const chunk of stream as any) assert.ok(chunk);
    await run.drain();
    assert.equal(engine.metricsSeen.filter((m) => m.cost).length, 1);
    assert.equal(engine.metricsSeen.at(-1)?.cost, 1080);
  });

  it('governs the Responses surface too, which the example never calls', async () => {
    const { engine, run } = harness();
    // Left undeclared it would be ungated rather than metered by something else - this recipe is
    // matched ahead of the OpenAI one, so there is nothing underneath to fall through to.
    const usage = {
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      cost: COST,
      inputTokensDetails: { cachedTokens: 5, cacheWriteTokens: 2 },
    };
    const client = wrapClient(
      fakeOpenRouterSdk({ ...sdkCompletion(usage) }, 'responses'),
      costRecipe(),
      run.session,
      run.context,
    );
    await client.responses.send({ responsesRequest: { model: 'x' } });
    await run.drain();
    assert.equal(engine.metricsSeen.at(-1)?.cost, 1080);
    assert.equal(engine.metricsSeen.at(-1)?.input_tokens, 30);
    assert.equal(engine.metricsSeen.at(-1)?.cached_tokens, 5);
  });

  it('keeps the vendor spelling on the raw payload an event carries', () => {
    const chat = openrouterRecipe().methods.find((m) => m.path.join('.') === 'chat.send');
    const measurement = chat?.extractUsage?.(sdkCompletion()) as any;
    // Translated for metering, not for the record: an event should reconcile against what
    // OpenRouter actually sent, in its own spelling and with the fraction it was charged.
    assert.equal(measurement.raw.promptTokens, 21);
    assert.equal(measurement.raw.cost, COST);
    // And the metric beside it is the scaled whole-unit number, under the wire's own name.
    assert.equal(measurement.metrics.prompt_tokens, 21);
    assert.equal(measurement.metrics.cost, 1080);
  });
});
