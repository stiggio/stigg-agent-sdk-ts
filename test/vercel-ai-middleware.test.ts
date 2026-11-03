/**
 * The Vercel AI SDK binding: `wrapLanguageModel({ model, middleware: stiggVercelMiddleware(...) })`.
 *
 * The first block runs `generateText`, `streamText` or a `ToolLoopAgent` against the offline
 * Anthropic mock and the mock Stigg server, because what is pinned there is what the AI SDK does
 * around the middleware: that the customer a call names in `providerOptions.stigg` reaches the
 * gate, and what becomes of a refusal raised from a model call. The rest drive the stream reader
 * and context handling directly, with hand-built parts, for the exits a live stream reaches only
 * by timing.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createAnthropic } from '@ai-sdk/anthropic';
import { ToolLoopAgent, generateText, stepCountIs, streamText, tool, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import type { HookContext, IngestResult, Measurement } from '../src';
import { AccessDeniedError, stiggVercelMiddleware } from '../src';
import { measurementOf, observeStream } from '../src/bindings/orchestrator/vercel-ai/middleware';
import { newStigg } from './stigg-harness';
import { fundPool, seedBudget } from '../testing/mock-stigg-server';
import { startMockServer } from '../examples/shared/mock-server';

const CUSTOMER = 'customer-acme';
const OTHER_CUSTOMER = 'customer-globex';
const credits = { currencyId: 'credits' } as const;

let vendor: Awaited<ReturnType<typeof startMockServer>> | undefined;
after(() => vendor?.close());

/** A lead and a researcher, each its own entity with a budget, every ingest captured by who it was for. */
async function setup(budgets: { lead?: number; researcher?: number } = {}) {
  vendor ??= await startMockServer();
  const { stigg, mock } = await newStigg();
  fundPool(mock.state, OTHER_CUSTOMER, 1_000);
  for (const customerId of [CUSTOMER, OTHER_CUSTOMER]) {
    for (const [entityId, usageLimit] of Object.entries({
      'agent-lead': budgets.lead ?? 100,
      'agent-researcher': budgets.researcher ?? 100,
    })) {
      seedBudget(mock.state, customerId, { entityId, entityTypeId: 'agent', capabilityId: 'credits', usageLimit });
    }
  }
  const ingests: HookContext[] = [];
  const results: IngestResult[] = [];
  const base = createAnthropic({ apiKey: 'offline-mock', baseURL: `${vendor.baseUrl}/v1` })('claude-opus-5');
  const model = (agentId: string, customerId?: string) =>
    wrapLanguageModel({
      model: base,
      middleware: stiggVercelMiddleware({
        stigg,
        stiggContext: { agentId, attributionKey: 'agentId', entitlement: credits, ingestMode: 'sync', customerId },
        hooks: {
          onIngest: (result, context) => {
            results.push(result);
            ingests.push(context);
          },
        },
      }),
    });
  /** Who each call was reported for: agent and customer. */
  const reported = () => ingests.map((c) => `${c.dimensions.agentId}@${c.customerId}`);
  return { stigg, base, model, reported, results };
}

describe('stiggVercelMiddleware - a model wrapped by wrapLanguageModel', () => {
  it('checks and reports a call for the customer it names in providerOptions.stigg', async () => {
    const { stigg, model, reported, results } = await setup();

    const { usage } = await generateText({
      model: model('agent-lead'),
      prompt: 'hi',
      providerOptions: { stigg: { customerId: CUSTOMER } },
    });
    await stigg.flush();

    assert.deepEqual(reported(), [`agent-lead@${CUSTOMER}`]);
    // What the model stated, keyed by its own response id.
    assert.equal(results[0]?.reported.input_tokens, usage.inputTokens);
    assert.equal(results[0]?.reported.output_tokens, usage.outputTokens);
    assert.match(results[0]?.idempotencyKey ?? '', /msg_mock/);
  });

  it("lets a call's own context override the middleware's", async () => {
    const { stigg, model, reported } = await setup();

    await generateText({
      model: model('agent-lead', CUSTOMER),
      prompt: 'hi',
      providerOptions: { stigg: { customerId: OTHER_CUSTOMER } },
    });
    await stigg.flush();

    assert.deepEqual(reported(), [`agent-lead@${OTHER_CUSTOMER}`]);
  });

  it('refuses a call that names no customer, before the model is called', async () => {
    const { model, reported } = await setup();

    await assert.rejects(generateText({ model: model('agent-lead'), prompt: 'hi', maxRetries: 0 }), /No customerId/);
    assert.deepEqual(reported(), []);
  });

  it('rejects the call when the agent is out of budget', async () => {
    const { model } = await setup({ lead: 0 });

    await assert.rejects(
      generateText({
        model: model('agent-lead'),
        prompt: 'hi',
        maxRetries: 0,
        providerOptions: { stigg: { customerId: CUSTOMER } },
      }),
      (err) => err instanceof AccessDeniedError,
    );
  });

  it('hands a refused sub-agent back to the lead as a failed tool call, and the lead goes on', async () => {
    const { stigg, model, reported } = await setup({ researcher: 0 });
    const researcher = new ToolLoopAgent({ model: model('agent-researcher'), stopWhen: stepCountIs(3) });
    // An agent's generate() takes providerOptions and toolsContext at runtime, and its types do not say so.
    const call = (options: object): any => options;
    const lead = new ToolLoopAgent({
      model: model('agent-lead'),
      stopWhen: stepCountIs(4),
      tools: {
        research: tool({
          inputSchema: z.object({ brief: z.string() }),
          execute: async ({ brief }, { context }) =>
            (await researcher.generate(call({ prompt: brief, providerOptions: { stigg: (context as any).stigg } })))
              .text,
        }),
      },
    });

    const request = { customerId: CUSTOMER };
    const result = await lead.generate(
      call({ prompt: 'hi', providerOptions: { stigg: request }, toolsContext: { research: { stigg: request } } }),
    );
    await stigg.flush();

    const errors = result.steps.flatMap((step) => step.content).filter((part) => part.type === 'tool-error');
    assert.equal(errors.length, 1);
    assert.ok((errors[0] as { error: unknown }).error instanceof AccessDeniedError);
    assert.deepEqual(reported(), [`agent-lead@${CUSTOMER}`, `agent-lead@${CUSTOMER}`]);
  });

  it('reports a streamed call once, when the stream ends, keyed by its response id', async () => {
    const { stigg, model, reported, results } = await setup();

    const stream = streamText({
      model: model('agent-lead'),
      prompt: 'hi',
      providerOptions: { stigg: { customerId: CUSTOMER } },
    });
    for await (const _ of stream.textStream) void _;
    await stigg.flush();

    assert.deepEqual(reported(), [`agent-lead@${CUSTOMER}`]);
    assert.match(results[0]?.idempotencyKey ?? '', /msg_mock/);
  });

  it('hands a refused streamed call to onError, and the stream ends without rejecting', async () => {
    const { model } = await setup({ lead: 0 });
    const errors: unknown[] = [];

    const stream = streamText({
      model: model('agent-lead'),
      prompt: 'hi',
      providerOptions: { stigg: { customerId: CUSTOMER } },
      onError: ({ error }) => void errors.push(error),
    });
    let text = '';
    for await (const chunk of stream.textStream) text += chunk;

    assert.equal(text, '');
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof AccessDeniedError);
  });

  it('reports a stream stopped by its abortSignal, by the text it produced', async () => {
    const { stigg, model, reported } = await setup();

    const stop = new AbortController();
    const stream = streamText({
      model: model('agent-lead'),
      prompt: 'hi',
      abortSignal: stop.signal,
      providerOptions: { stigg: { customerId: CUSTOMER } },
    });
    let words = 0;
    for await (const chunk of stream.textStream) if (chunk && ++words === 2) stop.abort();
    await stigg.flush();

    assert.deepEqual(reported(), [`agent-lead@${CUSTOMER}`]);
  });
});

describe('measurementOf - the AI SDK usage block', () => {
  it('keeps cached input out of the input counter, which the AI SDK total includes', () => {
    const measured = measurementOf({
      inputTokens: { total: 1_000, noCache: 200, cacheRead: 700, cacheWrite: 100 },
      outputTokens: { total: 50 },
    });

    assert.deepEqual(measured?.usage, { input: 200, output: 50, cacheRead: 700, cacheCreate: 100 });
    assert.deepEqual(measured?.metrics, {
      input_tokens: 1_000,
      output_tokens: 50,
      cache_read_tokens: 700,
      cache_write_tokens: 100,
      total_tokens: 1_050,
    });
  });

  it('derives the uncached input when the provider states no noCache', () => {
    const measured = measurementOf({ inputTokens: { total: 1_000, cacheRead: 700 }, outputTokens: { total: 50 } });

    assert.equal(measured?.usage?.input, 300);
  });

  it('is no measurement when the model stated no counter at all', () => {
    assert.equal(measurementOf({ inputTokens: {}, outputTokens: {} }), undefined);
  });

  it('says so when the model stated only part of its usage', () => {
    const measured = measurementOf({ outputTokens: { total: 50 } });

    assert.ok(measured?.incomplete);
    assert.deepEqual(measured?.metrics, { output_tokens: 50, total_tokens: 50 });
  });

  it('keys a measurement by the response id, and drops counters that are not numbers', () => {
    const measured = measurementOf(
      { inputTokens: { total: Number.NaN, noCache: 0 }, outputTokens: { total: 5 }, raw: { input_tokens: 3 } },
      'msg_1',
    );

    assert.equal(measured?.idempotencyKey, 'msg_1');
    assert.deepEqual(measured?.metrics, { output_tokens: 5 });
    assert.equal(measured?.usage?.input, 0, 'a stated noCache of 0 is kept, not derived');
    assert.deepEqual(measured?.raw, { input_tokens: 3 });
    assert.equal(measurementOf({ outputTokens: { total: 5 }, raw: [1] })?.raw, undefined);
  });
});

/** A ReadableStream of these parts, and a spy on whether the reader cancelled it and why. */
function partStream(parts: unknown[], options: { failAfter?: number } = {}) {
  const cancelled: unknown[] = [];
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (options.failAfter !== undefined && i === options.failAfter) {
        controller.error(new Error('connection reset'));
        return;
      }
      if (i < parts.length) controller.enqueue(parts[i++]);
      else controller.close();
    },
    cancel(reason) {
      cancelled.push(reason);
    },
  });
  return { stream, cancelled };
}

/** Runs the stream reader over `parts`, collecting what it reports. */
function observe(parts: unknown[], params: { abortSignal?: unknown } = {}, options: { failAfter?: number } = {}) {
  const { stream, cancelled } = partStream(parts, options);
  const result: { stream: ReadableStream } = { stream };
  const ingested: Measurement[] = [];
  let ended = 0;
  observeStream(result, params.abortSignal as AbortSignal | undefined, (m) => {
    ended += 1;
    if (m) ingested.push(m);
  });
  return { reader: result.stream.getReader(), ingested, cancelled, ended: () => ended };
}

const USAGE = { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 4 } };
const TEXT = (delta: string) => ({ type: 'text-delta', id: 't', delta });

describe('the stream reader', () => {
  it('reports what the finish part states, once, keyed by the response id', async () => {
    const { reader, ingested } = observe([
      { type: 'response-metadata', id: 'msg_1' },
      TEXT('hello'),
      { type: 'finish', usage: USAGE },
    ]);
    while (!(await reader.read()).done);

    assert.equal(ingested.length, 1);
    assert.deepEqual(ingested[0]?.metrics, { input_tokens: 10, output_tokens: 4, total_tokens: 14 });
    assert.equal(ingested[0]?.idempotencyKey, 'msg_1');
    assert.equal(ingested[0]?.estimated, undefined);
  });

  it('estimates the output of a stream its abortSignal stopped, and reports it once', async () => {
    const stop = new AbortController();
    const { reader, ingested } = observe([TEXT('12345678'), TEXT('9'), { type: 'finish', usage: USAGE }], {
      abortSignal: stop.signal,
    });
    await reader.read();
    stop.abort();
    while (!(await reader.read()).done);

    assert.equal(ingested.length, 1);
    assert.deepEqual(ingested[0]?.metrics, { output_tokens: 2, total_tokens: 2 });
    assert.equal(ingested[0]?.estimated, true);
    assert.ok(ingested[0]?.incomplete);
  });

  it('lets go of the abortSignal once the stream has ended', async () => {
    const listeners = new Set<unknown>();
    const signal = {
      aborted: false,
      addEventListener: (_: string, fn: unknown) => listeners.add(fn),
      removeEventListener: (_: string, fn: unknown) => listeners.delete(fn),
    };
    const { reader } = observe([{ type: 'finish', usage: USAGE }], { abortSignal: signal });
    assert.equal(listeners.size, 1);
    while (!(await reader.read()).done);

    assert.equal(listeners.size, 0);
  });

  it('ends at once on a signal that was already aborted, reporting nothing for nothing produced', () => {
    const { ingested } = observe([TEXT('late')], { abortSignal: AbortSignal.abort() });

    assert.deepEqual(ingested, []);
  });

  it('estimates a stream its reader cancelled, and passes the cancel on', async () => {
    const { reader, ingested, cancelled } = observe([TEXT('12345'), TEXT('more')]);
    await reader.read();
    await reader.cancel('user stopped');

    assert.equal(ingested.length, 1);
    assert.equal(ingested[0]?.estimated, true);
    assert.deepEqual(cancelled, ['user stopped']);
  });

  it('estimates a stream whose source failed partway, and passes the error on', async () => {
    const { reader, ingested } = observe([TEXT('12345')], {}, { failAfter: 1 });
    await reader.read();

    await assert.rejects(reader.read(), /connection reset/);
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0]?.estimated, true);
  });

  it('estimates when the finish part states no usage', async () => {
    const { reader, ingested } = observe([TEXT('12345'), { type: 'finish', usage: {} }]);
    while (!(await reader.read()).done);

    assert.equal(ingested[0]?.estimated, true);
  });

  it('reports nothing for a stream that produced nothing and named no response', async () => {
    const { reader, ingested, ended } = observe([{ type: 'stream-start', warnings: [] }]);
    while (!(await reader.read()).done);

    assert.deepEqual(ingested, []);
    assert.equal(ended(), 1, 'still ends, so the step is let go');
  });

  it('passes malformed parts through untouched', async () => {
    const { reader } = observe([null, { id: 5, type: 'response-metadata' }, { type: 'finish', usage: USAGE }]);
    const seen: unknown[] = [];
    for (let next = await reader.read(); !next.done; next = await reader.read()) seen.push(next.value);

    assert.equal(seen.length, 3);
  });
});

/** A model on the given spec version that records the options each call was handed. */
function fakeModel(specificationVersion = 'v4') {
  const calls: { providerOptions?: unknown }[] = [];
  return {
    calls,
    model: {
      specificationVersion,
      provider: 'fake',
      modelId: 'fake-1',
      supportedUrls: {},
      doGenerate: async (options: { providerOptions?: unknown }) => {
        calls.push(options);
        return {
          content: [{ type: 'text', text: 'hi' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 3, noCache: 3 }, outputTokens: { total: 2 } },
          response: { id: 'resp_1' },
          warnings: [],
        };
      },
      doStream: async () => ({ stream: new ReadableStream() }),
    },
  };
}

/** `fakeModel()` behind the middleware, its calls checked against the given context. */
async function governedFake(stiggContext: object, specificationVersion = 'v4') {
  const { stigg, results } = await setup();
  const fake = fakeModel(specificationVersion);
  const model = wrapLanguageModel({
    model: fake.model as never,
    middleware: stiggVercelMiddleware({
      stigg,
      stiggContext: { entitlement: credits, ingestMode: 'sync', ...stiggContext },
      hooks: { onIngest: (result) => results.push(result) },
    }),
  });
  return { stigg, results, model, calls: fake.calls };
}

describe('the per-call context', () => {
  it('meters a v3 model run by the AI SDK', async () => {
    const { stigg, results, model } = await governedFake({ customerId: CUSTOMER }, 'v3');

    await generateText({ model, prompt: 'hi' });
    await stigg.flush();

    assert.equal(results.length, 1);
    assert.equal(results[0]?.idempotencyKey.startsWith('resp_1'), true);
  });

  it("takes stigg out of the call before the provider sees it, and keeps the provider's own options", async () => {
    const { model, calls } = await governedFake({});

    await generateText({
      model,
      prompt: 'hi',
      providerOptions: { stigg: { customerId: CUSTOMER }, fake: { temperature: 1 } },
    });

    assert.deepEqual(calls[0]?.providerOptions, { fake: { temperature: 1 } });
  });

  it('reports a call whose model stated only part of its usage, and says it was not fully measured', async () => {
    const { stigg } = await setup();
    const fake = fakeModel();
    const partial = {
      ...fake.model,
      doGenerate: async (options: object) => ({
        ...(await fake.model.doGenerate(options)),
        usage: { inputTokens: {}, outputTokens: { total: 2 } },
      }),
    };
    const middleware = stiggVercelMiddleware({
      stigg,
      stiggContext: { customerId: CUSTOMER, entitlement: credits, ingestMode: 'sync' },
    });

    await generateText({ model: wrapLanguageModel({ model: partial as never, middleware }), prompt: 'hi' });
    const summary = await middleware.stigg.flush();

    assert.equal(summary.ingested, 1);
    assert.equal(summary.ingestFailures, 1);
  });

  it('refuses a providerOptions.stigg that is not an object, before the model is called', async () => {
    const { model, calls } = await governedFake({ customerId: CUSTOMER });

    for (const stigg of [0, false, 'customer-acme', ['customer-acme']]) {
      await assert.rejects(
        generateText({ model, prompt: 'hi', maxRetries: 0, providerOptions: { stigg: stigg as never } }),
        /must be a stiggContext object/,
      );
    }
    assert.equal(calls.length, 0);
  });

  it("checks the next step only once the last stream's report has landed", async () => {
    const order: string[] = [];
    let land!: () => void;
    const landed = new Promise<void>((resolve) => (land = resolve));
    const fake = {
      middleware: () => ({
        stigg: {},
        startModel: async () => void order.push('check'),
        endModel: async () => {
          await landed;
          order.push('reported');
        },
        abandon: () => undefined,
      }),
    };
    const middleware = stiggVercelMiddleware({ stigg: fake as never });
    // One call: every step gets the same `stigg` object, as the AI SDK hands it on.
    const params = await middleware.transformParams({
      params: { providerOptions: { stigg: { customerId: CUSTOMER } } },
    });
    const finish = { type: 'finish', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };

    const { stream } = await middleware.wrapStream({
      doStream: async () => ({ stream: partStream([finish]).stream }),
      params,
    });
    const reader = stream.getReader();
    while (!(await reader.read()).done);
    const next = middleware.wrapGenerate({ doGenerate: async () => ({ usage: finish.usage }), params });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(order, ['check'], 'the next check waits');

    land();
    await next;
    assert.deepEqual(order, ['check', 'reported', 'check', 'reported']);
  });

  it("does not hold another call's check on a stream's report, even for the same customer", async () => {
    const order: string[] = [];
    let reports = 0;
    const fake = {
      middleware: () => ({
        stigg: {},
        startModel: async () => void order.push('check'),
        // The stream's report never lands; the generate call's own does.
        endModel: () => {
          order.push('reporting');
          return reports++ === 0 ? new Promise<void>(() => undefined) : Promise.resolve();
        },
        abandon: () => undefined,
      }),
    };
    const middleware = stiggVercelMiddleware({ stigg: fake as never });
    // Two calls for one customer - two users of the same company: two `stigg` objects.
    const call = () => middleware.transformParams({ params: { providerOptions: { stigg: { customerId: CUSTOMER } } } });
    const finish = { type: 'finish', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };

    const { stream } = await middleware.wrapStream({
      doStream: async () => ({ stream: partStream([finish]).stream }),
      params: await call(),
    });
    const reader = stream.getReader();
    while (!(await reader.read()).done);
    await middleware.wrapGenerate({ doGenerate: async () => ({}), params: await call() });

    assert.deepEqual(order, ['check', 'reporting', 'check', 'reporting']);
  });

  it("does not hold another customer's check on that stream's report", async () => {
    const order: string[] = [];
    let reports = 0;
    const fake = {
      middleware: () => ({
        stigg: {},
        startModel: async () => void order.push('check'),
        // The stream's report never lands; the generate call's own does.
        endModel: () => {
          order.push('reporting');
          return reports++ === 0 ? new Promise<void>(() => undefined) : Promise.resolve();
        },
        abandon: () => undefined,
      }),
    };
    const middleware = stiggVercelMiddleware({ stigg: fake as never });
    const asCustomer = (customerId: string) =>
      middleware.transformParams({ params: { providerOptions: { stigg: { customerId } } } });
    const finish = { type: 'finish', usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };

    const { stream } = await middleware.wrapStream({
      doStream: async () => ({ stream: partStream([finish]).stream }),
      params: await asCustomer('customer-a'),
    });
    const reader = stream.getReader();
    while (!(await reader.read()).done);
    await middleware.wrapGenerate({ doGenerate: async () => ({}), params: await asCustomer('customer-b') });

    assert.deepEqual(order, ['check', 'reporting', 'check', 'reporting']);
  });

  it('treats a null stigg as no context of its own', async () => {
    const { model } = await governedFake({ customerId: CUSTOMER });

    await generateText({ model, prompt: 'hi', providerOptions: { stigg: null as never } });
  });

  it('refuses an idempotencyKey in providerOptions.stigg, which every step of a loop would share', async () => {
    const { model, calls } = await governedFake({});

    await assert.rejects(
      generateText({
        model,
        prompt: 'hi',
        maxRetries: 0,
        providerOptions: { stigg: { customerId: CUSTOMER, idempotencyKey: 'k' } },
      }),
      /cannot set `idempotencyKey`/,
    );
    assert.equal(calls.length, 0);
  });

  it('refuses a misspelt field in providerOptions.stigg', async () => {
    const { model, calls } = await governedFake({});

    await assert.rejects(
      generateText({ model, prompt: 'hi', maxRetries: 0, providerOptions: { stigg: { custmerId: CUSTOMER } } }),
    );
    assert.equal(calls.length, 0);
  });
});
