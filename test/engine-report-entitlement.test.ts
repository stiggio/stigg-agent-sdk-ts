/**
 * Ingest addresses a credit currency and a metered feature through different endpoints, and the
 * two are not interchangeable: `reportUsage` accepts only a `featureId`, so a currency id sent
 * there comes back as `FeatureNotFound`. Both engines fork on entitlement kind before anything else.
 *
 * The engines are built without their constructors so no client is initialized - what is under
 * test is which call the fork makes, not the transport.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NodeSdkEngine } from '../src/engine/node-sdk-engine';
import { RestGovernanceEngine } from '../src/engine/rest-governance-engine';
import type { EngineReportParams } from '../src/engine/engine';
import type { Entitlement } from '../src/types';

type Call = { method: string; args: Record<string, unknown> };

const VALUE = 7;

const params = (
  // Required here, though the seam allows none: every case below is about which half of a named
  // entitlement the report draws from, and the one case that names none builds its own params.
  entitlement: Entitlement,
  mode: EngineReportParams['mode'] = 'sync',
): EngineReportParams => ({
  entitlement,
  mode,
  metrics: { [entitlement.currencyId ?? entitlement.featureId!]: VALUE },
  dimensions: { agentId: 'agent-support-bot' },
  idempotencyKey: 'run-1:1',
});

/** Under sync each metric dedupes under its own key, so the wire carries the feature id too. */
const keyFor = (id: string) => `run-1:1:${id}`;

/** A NodeSdkEngine wired to a recording client, with no `Stigg.initialize` behind it. */
function nodeEngine(calls: Call[]): NodeSdkEngine {
  const engine = Object.create(NodeSdkEngine.prototype) as NodeSdkEngine;
  return Object.assign(engine, {
    client: {
      consumeCredits: async (args: Record<string, unknown>) => {
        calls.push({ method: 'consumeCredits', args });
        return { credit: { currentUsage: 120 } };
      },
      consumeCreditsAsync: async (args: Record<string, unknown>) => {
        calls.push({ method: 'consumeCreditsAsync', args });
      },
      // Bulk, because a turn reports several metrics and this client has one call for that.
      reportUsageBulk: async (args: Record<string, unknown>) => {
        calls.push({ method: 'reportUsageBulk', args });
        return [{ currentUsage: 42, credit: null }];
      },
      reportEvent: async (args: Record<string, unknown>) => {
        calls.push({ method: 'reportEvent', args });
      },
    },
  });
}

function restEngine(calls: Call[]): RestGovernanceEngine {
  const engine = Object.create(RestGovernanceEngine.prototype) as RestGovernanceEngine;
  return Object.assign(engine, {
    client: {
      v1: {
        credits: {
          consumption: {
            consume: async (args: Record<string, unknown>) => {
              calls.push({ method: 'credits.consumption.consume', args });
              return { data: { credit: { currentUsage: 120 } } };
            },
            consumeAsync: async (args: Record<string, unknown>) => {
              calls.push({ method: 'credits.consumption.consumeAsync', args });
              return { data: {} };
            },
          },
        },
        usage: {
          report: async (args: Record<string, unknown>) => {
            calls.push({ method: 'usage.report', args });
            return { data: [{ currentUsage: 42 }] };
          },
        },
        events: {
          report: async (args: Record<string, unknown>) => {
            calls.push({ method: 'events.report', args });
            return { data: {} };
          },
        },
      },
    },
  });
}

describe('report forks on entitlement kind', () => {
  it('draws a credit currency from the wallet, never through reportUsage', async () => {
    const calls: Call[] = [];
    const result = await nodeEngine(calls).report('customer-acme', params({ currencyId: 'data_credit' }));

    assert.deepEqual(
      calls.map((c) => c.method),
      ['consumeCredits'],
    );
    assert.deepEqual(calls[0].args, {
      customerId: 'customer-acme',
      currencyId: 'data_credit',
      amount: 7,
      idempotencyKey: keyFor('data_credit'),
      dimensions: { agentId: 'agent-support-bot' },
    });
    assert.equal(result.currentUsage, 120);
    // The response carries the running balance, not this call's deduction - see `consumeCredits`.
    assert.equal(result.replayed, false);
  });

  it('sends a metered feature through reportUsage', async () => {
    const calls: Call[] = [];
    await nodeEngine(calls).report('customer-acme', params({ featureId: 'feature-data-credit-usage' }));

    assert.equal(calls[0].method, 'reportUsageBulk');
    const usages = calls[0].args.usages as { featureId: string; idempotencyKey: string }[];
    assert.equal(usages[0].featureId, 'feature-data-credit-usage');
    assert.equal(usages[0].idempotencyKey, keyFor('feature-data-credit-usage'), 'keyed per metric');
  });

  it('takes the same fork on the REST engine', async () => {
    const credit: Call[] = [];
    const feature: Call[] = [];
    await restEngine(credit).report('customer-acme', params({ currencyId: 'data_credit' }));
    await restEngine(feature).report('customer-acme', params({ featureId: 'feature-data-credit-usage' }));

    assert.equal(credit[0].method, 'credits.consumption.consume');
    assert.equal(credit[0].args.currencyId, 'data_credit');
    assert.equal(feature[0].method, 'usage.report');
  });

  it('never routes a credit entitlement through an event, whatever the mode', async () => {
    // There is no path from a raw event to a currency: an event feeds a meter, a meter fills a
    // feature. Async changes which wallet call is made, never that the wallet is the target.
    const node: Call[] = [];
    const rest: Call[] = [];
    await nodeEngine(node).report('customer-acme', params({ currencyId: 'data_credit' }, 'async'));
    await restEngine(rest).report('customer-acme', params({ currencyId: 'data_credit' }, 'async'));

    assert.deepEqual(
      node.map((c) => c.method),
      ['consumeCreditsAsync'],
    );
    assert.deepEqual(
      rest.map((c) => c.method),
      ['credits.consumption.consumeAsync'],
    );
  });

  it('states what it sent, and claims nothing confirmed, when the wallet draw goes async', async () => {
    const calls: Call[] = [];
    const result = await nodeEngine(calls).report('customer-acme', params({ currencyId: 'data_credit' }, 'async'));

    const [{ consumptions }] = [calls[0].args as { consumptions: Record<string, unknown>[] }];
    assert.equal(consumptions[0].amount, VALUE, 'the SDK states the amount, so the run still knows the cost');

    // `reported` is what this client sent and is always there. `creditsConsumed` is what Stigg
    // said it drew, and an async draw is reconciled later with no balance in the response - so
    // there is nothing confirmed to state. A field meaning "confirmed" under one mode and "sent"
    // under the other cannot be branched on, which is the whole use for it.
    assert.equal(result.reported.data_credit, VALUE, 'the cost is still knowable');
    assert.equal(result.creditsConsumed, undefined, 'but not as a confirmation nobody gave');
    assert.equal(result.currentUsage, undefined, 'nothing comes back to correct from');
    assert.equal(result.replayed, undefined, 'and a replay is something only Stigg can see');
  });
});

describe('the two transports share one ingest shape', () => {
  const feature = { featureId: 'feature-data-credit-usage' } as const;

  it('tells the caller the same thing when an async run has no event name', async () => {
    const messages: string[] = [];
    for (const engine of [nodeEngine([]), restEngine([])]) {
      // No `event` on the params: async reports one event per call and nothing named it.
      await assert.rejects(
        () => engine.report('customer-acme', params(feature, 'async')),
        (err: Error) => {
          messages.push(err.message);
          return true;
        },
      );
    }
    assert.equal(messages[0], messages[1], 'the fix reads the same whichever client found it');
    assert.match(messages[0], /has to be named/);
    assert.match(messages[0], /stiggContext\.eventName/);
  });

  it('sends one event for the whole turn, carrying every metric as a dimension', async () => {
    const node: Call[] = [];
    const rest: Call[] = [];
    const turn: EngineReportParams = {
      ...params(feature, 'async'),
      metrics: { input_tokens: 12, output_tokens: 46, cache_read_input_tokens: 3 },
      raw: { 'raw.service_tier': 'standard' },
      event: { name: 'anthropic.messages.create' },
    };
    for (const engine of [nodeEngine(node), restEngine(rest)]) {
      await engine.report('customer-acme', turn);
    }
    const eventOf = (call: Call): Record<string, any> => {
      const batched = call.args.events as Record<string, any>[] | undefined;
      return batched ? batched[0] : (call.args as Record<string, any>);
    };

    assert.equal(node.length, 1, 'three metrics, one request');
    assert.deepEqual(eventOf(node[0]), eventOf(rest[0]), 'the two clients say the same thing');
    assert.equal(eventOf(node[0]).eventName, 'anthropic.messages.create');
    assert.equal(eventOf(node[0]).idempotencyKey, 'run-1:1', 'the turn is the unit, so no feature suffix');
    assert.deepEqual(eventOf(node[0]).dimensions, {
      'raw.service_tier': 'standard',
      input_tokens: 12,
      output_tokens: 46,
      cache_read_input_tokens: 3,
      agentId: 'agent-support-bot',
    });
  });

  it('lets attribution win a key the vendor also used', async () => {
    const calls: Call[] = [];
    await nodeEngine(calls).report('customer-acme', {
      ...params(feature, 'async'),
      metrics: { agentId: 5 } as unknown as EngineReportParams['metrics'],
      raw: { agentId: 'from-the-vendor' },
      event: { name: 'anthropic.messages.create' },
    });
    // Re-attributing a bill to an entity that never ran is the one collision that has to be
    // decided rather than merged, so attribution is applied last.
    assert.equal((calls[0].args as any).dimensions.agentId, 'agent-support-bot');
  });

  it('says to switch modes when a sync report hits a meter it cannot fill', async () => {
    const engine = nodeEngine([]);
    (engine as unknown as { client: { reportUsageBulk: () => Promise<unknown> } }).client.reportUsageBulk =
      async () => {
        throw Object.assign(new Error('cannot report usage for entitlement with meter'), {
          code: 'CannotReportUsageForEntitlementWithMeterError',
        });
      };

    // It used to re-route silently and remember. A run's transport is not the catalog's to choose.
    await assert.rejects(
      () => engine.report('customer-acme', params(feature)),
      (err: Error) => /raw-events meter/.test(err.message) && /ingest: 'async'/.test(err.message),
    );
  });
});

/**
 * A report that names no entitlement is a metering-only run's report. There is no wallet behind it,
 * so the fork above has nothing to fork on - and the question worth pinning is which way it falls.
 */
describe('a report that names no entitlement', () => {
  const unenforced = (metrics: EngineReportParams['metrics']): EngineReportParams => ({
    mode: 'sync',
    metrics,
    dimensions: { agentId: 'agent-support-bot' },
    idempotencyKey: 'run-1:1',
  });

  it('reports every metric as a feature - there is no wallet to draw', async () => {
    const calls: Call[] = [];
    // `credits` would have drawn the wallet under an entitlement that named it. Here nothing does.
    await nodeEngine(calls).report('customer-acme', unenforced({ credits: VALUE, input_tokens: 12 }));

    assert.deepEqual(
      calls.map((c) => c.method),
      ['reportUsageBulk'],
    );
    const usages = calls[0].args.usages as { featureId: string }[];
    assert.deepEqual(
      usages.map((usage) => usage.featureId),
      ['credits', 'input_tokens'],
    );
  });

  it('takes the same fork on the REST engine, which has the same nothing to fork on', async () => {
    const calls: Call[] = [];
    await restEngine(calls).report('customer-acme', unenforced({ credits: VALUE }));

    assert.equal(calls[0].method, 'usage.report');
  });
});
