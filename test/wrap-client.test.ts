/**
 * The generic client wrapper, against a fake vendor client. What matters here is what the
 * wrapper promises: it gates before the call, meters after it, stays idempotent, and keeps the
 * vendor's own promise handle intact for helpers that re-enter the client.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { wrapClient } from '../src/bindings/client/core/wrap-client';
import { cloudflareRecipe } from '../src/bindings/client/gateways/cloudflare/cloudflare-recipe';
import { meterStream } from '../src/bindings/shared/meter-stream';
import { isAccessDenied } from '../src/errors';
import { unitsPerTokens, type TokenUsage } from '../src/types';
import type { ClientRecipe } from '../src/bindings/client/core/types';
import { newRun } from './session-harness';
import { resolveContext } from '../src/core/context';
import { FakeEngine, type FakeEngineOptions } from './fake-engine';

/** Mimics a Stainless-style client: a namespace holding a method that returns an APIPromise. */
function fakeClient() {
  const calls: any[] = [];
  const client = {
    messages: {
      create(params: any, _options?: any) {
        calls.push(params);
        const response = { status: 200 };
        const data = params.stream
          ? {
              [Symbol.asyncIterator]: async function* () {
                yield { usage: { input_tokens: 500, output_tokens: 500 } };
              },
            }
          : { usage: { input_tokens: 600, output_tokens: 400 } };
        const promise: any = Promise.resolve(data);
        promise.withResponse = async () => ({ data, response });
        return promise;
      },
    },
  };
  return { client, calls };
}

const recipe: ClientRecipe = {
  vendor: 'fake',
  metrics: [],
  methods: [
    {
      path: ['messages', 'create'],
      passthrough: (_params, options) => options?.internal === true,
      extractUsage: (result) =>
        result?.usage
          ? { input: result.usage.input_tokens, output: result.usage.output_tokens, cacheRead: 0, cacheCreate: 0 }
          : undefined,
      attachStream: (result, ingest) => {
        const iterate = result[Symbol.asyncIterator].bind(result);
        result[Symbol.asyncIterator] = async function* () {
          let total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
          for await (const chunk of iterate()) {
            if (chunk.usage)
              total = {
                input: chunk.usage.input_tokens,
                output: chunk.usage.output_tokens,
                cacheRead: 0,
                cacheCreate: 0,
              };
            yield chunk;
          }
          ingest(total);
        };
      },
    },
  ],
};

function harness(options: FakeEngineOptions = {}) {
  const engine = new FakeEngine(options);
  const run = newRun({
    engine,
    dimensions: { agentId: 'agent-1' },
    ingestMode: 'sync',
    usageMapper: unitsPerTokens('credits', 1000),
    checkErrorAction: 'deny',
  });
  const fake = fakeClient();
  return { engine, run, ...fake };
}

describe('wrapClient', () => {
  it('gates before the call and meters after it', async () => {
    const { client, run, engine, calls } = harness({ usageLimit: null });
    const wrapped = wrapClient(client, recipe, run.session, run.context);
    await wrapped.messages.create({ model: 'x' });
    await run.drain();

    assert.equal(calls.length, 1);
    assert.equal(engine.checks, 1);
    assert.equal(engine.currentUsage, 1, '1000 tokens mapped to one unit');
  });

  it('refuses before the vendor is ever called', async () => {
    const { client, run, engine, calls } = harness({ usageLimit: 0 });
    const wrapped = wrapClient(client, recipe, run.session, run.context);

    await assert.rejects(
      () => wrapped.messages.create({ model: 'x' }),
      (err) => {
        const decision = isAccessDenied(err);
        assert.equal(decision?.hasAccess, false);
        assert.equal(decision?.deniedBy, 'agent-1');
        return true;
      },
    );
    assert.equal(calls.length, 0, 'no spend was attempted');
    assert.equal(engine.reports, 0);
  });

  it('charges once per call, because a second wrap is refused rather than stacked', async () => {
    const { client, run, engine } = harness({ usageLimit: null });
    const once = wrapClient(client, recipe, run.session, run.context);
    assert.throws(() => wrapClient(once, recipe, run.session, run.context), /already governed/);
    await once.messages.create({ model: 'x' });
    await run.drain();
    assert.equal(engine.checks, 1);
    assert.equal(engine.reports, 1);
  });

  it('leaves an internal leg alone - the caller-facing method already gated it', async () => {
    const { client, run, engine } = harness({ usageLimit: null });
    const wrapped = wrapClient(client, recipe, run.session, run.context);
    await wrapped.messages.create({ model: 'x' }, { internal: true });
    assert.equal(engine.checks, 0);
  });

  it('keeps withResponse() working, which is how the stream helper re-enters the client', async () => {
    const { client, run } = harness({ usageLimit: null });
    const wrapped = wrapClient(client, recipe, run.session, run.context);
    const { data, response } = await (wrapped.messages.create({ model: 'x' }) as any).withResponse();
    assert.equal((response as any).status, 200);
    assert.ok((data as any).usage);
  });

  it('meters a stream once, when it completes - not once per chunk', async () => {
    const { client, run, engine } = harness({ usageLimit: null });
    const wrapped = wrapClient(client, recipe, run.session, run.context);
    const stream: any = await wrapped.messages.create({ model: 'x', stream: true });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const chunk of stream) {
      // drain the stream; the wrapper meters when it completes
    }
    await run.drain();
    assert.equal(engine.reports, 1);
    assert.equal(engine.currentUsage, 1);
  });
});

describe('wrapClient returns a copy, not a mutation', () => {
  it("leaves the caller's own client alone", async () => {
    const { client, run, calls } = harness({ usageLimit: 0 });
    const before = client.messages.create;
    const wrapped = wrapClient(client, recipe, run.session, run.context);

    assert.notEqual(wrapped, client, 'the gate goes on a copy');
    assert.equal(client.messages.create, before, 'the original method is untouched');

    // The copy denies; the original is not governed at all and still reaches the vendor.
    await assert.rejects(() => wrapped.messages.create({ model: 'x' }));
    await client.messages.create({ model: 'x' });
    assert.equal(calls.length, 1, 'only the ungated original got through');
  });

  it('gives the copy its own namespace object, or two runs would share one gate', async () => {
    const { client, run } = harness({ usageLimit: null });
    const first = wrapClient(client, recipe, run.session, run.context);
    const second = wrapClient(client, recipe, run.session, run.context);

    assert.notEqual(first.messages, client.messages, 'messages is copied, not inherited');
    assert.notEqual(first.messages, second.messages);
    assert.notEqual(first.messages.create, second.messages.create);
  });

  it('inherits everything it did not gate, so a namespace the vendor built lazily still resolves', async () => {
    const { client, run } = harness({ usageLimit: null });
    const extended = Object.assign(client, { models: { list: () => 'vendor' } });
    const wrapped = wrapClient(extended, recipe, run.session, run.context);

    assert.equal(wrapped.models.list(), 'vendor');
    assert.equal(wrapped.models, extended.models, 'untouched paths are shared, not copied');
  });

  it("calls the vendor with the vendor's own receiver, so a private field still resolves", async () => {
    const { run } = harness({ usageLimit: null });
    class Messages {
      #secret = 'private';
      create(_params: any) {
        return Promise.resolve({ usage: { input_tokens: 1, output_tokens: 0 }, seen: this.#secret });
      }
    }
    const client = { messages: new Messages() };
    const wrapped = wrapClient(client, recipe, run.session, run.context);

    // `this` inside create() must be the real Messages instance: a delegating copy has no #secret.
    assert.equal((await wrapped.messages.create({})).seen, 'private');
  });

  it('refuses a second wrap rather than silently dropping the context it carried', async () => {
    const { client, run, engine } = harness({ usageLimit: null });
    const once = wrapClient(client, recipe, run.session, run.context);

    // Returning the first client would be the quiet failure: the second call's context would
    // never take effect, and nothing would say so. The context travels per call now, so there is
    // no reason to wrap twice and every reason to be told when something did.
    assert.throws(() => wrapClient(once, recipe, run.session, run.context), /already governed/);
    await once.messages.create({ model: 'x' });
    await run.drain();
    assert.equal(engine.checks, 1, 'one gate, not two');
  });
});

describe('a wrapped client is wrapped once', () => {
  it('refuses to govern one that already is, rather than stacking a second gate on it', () => {
    const { client, run } = harness({ usageLimit: null });
    const governed = wrapClient(client, recipe, run.session, run.context);
    // There is nothing a second wrap could mean now that the context travels with each call: one
    // wrapped client already serves every customer and agent. Stacking would double-charge.
    assert.throws(() => wrapClient(governed, recipe, run.session, run.context), /already governed/);
  });

  it('refuses a copy of a governed client, which carries the same gate', () => {
    const { client, run } = harness({ usageLimit: null });
    const governed = wrapClient(client, recipe, run.session, run.context);
    // `Object.create` is how the wrapper itself makes copies, so this is the shape a caller
    // reaches for when they try to derive a second governed client from one.
    assert.throws(
      () => wrapClient(Object.create(governed) as typeof governed, recipe, run.session, run.context),
      /already governed/,
    );
  });

  it('keeps metering whatever else was attempted', async () => {
    const { client, run, engine } = harness({ usageLimit: null });
    const governed = wrapClient(client, recipe, run.session, run.context);
    try {
      wrapClient(governed, recipe, run.session, run.context);
    } catch {
      // expected
    }
    await governed.messages.create({ model: 'x' });
    await run.drain();
    assert.deepEqual(engine.dimensionsSeen, [{ agentId: 'agent-1' }], 'still the one billed');
  });
});

describe('the gated call stands in for the vendor promise', () => {
  /**
   * An APIPromise as both SDKs build it: `asResponse` leaves the body alone, the parse consumes
   * it, and the parse is lazy - nothing reads the body until `then` or `withResponse` asks.
   */
  function client(body: unknown, headers: Record<string, string> = {}) {
    return {
      messages: {
        create(params: any) {
          const response = new Response(JSON.stringify(body), { headers });
          let parsed: Promise<any> | undefined;
          const parse = () =>
            (parsed ??= params?.stream ? Promise.resolve(body) : response.text().then((t) => JSON.parse(t)));
          return {
            then: (ok: any, err: any) => parse().then(ok, err),
            catch: (err: any) => parse().catch(err),
            finally: (f: any) => parse().finally(f),
            asResponse: () => Promise.resolve(response),
            withResponse: async () => ({ data: await parse(), response, request_id: 'req_1' }),
          } as any;
        },
      },
    };
  }

  const body = { text: 'hi', usage: { input_tokens: 600, output_tokens: 400 } };

  it('is a real promise, not an object that merely has a then', async () => {
    const { run } = harness({ usageLimit: null });
    const govClient = wrapClient(client(body), recipe, run.session, run.context);
    const promise = govClient.messages.create({ model: 'x' });
    assert.ok(promise instanceof Promise, 'helpers and libraries branch on this');
    assert.deepEqual(await promise, body);
    assert.deepEqual(await Promise.all([govClient.messages.create({ model: 'x' })]), [body]);
  });

  it('hands back a response the caller can still read', async () => {
    const { run } = harness({ usageLimit: null });
    const govClient = wrapClient(client(body), recipe, run.session, run.context);
    const response = await govClient.messages.create({ model: 'x' }).asResponse();
    // The gate parsed a copy to find the usage in; this one was never touched.
    assert.equal(response.bodyUsed, false);
    assert.deepEqual(await response.json(), body);
  });

  it('keeps the vendor request id on withResponse()', async () => {
    const { run } = harness({ usageLimit: null });
    const govClient = wrapClient(client(body), recipe, run.session, run.context);
    const settled = await govClient.messages.create({ model: 'x' }).withResponse();
    assert.equal(settled.request_id, 'req_1');
    assert.deepEqual(settled.data, body);
    assert.equal('spare' in settled, false, 'the copy is ours, not part of the vendor contract');
  });

  it('carries _thenUnwrap, which the SDKs use to build their own helpers', async () => {
    const { run } = harness({ usageLimit: null });
    const govClient = wrapClient(client(body), recipe, run.session, run.context);
    const unwrapped = govClient.messages.create({ model: 'x' })._thenUnwrap((d: any) => d.text.toUpperCase());
    assert.equal(await unwrapped, 'HI');
  });

  it('meters the call whichever way the caller consumes it', async () => {
    const { run, engine } = harness({ usageLimit: null });
    const govClient = wrapClient(client(body), recipe, run.session, run.context);
    await govClient.messages.create({ model: 'x' }).asResponse();
    await run.drain();
    assert.equal(engine.reports, 1, 'never awaiting the data must not skip the ingest');
  });

  it('does not copy a streaming body, because the body is the stream', async () => {
    const { run } = harness({ usageLimit: null });
    const govClient = wrapClient(client(body), recipe, run.session, run.context);
    // Same call, asked for as a stream: the transport response comes through as it always did,
    // and nothing tees an open connection into memory to get it.
    const response = await govClient.messages.create({ model: 'x', stream: true }).asResponse();
    assert.equal(response.bodyUsed, false, 'untouched - but it is the original, not a copy');
    const settled = await govClient.messages.create({ model: 'y', stream: true }).withResponse();
    assert.equal(settled.request_id, 'req_1');
  });
});

describe('measuring a call that already succeeded', () => {
  const throwingRecipe: ClientRecipe = {
    vendor: 'fake',
    metrics: [],
    methods: [
      {
        path: ['messages', 'create'],
        extractUsage: () => {
          throw new Error('the vendor changed shape');
        },
      },
    ],
  };

  it('does not reject a call the vendor answered, when the recipe cannot read it', async () => {
    const { client, run } = harness({ usageLimit: null });
    const governed = wrapClient(client, throwingRecipe, run.session, run.context);
    const result = await governed.messages.create({ model: 'x' });
    assert.ok(result, 'the caller asked the vendor for something and got it');
    const summary = await run.drain();
    assert.equal(summary.ingestFailures, 1, 'and the client says it failed to meter it');
    assert.equal(summary.ingested, 0);
  });

  it('keeps the consumer iterating when a chunk cannot be read', async () => {
    const seen: unknown[] = [];
    const streamRecipe: ClientRecipe = {
      vendor: 'fake',
      metrics: [],
      methods: [
        {
          path: ['messages', 'create'],
          extractUsage: () => undefined,
          attachStream: (stream: any) =>
            meterStream(
              stream,
              () => {
                throw new Error('unreadable chunk');
              },
              () => undefined,
            ),
        },
      ],
    };
    const { client, run } = harness({ usageLimit: null });
    const governed = wrapClient(client, streamRecipe, run.session, run.context);
    const stream = await governed.messages.create({ model: 'x', stream: true });
    for await (const chunk of stream as AsyncIterable<unknown>) seen.push(chunk);
    assert.equal(seen.length, 1, 'the stream the caller is standing in still delivers');
    await run.drain();
  });
});

describe('a refusal reaches whoever asked, and nobody else', () => {
  /** Node reports a rejection when nothing is holding it, and exits on it by default. */
  const rejectionsDuring = async (run: () => Promise<void>): Promise<unknown[]> => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await run();
      // Unhandled rejections are reported a turn of the loop later than they happen.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    return seen;
  };

  it('does not orphan the promise when the caller only takes the response', async () => {
    // What Anthropic's stream helper does: `messages.create(...).withResponse()`, never awaiting
    // the promise itself. Left unhandled, a denied turn took the whole process down with it.
    const { client, run } = harness({ usageLimit: 0 });
    const wrapped = wrapClient(client, recipe, run.session, run.context);

    const seen = await rejectionsDuring(async () => {
      await assert.rejects(() => wrapped.messages.create({ model: 'x' }).withResponse());
    });

    assert.deepEqual(seen, [], 'the refusal was delivered, not orphaned');
  });

  it('still rejects for a caller that does await the promise', async () => {
    const { client, run } = harness({ usageLimit: 0 });
    const wrapped = wrapClient(client, recipe, run.session, run.context);

    await assert.rejects(
      () => wrapped.messages.create({ model: 'x' }),
      (err) => isAccessDenied(err) !== undefined,
    );
  });
});

/**
 * The other half of the enforcement switch: the wrapper's gate is conditional on the run having
 * something to gate against. What is pinned here is that the call goes out, that it is still
 * metered, and that the skip is a skip - the recipe is never asked what to estimate, because the
 * answer would be thrown away.
 */
describe('a client in a metering-only run', () => {
  const metering = (options: FakeEngineOptions = {}) => {
    const engine = new FakeEngine(options);
    const run = newRun({
      engine,
      // The whole difference. Everything else matches `harness` above.
      entitlement: undefined,
      dimensions: { agentId: 'agent-1' },
      ingestMode: 'sync',
      usageMapper: unitsPerTokens('credits', 1000),
      checkErrorAction: 'deny',
    });
    return { engine, run, ...fakeClient() };
  };

  it('lets the call through without a check - the run named nothing to check against', async () => {
    const { client, run, engine, calls } = metering({ usageLimit: 0 });
    const wrapped = wrapClient(client, recipe, run.session, run.context);
    await wrapped.messages.create({ model: 'x' });
    await run.drain();

    assert.equal(calls.length, 1, 'a budget of zero refuses nothing on this path');
    assert.equal(engine.checks, 0, 'and nobody was asked whether it should');
  });

  it('still meters after it, which is the only half of the lifecycle it kept', async () => {
    const { client, run, engine } = metering({ usageLimit: 0 });
    await wrapClient(client, recipe, run.session, run.context).messages.create({ model: 'x' });
    await run.drain();

    assert.equal(engine.reports, 1);
    assert.equal(engine.currentUsage, 1, '1000 tokens mapped to one unit, exactly as when gated');
  });

  it('never raises AccessDeniedError, however empty the budget behind it is', async () => {
    const { client, run } = metering({ usageLimit: 0 });
    const wrapped = wrapClient(client, recipe, run.session, run.context);

    await wrapped.messages.create({ model: 'x' });
    await run.drain();
    assert.equal(run.lastDecision, undefined, 'no decision, because no question');
  });

  it('does not even ask the recipe what to estimate, so the mode costs nothing per call', async () => {
    let estimates = 0;
    const counted: ClientRecipe = {
      ...recipe,
      methods: recipe.methods.map((method) => ({ ...method, estimate: () => ++estimates })),
    };
    const { client, run } = metering({ usageLimit: null });
    await wrapClient(client, counted, run.session, run.context).messages.create({ model: 'x' });
    await run.drain();

    assert.equal(estimates, 0, 'the estimate reads the caller’s own parameters - skipped, not discarded');
  });
});

/**
 * `wrap` allows a client with no customer on purpose - its calls each name their own, and
 * `CallContext` then types `customerId` as required on every one of them. A type is not a
 * guarantee at runtime: a JS caller, or a framework that owns the call site and cannot pass a
 * `stiggContext` at all, reaches the gate with nothing to bill.
 *
 * Left to reach the engine, the empty id comes back as a verdict about a customer that is not
 * there, phrased as confidently as any other and attributed to nobody. The `client.stigg.*`
 * handle refuses it; so does the gated call.
 */
describe('a call that names no customer', () => {
  /** What `wrap(client)` builds when the context carried no customer. */
  const customerless = (entitlement?: { currencyId: string }) =>
    resolveContext({ entitlement, usageMapper: unitsPerTokens('credits', 1000) }, 'correlation-1', {
      requireCustomer: false,
    });

  it('is refused where the call is, not three frames down', async () => {
    const { client, run } = harness({ usageLimit: null });
    const wrapped = wrapClient(client, recipe, run.session, customerless({ currencyId: 'credits' }));

    await assert.rejects(() => wrapped.messages.create({ model: 'x' }), /No customerId/);
  });

  it('refuses a metering-only call too - a report with no customer lands nowhere', async () => {
    const { client, run } = harness({ usageLimit: null });
    // No entitlement, so nothing gates. The ingest still needs somebody to bill.
    const wrapped = wrapClient(client, recipe, run.session, customerless());

    await assert.rejects(() => wrapped.messages.create({ model: 'x' }), /No customerId/);
  });

  it('never reaches the vendor, so nothing is spent on a call that cannot be billed', async () => {
    const { client, run, engine, calls } = harness({ usageLimit: null });
    const wrapped = wrapClient(client, recipe, run.session, customerless({ currencyId: 'credits' }));

    await assert.rejects(() => wrapped.messages.create({ model: 'x' }));
    assert.equal(calls.length, 0, 'the request went out for a call nobody could be charged for');
    assert.equal(engine.checks, 0, 'and the engine was asked about a customer that is not there');
  });

  /**
   * A passthrough leg is an internal call the vendor's own SDK makes while serving a method this
   * recipe already gated - a `stream()` that routes through `create()`, say. It carries the
   * wrap-time context and nothing else, because the vendor cannot know to forward a
   * `stiggContext`, so on a customerless wrap it has no customer by construction.
   *
   * Checking it would refuse the inner half of a call whose outer half was already allowed, and
   * it is not billed either way: the outer call is what reports. So the guard sits after the
   * passthrough return, and that order is the behaviour rather than an oversight.
   */
  it('does not re-check a passthrough leg, which the outer call already answered for', async () => {
    const { client, run, calls } = harness({ usageLimit: null });
    const wrapped = wrapClient(client, recipe, run.session, customerless({ currencyId: 'credits' }));

    await assert.doesNotReject(() => wrapped.messages.create({ model: 'x' }, { internal: true }));
    assert.equal(calls.length, 1, 'the internal leg reached the vendor');
    assert.equal(run.session.summary().checks, 0, 'and was not gated a second time');
  });

  it('still runs when the call supplies one, which is the whole point of the shape', async () => {
    const { client, run, calls } = harness({ usageLimit: null });
    const wrapped = wrapClient(client, recipe, run.session, customerless({ currencyId: 'credits' }));

    await wrapped.messages.create({ model: 'x', stiggContext: { customerId: 'customer-acme' } });
    await run.drain();

    assert.equal(calls.length, 1);
  });
});

/**
 * A field this SDK does not read is almost always a typo, and a silent one without this guard:
 * the context is read key by key, so an unknown key never arrives and the call is governed by
 * whatever `wrap` was given. A mistyped `agentId` bills the wrong entity and says nothing.
 *
 * The types catch it everywhere but `messages.stream` - see `gated-surface-vendors.test.ts` for
 * why that one cannot be caught at compile time. These cases make the guarantee hold anyway, and
 * hold for a JS caller and a hand-typed call site too, where no overlay is in play.
 *
 * Thrown synchronously rather than as a rejection, which is what the context's other guards
 * already do - an empty `agentId` in a per-call context throws from the same place. Nothing has
 * been attempted at that point: no check has left the process and the vendor has not been
 * called, so there is no in-flight operation for a rejection to belong to. It also means
 * `messages.stream()`, whose signature is synchronous, reports the mistake where it was made.
 */
describe('a context carrying a field the SDK does not read', () => {
  it('is refused rather than ignored, naming the field and what is valid', () => {
    const { client, run } = harness({ usageLimit: null });
    const wrapped = wrapClient(client, recipe, run.session, run.context);

    assert.throws(
      () => wrapped.messages.create({ model: 'x', stiggContext: { custmerId: 'customer-acme' } as any }),
      /no field `custmerId`[\s\S]*customerId/,
    );
  });

  it('is refused on the one surface the types cannot reach - the reason this guard exists', () => {
    const { client, run } = harness({ usageLimit: null });
    const wrapped = wrapClient(client, recipe, run.session, run.context);

    // `agentId` misspelled: the call meant to spend as one agent and would have spent as the
    // client's default, which is a bill against the wrong entity and no error to read.
    assert.throws(
      () => wrapped.messages.create({ model: 'x', stiggContext: { agentID: 'agent-2' } as any }),
      /no field `agentID`/,
    );
  });

  it('refuses before the vendor is called, so a typo costs nothing', () => {
    const { client, run, engine, calls } = harness({ usageLimit: null });
    const wrapped = wrapClient(client, recipe, run.session, run.context);

    assert.throws(() => wrapped.messages.create({ model: 'x', stiggContext: { custmerId: 'c' } as any }));
    assert.equal(calls.length, 0, 'no spend was attempted');
    assert.equal(engine.checks, 0, 'and nothing was checked against a context that was wrong');
  });

  it('leaves a context of known fields alone, including the ones that mean "use the default"', async () => {
    const { client, run, calls } = harness({ usageLimit: null });
    const wrapped = wrapClient(client, recipe, run.session, run.context);

    await assert.doesNotReject(() =>
      wrapped.messages.create({
        model: 'x',
        stiggContext: { customerId: 'customer-acme', idempotencyKey: 'key-1', correlationId: 'run-7' },
      }),
    );
    await run.drain();
    assert.equal(calls.length, 1);
  });

  it('refuses a prototype name, which an `in` check would accept', () => {
    const { client, run } = harness({ usageLimit: null });
    const wrapped = wrapClient(client, recipe, run.session, run.context);

    // `'toString' in CONTEXT_KEYS` is true through Object.prototype, so an `in` check accepts
    // these as known fields - on exactly the names a JS caller is likeliest to carry in from an
    // object it did not build itself.
    for (const key of ['toString', 'constructor', 'hasOwnProperty']) {
      assert.throws(
        () => wrapped.messages.create({ model: 'x', stiggContext: { [key]: 'x' } as any }),
        new RegExp('no field `' + key + '`'),
        key + ' should be refused like any other unknown field',
      );
    }
  });

  it('costs a call that carries no context nothing at all', async () => {
    // The guard runs inside the override branch, which a call with no `stiggContext` never
    // enters - the hot path this file's header describes stays one property read and one test.
    const { client, run, calls } = harness({ usageLimit: null });
    const wrapped = wrapClient(client, recipe, run.session, run.context);

    await assert.doesNotReject(() => wrapped.messages.create({ model: 'x' }));
    assert.equal(calls.length, 1);
  });
});

describe('a method whose context does not ride in the first argument', () => {
  // `ai.run(model, inputs)` - Cloudflare names the model first. The wrapper reads `stiggContext`
  // from the argument the recipe nominates, and this exercises the whole boundary rather than
  // the declaration: a wrapper that regressed to argument 0 would authorize and meter with the
  // wrap-time context and hand the caller's override to the vendor as an unknown input, which a
  // test asserting only `contextArg === 1` would not notice.
  const cloudflareShaped = () => {
    const calls: unknown[][] = [];
    const client = {
      baseURL: 'https://api.cloudflare.com/client/v4/accounts/acct/ai/v1',
      ai: {
        run: async (...args: unknown[]) => {
          calls.push(args);
          return { response: 'hi', usage: { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 } };
        },
      },
    };
    return { client, calls };
  };

  it('reads the context out of the second argument and forwards the rest untouched', async () => {
    const engine = new FakeEngine({ usageLimit: null });
    const run = newRun({
      engine,
      dimensions: { agentId: 'agent-1' },
      ingestMode: 'sync',
      usageMapper: unitsPerTokens('credits', 1000),
      checkErrorAction: 'deny',
    });
    const { client, calls } = cloudflareShaped();
    const wrapped: any = wrapClient(client, cloudflareRecipe() as ClientRecipe, run.session, run.context);

    await wrapped.ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: 'user', content: 'hi' }],
      stiggContext: { dimensions: { agentId: 'per-call-agent' } },
    });
    await run.drain();

    assert.equal(calls.length, 1, 'the vendor was called exactly once');
    const [model, inputs] = calls[0] as [string, Record<string, unknown>];
    assert.equal(model, '@cf/meta/llama-3.1-8b-instruct', 'argument 0 is still the model');
    assert.deepEqual(inputs, { messages: [{ role: 'user', content: 'hi' }] }, 'stiggContext was stripped');
    assert.equal('stiggContext' in inputs, false, 'the vendor never sees the context');

    // The per-call override reached the gate, rather than the wrap-time dimensions.
    assert.equal(engine.checks, 1);
    assert.deepEqual(engine.dimensionsSeen.at(-1)?.agentId, 'per-call-agent');
  });

  it('still gates on the wrap-time context when a call carries none', async () => {
    const engine = new FakeEngine({ usageLimit: null });
    const run = newRun({
      engine,
      dimensions: { agentId: 'agent-1' },
      ingestMode: 'sync',
      usageMapper: unitsPerTokens('credits', 1000),
      checkErrorAction: 'deny',
    });
    const { client, calls } = cloudflareShaped();
    const wrapped: any = wrapClient(client, cloudflareRecipe() as ClientRecipe, run.session, run.context);

    await wrapped.ai.run('@cf/x', { messages: [] });
    await run.drain();

    assert.deepEqual((calls[0] as unknown[])[1], { messages: [] }, 'untouched when there was nothing to strip');
    assert.deepEqual(engine.dimensionsSeen.at(-1)?.agentId, 'agent-1');
  });
});
