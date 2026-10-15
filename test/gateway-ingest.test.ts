/**
 * The gateway path: usage a different process observed, attributed from the request's headers.
 *
 * It has no run handle - a gateway sees requests, not runs - so everything the handle does for an
 * ingest, this call has to do for itself. These cases are about the half that is easy to forget.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EngineError } from '../src/errors';
import { GOVERNANCE_HEADERS } from '../src/headers';
import { context, newStigg } from './stigg-harness';
import { seedCreditRate, seedEventMeter } from '../testing/mock-stigg-server';
import type { IngestResult } from '../src/types';
import type { ErrorContext } from '../src/config';

/** These cases are about the usage DTO and the balance it answers with, so they name that mode. */
const sync = { ingest: 'sync' } as const;

const headers = {
  [GOVERNANCE_HEADERS.customer]: context.customerId,
  [GOVERNANCE_HEADERS.dimensions]: JSON.stringify({ agentId: 'agent-1' }),
  [GOVERNANCE_HEADERS.run]: 'run-1',
  [GOVERNANCE_HEADERS.attributionKey]: 'agentId',
};

const usage = { input: 600, output: 400, cacheRead: 0, cacheCreate: 0 };
/** What a proxy actually observes: somebody else's response, in that vendor's own words. */
const anthropicUsage = { input_tokens: 600, output_tokens: 400 };

describe('ingestFromHeaders', () => {
  it('meters against the entity the request names', async () => {
    const { stigg, mock } = await newStigg();
    const result = await stigg.ingestFromHeaders(headers, {
      ...context,
      ...sync,
      vendor: 'anthropic',
      usage: anthropicUsage,
      idempotencyKey: 'run-1:1',
    });
    assert.equal(result.ok, true);
    // The same default a wrapped client gets: the names the vendor itself used.
    assert.deepEqual(result.reported, { input_tokens: 600, output_tokens: 400 });
    assert.deepEqual(mock.state.dimensionsSeen.at(-1), { agentId: 'agent-1' });
  });

  it('reports nothing raw when nobody says whose usage this is, rather than guessing', async () => {
    const { stigg } = await newStigg();
    // Anthropic and the Responses API both count `input_tokens`. A guess that got it wrong used
    // to mis-count; under vendor names it would report to somebody else's meter entirely.
    const result = await stigg.ingestFromHeaders(headers, {
      ...context,
      ...sync,
      usage: anthropicUsage,
      idempotencyKey: 'run-1:2',
    });
    assert.equal(result.ok, true, 'not an error - there was simply nothing it could safely name');
    assert.deepEqual(result.reported, {});
  });

  it('still takes a mapper, which needs no vendor because it reads the normalized counters', async () => {
    const { stigg } = await newStigg();
    const result = await stigg.ingestFromHeaders(headers, {
      ...context,
      ...sync,
      usage: anthropicUsage,
      metrics: ({ usage: counted }) => ({
        credits: Math.ceil(((counted?.input ?? 0) + (counted?.output ?? 0)) / 1000),
      }),
      idempotencyKey: 'run-1:3',
    });
    assert.deepEqual(result.reported, { credits: 1 });
  });

  it('refuses a request carrying no attribution, rather than billing the wrong customer', async () => {
    const { stigg, mock } = await newStigg();
    const result = await stigg.ingestFromHeaders({}, { ...context, usage, idempotencyKey: 'run-1:1' });
    assert.equal(result.ok, false);
    assert.equal(mock.state.dimensionsSeen.length, 0);
  });

  it('treats a zero-token turn as a no-op, not a failure', async () => {
    const { stigg, mock } = await newStigg();
    const result = await stigg.ingestFromHeaders(headers, {
      ...context,
      ...sync,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      idempotencyKey: 'run-1:1',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.reported, {});
    assert.equal(mock.state.dimensionsSeen.length, 0, 'nothing to report');
  });

  // None of these is a measurement on any path. A fraction is not among them: the wallet takes
  // one, and so does an event - only `POST /api/v1/usage` refuses it.
  for (const [label, mapped, complaint] of [
    ['NaN', NaN, /finite non-negative/],
    ['Infinity', Infinity, /finite non-negative/],
    ['a negative value', -5, /finite non-negative/],
  ] as const) {
    it(`refuses ${label} from the mapper rather than sending it`, async () => {
      const { stigg, mock } = await newStigg();
      const errors: string[] = [];
      stigg.config.onError = (error) => errors.push(error.message);

      const result = await stigg.ingestFromHeaders(headers, {
        ...context,
        ...sync,
        usage,
        metrics: () => ({ credits: mapped }),
        idempotencyKey: 'run-1:1',
      });

      assert.equal(result.ok, false, 'a broken measurement must not read as a delivered one');
      assert.equal(mock.state.dimensionsSeen.length, 0, 'and never reaches the wire');
      assert.equal(errors.length, 1);
      assert.match(errors[0], complaint);
    });
  }

  it('sends a fractional draw as given when nothing is attributed', async () => {
    // Verified against the API: a fractional `amount` answers 200 and the balance comes back
    // fractional. Rounding here would be this SDK's arithmetic on someone else's price.
    const { stigg } = await newStigg();
    const errors: string[] = [];
    stigg.config.onError = (error) => errors.push(error.message);

    const result = await stigg.ingestFromHeaders(
      { ...headers, [GOVERNANCE_HEADERS.dimensions]: JSON.stringify({}), [GOVERNANCE_HEADERS.attributionKey]: '' },
      { ...context, ...sync, usage, metrics: () => ({ credits: 1.5 }), idempotencyKey: 'run-frac:1' },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(errors, []);
    assert.equal(result.reported.credits, 1.5, 'as given, not rounded');
  });

  it('leaves a draw exact when the dimensions are ordinary metadata', async () => {
    // `{ region: 'eu' }` is not attribution, and from out of process it looks exactly like it is.
    // Rounding on the mere presence of a dimension overcharged a wallet with no entity behind it,
    // which is why the sending side now names the key rather than leaving the receiver to guess.
    const { stigg } = await newStigg();
    const result = await stigg.ingestFromHeaders(
      {
        [GOVERNANCE_HEADERS.customer]: context.customerId,
        [GOVERNANCE_HEADERS.dimensions]: JSON.stringify({ region: 'eu' }),
        [GOVERNANCE_HEADERS.run]: 'run-meta',
      },
      { ...context, ...sync, usage, metrics: () => ({ credits: 1.5 }), idempotencyKey: 'run-meta:1' },
    );

    assert.equal(result.reported.credits, 1.5, 'metadata is not an entity');
  });

  it('ignores an attribution key that names no dimension', async () => {
    // A key with nothing under it attributes to nothing, so there is no counter to keep whole.
    const { stigg } = await newStigg();
    const result = await stigg.ingestFromHeaders(
      {
        ...headers,
        [GOVERNANCE_HEADERS.dimensions]: JSON.stringify({ region: 'eu' }),
        [GOVERNANCE_HEADERS.attributionKey]: 'agentId',
      },
      { ...context, ...sync, usage, metrics: () => ({ credits: 1.5 }), idempotencyKey: 'run-empty-key:1' },
    );

    assert.equal(result.reported.credits, 1.5);
  });

  it('rounds an attributed draw up, because governance counts whole units', async () => {
    // The headers name an agent, so governance will resolve an entity and increment its counter -
    // and that counter is a Redis `HINCRBY` behind a `z.number().int()` schema. A fraction is
    // rejected there while the wallet still moves, so the entity's budget stops advancing in
    // silence. Rounded here instead, and announced. See `wholeUnitsForGovernance`.
    const { stigg } = await newStigg();
    const result = await stigg.ingestFromHeaders(headers, {
      ...context,
      ...sync,
      usage,
      metrics: () => ({ credits: 1.5 }),
      idempotencyKey: 'run-frac-attributed:1',
    });

    assert.equal(result.ok, true);
    assert.equal(result.reported.credits, 2, 'up, so a call that happened still costs something');
  });
});

describe('the gateway reports through the same two APIs', () => {
  it('sends one event per observed call by default, named after the vendor it was told about', async () => {
    const { stigg, mock } = await newStigg();
    seedEventMeter(mock.state, {
      eventName: 'anthropic.proxied',
      featureId: 'input_tokens',
      aggregation: { function: 'SUM', field: 'input_tokens' },
    });
    seedCreditRate(mock.state, 'input_tokens', 1);

    // No `ingest`, no `events`: a proxy out of process has no wrapped call to take a name from,
    // so the vendor it declared is the closest thing to the call that actually happened.
    const result = await stigg.ingestFromHeaders(headers, {
      ...context,
      vendor: 'anthropic',
      usage: anthropicUsage,
      idempotencyKey: 'req-42',
    });

    assert.equal(result.mode, 'async');
    assert.equal(result.replayed, undefined, 'the event API cannot say, so neither does this');
    assert.equal(mock.state.usageByFeature.get('input_tokens'), 600, 'the meter read the event');
  });

  it('carries the vendor block the proxy observed, for a meter to read', async () => {
    const { stigg, mock } = await newStigg();
    seedEventMeter(mock.state, {
      eventName: 'anthropic.proxied',
      featureId: 'cache_read_input_tokens',
      // A counter the recipe drops as a zero is still a field on the event.
      aggregation: { function: 'SUM', field: 'raw.cache_read_input_tokens' },
    });
    seedCreditRate(mock.state, 'cache_read_input_tokens', 1);

    await stigg.ingestFromHeaders(headers, {
      ...context,
      vendor: 'anthropic',
      usage: { ...anthropicUsage, cache_read_input_tokens: 25 },
      idempotencyKey: 'req-43',
    });

    assert.equal(mock.state.usageByFeature.get('cache_read_input_tokens'), 25);
  });
});

describe('ingestFromHeaders answers rather than throws', () => {
  const hooked = async () => {
    const errors: string[] = [];
    const seen: IngestResult[] = [];
    const { stigg, mock } = await newStigg({ onError: (error) => errors.push(error.message) });
    // Spread into each call: out here there is no run to hang an observer on, so the report
    // carries its own.
    const tap = { onIngest: (result: IngestResult) => void seen.push(result) };
    return { stigg, mock, errors, seen, tap };
  };

  it('returns a failure when the mapper throws, rather than rejecting', async () => {
    const { stigg, mock, errors, seen, tap } = await hooked();
    const result = await stigg.ingestFromHeaders(headers, {
      ...context,
      ...sync,
      ...tap,
      usage,
      metrics: () => {
        throw new Error('the vendor changed shape');
      },
      idempotencyKey: 'run-1:1',
    });
    assert.equal(result.ok, false, 'the caller is holding a request, not a run');
    assert.equal(mock.state.dimensionsSeen.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(seen.length, 1, 'and the observers hear about it like any other result');
  });

  /**
   * An ingest is up to two calls - the features, then the wallet - so a rejection on the second
   * leaves the first one's spend sitting at Stigg. `asEngineError` preserves what landed; this
   * path used to construct its result with a hardcoded `reported: {}`, so a gateway was told
   * nothing was reported and would retry usage that had already been billed. The in-process
   * session had the same bug and was fixed first; this is the other half.
   */
  it('reports what landed before a later call failed, rather than claiming nothing did', async () => {
    const { stigg, mock, tap } = await hooked();
    const landed = { input_tokens: 7 };
    // The engine only exists once started, and the stand-in rejects the way a half-delivered
    // ingest does: carrying what had already been accepted.
    await stigg.init();
    const engine = (stigg as unknown as { engine: { report: () => Promise<never> } }).engine;
    engine.report = () =>
      Promise.reject(new EngineError('ingest', 'the wallet draw rejected', { reported: landed, replayed: false }));

    const result = await stigg.ingestFromHeaders(headers, {
      ...context,
      ...sync,
      ...tap,
      usage,
      metrics: () => landed,
      idempotencyKey: 'run-partial:1',
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.reported, landed, 'the features were accepted and the caller has to know');
    assert.equal(result.replayed, false);
    void mock;
  });

  it('refuses an empty idempotency key, which would bill every retry again', async () => {
    const { stigg, mock, tap } = await hooked();
    const result = await stigg.ingestFromHeaders(headers, { ...context, ...tap, usage, idempotencyKey: '' });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /idempotencyKey must not be empty/);
    assert.equal(mock.state.dimensionsSeen.length, 0);
  });

  /**
   * Out here nobody is holding a `RunHandle` to ask what this was for, so a failure reported
   * without the attribution is a failure attached to a request id and nothing else - even though
   * the run and the customer both arrived in the headers.
   */
  it('reports which run and customer a failed ingest was for', async () => {
    const { stigg } = await newStigg();
    const contexts: ErrorContext[] = [];
    stigg.config.onError = (_error, errorContext) => contexts.push(errorContext);

    await stigg.ingestFromHeaders(headers, {
      ...context,
      ...sync,
      usage,
      metrics: () => ({ credits: -5 }),
      idempotencyKey: 'run-1:1',
    });

    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].runId, 'run-1', 'the run id travelled in x-stigg-run-id');
    assert.equal(contexts[0].customerId, context.customerId);
    assert.equal(contexts[0].idempotencyKey, 'run-1:1');
  });

  it('claims no attribution for a failure raised before the headers are read', async () => {
    const { stigg } = await newStigg();
    const contexts: ErrorContext[] = [];
    stigg.config.onError = (_error, errorContext) => contexts.push(errorContext);

    // The empty key is rejected first, deliberately - so at that point the request has not been
    // read and saying which run it was for would be a guess.
    await stigg.ingestFromHeaders(headers, { ...context, usage, idempotencyKey: '' });

    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].runId, undefined);
    assert.equal(contexts[0].customerId, undefined);
  });

  it('tells the observers about a zero turn too', async () => {
    const { stigg, seen, tap } = await hooked();
    const result = await stigg.ingestFromHeaders(headers, {
      ...tap,
      ...context,
      ...sync,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      idempotencyKey: 'run-1:1',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      seen.map((r) => [r.ok, Object.keys(r.reported).length]),
      [[true, 0]],
    );
  });

  it('keeps a delivered ingest successful when the hook throws', async () => {
    const { stigg, mock } = await newStigg();
    const result = await stigg.ingestFromHeaders(headers, {
      ...context,
      ...sync,
      onIngest: () => {
        throw new Error('hook blew up');
      },
      vendor: 'anthropic',
      usage: anthropicUsage,
      idempotencyKey: 'run-1:1',
    });
    assert.equal(result.ok, true, 'the usage was delivered; the hook is not part of that');
    // One entry per metric: the call reported both counters Anthropic stated.
    assert.equal(mock.state.dimensionsSeen.length, 2);
  });
});

/**
 * The run paths dropped their credits default: naming no entitlement there is a caller asking not
 * to be gated, and substituting one would gate them. This path has no gate to speak of, so the same
 * absence means something else entirely - which metric name draws the wallet - and the default
 * stays. The two cases below are that distinction, written down.
 */
describe('a gateway routes rather than gates, which is why it still has a default', () => {
  it('still draws the wallet for a report that named no entitlement', async () => {
    const { stigg } = await newStigg();
    const result = await stigg.ingestFromHeaders(headers, {
      ...sync,
      // No entitlement, and a metric named after the credit currency.
      vendor: 'anthropic',
      usage: anthropicUsage,
      metrics: () => ({ credits: 3 }),
      idempotencyKey: 'req-50',
    });

    assert.equal(result.ok, true);
    assert.equal(result.creditsConsumed, 3, 'the wallet answered, so the wallet is what it drew');
  });

  it('reports a metric that is not the wallet as a feature, with or without one named', async () => {
    const { stigg, mock } = await newStigg();
    seedCreditRate(mock.state, 'input_tokens', 1);
    const result = await stigg.ingestFromHeaders(headers, {
      ...sync,
      vendor: 'anthropic',
      usage: anthropicUsage,
      idempotencyKey: 'req-51',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.reported, { input_tokens: 600, output_tokens: 400 });
  });
});
