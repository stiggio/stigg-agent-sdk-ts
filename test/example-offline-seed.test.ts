/**
 * What the offline demo has to seed for a feature entitlement to behave like a real account.
 *
 * A metric naming the run's own credit currency draws the wallet directly, which is why the
 * default demo enforced correctly with nothing seeded. A feature is different: under the default
 * `'async'` ingest it goes out as an event, and an event matching no meter is accepted and
 * converted to nothing. Every check then passed, every ingest answered `ok`, and the budget never
 * moved - the example demonstrating the one failure the SDK exists to make visible, with nothing
 * to say so, because an empty event response cannot tell a meter that did nothing from one that
 * has not run yet.
 */
import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import { startMockStiggServer, type MockStiggServer } from '../testing/mock-stigg-server';
import { PROXY_EVENT_NAMES, seedMock } from '../examples/shared/setup-governance';
import { StiggAgentSDK } from '../src/stigg-agent-sdk';
import { unitsPerTokens } from '../src';
import { DEFAULT_RECIPES, eventNameFor } from '../src/internal';
import type { DemoEnv } from '../examples/shared/demo-env';

/**
 * One SDK for the whole file. `@stigg/node-server-sdk` keeps process-global state, so a second
 * instance pointed at a second mock reports into the first one's - which looks exactly like a
 * meter that did not fire, and is the trap this file is about.
 */
let shared: { stigg: StiggAgentSDK; mock: MockStiggServer } | undefined;

async function reporting(): Promise<{ stigg: StiggAgentSDK; mock: MockStiggServer }> {
  if (shared) return shared;
  const mock = await startMockStiggServer();
  await seedMock(demoEnv({ featureId: 'tokens_used' }), mock, {
    agents: ['agent-1'],
    agentLimit: 5,
    log: () => undefined,
  });
  const stigg = new StiggAgentSDK({ apiKey: 'offline-key', baseUrl: mock.baseUrl, logger: 'none' });
  await stigg.init();
  shared = { stigg, mock };
  return shared;
}

/** Seeding only, with no SDK to talk to it - safe to create as many of these as the cases need. */
async function seededMock(entitlement: DemoEnv['entitlement']): Promise<MockStiggServer> {
  const mock = await startMockStiggServer();
  await seedMock(demoEnv(entitlement), mock, { agents: ['agent-1'], agentLimit: 5, log: () => undefined });
  mocks.push(mock);
  return mock;
}

const mocks: MockStiggServer[] = [];

after(async () => {
  if (shared) {
    await shared.stigg.close();
    await shared.mock.close();
  }
  for (const mock of mocks) await mock.close();
});

const demoEnv = (entitlement: DemoEnv['entitlement']): DemoEnv =>
  ({
    customerId: 'customer-acme',
    entitlement,
    // Nested, because this is the *demo's* env rather than a `stiggContext`: `setupGovernance`
    // reads both halves from here, and a key at the top level is one it never sees.
    agentType: { entityTypeId: 'agent', attributionKey: 'agentId' },
    agentId: 'agent-1',
  }) as DemoEnv;

describe('the offline seed', () => {
  it('drains a feature entitlement, which needs a meter to convert the event at all', async () => {
    const { stigg, mock } = await reporting();

    await stigg.report(
      {
        customerId: 'customer-acme',
        entitlement: { featureId: 'tokens_used' },
        eventName: { name: 'anthropic.messages.create' },
      },
      { tokens_used: 3 },
    );

    assert.ok(
      (mock.state.usageByFeature.get('tokens_used') ?? 0) >= 3,
      'the event matched no meter, so nothing was metered',
    );
  });

  it('seeds a meter per event name the examples derive, so a new binding is covered by existing ones', async () => {
    const mock = await seededMock({ featureId: 'tokens_used' });
    const names = mock.state.eventMeters.map((meter) => meter.eventName);

    // Derived from the registry, not a list of three names typed out here. This test said
    // "a new binding is covered by existing" while checking only bindings it already knew about,
    // so when Gemini was added and the seeding missed it, nothing failed: its events matched no
    // meter, and under a feature entitlement that is silent by construction - accepted, converted
    // to nothing, budget unmoved.
    const derived = DEFAULT_RECIPES.flatMap((recipe) => recipe.methods.map((method) => eventNameFor(recipe, method)));
    assert.ok(derived.length >= 8, `expected the shipped bindings, derived ${derived.length}`);

    const missing = derived.filter((name) => !names.includes(name));
    assert.deepEqual(missing, [], 'a binding whose events the offline demo would convert to nothing');
  });

  it('seeds none for a credit currency, which draws the wallet and never becomes an event', async () => {
    const mock = await seededMock({ currencyId: 'credits' });

    assert.deepEqual(mock.state.eventMeters, []);
  });
});

describe('the offline seed, for a gateway you operate', () => {
  it('drains a feature from a proxy ingest, which no recipe names an event for', async () => {
    const { stigg, mock } = await reporting();
    const context = { customerId: 'customer-acme', entitlement: { featureId: 'tokens_used' } };
    const before = mock.state.usageByFeature.get('tokens_used') ?? 0;

    // Exactly what `examples/gateway/core/proxy.ts` does: attribution off the wire, the vendor
    // named rather than sniffed, and no event name - so the SDK derives `openai.proxied`, a name
    // no recipe produces and the seeding therefore had to know about separately.
    await stigg.ingestFromHeaders(stigg.governanceHeaders(context), {
      entitlement: context.entitlement,
      vendor: 'openai',
      metrics: unitsPerTokens('tokens_used', 1),
      usage: { prompt_tokens: 2000, completion_tokens: 1000 },
      idempotencyKey: 'proxy-turn-1',
    });

    assert.equal(
      mock.state.usageByFeature.get('tokens_used'),
      before + 3000,
      'the proxy event matched no meter, so the budget never moved',
    );
  });

  it('seeds every name the proxy can send', async () => {
    const mock = await seededMock({ featureId: 'tokens_used' });
    const names = mock.state.eventMeters.map((meter) => meter.eventName);

    for (const expected of PROXY_EVENT_NAMES) assert.ok(names.includes(expected), `no meter for ${expected}`);
  });
});
