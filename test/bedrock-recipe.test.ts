/**
 * The Bedrock recipe - the gateway whose client is a command bus and whose response has no price.
 *
 * Two things here exist nowhere else in these bindings, and both are what the tests are about:
 * the operation being an *argument* rather than a method path, so the recipe has to decide per
 * call whether it is looking at inference at all; and a streamed response that hands back an
 * envelope with the stream hanging off it rather than the stream itself.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bedrockRecipe } from '../src/bindings/client/gateways/bedrock/bedrock-recipe';
import { wrapClient } from '../src/bindings/client/core/wrap-client';
import { FakeEngine, type FakeEngineOptions } from './fake-engine';
import { newRun } from './session-harness';

/** Bedrock's counters, which are disjoint: `inputTokens` excludes both cache numbers. */
const USAGE = {
  inputTokens: 21,
  outputTokens: 39,
  totalTokens: 60,
  cacheReadInputTokens: 7,
  cacheWriteInputTokens: 3,
};

/** A command as the AWS SDK builds one: the operation lives in `schema[2]`. */
const command = (operation: string, input: unknown = {}) => ({
  schema: [9, 'com.amazonaws.bedrockruntime', operation, { http: ['POST', '/model/{modelId}/x', 200] }],
  input,
});

/**
 * A stand-in for `BedrockRuntimeClient`: one `send`, and a config that names the service.
 *
 * `config.defaultSigningName` is what separates this from every other AWS v3 client, all of which
 * also have a `send` - so the fake carries it for the same reason the real guard reads it.
 */
function fakeBedrock(response: any) {
  const calls: string[] = [];
  const client: any = {
    config: { defaultSigningName: 'bedrock', serviceId: 'Bedrock Runtime', region: 'us-east-1' },
    send(cmd: any) {
      calls.push(cmd?.schema?.[2] ?? 'unknown');
      return Promise.resolve(typeof response === 'function' ? response(cmd) : response);
    },
  };
  return { client, calls };
}

const converseResult = (usage: any = USAGE) => ({
  output: { message: { role: 'assistant', content: [{ text: 'hi' }] } },
  stopReason: 'end_turn',
  usage,
  $metadata: { requestId: 'req-bedrock-1' },
});

/** What ConverseStream resolves to: the stream is a property, not the response. */
const streamResult = (usage: any = USAGE) => ({
  $metadata: { requestId: 'req-bedrock-2' },
  stream: {
    [Symbol.asyncIterator]: async function* () {
      yield { contentBlockDelta: { delta: { text: 'hi' } } };
      yield { messageStop: { stopReason: 'end_turn' } };
      yield { metadata: { usage, metrics: { latencyMs: 12 } } };
    },
  },
});

function harness(options: FakeEngineOptions = { usageLimit: null }) {
  const engine = new FakeEngine(options);
  const run = newRun({ engine, dimensions: { agentId: 'agent-1' }, ingestMode: 'sync', checkErrorAction: 'deny' });
  return { engine, run };
}

describe('bedrockRecipe', () => {
  it('recognises the client by what it signs for, not by its class name', () => {
    const { client } = fakeBedrock(converseResult());
    assert.equal(bedrockRecipe().matches?.(client), true);
  });

  it('does not claim another AWS client, which also has a send', () => {
    const s3Like = { config: { defaultSigningName: 's3', serviceId: 'S3' }, send: () => undefined };
    assert.equal(bedrockRecipe().matches?.(s3Like), false);
  });

  it('meters a Converse call under Bedrock’s own names', async () => {
    const { engine, run } = harness();
    const { client } = fakeBedrock(converseResult());
    const governed = wrapClient(client, bedrockRecipe(), run.session, run.context);
    await governed.send(command('Converse', { modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0' }));
    await run.drain();

    const metrics = engine.metricsSeen.at(-1);
    assert.equal(metrics?.inputTokens, 21);
    assert.equal(metrics?.outputTokens, 39);
    assert.equal(metrics?.cacheReadInputTokens, 7);
    assert.equal(metrics?.totalTokens, 60);
    // The thing that most separates Bedrock from the other two gateways: no price on the response,
    // so none reported. A zero here would be a number a mapper could multiply.
    assert.equal('cost' in (metrics ?? {}), false);
  });

  it('adds the cache counters to the normalized call rather than subtracting them', () => {
    const [method] = bedrockRecipe().methods;
    const measured = method.extractUsage?.(converseResult()) as any;
    // AWS states `inputTokens` excludes both cache numbers, so the normalized input is that
    // figure untouched - the opposite of the OpenAI reader, which subtracts what is nested inside.
    // Subtracting here would bill the call for less than it used.
    assert.equal(measured.usage.input, 21);
    assert.equal(measured.usage.cacheRead, 7);
    assert.equal(measured.usage.cacheCreate, 3);
    // The vendor's own total is read rather than recomputed, which on a cached call is smaller
    // than the four counters add up to - see the reader for why both numbers are worth having.
    assert.equal(measured.usage.total, 60);
  });

  it('deduplicates on the AWS request id, because the SDK retries on its own', async () => {
    const { engine, run } = harness();
    const { client } = fakeBedrock(converseResult());
    const governed = wrapClient(client, bedrockRecipe(), run.session, run.context);
    await governed.send(command('Converse'));
    await run.drain();
    assert.ok([...engine.seenKeys].some((key) => key.startsWith('req-bedrock-1')));
  });

  it('meters a streamed call off the envelope’s stream, once, at the end', async () => {
    const { engine, run } = harness();
    const { client } = fakeBedrock(streamResult());
    const governed = wrapClient(client, bedrockRecipe(), run.session, run.context);
    const result: any = await governed.send(command('ConverseStream'));
    for await (const event of result.stream) assert.ok(event);
    await run.drain();
    assert.equal(engine.metricsSeen.length, 1);
    assert.equal(engine.metricsSeen.at(-1)?.totalTokens, 60);
  });

  it('leaves a non-inference command alone - it is the same method', async () => {
    const { engine, run } = harness();
    const { client, calls } = fakeBedrock({ asyncInvokeSummaries: [] });
    const governed = wrapClient(client, bedrockRecipe(), run.session, run.context);
    await governed.send(command('ListAsyncInvokes'));
    await run.drain();

    // It still reached the service - passthrough means ungated, not swallowed - but nothing was
    // checked or metered, because listing invocations spends nothing.
    assert.deepEqual(calls, ['ListAsyncInvokes']);
    assert.equal(engine.checks, 0);
    assert.equal(engine.metricsSeen.length, 0);
  });

  it('leaves InvokeModel alone too, because its body is the upstream vendor’s', async () => {
    const { engine, run } = harness();
    const { client } = fakeBedrock({ body: new Uint8Array() });
    const governed = wrapClient(client, bedrockRecipe(), run.session, run.context);
    await governed.send(command('InvokeModel'));
    await run.drain();
    // Gating it while measuring nothing would report every call as a metering failure; metering it
    // needs a reader per upstream model, which is a recipe of its own rather than a guess here.
    assert.equal(engine.metricsSeen.length, 0);
  });

  it('does not gate a command from a different AWS service that borrowed the shape', async () => {
    const { engine, run } = harness();
    const { client } = fakeBedrock({});
    const governed = wrapClient(client, bedrockRecipe(), run.session, run.context);
    await governed.send({ schema: [9, 'com.amazonaws.s3', 'Converse', {}], input: {} });
    await run.drain();
    // Same operation name, different service: the namespace is checked precisely so a collision
    // somewhere else in AWS cannot be metered as inference.
    assert.equal(engine.metricsSeen.length, 0);
  });

  it('asks for 1 by default, and for whatever the caller can work out instead', () => {
    const [method] = bedrockRecipe().methods;
    assert.equal(method.estimate?.(command('Converse', { inferenceConfig: { maxTokens: 4096 } })), 1);

    const sized = bedrockRecipe({ estimate: (cmd) => cmd?.input?.inferenceConfig?.maxTokens ?? 1 });
    const [method2] = sized.methods;
    assert.equal(method2.estimate?.(command('Converse', { inferenceConfig: { maxTokens: 4096 } })), 4096);
  });
});
