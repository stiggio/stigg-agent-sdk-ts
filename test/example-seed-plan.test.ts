/**
 * The demo plan the examples seed: created once, finished and published by the seed alone, never
 * a plan somebody else owns - and safe when two examples start at the same moment.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import Stigg from '@stigg/typescript';
import { ensureEnvironment } from '../examples/shared/setup-governance';
import { startMockStiggServer, type MockStiggServer } from '../testing/mock-stigg-server';
import type { DemoEnv } from '../examples/shared/demo-env';

const mocks: MockStiggServer[] = [];
after(async () => {
  for (const mock of mocks) await mock.close();
});

const demoEnv = { customerId: 'customer-acme', entitlement: { currencyId: 'credits' }, planId: 'plan-demo' } as DemoEnv;

async function account() {
  const mock = await startMockStiggServer();
  mocks.push(mock);
  const lines: string[] = [];
  const client = new Stigg({ apiKey: 'offline-mock', baseURL: mock.baseUrl, maxRetries: 0 });
  const seed = () => ensureEnvironment(client, demoEnv, { log: (line) => lines.push(line.trim()) });
  return { mock, lines, seed };
}

describe('the demo plan the examples seed', () => {
  it('is created on a fresh account - product, plan, its credits, published - and marked as the seed’s', async () => {
    const { mock, lines, seed } = await account();
    await seed();

    const plan = mock.state.plans.get('plan-demo')!;
    assert.equal(plan.status, 'PUBLISHED');
    assert.equal(plan.pricingType, 'FREE');
    assert.deepEqual(
      plan.entitlements.map((e) => [e.type, e.id]),
      [['CREDIT', 'credits']],
    );
    assert.equal(plan.metadata.createdBy, 'stigg-agent-sdk-examples');
    assert.ok(lines.includes('created free plan plan-demo'));
  });

  it('creates nothing on a second start', async () => {
    const { lines, seed } = await account();
    await seed();
    lines.length = 0;
    await seed();

    assert.deepEqual(
      lines.filter((line) => /created|grants|published/.test(line)),
      [],
    );
  });

  it("leaves somebody else's draft exactly as it is - no entitlement added, not published - and says so", async () => {
    const { mock, lines, seed } = await account();
    mock.state.products.set('product-other', { id: 'product-other', displayName: 'Other' });
    mock.state.plans.set('plan-demo', {
      id: 'plan-demo',
      displayName: 'A plan in progress',
      productId: 'product-other',
      pricingType: 'FREE',
      status: 'DRAFT',
      metadata: {},
      entitlements: [],
    });

    await seed();

    const plan = mock.state.plans.get('plan-demo')!;
    assert.equal(plan.status, 'DRAFT');
    assert.deepEqual(plan.entitlements, []);
    assert.ok(lines.some((line) => line.includes('does not grant credits')));
    assert.ok(lines.some((line) => line.includes('is a draft')));
  });

  it('settles two starts racing each other: both succeed, and there is one plan', async () => {
    const { mock, seed } = await account();

    await Promise.all([seed(), seed()]);

    assert.equal(mock.state.plans.size, 1);
    assert.equal(mock.state.plans.get('plan-demo')!.status, 'PUBLISHED');
    // One grant, however many starts wrote it - a new customer is funded once.
    assert.deepEqual(
      mock.state.plans.get('plan-demo')!.entitlements.map((e) => [e.type, e.id]),
      [['CREDIT', 'credits']],
    );
  });

  it('settles a grant another start wrote between its read and its write, rather than fail or grant twice', async () => {
    // Deterministic, where two seeds in parallel interleave only by luck: the other start's grant
    // lands just before this one's, so the create is refused and the seed has to read it back.
    const { mock } = await account();
    mock.state.products.set('product-agent-sdk-demo', { id: 'product-agent-sdk-demo', displayName: 'Agent SDK demo' });
    mock.state.plans.set('plan-demo', {
      id: 'plan-demo',
      displayName: 'Agent SDK demo (free)',
      productId: 'product-agent-sdk-demo',
      pricingType: 'FREE',
      status: 'DRAFT',
      metadata: { createdBy: 'stigg-agent-sdk-examples' },
      entitlements: [],
    });
    const client = new Stigg({ apiKey: 'offline-mock', baseURL: mock.baseUrl, maxRetries: 0 });
    const create = client.v1.plans.entitlements.create.bind(client.v1.plans.entitlements);
    client.v1.plans.entitlements.create = ((planId: string, body: never) => {
      mock.state.plans.get(planId)!.entitlements.push({ type: 'CREDIT', id: 'credits', amount: 100 });
      return create(planId, body);
    }) as typeof client.v1.plans.entitlements.create;

    await ensureEnvironment(client, demoEnv, { log: () => {} });

    const plan = mock.state.plans.get('plan-demo')!;
    assert.deepEqual(
      plan.entitlements.map((e) => [e.type, e.id]),
      [['CREDIT', 'credits']],
    );
    assert.equal(plan.status, 'PUBLISHED');
  });

  it("leaves an account's own entity types as they are, says when one won't attribute, and adds only the missing", async () => {
    const { mock, lines, seed } = await account();
    mock.state.entityTypes.set('model', { id: 'model', attributionKeys: ['llm'], displayName: 'Their model' } as never);

    await seed();

    assert.deepEqual(mock.state.entityTypes.get('model'), {
      id: 'model',
      attributionKeys: ['llm'],
      displayName: 'Their model',
    });
    assert.ok(lines.some((line) => line.includes('entity type model exists, attributed by [llm]')));
    assert.ok(lines.includes('created entity types team, agent'));
  });

  it('settles two feature-mode starts racing to create the feature', async () => {
    const { mock } = await account();
    const client = new Stigg({ apiKey: 'offline-mock', baseURL: mock.baseUrl, maxRetries: 0 });
    const featureEnv = { ...demoEnv, entitlement: { featureId: 'feature-demo' } } as DemoEnv;
    const seed = () => ensureEnvironment(client, featureEnv, { log: () => {} });

    await Promise.all([seed(), seed()]);

    assert.deepEqual([...mock.state.features.keys()], ['feature-demo']);
  });

  for (const reserved of ['model', 'team']) {
    it(`refuses an agent type named "${reserved}", a type the seed declares itself, rather than overwrite one with the other`, async () => {
      const { mock } = await account();
      const client = new Stigg({ apiKey: 'offline-mock', baseURL: mock.baseUrl, maxRetries: 0 });
      const clash = { ...demoEnv, agentType: { entityTypeId: reserved, attributionKey: 'agentId' } } as DemoEnv;

      await assert.rejects(ensureEnvironment(client, clash, { log: () => {} }), new RegExp(`cannot be "${reserved}"`));
      assert.equal(mock.state.entityTypes.size, 0, 'nothing upserted');
    });
  }

  it("does not take a feature of the same id for the credits the demo meters - the seed's plan gets them", async () => {
    const { mock, seed } = await account();
    await seed();
    const plan = mock.state.plans.get('plan-demo')!;
    plan.status = 'DRAFT';
    plan.entitlements = [{ type: 'FEATURE', id: 'credits', usageLimit: 10 }];

    await seed();

    assert.deepEqual(
      plan.entitlements.map((e) => [e.type, e.id]),
      [
        ['FEATURE', 'credits'],
        ['CREDIT', 'credits'],
      ],
    );
  });

  it('grants a feature-mode demo its feature: customers on the plan are entitled to it, and only to it', async () => {
    const { mock } = await account();
    const client = new Stigg({ apiKey: 'offline-mock', baseURL: mock.baseUrl, maxRetries: 0 });
    const featureEnv = { ...demoEnv, entitlement: { featureId: 'feature-demo' } } as DemoEnv;
    await ensureEnvironment(client, featureEnv, { log: () => {} });
    mock.state.subscriptionWrites.push({ customerId: 'customer-acme', planId: 'plan-demo' });

    const check = async (featureId: string) =>
      (await client.v1Beta.customers.entitlements.check('customer-acme', { featureId } as never)).data;
    assert.equal((await check('feature-demo')).isGranted, true);
    const other = await check('feature-other');
    assert.equal(other.isGranted, false);
    assert.equal((other as { accessDeniedReason?: string }).accessDeniedReason, 'NoFeatureEntitlementInSubscription');
  });
});
