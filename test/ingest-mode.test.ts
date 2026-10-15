/**
 * Which ingest API a run reports through, and what each one can honestly say afterwards.
 *
 * The two are not variants of one call. A usage report states a value per feature and answers with
 * a balance; an event states the call and answers with nothing, leaving the arithmetic to meters
 * that run seconds later. Everything here is about keeping that difference visible instead of
 * papering over it - what the SDK sends, what it is allowed to claim, and what it does with the
 * budget while nothing has come back.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flattenRaw } from '../src/core/dimensions';
import { FakeEngine } from './fake-engine';
import { newRun } from './session-harness';
import { newStigg, runOn, context } from './stigg-harness';
import { seedCreditRate, seedEventMeter } from '../testing/mock-stigg-server';
import type { IngestResult } from '../src/types';

const run = (options: { mode: 'sync' | 'async'; engine?: FakeEngine }) =>
  newRun({
    engine: options.engine,
    ingestMode: options.mode,
    eventName: { name: 'anthropic.messages.create' },
    checkErrorAction: 'deny',
  });

describe('the vendor block an event carries', () => {
  it('flattens nested counters to dotted keys under its own prefix', () => {
    assert.deepEqual(
      flattenRaw({ prompt_tokens: 12, prompt_tokens_details: { cached_tokens: 3 }, service_tier: 'standard' }),
      {
        'raw.prompt_tokens': 12,
        'raw.prompt_tokens_details.cached_tokens': 3,
        'raw.service_tier': 'standard',
      },
    );
  });

  it('keeps a fraction, which is the only way a gateway states a cost honestly', () => {
    assert.deepEqual(flattenRaw({ cost: 0.00042 }), { 'raw.cost': 0.00042 });
  });

  it('drops what no meter could read rather than coercing it', () => {
    assert.deepEqual(
      flattenRaw({ ok: 1, nothing: null, missing: undefined, broken: NaN, endless: Infinity, list: [1, 2] }),
      { 'raw.ok': 1 },
    );
  });

  it('stops at a depth, so a response that grows a subtree cannot grow the event', () => {
    assert.deepEqual(flattenRaw({ a: { b: { c: { d: 1 } } } }), {});
  });

  it('is nothing at all when the vendor said nothing', () => {
    assert.deepEqual(flattenRaw(undefined), {});
  });
});

describe('what each mode is allowed to claim', () => {
  it('says nothing about a replay under async, because the response cannot', async () => {
    const result = await run({ mode: 'async' }).ingestMetrics({ output_tokens: 4 });
    assert.equal(result.mode, 'async');
    assert.equal(result.replayed, undefined, 'unknown is a different answer from "no"');
    assert.equal(result.creditsConsumed, undefined, 'and no balance came back to report');
  });

  it('still answers with the balance under sync', async () => {
    const result = await run({ mode: 'sync' }).ingestMetrics({ credits: 4 });
    assert.equal(result.mode, 'sync');
    assert.equal(result.replayed, false);
    assert.equal(result.creditsConsumed, 4);
  });
});

describe('what each DTO accepts', () => {
  const sent = async (mode: 'sync' | 'async', metrics: Record<string, number>) => {
    const engine = new FakeEngine({ usageLimit: 100 });
    const seen: Record<string, number>[] = [];
    const report = engine.report.bind(engine);
    engine.report = (customerId, params) => {
      seen.push(params.metrics);
      return report(customerId, params);
    };
    const result = await run({ mode, engine }).ingestMetrics(metrics);
    return { seen: seen[0], result };
  };

  it('keeps a zero in an event, where a meter may filter on the field being there', async () => {
    const { seen } = await sent('async', { input_tokens: 12, cache_read_input_tokens: 0 });
    assert.deepEqual(seen, { input_tokens: 12, cache_read_input_tokens: 0 });
  });

  it('drops it from a usage report, which would be a request that moves nothing', async () => {
    const { seen } = await sent('sync', { input_tokens: 12, cache_read_input_tokens: 0 });
    assert.deepEqual(seen, { input_tokens: 12 });
  });

  it('takes a fraction as an event and refuses it as a usage report', async () => {
    const asEvent = await sent('async', { cost: 0.5 });
    assert.deepEqual(asEvent.seen, { cost: 0.5 });

    const asUsage = await sent('sync', { cost: 0.5 });
    assert.equal(asUsage.result.ok, false, 'the usage DTO takes whole units');
  });

  it('refuses a broken number in either mode, because neither is a measurement', async () => {
    for (const mode of ['sync', 'async'] as const) {
      const { result } = await sent(mode, { input_tokens: Number.NaN });
      assert.equal(result.ok, false, `${mode} reported a measurement of nothing at all`);
    }
  });
});

describe('end to end, against a Stigg that meters events the way Stigg does', () => {
  it('denies once the meters behind one event name have drained the budget', async () => {
    const { stigg, mock } = await newStigg({ pool: 10 });
    // What the account configures on Stigg's side: one meter per feature, all reading the same
    // event. This is the fan-out that makes one event per turn enough.
    for (const field of ['input_tokens', 'output_tokens']) {
      seedEventMeter(mock.state, {
        eventName: 'anthropic.messages.create',
        featureId: field,
        aggregation: { function: 'SUM', field },
      });
      seedCreditRate(mock.state, field, 1);
    }

    const handle = await runOn(stigg, {
      ...context,
      ingestMode: 'async',
      eventName: { name: 'anthropic.messages.create' },
    });
    const first = await handle.check(1);
    assert.equal(first.hasAccess, true);

    // One event, two meters, six credits - and none of that was stated by the SDK.
    await handle.ingestMetrics({ input_tokens: 4, output_tokens: 2 });
    await handle.drain();

    const spent = await handle.check(1);
    assert.equal(spent.remaining, 4, 'the meters priced it, and the pool moved');

    await handle.ingestMetrics({ input_tokens: 4 }, {});
    await handle.drain();
    const denied = await handle.check(1);
    assert.equal(denied.hasAccess, false, 'an eventually-consistent path still enforces');
  });

  it('meters nothing when no meter is configured for the event name', async () => {
    const { stigg, mock } = await newStigg({ pool: 10 });
    const warnings: string[] = [];
    const handle = await runOn(stigg, {
      ...context,
      ingestMode: 'async',
      entitlement: { currencyId: 'credits' },
      eventName: { name: 'anthropic.messages.create' },
      hooks: { onIngest: (result: IngestResult) => warnings.push(String(result.ok)) },
    });

    await handle.ingestMetrics({ input_tokens: 4 });
    await handle.drain();

    // Accepted, acknowledged, and worth nothing - which is exactly what Stigg does with an event
    // no meter reads, and why the SDK warns rather than pretending the ack means something.
    assert.deepEqual(warnings, ['true']);
    const after = await handle.check(1);
    assert.equal(after.remaining, 10);
    assert.equal(mock.state.usageByFeature.get('input_tokens'), undefined);
  });

  it('reports as events without being asked to, which is the default', async () => {
    const { stigg, mock } = await newStigg({ pool: 10 });
    seedEventMeter(mock.state, {
      eventName: 'agent.usage',
      featureId: 'input_tokens',
      aggregation: { function: 'SUM', field: 'input_tokens' },
    });
    seedCreditRate(mock.state, 'input_tokens', 1);

    // No `ingest`, and no `events`: the run takes the client's default and the fallback name.
    const handle = await runOn(stigg, context);
    await handle.ingestMetrics({ input_tokens: 4 });
    await handle.drain();

    assert.equal(mock.state.usageByFeature.get('input_tokens'), 4, 'the meter read it, so it was an event');
  });

  it('dedupes the turn, not each metric, so one replayed event is one replay', async () => {
    const { stigg, mock } = await newStigg({ pool: 100 });
    seedEventMeter(mock.state, {
      eventName: 'anthropic.messages.create',
      featureId: 'input_tokens',
      aggregation: { function: 'SUM', field: 'input_tokens' },
    });
    seedCreditRate(mock.state, 'input_tokens', 1);

    const handle = await runOn(stigg, {
      ...context,
      ingestMode: 'async',
      eventName: { name: 'anthropic.messages.create' },
    });
    await handle.ingestMetrics({ input_tokens: 4 }, { idempotencyKey: 'turn-1' });
    await handle.ingestMetrics({ input_tokens: 4 }, { idempotencyKey: 'turn-1' });
    await handle.drain();

    assert.equal(mock.state.usageByFeature.get('input_tokens'), 4, 'the second delivery was the same turn');
  });
});
