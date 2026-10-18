/**
 * The session's two promises: a check that never throws, and an ingest that never breaks the
 * caller's call. Both are exercised against a literal engine - no network anywhere.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isEngineError, EngineError } from '../src/errors';
import { resolveContext } from '../src/core/context';
import { noopLogger } from '../src/logger';
import { unitsPerTokens, type IngestResult, type Measurement } from '../src/types';
import { FakeEngine, type FakeEngineOptions } from './fake-engine';
import { newRun, type BoundSession, type BoundSessionOptions } from './session-harness';
import type { GovernanceEngine } from '../src/engine/engine';

type Harness = { run: BoundSession; engine: FakeEngine; errors: { operation: string }[]; warnings: string[] };

function harness(options: FakeEngineOptions = {}, overrides: BoundSessionOptions = {}): Harness {
  const engine = new FakeEngine(options);
  const errors: { operation: string }[] = [];
  const warnings: string[] = [];
  const run = newRun({
    engine,
    usageMapper: unitsPerTokens('credits', 1000),
    // Sync unless a test says otherwise: most of what follows is about the balance that comes
    // back, and only the usage report answers with one.
    ingestMode: 'sync',
    checkErrorAction: 'deny',
    logger: { ...noopLogger, warn: (line: string) => warnings.push(line) },
    onError: (_error, context) => errors.push({ operation: context.operation }),
    ...overrides,
  });
  return { run, engine, errors, warnings };
}

describe('session.check', () => {
  it('asks the engine every time, because nothing is cached above it', async () => {
    const { run, engine } = harness();
    await run.check(1);
    const second = await run.check(1);
    assert.equal(engine.checks, 2);
    assert.equal(second.source, 'rest');
  });

  it('evaluates each request against the amount it actually asks for', async () => {
    // The case a decision cache got wrong: an allow fetched for 1 unit does not authorize 5. The
    // engine's own cache holds entitlement state and evaluates the ask, so size is never assumed.
    const { run } = harness({ usageLimit: 3 });
    assert.equal((await run.check(1)).hasAccess, true);
    assert.equal((await run.check(5)).hasAccess, false, 'a larger ask must be evaluated, not inherited');
  });

  it('sees a report that moved the budget on the very next check', async () => {
    const { run } = harness({ usageLimit: 3 });
    assert.equal((await run.check(3)).hasAccess, true);
    await run.ingest(3);
    assert.equal((await run.check(1)).hasAccess, false, 'the spend must not be hidden by a stale allow');
  });

  it('never hides a denial, so a top-up is visible on the very next call', async () => {
    const { run, engine } = harness({ usageLimit: 0 });
    const first = await run.check(1);
    const second = await run.check(1);
    assert.equal(first.hasAccess, false);
    assert.equal(second.source, 'rest', 'a denial must not be served from cache');
    assert.equal(engine.checks, 2);
  });

  it('is fail-closed by default when the engine breaks, and never throws', async () => {
    const { run, errors } = harness({ failCheck: new EngineError('check', 'governance cache unavailable') });
    const decision = await run.check(1);
    assert.equal(decision.hasAccess, false);
    assert.equal(decision.source, 'policy');
    assert.equal(decision.remedy, 'retry');
    assert.deepEqual(errors, [{ operation: 'check' }], 'the failure must still be reported');
  });

  it('honours an explicit allow policy, which the context carries', async () => {
    const { run } = harness({ failCheck: new EngineError('check', 'boom') }, { checkErrorAction: 'allow' });
    assert.equal((await run.check(1)).hasAccess, true);
  });
});

describe('session.ingest', () => {
  it('reports a replay rather than hiding it', async () => {
    const { run } = harness({ usageLimit: null });
    const first = await run.ingest(1, { idempotencyKey: 'run-1:node-a' });
    const second = await run.ingest(1, { idempotencyKey: 'run-1:node-a' });
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(first.idempotencyKey, 'run-1:node-a');
  });

  it('never rejects when the engine fails, and routes the failure to onError', async () => {
    const { run, errors } = harness({ failReport: new EngineError('ingest', 'boom') });
    const result = await run.ingest(1);
    assert.equal(result.ok, false);
    assert.deepEqual(errors, [{ operation: 'ingest' }]);
  });

  /**
   * Which endpoint takes a fraction, verified against the API rather than assumed.
   *
   * `credits.consumption.consume` answers 200 to a fractional `amount` and reports a fractional
   * balance back. `POST /api/v1/usage` answers `400 Expected integer, received float`. So the
   * refusal belongs to the feature path alone - the wallet is where fractions are the point,
   * since a currency has to be denominable finely enough to price a call worth a tenth of a cent.
   */
  it('sends a fractional draw on the wallet, which the API takes', async () => {
    const { run, engine } = harness();
    const result = await run.ingest(1.5);
    assert.equal(result.ok, true);
    assert.equal(engine.reports, 1, 'it reached the wire as given');
  });

  /**
   * Governance counts in whole units: its ingest schema is `z.number().int()` and the counter is
   * a Redis `HINCRBY`. A fractional amount is rejected there while the wallet still moves, so an
   * attributed agent's budget stops advancing and nothing says so. An attributed run therefore
   * rounds up; an unattributed one reports what its mapper measured.
   */
  it('rounds an attributed run up, so the agent budget keeps advancing', async () => {
    const { run, engine, warnings } = harness({}, { dimensions: { agentId: 'agent-1' }, attributionKey: 'agentId' });
    const result = await run.ingest(1.5);

    assert.equal(result.ok, true);
    assert.equal(engine.currentUsage, 2, 'up, so a call that happened still costs something');
    assert.match(warnings.join(' '), /rounded credits up from 1.5 to 2/, 'and never silently');
  });

  it('refuses a negative on an attributed run, which rounding used to launder', async () => {
    // `Math.ceil(-0.5)` is `-0`, which is not `< 0` - so rounding before validating slipped a
    // negative past the guard that exists to catch it, dropped it for not being `> 0`, and
    // reported the empty turn as a success. The mapper's own number is what gets validated now.
    const { run, engine } = harness({}, { dimensions: { agentId: 'agent-1' }, attributionKey: 'agentId' });
    const result = await run.ingest(-0.5);

    assert.equal(result.ok, false, 'a negative is not a no-op');
    assert.equal(engine.reports, 0, 'and never reached the wire');
  });

  it('leaves an unattributed run exact, which the wallet takes', async () => {
    const { run, engine, warnings } = harness();
    const result = await run.ingest(1.5);

    assert.equal(result.ok, true);
    assert.equal(engine.currentUsage, 1.5);
    assert.deepEqual(warnings, [], 'nothing was changed, so nothing is announced');
  });

  it('refuses a fraction reported against a feature, which the usage report rejects', async () => {
    // Gating on a feature rather than a currency makes the same value a usage report.
    const { run, engine } = harness({}, { entitlement: { featureId: 'tokens' } });
    const result = await run.ingest(1.5);
    assert.equal(result.ok, false);
    assert.equal(engine.reports, 0, 'refused here, where the caller can still see which metric');
  });

  it('treats a zero-token turn as a no-op, not a failure', async () => {
    const { run, engine, errors } = harness();
    const result = await run.ingest(0);
    assert.equal(result.ok, true);
    assert.equal(engine.reports, 0);
    assert.deepEqual(errors, [], 'zero is the one value that is genuinely nothing to report');
  });

  it('still counts a zero turn and tells the observers, since the ingest did happen', async () => {
    const seen: IngestResult[] = [];
    const { run, engine } = harness({}, { onIngest: (result) => seen.push(result) });
    await run.ingest(0);
    await run.ingest(0);
    assert.equal(engine.reports, 0, 'nothing reaches the wire');
    assert.deepEqual(
      seen.map((r) => [r.ok, Object.keys(r.reported).length]),
      [
        [true, 0],
        [true, 0],
      ],
      'an observer watching every ingest sees these too',
    );
    const summary = await run.drain();
    assert.equal(summary.ingested, 2, 'a run of empty turns is not a run that never metered');
    assert.deepEqual(summary.reported, {});
    assert.equal(summary.ingestFailures, 0);
  });

  for (const [label, value] of [
    ['NaN, which a mapper dividing by an unset config returns', NaN],
    ['Infinity, which one dividing by zero returns', Infinity],
    ['-Infinity', -Infinity],
    ['a negative value, which would hand usage back as a DELTA', -5],
  ] as const) {
    it(`refuses ${label}, rather than metering it as a silent zero`, async () => {
      const { run, engine, errors } = harness();
      const result = await run.ingest(value);
      assert.equal(result.ok, false, 'a broken measurement must not read as a delivered one');
      assert.equal(engine.reports, 0, 'and never reaches the wire');
      assert.deepEqual(errors, [{ operation: 'ingest' }]);
      const summary = await run.drain();
      assert.equal(summary.ingestFailures, 1, 'the run says so rather than looking idle');
      assert.deepEqual(summary.reported, {});
    });
  }

  it('counts a run whose mapper is broken as failing, not as one that used nothing', async () => {
    // A mapper dividing by an unset config: an empty env var, not a typo.
    const { run } = harness({ usageLimit: null }, { usageMapper: () => ({ credits: Infinity }) });
    await run.ingestTokens({ input: 600, output: 300, cacheRead: 0, cacheCreate: 0 });
    const summary = await run.drain();
    assert.equal(summary.ingestFailures, 1);
    assert.equal(summary.ingested, 0);
  });

  it('maps tokens through the configured unit size', async () => {
    const { run, engine } = harness({ usageLimit: null });
    await run.ingestTokens({ input: 600, output: 300, cacheRead: 100, cacheCreate: 0 });
    assert.equal(engine.currentUsage, 1, '1000 tokens is one unit');
  });
});

describe('session.drain', () => {
  it('waits for in-flight ingests so the summary is what was actually delivered', async () => {
    const { run } = harness({ usageLimit: null });
    void run.ingest(2);
    void run.ingest(3);
    const summary = await run.drain();
    assert.equal(summary.ingested, 2);
    assert.deepEqual(summary.reported, { credits: 5 });
    assert.equal(summary.ingestFailures, 0);
  });
});

describe('session hooks are instrumentation, never a participant', () => {
  const throwing = () => {
    throw new Error('hook blew up');
  };

  it('keeps a delivered ingest successful when onIngest throws', async () => {
    const { run, errors } = harness({ usageLimit: null }, { onIngest: throwing });
    const result = await run.ingest(2);
    assert.equal(result.ok, true, 'the report landed; the hook is not part of the delivery');
    assert.deepEqual(result.reported, { credits: 2 });
    const summary = await run.drain();
    assert.equal(summary.ingestFailures, 0, 'and it is not counted as a failed ingest');
    assert.deepEqual(
      errors.map((error) => error.operation),
      ['onIngest'],
    );
  });

  it('keeps a decision intact when onDecision throws', async () => {
    const { run, errors } = harness({ usageLimit: 5 }, { onDecision: throwing });
    const decision = await run.check(1);
    assert.equal(decision.hasAccess, true);
    assert.deepEqual(
      errors.map((error) => error.operation),
      ['onDecision'],
    );
  });

  it('does not reject a failed ingest when the hooks throw on the way out', async () => {
    const { run } = harness(
      { usageLimit: null, failReport: new Error('network down') },
      { onIngest: throwing, onError: throwing },
    );
    const result = await run.ingest(2);
    assert.equal(result.ok, false, 'the ingest still answers - it is documented never to throw');
    assert.ok(result.error instanceof EngineError);
    assert.equal(result.error.operation, 'ingest');
  });
});

describe('an ingest that consumed nothing leaves nothing behind', () => {
  it('drops the warm state when the report never landed, rather than keeping a low guess', async () => {
    const { run, engine } = harness({ usageLimit: 3, failReport: new EngineError('ingest', 'boom') });
    const first = await run.check(1);
    assert.equal(first.remaining, 3);

    const result = await run.ingest(2);
    assert.equal(result.ok, false);

    // The wallet was never drawn, so the deduction that preceded the call is a fiction now.
    const next = await run.check(1);
    assert.equal(engine.checks, 2, 'the next check asks rather than trusting a figure it knows is low');
    assert.equal(next.source, 'rest');
    assert.equal(next.remaining, 3);
  });

  it('drops it for a feature run too, which now spends its own budget down the same way', async () => {
    const { run, engine } = harness(
      { usageLimit: 3, failReport: new EngineError('ingest', 'boom') },
      { entitlement: { featureId: 'tokens' } },
    );
    await run.check(1);
    await run.ingest(2);
    const next = await run.check(1);
    assert.equal(engine.checks, 2, 'the deduction that preceded the failed call is a fiction now');
    assert.equal(next.source, 'rest');
    assert.equal(next.remaining, 3);
  });

  it('counts a replay as an ingest but not as spend', async () => {
    const { run } = harness({ usageLimit: null });
    const first = await run.ingest(1, { idempotencyKey: 'run-1:node-a' });
    const second = await run.ingest(1, { idempotencyKey: 'run-1:node-a' });
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);

    const summary = await run.drain();
    assert.equal(summary.ingested, 2, 'both calls were delivered');
    assert.deepEqual(summary.reported, { credits: 1 }, 'but the server counted the key once');
    assert.equal(summary.ingestFailures, 0);
  });
});

describe('a hook typed void may still be async', () => {
  const rejecting = () => Promise.reject(new Error('hook blew up')) as unknown as void;

  it('routes a rejected onIngest to onError instead of an unhandled rejection', async () => {
    const { run, errors } = harness({ usageLimit: null }, { onIngest: rejecting });
    const result = await run.ingest(2);
    assert.equal(result.ok, true, 'the delivery stands');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      errors.map((e) => e.operation),
      ['onIngest'],
    );
  });

  it('routes a rejected onDecision the same way, leaving the decision intact', async () => {
    const { run, errors } = harness({ usageLimit: 5 }, { onDecision: rejecting });
    const decision = await run.check(1);
    assert.equal(decision.hasAccess, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      errors.map((e) => e.operation),
      ['onDecision'],
    );
  });

  it('falls back to the logger when onError itself rejects, without calling it again', async () => {
    const warnings: string[] = [];
    let calls = 0;
    const { run } = harness(
      { usageLimit: null, failReport: new EngineError('ingest', 'boom') },
      {
        logger: { ...noopLogger, warn: (message: string) => warnings.push(message) },
        onError: () => {
          calls += 1;
          return Promise.reject(new Error('onError blew up')) as unknown as void;
        },
      },
    );
    const result = await run.ingest(2);
    assert.equal(result.ok, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'reporting the reporter would loop');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /onError threw while reporting/);
  });
});

describe('what a call measures with, and what it is called', () => {
  it('reports a throwing mapper instead of rejecting the ingest', async () => {
    const { run, engine, errors } = harness(
      { usageLimit: null },
      {
        usageMapper: () => {
          throw new Error('the vendor changed shape');
        },
      },
    );
    const result = await run.ingestTokens({ input: 600, output: 400, cacheRead: 0, cacheCreate: 0 });
    assert.equal(result.ok, false, 'ingest is documented never to throw, mapper included');
    assert.equal(engine.reports, 0);
    assert.deepEqual(
      errors.map((e) => e.operation),
      ['measure'],
    );
  });

  it('keeps the context attribution a measurement did not mention', async () => {
    const { run, engine } = harness({ usageLimit: null });
    // Through the context's own mapper, which is what decides what a measurement reports.
    await run.ingestMeasurement({
      usage: { input: 2000, output: 0, cacheRead: 0, cacheCreate: 0 },
      dimensions: { model: 'claude-sonnet-4' },
    });
    await run.drain();
    assert.deepEqual(engine.dimensionsSeen.at(-1), {
      agentId: 'agent-1',
      model: 'claude-sonnet-4',
    });
  });

  it('trims its own identity, so the headers it emits match what a parser reads back', async () => {
    const { run } = harness({}, { customerId: '  customer-acme  ', correlationId: '  run-1  ' });
    assert.equal(run.customerId, 'customer-acme');
    assert.equal(run.correlationId, 'run-1');
    assert.equal(run.headers()['x-stigg-customer-id'], 'customer-acme');
    assert.equal(run.headers()['x-stigg-run-id'], 'run-1');
  });
});

describe('one call, several meters', () => {
  it('reports each metric once, under its own idempotency key', async () => {
    const { run, engine } = harness({ usageLimit: null }, { usageMapper: (m: Measurement) => m.metrics ?? {} });
    await run.ingestMeasurement({ metrics: { input_tokens: 9, output_tokens: 46 } }, { idempotencyKey: 'k1' });
    await run.drain();

    assert.equal(engine.reports, 1, 'one call to the engine, not one per metric');
    assert.deepEqual(engine.metricsSeen.at(-1), { input_tokens: 9, output_tokens: 46 });
    assert.deepEqual(
      [...engine.seenKeys],
      ['k1:input_tokens', 'k1:output_tokens'],
      'each metric dedupes against its own earlier report, not against its siblings',
    );
  });

  it('sums what a run reported per feature, not into one meaningless total', async () => {
    const { run } = harness({ usageLimit: null }, { usageMapper: (m: Measurement) => m.metrics ?? {} });
    await run.ingestMeasurement({ metrics: { input_tokens: 9, output_tokens: 46 } });
    await run.ingestMeasurement({ metrics: { input_tokens: 4, cost: 1 } });

    const summary = await run.drain();
    assert.deepEqual(summary.reported, { input_tokens: 13, output_tokens: 46, cost: 1 });
    assert.equal(summary.ingested, 2, 'two calls, whatever each of them metered');
  });

  it('sends the metrics it can and says the turn did not report everything', async () => {
    const { run, engine, errors } = harness(
      { usageLimit: null },
      { usageMapper: () => ({ input_tokens: 9, output_tokens: Number.NaN }) },
    );
    const result = await run.ingestMeasurement({ metrics: {} });
    await run.drain();

    // The nine tokens are real and already spent, so they go - dropping them would understate a
    // bill, which is the one direction a meter must not be wrong in.
    assert.deepEqual(engine.metricsSeen.at(-1), { input_tokens: 9 });
    assert.deepEqual(result.reported, { input_tokens: 9 });

    // But `IngestResult.ok` is documented as "true only when every metric landed", and one did
    // not. This used to answer `ok: true` with nothing reported anywhere, so a mapper returning
    // NaN for one counter lost it in silence - the turn measured two things and billed one.
    assert.equal(result.ok, false, 'one of the two metrics never landed');
    assert.equal(isEngineError(result.error) && result.error.operation, 'ingest');
    assert.equal(errors.length, 1, 'a mapper that produced an unusable value is worth reporting');
  });

  it('fails the ingest when every metric is broken, rather than reporting silence', async () => {
    const { run, engine, errors } = harness(
      { usageLimit: null },
      { usageMapper: () => ({ input_tokens: Number.NaN }) },
    );
    const result = await run.ingestMeasurement({ metrics: {} });

    assert.equal(result.ok, false);
    assert.equal(engine.reports, 0);
    assert.deepEqual(
      errors.map((e) => e.operation),
      ['ingest'],
    );
  });

  it('says so, once, when nothing it reported can drain the budget it checks', async () => {
    const { run, warnings } = harness(
      { usageLimit: null, creditBacked: false },
      { usageMapper: (m: Measurement) => m.metrics ?? {} },
    );
    await run.ingestMeasurement({ metrics: { input_tokens: 9 } });
    await run.ingestMeasurement({ metrics: { input_tokens: 4 } });
    await run.drain();

    const unmapped = warnings.filter((line) => line.includes('no credit balance'));
    assert.equal(unmapped.length, 1, 'once per run, however many turns');
    assert.match(unmapped[0]!, /input_tokens.*never drain.*Map it in Stigg/s);
  });
});

/**
 * The entitlement is the enforcement switch, and this is the half of it the handle owns: a run that
 * named none gates nothing and meters exactly as the gated one above does. What is worth pinning
 * here is not that checks pass - it is that nobody is asked, and that every number a caller reads
 * afterwards still says what happened.
 */
describe('a context that names no entitlement meters, and gates nothing', () => {
  const metering = (options: FakeEngineOptions = {}, overrides: BoundSessionOptions = {}) =>
    harness(options, { entitlement: undefined, usageMapper: (m: Measurement) => m.metrics ?? {}, ...overrides });

  it('allows every check without ever reaching the engine - there is nothing there to ask', async () => {
    const { run, engine } = metering({ usageLimit: 0 });
    const decision = await run.check(5);

    assert.equal(decision.hasAccess, true, 'an empty budget cannot refuse a run that is not checking one');
    assert.equal(engine.checks, 0, 'nobody was asked');
  });

  it('says which kind of allow it is, so a log line explains why nothing was ever refused', async () => {
    const { run } = metering();
    const decision = await run.check(1);

    assert.equal(decision.source, 'unenforced');
    assert.equal(decision.remaining, undefined, 'nothing is bounded');
    assert.equal(decision.deniedBy, undefined, 'and nothing refused');
    assert.match(decision.summary, /source=unenforced.*named no entitlement/);
  });

  it('still counts the check and still tells onDecision, because the caller did ask', async () => {
    const seen: string[] = [];
    const { run } = metering({}, { onDecision: (decision) => seen.push(decision.source) });
    await run.check(1);
    const summary = await run.drain();

    assert.deepEqual(seen, ['unenforced']);
    assert.equal(summary.checks, 1);
  });

  it('does not warm up, so a run nobody checked reports no checks at all', async () => {
    const { run, engine } = metering({ usageLimit: 0 });
    await run.warmUp();

    const summary = await run.drain();
    assert.equal(engine.checks, 0);
    assert.deepEqual(engine.preloaded, [], 'nothing to warm for a context that checks nothing');
    assert.equal(summary.checks, 0, 'the number an operator reads to confirm the mode');
  });

  it('reports metrics by name exactly as a gated run does - metering is the whole point', async () => {
    const { run, engine } = metering({ usageLimit: 0 });
    const result = await run.ingestMeasurement({ metrics: { input_tokens: 12, output_tokens: 4 } });
    await run.drain();

    assert.equal(result.ok, true);
    assert.deepEqual(result.reported, { input_tokens: 12, output_tokens: 4 });
    assert.equal(engine.reports, 1, 'an empty budget stops nothing here either');
  });

  it('fails ingest(value) honestly instead of throwing, because there is no feature id to use', async () => {
    const { run, engine, errors } = metering();
    const result = await run.ingest(7);

    assert.equal(result.ok, false);
    assert.equal(engine.reports, 0, 'there was no name to report it under');
    assert.deepEqual(
      errors.map((e) => e.operation),
      ['ingest'],
    );
    assert.match(String((result.error as Error).message), /named none.*ingestMetrics/s);
  });

  it('never warns that nothing drains, because no budget was ever being watched', async () => {
    const { run, warnings } = metering({ usageLimit: null, creditBacked: false });
    await run.ingestMeasurement({ metrics: { input_tokens: 9 } });
    await run.drain();

    assert.deepEqual(
      warnings.filter((line) => line.includes('never drain')),
      [],
    );
  });

  it('emits the same headers, so a gateway downstream cannot tell the difference', () => {
    assert.deepEqual(metering().run.headers(), harness().run.headers());
  });
});

/**
 * Two budgets can be called the same thing.
 *
 * A credit currency and a metered feature are different objects in Stigg with different
 * enforcement - one draws the customer's wallet, the other needs an entitling subscription - and
 * nothing stops an account naming both `credits`. This used to be a cache-key test: the key had
 * to carry the kind as well as the id, or an allow cached for one authorized the other. There is
 * no key and no cache now, so what is left to prove is that each check reaches the engine with
 * the entitlement it was actually asked about.
 */
describe('a currency and a feature of the same name stay two budgets', () => {
  it('asks about each one separately', async () => {
    // One session, two contexts - the shape a wrapped client has: it serves every tenant and
    // every budget a process is called for.
    const engine = new FakeEngine({ usageLimit: 5 });
    const { session } = newRun({ engine });
    const base = { customerId: 'customer-acme', dimensions: { agentId: 'agent-1' } };
    const wallet = resolveContext({ ...base, entitlement: { currencyId: 'credits' } }, 'r1');
    const feature = resolveContext({ ...base, entitlement: { featureId: 'credits' } } as never, 'r2');

    await session.check(wallet, 1);
    await session.check(feature, 1);

    assert.equal(engine.checks, 2, 'the feature check was served the wallet decision');
  });
});

/**
 * Warm-up primes the engine's cache, because that is the only cache there is.
 *
 * It used to run a `check(context, 1)` and keep the answer here - which seeded the most
 * permissive decision obtainable and then served it to calls asking for far more. Now it hands
 * the customer to the engine, which loads their whole entitlement state and evaluates every
 * later check against the amount that check actually asks for.
 */
describe('session.warmUp', () => {
  it('asks the engine to load the customer, and checks nothing', async () => {
    const engine = new FakeEngine({ usageLimit: 5 });
    const { session, context } = newRun({ engine });

    await session.warmUp(context);

    assert.deepEqual(engine.preloaded, [{ customerId: 'customer-acme', dimensions: { agentId: 'agent-1' } }]);
    assert.equal(engine.checks, 0, 'a warm-up is not a check and must not be counted as one');
    assert.equal(session.summary().checks, 0);
  });

  it('is a no-op on an engine that caches nothing, rather than an error', async () => {
    // The governance REST client's shape: no `preload` at all, because there is nothing to fill.
    const engine = new FakeEngine({ usageLimit: 5 });
    const { session, context } = newRun({ engine: withPreload(engine, undefined) });

    await session.warmUp(context);
    assert.equal(engine.checks, 0);
  });

  it('reports a failing warm-up as a warning and lets the client work', async () => {
    const engine = new FakeEngine({ usageLimit: 5 });
    const warnings: string[] = [];
    const { session, context } = newRun({
      engine: withPreload(engine, () => Promise.reject(new Error('redis is down'))),
      logger: { ...noopLogger, warn: (line: string) => warnings.push(line) },
    });

    await session.warmUp(context);

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /warm-up failed for customer-acme/);
    assert.equal((await session.check(context, 1)).hasAccess, true, 'the client still works');
  });
});

/** A `FakeEngine` with its `preload` swapped - or removed, which is how a cacheless engine looks. */
function withPreload(engine: FakeEngine, preload: GovernanceEngine['preload']): GovernanceEngine {
  return {
    capabilities: engine.capabilities,
    upsertEntity: (...args) => engine.upsertEntity(...args),
    check: (...args) => engine.check(...args),
    report: (...args) => engine.report(...args),
    archiveEntity: (...args) => engine.archiveEntity(...args),
    ...(preload ? { preload } : {}),
  };
}
