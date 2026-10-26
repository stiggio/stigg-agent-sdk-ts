/**
 * Three ways a call could be billed to the wrong place, or not at all.
 *
 * Each of these failed silently: nothing threw, nothing logged, and the usage either landed on
 * another customer's invoice or never landed at all. They share a shape - a value that is fine
 * per call and wrong when it belongs to the client - which is why they are tested together.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import { StiggAgentSDK } from '../src/index';
import type { StiggContext } from '../src/index';
import type { ClientOptions } from '../src/types';
import { overrideContext, resolveContext } from '../src/internal';

const BASE = { apiKey: 'server-test-key', baseUrl: 'https://stigg.internal' } as const;

// The compiler half of the same rule. `@ts-expect-error` fails the typecheck if the error stops
// happening - so this breaks loudly the day `ClientContext` lets the field back in.
const _wrapRejectsIdempotencyKey: ClientOptions = {
  // @ts-expect-error `idempotencyKey` deduplicates one report and cannot belong to a client
  stiggContext: { customerId: 'customer-acme', idempotencyKey: 'one-key' },
};
void _wrapRejectsIdempotencyKey;

// A bare `Omit` only rejects the field in a fresh object literal: excess-property checking is what
// catches it there, and that check does not run on a variable that is already typed. So the same
// key, parked in a `StiggContext` first, used to reach `wrap` with the compiler saying nothing.
const parked: StiggContext = { customerId: 'customer-acme', idempotencyKey: 'one-key' };
const _wrapRejectsIdempotencyKeyFromAVariable: ClientOptions = {
  // @ts-expect-error a client context cannot carry `idempotencyKey`, however it is spelled
  stiggContext: parked,
};
void _wrapRejectsIdempotencyKeyFromAVariable;

describe('an idempotency key belongs to a report, not to a client', () => {
  it('is refused at wrap, where it would silence every call after the first', () => {
    assert.throws(
      () =>
        resolveContext({ customerId: 'customer-acme', idempotencyKey: 'one-key' }, 'run-1', {
          requireCustomer: false,
        }),
      /cannot set `idempotencyKey`/,
      'one key for every call through a client is deduplicated down to the first report',
    );
  });

  it('is accepted per call, which is what it is for', () => {
    const base = resolveContext({ customerId: 'customer-acme' }, 'run-1', { requireCustomer: false });
    const call = overrideContext(base, { idempotencyKey: 'this-report' });
    assert.equal(call.idempotencyKey, 'this-report');
  });
});

describe('a call that names a customer must name one', () => {
  const base = resolveContext({ customerId: 'customer-acme' }, 'run-1', { requireCustomer: false });

  // `{ agentId: undefined }` names nothing that can change which budget is consulted, so
  // `overrideContext` returns the base untouched and never reaches the branch below. A context
  // that *does* rebase, while naming no customer, is what actually exercises the inherit path.
  it('inherits the client default when the field is absent', () => {
    assert.equal(overrideContext(base, { dimensions: { region: 'eu' } }).customerId, 'customer-acme');
  });

  // `null` and a number are what a JavaScript caller passes by accident - a config read that
  // returned nothing, an id that was never a string. Both used to surface as a raw TypeError.
  for (const blank of ['', '   ', null, 0, {}]) {
    it(`throws on ${JSON.stringify(blank) ?? 'null'} rather than billing the default customer`, () => {
      assert.throws(
        () => overrideContext(base, { customerId: blank as unknown as string }),
        /customerId is empty/,
        "an empty id used to fall through to the client default - someone else's invoice",
      );
    });
  }
});

describe('a default plan sits beside the customer, not inside it', () => {
  const base = resolveContext({ defaultPlanId: ' plan-free ' }, 'run-1', { requireCustomer: false });

  it('is given at wrap and kept by a call that names only its customer', () => {
    const call = overrideContext(base, { customerId: 'customer-acme' });
    assert.equal(call.customerId, 'customer-acme');
    assert.equal(call.defaultPlanId, 'plan-free');
  });

  it('is replaced by a call that names its own', () => {
    assert.equal(overrideContext(base, { defaultPlanId: 'plan-pro' }).defaultPlanId, 'plan-pro');
  });

  it('stays absent when nobody names one', () => {
    const none = resolveContext({ customerId: 'customer-acme' }, 'run-1');
    assert.equal(none.defaultPlanId, undefined);
  });

  for (const blank of ['', '   ', null, 0]) {
    it(`throws on ${JSON.stringify(blank)} rather than provisioning onto nothing`, () => {
      assert.throws(
        () => overrideContext(base, { defaultPlanId: blank as unknown as string }),
        /defaultPlanId is empty/,
      );
      assert.throws(
        () => resolveContext({ defaultPlanId: blank as unknown as string }, 'run-1', { requireCustomer: false }),
        /defaultPlanId is empty/,
      );
    });
  }
});

describe('the API key is readable and not printable', () => {
  const sdk = new StiggAgentSDK({ ...BASE, apiKey: 'server-SUPERSECRET' });

  it('still reads where the engines need it', () => {
    assert.equal(sdk.config.apiKey, 'server-SUPERSECRET');
  });

  // A caller-supplied client carries its own copy of the key, so hiding `config.apiKey` alone
  // left `console.log(stigg.config)` printing it through there. Both objects render themselves.
  it('stays hidden when the caller supplies a client that holds its own copy', async () => {
    const held = { apiKey: 'server-SUPERSECRET', configuration: { apiKey: 'server-SUPERSECRET' } };
    const withClient = new StiggAgentSDK({ ...BASE, apiKey: 'server-SUPERSECRET', client: held as never });

    for (const rendered of [
      inspect(withClient, { depth: 8 }),
      JSON.stringify(withClient) ?? '',
      inspect(withClient.config, { depth: 8 }),
      JSON.stringify(withClient.config) ?? '',
    ]) {
      assert.equal(rendered.includes('SUPERSECRET'), false, rendered.slice(0, 80));
    }

    await withClient.close().catch(() => undefined);
  });

  it('does not appear in inspect, JSON, or the key list', () => {
    assert.equal(inspect(sdk, { depth: 4 }).includes('SUPERSECRET'), false, 'console.log prints the SDK object');
    assert.equal(JSON.stringify(sdk).includes('SUPERSECRET'), false, 'structured loggers serialize it');
    assert.equal(Object.keys(sdk.config).includes('apiKey'), false);
  });
});

describe('what the SDK object says about itself', () => {
  // Hiding the key must not also freeze the field: `ResolvedConfig` declares `apiKey` writable, so
  // rotating it has to keep working. `defineProperty` defaults `writable` to false, which is how a
  // plain assignment started throwing in strict mode - every ES module - while the type said it was fine.
  it('leaves apiKey assignable, as its type promises', () => {
    const rotating = new StiggAgentSDK({ ...BASE, apiKey: 'server-SUPERSECRET' });
    rotating.config.apiKey = 'server-ROTATED';
    assert.equal(rotating.config.apiKey, 'server-ROTATED');
    assert.equal(Object.keys(rotating.config).includes('apiKey'), false, 'still hidden from logs');
  });

  // `started` is the in-flight promise, set the moment a probe begins and kept for the retry
  // window after one fails - so reading it answered "did anything try?", not "is there an engine?".
  it('reports started only once an engine actually exists', async () => {
    const unreachable = new StiggAgentSDK({ ...BASE, baseUrl: 'http://127.0.0.1:1/nope' });
    assert.equal((JSON.parse(JSON.stringify(unreachable)) as { started: boolean }).started, false);

    await unreachable.init().catch(() => undefined);
    const after = JSON.parse(JSON.stringify(unreachable)) as { started: boolean };
    assert.equal(after.started, false, 'a failed probe left no engine, so nothing started');

    await unreachable.close().catch(() => undefined);
  });
});
