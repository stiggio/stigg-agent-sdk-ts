/**
 * AUDR emission: one record per measured model call, to the application's own AUDR client, and
 * only when `audr` was passed at construction.
 *
 * The client here is a literal that collects what it is handed - the shape of `@openaudr/audr`'s
 * `Client`, which is all the SDK depends on - and checks each record with that package's own
 * `validate()`, at the version `package.json` pins.
 */
import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import type { AudrRecord as SpecRecord, Client, Environment, ValidationIssue } from '@openaudr/audr' with {
  'resolution-mode': 'import',
};
import {
  AUDR_SPEC_VERSION,
  createAudrEmitter,
  toRecord,
  uuidv7,
  type AudrClientLike,
  type AudrEnvironment,
  type AudrRecord,
} from '../src/core/audr';
import { resolveConfig } from '../src/config';
import { resolveContext, type ResolvedContext } from '../src/core/context';
import { modelOf } from '../src/bindings/client/core/wrap-client';
import { StiggAgentSDK } from '../src/stigg-agent-sdk';
import { StiggLangChainCallbackHandler } from '../src/integrations/langchain';
import { StiggAdkPlugin } from '../src/integrations/adk';
import { agentgatewayRecipe, stiggVercelMiddleware, unitsPerTokens } from '../src';
import { BaseLlm, InMemoryRunner, LlmAgent, type LlmResponse } from '@google/adk';
import { newStigg, context } from './stigg-harness';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Compile-time: what this SDK writes and takes, against the AUDR package's own types. A version of
// it that changes them fails here, not in a sink.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const environmentsMatch: Same<AudrEnvironment, Environment> = true;
const recordsFit: Same<AudrRecord extends SpecRecord ? true : false, true> = true;
const clientFits: Same<Client extends AudrClientLike ? true : false, true> = true;
void [environmentsMatch, recordsFit, clientFits];

let validate: (value: unknown) => ValidationIssue[];
let specVersion: string;
before(async () => {
  ({ validate, SPEC_VERSION: specVersion } = await import('@openaudr/audr'));
});

/** Every record a collector was handed, by what the AUDR package says is wrong with it. */
const issues: { record: AudrRecord; issues: ValidationIssue[] }[] = [];
afterEach(() => {
  const found = issues.splice(0);
  assert.deepEqual(found, [], 'every record passes @openaudr/audr validate()');
});

const collector = () => {
  const records: AudrRecord[] = [];
  const record = (written: AudrRecord) => {
    records.push(written);
    const wrong = validate(written);
    if (wrong.length) issues.push({ record: written, issues: wrong });
  };
  return { records, client: { record } };
};

/** A model's answer an instant after it is asked: whatever a record times is the SDK's, not the model's. */
const busyFor = (ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until);
};

/** A context for `toRecord`, with what a binding would have traced. */
const traced = (audr: ResolvedContext['audr'], stated: Partial<ResolvedContext> = {}): ResolvedContext => ({
  ...resolveContext({ customerId: 'c-1' }, 'generated-correlation', { requireCustomer: true }),
  ...stated,
  audr,
});

const usage = { input: 1, output: 2, cacheRead: 0, cacheCreate: 0 };

/** A stream of AI SDK parts, read to its end or cancelled after the first. */
const partStream = (parts: unknown[]) => {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < parts.length) controller.enqueue(parts[i++]);
      else controller.close();
    },
  });
};

/**
 * An Anthropic-shaped client, which `wrap` detects as one. It answers with a dated model id, as
 * the API does for an alias - so a record that names the request's model is told apart.
 */
const anthropicLike = () => ({
  messages: {
    create: async () => ({
      id: 'msg_1',
      model: 'claude-sonnet-5-5-20261001',
      usage: { input_tokens: 900, output_tokens: 100, cache_read_input_tokens: 40 },
    }),
    stream: () => undefined,
  },
});

describe('AUDR emission', () => {
  it('writes the spec version the AUDR package is at', () => {
    assert.equal(AUDR_SPEC_VERSION, specVersion);
  });

  it('writes one record per wrapped call, as the harness that ran it', async () => {
    const { records, client } = collector();
    const { stigg } = await newStigg({ audr: { client, environment: 'production' } });
    const governed = stigg.wrap(anthropicLike(), { stiggContext: context });

    await governed.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [] } as never);
    await stigg.flush();

    assert.equal(records.length, 1);
    const [record] = records as [AudrRecord];
    assert.equal(record.spec_version, '1.1.0');
    assert.match(record.record_id, UUID_V7);
    assert.deepEqual(record.emitter, {
      component: 'harness',
      name: '@stigg/agent-sdk-js',
      version: record.emitter.version,
    });
    assert.deepEqual(record.resource, {
      type: 'model',
      operation: 'generation',
      modality: 'text',
      provider: 'anthropic',
      name: 'claude-sonnet-5-5-20261001',
    });
    assert.deepEqual(record.usage.llm, {
      input_tokens: 900,
      output_tokens: 100,
      cache_read_tokens: 40,
      cache_write_tokens: 0,
      requests: 1,
    });
    assert.equal(record.attribution.environment, 'production');
    assert.equal(record.attribution.account_id, context.customerId);
    assert.equal(record.attribution.feature_id, 'credits');
    assert.equal(record.run.run_id, record.run.span_id, 'a call with no correlationId is its own run');
    assert.ok(typeof record.timing.duration_ms === 'number' && record.timing.duration_ms >= 0);
  });

  it('writes a record for a wrapFetch request, with the provider and the model that served', async () => {
    const { records, client } = collector();
    const { stigg } = await newStigg({ audr: { client, environment: 'production' } });
    const reply = {
      id: 'chatcmpl-1',
      model: 'gpt-5-mini-2025-08-07',
      usage: { prompt_tokens: 50, completion_tokens: 45, total_tokens: 95 },
    };
    const gatewayFetch = stigg.wrapFetch({
      baseUrl: 'http://agentgateway.internal:8080/v1',
      recipe: agentgatewayRecipe(),
      fetch: async () => new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } }),
      stiggContext: context,
    });

    await gatewayFetch('http://agentgateway.internal:8080/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5-mini', messages: [] }),
    });
    await stigg.flush();

    assert.equal(records.length, 1);
    const [record] = records as [AudrRecord];
    assert.equal(record.resource.provider, 'agentgateway');
    assert.equal(record.resource.name, 'gpt-5-mini-2025-08-07');
    assert.equal(typeof record.timing?.duration_ms, 'number');
  });

  it('names the served model on a streamed wrapFetch request too, not the one it asked for', async () => {
    const { records, client } = collector();
    const { stigg } = await newStigg({ audr: { client, environment: 'production' } });
    const events = [
      { id: 'c-1', model: 'gpt-5-mini-2025-08-07', choices: [{ delta: { content: 'hi' } }] },
      {
        id: 'c-1',
        model: 'gpt-5-mini-2025-08-07',
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    ];
    const sse = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
    const gatewayFetch = stigg.wrapFetch({
      baseUrl: 'http://agentgateway.internal:8080/v1',
      recipe: agentgatewayRecipe(),
      fetch: async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
      stiggContext: context,
    });

    const response = await gatewayFetch('http://agentgateway.internal:8080/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5-mini', stream: true, messages: [] }),
    });
    await response.text();
    await stigg.flush();

    assert.equal(records.length, 1);
    assert.equal((records as [AudrRecord])[0].resource.name, 'gpt-5-mini-2025-08-07');
  });

  it('builds no emitter unless `audr` is passed, and never prints the client', async () => {
    const emitterOf = (stigg: StiggAgentSDK) => (stigg as unknown as { audr?: unknown }).audr;
    assert.equal(emitterOf((await newStigg()).stigg), undefined);
    assert.ok(emitterOf((await newStigg({ audr: { client: collector().client, environment: 'test' } })).stigg));

    const { client } = collector();
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(resolveConfig({ baseUrl: 'http://localhost:1', audr: { client, environment: 'staging' } })),
      ).audr,
      {
        environment: 'staging',
        client: '[client supplied by the caller]',
      },
    );
  });

  it("runs a wrapped client's calls together only when they state one correlationId", async () => {
    const { records, client } = collector();
    const { stigg } = await newStigg({ audr: { client, environment: 'production' } });
    const governed = stigg.wrap(anthropicLike(), { stiggContext: context });
    const call = (correlationId?: string) =>
      governed.messages.create({
        model: 'claude-sonnet-5-5',
        max_tokens: 10,
        messages: [],
        ...(correlationId ? { stiggContext: { correlationId } } : {}),
      } as never);

    await call();
    await call();
    await call('conversation-42');
    await call('conversation-42');
    await stigg.flush();

    const runs = records.map((record) => record.run.run_id);
    assert.notEqual(runs[0], runs[1], "the wrap's own id is not a run");
    assert.deepEqual(runs.slice(2), ['conversation-42', 'conversation-42']);
  });

  it('times the model call, not the check before it', async () => {
    const { records, client } = collector();
    // The decision hook runs inside the check, so a slow one is a slow check.
    const hooks = { onDecision: () => busyFor(150) };
    const { stigg } = await newStigg({ audr: { client, environment: 'production' } });

    const governed = stigg.wrap(anthropicLike(), { stiggContext: context, hooks });
    await governed.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [] } as never);
    await stiggVercelMiddleware({ stigg, stiggContext: { ...context, ingestMode: 'sync' }, hooks }).wrapGenerate({
      doGenerate: async () => ({ usage: { inputTokens: { total: 9 }, outputTokens: { total: 1 } } }),
      params: {},
    });
    await stigg.flush();

    assert.equal(records.length, 2);
    for (const record of records) assert.ok(record.timing.duration_ms! < 150, `${record.timing.duration_ms}ms`);
  });

  it("reads the model by each vendor's shape, the response's before the request's", () => {
    assert.equal(modelOf({ model: 'served' }, { model: 'asked' }), 'served');
    assert.equal(
      modelOf({ modelVersion: 'gemini-2.5-flash-001' }, { model: 'gemini-2.5-flash' }),
      'gemini-2.5-flash-001',
    );
    assert.equal(modelOf({}, { input: { modelId: 'anthropic.claude-sonnet' } }), 'anthropic.claude-sonnet');
    assert.equal(modelOf(undefined, undefined, '@cf/meta/llama-3'), '@cf/meta/llama-3');
    assert.equal(modelOf({ model: '' }, null), undefined);
    assert.equal(toRecord(traced({}), { usage }, 'test')?.resource.name, 'unknown');
  });

  it('never fails the call for a client that throws, and says so through onError', async () => {
    const errors: string[] = [];
    const { stigg } = await newStigg({
      audr: {
        client: {
          record: () => {
            throw new Error('sink down');
          },
        },
        environment: 'production',
      },
      onError: (_error, ctx) => errors.push(ctx.operation),
    });
    const governed = stigg.wrap(anthropicLike(), { stiggContext: context });

    const reply = await governed.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [] } as never);
    const [summary] = await stigg.flush();

    assert.equal((reply as { id: string }).id, 'msg_1');
    assert.ok(errors.includes('audr'));
    assert.equal(summary?.ingested, 1, 'the report to Stigg went out regardless');
  });

  it('refuses a client with no record() and an environment a sink would ignore, at construction', () => {
    assert.throws(
      () =>
        new StiggAgentSDK({ baseUrl: 'http://localhost:1', audr: { client: {} as never, environment: 'production' } }),
      /record\(\)/,
    );
    assert.throws(
      () =>
        new StiggAgentSDK({
          baseUrl: 'http://localhost:1',
          audr: { client: collector().client, environment: 'prod' as never },
        }),
      /audr\.environment/,
    );
  });

  it("places a graph's model step in LangChain's run tree, named as its agent", async () => {
    const { records, client } = collector();
    const { stigg } = await newStigg({ agentBudget: 100, audr: { client, environment: 'production' } });
    const handler = new StiggLangChainCallbackHandler({
      stigg,
      stiggContext: {
        attributionKey: 'agentId',
        entitlement: { currencyId: 'credits' },
        ingestMode: 'sync',
        usageMapper: unitsPerTokens('credits', 1_000),
      },
      agents: { lead: { stiggContext: { agentId: 'agent-1' } } },
    });
    const openRun = (runId: string, name: string, parent?: string) =>
      (handler.handleChainStart as (...args: unknown[]) => void)({}, {}, runId, parent, [], {}, 'chain', name);
    openRun('graph-run-0001', 'LangGraph');
    openRun('lead-run', 'lead', 'graph-run-0001');

    await handler.handleChatModelStart({}, [[]], 'model-run', 'lead-run', {}, [], {
      stiggCustomerId: context.customerId,
      ls_provider: 'anthropic',
      ls_model_name: 'claude-sonnet-5-5',
    });
    await handler.handleLLMEnd(
      { generations: [[{ message: { id: 'msg_1', usage_metadata: { input_tokens: 900, output_tokens: 100 } } }]] },
      'model-run',
    );
    await stigg.flush();

    assert.equal(records.length, 1);
    const [record] = records as [AudrRecord];
    assert.deepEqual(record.run, {
      run_id: 'graph-run-0001',
      span_id: 'model-run',
      parent_span_id: 'lead-run',
      name: 'lead',
    });
    assert.equal(record.resource.provider, 'anthropic');
    assert.equal(record.resource.name, 'claude-sonnet-5-5');
    assert.equal(record.attribution.labels?.agentId, 'agent-1');
  });

  it('makes a model run with nothing above it its own AUDR run', async () => {
    const { records, client } = collector();
    const { stigg } = await newStigg({ audr: { client, environment: 'production' } });
    const handler = new StiggLangChainCallbackHandler({ stigg, stiggContext: { ...context, ingestMode: 'sync' } });

    await handler.handleChatModelStart({}, [[]], 'solo-model-run', undefined, {}, [], {
      stiggCustomerId: context.customerId,
    });
    await handler.handleLLMEnd(
      { generations: [[{ message: { id: 'msg_1', usage_metadata: { input_tokens: 9, output_tokens: 1 } } }]] },
      'solo-model-run',
    );
    await stigg.flush();

    assert.deepEqual(records[0]?.run, { run_id: 'solo-model-run', span_id: 'solo-model-run' });
    assert.equal(records[0]?.resource.provider, 'unknown', 'no ls_provider, and none guessed');
  });

  it('says so through onError for a client whose record() rejects', async () => {
    const errors: string[] = [];
    const { stigg } = await newStigg({
      audr: { client: { record: async () => Promise.reject(new Error('sink down')) }, environment: 'production' },
      onError: (_error, ctx) => errors.push(ctx.operation),
    });
    const governed = stigg.wrap(anthropicLike(), { stiggContext: context });
    await governed.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [] } as never);
    await stigg.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(errors.includes('audr'));
  });

  it('emits no record for an estimate or an incomplete measurement, which AUDR cannot mark as one', () => {
    const { records, client } = collector();
    const warnings: string[] = [];
    const emitter = createAudrEmitter({ client, environment: 'test' }, (m) => warnings.push(m));
    const ctx = resolveContext({ customerId: 'c-1' }, 'run-0000001', { requireCustomer: true });

    emitter.emit(ctx, { usage: { input: 1, output: 2, cacheRead: 0, cacheCreate: 0 }, estimated: true });
    emitter.emit(ctx, { usage: { input: 0, output: 2, cacheRead: 0, cacheCreate: 0 }, incomplete: 'no input' });

    assert.equal(records.length, 0);
    assert.equal(warnings.length, 1, 'said once, not once per call');

    emitter.emit(ctx, { usage });
    assert.equal(records.length, 1, 'a stated measurement after a skipped one still goes out');
  });

  it('leaves out a counter AUDR cannot carry, and a measurement with no tokens at all', () => {
    const ctx = resolveContext({ customerId: 'c-1' }, 'run-0000001', { requireCustomer: true });
    const record = toRecord(ctx, { usage: { input: 1.5, output: 2, cacheRead: -1, cacheCreate: 0 } }, 'test');
    assert.deepEqual(record?.usage.llm, { output_tokens: 2, cache_write_tokens: 0, requests: 1 });
    assert.deepEqual(validate(record), []);
    assert.equal(toRecord(ctx, { metrics: { credits: 3 } }, 'test'), undefined);
  });

  it('keeps the labels AUDR accepts, the call over the context, and drops the rest - not the record', () => {
    const ctx = traced(
      {},
      { dimensions: { team: 'search', 'a b': 'x', ['k'.repeat(65)]: 'x', long: 'v'.repeat(257) } },
    );
    const record = toRecord(ctx, { usage, dimensions: { team: 'ranking' } }, 'test');
    assert.deepEqual(record?.attribution.labels, { team: 'ranking' });
    assert.deepEqual(validate(record), []);
    assert.equal(toRecord(traced({}), { usage }, 'test')?.attribution.labels, undefined);
  });

  it("fits a run id into AUDR's 8 to 64 characters, and a provider into its slug", () => {
    const runOf = (runId: string) => toRecord(traced({ runId }), { usage }, 'test')?.run.run_id;
    assert.equal(runOf('abc'), 'abc_____');
    assert.equal(runOf('r'.repeat(70)), 'r'.repeat(64));
    assert.equal(
      toRecord(traced({ provider: ' Azure OpenAI! ' }), { usage }, 'test')?.resource.provider,
      'azure-openai',
    );
    assert.deepEqual(validate(toRecord(traced({ runId: 'abc' }), { usage }, 'test')), []);
  });

  it('stamps a UUIDv7 with the milliseconds it was made', () => {
    const id = uuidv7(0x0189_abcd_ef01);
    assert.match(id, UUID_V7);
    assert.equal(id.replace(/-/g, '').slice(0, 12), '0189abcdef01');
  });

  it("names the AI SDK's provider and model on a Vercel middleware call", async () => {
    const { records, client } = collector();
    const { stigg } = await newStigg({ audr: { client, environment: 'production' } });
    const middleware = stiggVercelMiddleware({ stigg, stiggContext: { ...context, ingestMode: 'sync' } });

    await middleware.wrapGenerate({
      doGenerate: async () => ({
        usage: { inputTokens: { total: 900 }, outputTokens: { total: 100 } },
        response: { modelId: 'claude-sonnet-5-5-20261001' },
      }),
      params: {},
      model: { provider: 'anthropic.messages', modelId: 'claude-sonnet-5-5' },
    });
    await middleware.wrapGenerate({
      doGenerate: async () => ({ usage: { inputTokens: { total: 9 }, outputTokens: { total: 1 } } }),
      params: {},
      model: { provider: 'anthropic.messages', modelId: 'claude-sonnet-5-5' },
    });
    await stigg.flush();

    assert.equal(records.length, 2);
    assert.equal(records[0]?.resource.provider, 'anthropic');
    assert.equal(records[0]?.resource.name, 'claude-sonnet-5-5-20261001', 'the model the reply says served');
    assert.equal(records[1]?.resource.name, 'claude-sonnet-5-5', 'the one asked for, when the reply names none');
  });

  it('writes a record for a Vercel stream that states its usage, and none for one stopped before it does', async () => {
    const { records, client } = collector();
    const { stigg } = await newStigg({ audr: { client, environment: 'production' } });
    const middleware = stiggVercelMiddleware({ stigg, stiggContext: { ...context, ingestMode: 'sync' } });
    const model = { provider: 'openai.chat', modelId: 'gpt-5' };
    const text = { type: 'text-delta', id: 't', delta: 'a reply long enough to estimate' };
    const finish = { type: 'finish', usage: { inputTokens: { total: 9 }, outputTokens: { total: 1 } } };
    const metadata = { type: 'response-metadata', id: 'resp_1', modelId: 'gpt-5-2026-08-07' };

    const done = await middleware.wrapStream({
      doStream: async () => ({ stream: partStream([metadata, text, finish]) }),
      params: {},
      model,
    });
    const reader = done.stream.getReader();
    while (!(await reader.read()).done);

    const stopped = await middleware.wrapStream({
      doStream: async () => ({ stream: partStream([text, finish]) }),
      params: {},
      model,
    });
    const early = stopped.stream.getReader();
    await early.read();
    await early.cancel();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await stigg.flush();

    assert.equal(records.length, 1, 'the stopped stream is an estimate');
    assert.equal(records[0]?.resource.provider, 'openai');
    assert.equal(records[0]?.resource.name, 'gpt-5-2026-08-07', "the stream's metadata names what served");
  });

  it('gives each Vercel middleware call its own span, though every middleware counts its steps from 1', async () => {
    const { records, client } = collector();
    const { stigg } = await newStigg({ audr: { client, environment: 'production' } });
    for (let i = 0; i < 2; i++) {
      await stiggVercelMiddleware({ stigg, stiggContext: { ...context, ingestMode: 'sync' } }).wrapGenerate({
        doGenerate: async () => ({ usage: { inputTokens: { total: 9 }, outputTokens: { total: 1 } } }),
        params: {},
      });
    }
    await stigg.flush();
    assert.equal(records.length, 2);
    assert.notEqual(records[0]?.run.span_id, records[1]?.run.span_id);
  });

  it("runs an ADK invocation's model calls under it, with the model the request named", async () => {
    const { records, client } = collector();
    const { stigg } = await newStigg({ agentBudget: 100, audr: { client, environment: 'production' } });
    class OneAnswer extends BaseLlm {
      constructor() {
        super({ model: 'gemini-scripted' });
      }
      async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
        yield {
          content: { role: 'model', parts: [{ text: 'hi' }] },
          usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 100, totalTokenCount: 1000 },
          finishReason: 'STOP' as LlmResponse['finishReason'],
        };
      }
      connect(): never {
        throw new Error('not live');
      }
    }
    const plugin = new StiggAdkPlugin({
      stigg,
      stiggContext: { ...context, attributionKey: 'agentId', ingestMode: 'sync' },
      agents: { lead: { stiggContext: { agentId: 'agent-1' } } },
    });
    const runner = new InMemoryRunner({
      agent: new LlmAgent({ name: 'lead', model: new OneAnswer(), instruction: 'Answer.' }),
      appName: 'audr',
      plugins: [plugin],
    });
    const session = await runner.sessionService.createSession({ appName: 'audr', userId: 'user-1' });
    let invocationId: string | undefined;
    for await (const event of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text: 'hello' }] },
    })) {
      invocationId ??= event.invocationId;
    }
    await stigg.flush();

    assert.equal(records.length, 1);
    assert.equal(records[0]?.resource.name, 'gemini-scripted');
    assert.equal(records[0]?.run.run_id, invocationId);
    assert.equal(records[0]?.run.span_id, `adk:${invocationId}:1`);
    assert.equal(records[0]?.run.name, 'lead');
    assert.equal(records[0]?.resource.provider, 'unknown', 'ADK states no provider');
  });
});
