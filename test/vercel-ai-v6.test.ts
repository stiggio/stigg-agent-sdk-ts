/**
 * The middleware on `ai` 6, which runs `v3` models and requires a middleware to say `v3`. The rest
 * of the suite runs on `ai` 7.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateText, streamText, wrapLanguageModel } from 'ai-v6';
import { stiggVercelMiddleware } from '../src';
import { newStigg } from './stigg-harness';

const CUSTOMER = 'customer-acme';
const USAGE = { inputTokens: { total: 3, noCache: 3 }, outputTokens: { total: 2 } };

/** A `v3` model that records the options each call was handed. */
function v3Model() {
  const calls: { providerOptions?: unknown }[] = [];
  const model = {
    specificationVersion: 'v3',
    provider: 'fake',
    modelId: 'fake-1',
    supportedUrls: {},
    doGenerate: async (options: { providerOptions?: unknown }) => {
      calls.push(options);
      return {
        content: [{ type: 'text', text: 'hi' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: USAGE,
        response: { id: `resp_${calls.length}` },
        warnings: [],
      };
    },
    doStream: async (options: { providerOptions?: unknown }) => {
      calls.push(options);
      const parts = [
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: `resp_${calls.length}` },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'hi' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
      ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  return { model, calls };
}

async function governed() {
  const { stigg } = await newStigg();
  const fake = v3Model();
  const middleware = stiggVercelMiddleware({
    stigg,
    stiggContext: { entitlement: { currencyId: 'credits' }, ingestMode: 'sync' },
  });
  return { middleware, calls: fake.calls, model: wrapLanguageModel({ model: fake.model as never, middleware }) };
}

describe('stiggVercelMiddleware on ai 6', () => {
  it('checks and reports a generated call, with stigg taken out before the provider', async () => {
    const { middleware, model, calls } = await governed();

    await generateText({ model, prompt: 'hi', providerOptions: { stigg: { customerId: CUSTOMER } } });
    const summary = await middleware.stigg.flush();

    assert.equal(summary.ingested, 1);
    assert.equal(summary.ingestFailures, 0);
    assert.deepEqual(calls[0]?.providerOptions, {});
  });

  it('reports a streamed call once, when it ends, with stigg taken out before the provider', async () => {
    const { middleware, model, calls } = await governed();

    const stream = streamText({ model, prompt: 'hi', providerOptions: { stigg: { customerId: CUSTOMER } } });
    for await (const _ of stream.textStream) void _;
    const summary = await middleware.stigg.flush();

    assert.equal(summary.ingested, 1);
    assert.equal(summary.ingestFailures, 0);
    assert.deepEqual(calls[0]?.providerOptions, {});
  });
});
