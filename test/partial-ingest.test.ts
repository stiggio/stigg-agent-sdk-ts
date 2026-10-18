/**
 * What survives a half-delivered ingest.
 *
 * A turn is up to two calls: the features through the usage or event API, then the wallet draw
 * for the metric naming the run's currency. If the second rejects after the first landed, that
 * first report is at Stigg and the customer will be billed for it. A run that reports the turn as
 * nothing metered understates a real bill - the one direction a meter must never be wrong in.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reportMetrics, type ReportCalls } from '../src/engine/report';
import { EngineError, asEngineError } from '../src/errors';
import type { EngineReportParams } from '../src/engine/engine';

const ENTITLEMENT = { currencyId: 'credits' };

const params = (metrics: Record<string, number>): EngineReportParams => ({
  entitlement: ENTITLEMENT,
  mode: 'sync',
  metrics,
  dimensions: { agentId: 'agent-1' },
  idempotencyKey: 'run-1:1',
});

/** Features land; the wallet refuses. The order `reportMetrics` uses is what makes this reachable. */
const featuresLandWalletFails = (): ReportCalls => ({
  usage: async (metrics) => ({ reported: metrics, replayed: false, mode: 'sync', source: 'rest' }),
  event: async (metrics) => ({ reported: metrics, replayed: false, mode: 'async', source: 'rest' }),
  credits: () => Promise.reject(new Error('wallet is unavailable')),
  creditsAsync: () => Promise.reject(new Error('wallet is unavailable')),
});

describe('an ingest that fails after part of it landed', () => {
  it('carries the accepted features out on the error', async () => {
    const err = await reportMetrics(params({ input_tokens: 120, credits: 3 }), featuresLandWalletFails()).then(
      () => undefined,
      (e: unknown) => e,
    );

    assert.ok(err instanceof EngineError, 'the failure is still an engine error');
    assert.deepEqual(err.reported, { input_tokens: 120 }, 'the tokens reached Stigg and say so');
    assert.ok(!Object.keys(err.reported ?? {}).includes('credits'), 'the draw that rejected is not among them');
  });

  it('says whether what landed was a replay, so nobody counts it twice', async () => {
    const replayedFeatures: ReportCalls = {
      ...featuresLandWalletFails(),
      usage: async (metrics) => ({ reported: metrics, replayed: true, mode: 'sync', source: 'rest' }),
    };
    const err = await reportMetrics(params({ input_tokens: 120, credits: 3 }), replayedFeatures).then(
      () => undefined,
      (e: unknown) => e,
    );

    assert.ok(err instanceof EngineError);
    assert.deepEqual(err.reported, { input_tokens: 120 });
    assert.equal(err.replayed, true, 'Stigg had already counted these keys');
    // The run handle wraps again before it builds the failed result.
    assert.equal(asEngineError('ingest', err).replayed, true);
  });

  it('claims nothing when the first call is the one that failed', async () => {
    const calls: ReportCalls = {
      ...featuresLandWalletFails(),
      usage: () => Promise.reject(new Error('usage is unavailable')),
    };
    const err = await reportMetrics(params({ input_tokens: 120, credits: 3 }), calls).then(
      () => undefined,
      (e: unknown) => e,
    );

    assert.ok(err instanceof EngineError);
    assert.ok(
      err.reported === undefined || Object.keys(err.reported).length === 0,
      'nothing landed, so nothing is claimed',
    );
  });

  it('survives being re-wrapped on the way out', async () => {
    const err = await reportMetrics(params({ input_tokens: 120, credits: 3 }), featuresLandWalletFails()).then(
      () => undefined,
      (e: unknown) => e,
    );
    // `RunHandle` wraps again before it builds the failed result; the ack is as true one frame up.
    assert.deepEqual(asEngineError('ingest', err).reported, { input_tokens: 120 });
  });
});

describe('a zero that names the run currency', () => {
  const drawn: { featureId: string; value: number }[] = [];
  const recording = (): ReportCalls => ({
    usage: async (metrics) => ({ reported: metrics, replayed: false, mode: 'sync', source: 'rest' }),
    event: async (metrics) => ({ reported: metrics, replayed: false, mode: 'async', source: 'rest' }),
    credits: async (featureId, value) => {
      drawn.push({ featureId, value });
      return { reported: { [featureId]: value }, replayed: false, mode: 'sync', source: 'rest' };
    },
    creditsAsync: async (featureId, value) => {
      drawn.push({ featureId, value });
      return { reported: { [featureId]: value }, replayed: false, mode: 'async', source: 'rest' };
    },
  });

  /**
   * Zeros survive the run handle's filter under `'async'` so an event keeps its shape on a turn
   * that measured nothing. The wallet is not an event, so the same zero would only spend a call
   * and the turn's idempotency key on a draw of nothing.
   */
  it('is not drawn from the wallet', async () => {
    drawn.length = 0;
    await reportMetrics({ ...params({ credits: 0, input_tokens: 5 }), mode: 'async' }, recording());
    assert.deepEqual(drawn, [], 'no consumption is sent for a zero');
  });

  it('still draws a real amount', async () => {
    drawn.length = 0;
    await reportMetrics({ ...params({ credits: 2, input_tokens: 5 }), mode: 'async' }, recording());
    assert.deepEqual(drawn, [{ featureId: 'credits', value: 2 }]);
  });

  it('leaves the features alone, zero or not', async () => {
    drawn.length = 0;
    const result = await reportMetrics({ ...params({ credits: 0, input_tokens: 0 }), mode: 'async' }, recording());
    assert.deepEqual(result.reported, { input_tokens: 0 }, 'the event still carries the counter it measured');
  });
});
