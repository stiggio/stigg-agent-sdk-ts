/**
 * `register()` runs on every process start, so what it sends for the budget decides whether an
 * admin's change survives. `usageLimit` is authoritative and overwrites; `usageLimitOnCreate`
 * seeds a budget once and then leaves it alone.
 *
 * The engine is built without its constructor so no client is initialized.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RestGovernanceEngine } from '../src/engine/rest-governance-engine';
import type { EntityPlacement } from '../src/engine/engine';
import { assignmentsOf, seedBudget, startMockStiggServer } from '../testing/mock-stigg-server';

type Sent = Record<string, unknown>;

/** A RestGovernanceEngine whose assignment reads return `existing` and whose writes are recorded. */
function engineWith(existing: unknown[]): { engine: RestGovernanceEngine; sent: Sent[]; listed: Sent[] } {
  const sent: Sent[] = [];
  const listed: Sent[] = [];
  const engine = Object.create(RestGovernanceEngine.prototype) as RestGovernanceEngine;
  Object.assign(engine, {
    client: {
      v1Beta: {
        customers: {
          entities: { upsert: async () => ({ data: [] }) },
          assignments: {
            // Pages like the client's: iterated, one row at a time, across however many pages.
            list: (_customerId: string, params: Sent) => {
              listed.push(params);
              return (async function* () {
                yield* existing;
              })();
            },
            upsert: async (_customerId: string, body: { assignments: Sent[] }) => {
              sent.push(body.assignments[0]!);
              return { data: [] };
            },
          },
        },
      },
    },
  });
  return { engine, sent, listed };
}

const entity = { id: 'agent-1', entityTypeId: 'agent' };
const base: EntityPlacement = { entitlement: { currencyId: 'data_credit' }, parentId: 'team-1', cadence: 'P1M' };

describe('provisioning a budget', () => {
  it('usageLimit overwrites whatever is already assigned', async () => {
    const { engine, sent, listed } = engineWith([{ id: 'existing' }]);
    await engine.upsertEntity('c', entity, { ...base, usageLimit: 40 });

    assert.equal(listed.length, 0, 'the authoritative path needs no read');
    assert.equal(sent[0]!.usageLimit, 40);
    assert.equal(sent[0]!.cadence, 'P1M');
  });

  it('usageLimitOnCreate seeds the budget when no assignment exists', async () => {
    const { engine, sent, listed } = engineWith([]);
    await engine.upsertEntity('c', entity, { ...base, usageLimitOnCreate: 40 });

    // Every assignment for the pair, not the first: with scopes there can be one per scope.
    assert.deepEqual(listed[0], { entityId: 'agent-1', currencyId: 'data_credit' });
    assert.equal(sent[0]!.usageLimit, 40);
    assert.equal(sent[0]!.cadence, 'P1M');
  });

  it('usageLimitOnCreate seeds a scoped budget though the agent already has one for another scope', async () => {
    const { engine, sent } = engineWith([{ id: 'whole', usageLimit: 80, scopeEntityIds: [] }]);
    await engine.upsertEntity('c', entity, { ...base, usageLimitOnCreate: 40, scopeEntityIds: ['claude-opus-5'] });

    assert.equal(sent[0]!.usageLimit, 40, 'its own scope has no assignment yet');
    assert.deepEqual(sent[0]!.scopeEntityIds, ['claude-opus-5']);
  });

  it('finds a scoped budget past the first page, rather than overwrite its limit with the seed', async () => {
    // The real client against a server that pages: twenty-five other scopes ahead of it.
    const mock = await startMockStiggServer();
    try {
      const budget = { entityId: 'agent-1', capabilityId: 'data_credit', parentId: 'team-1' };
      for (let n = 0; n < 25; n++)
        seedBudget(mock.state, 'c', { ...budget, usageLimit: 10, scopeEntityIds: [`model-${n}`] });
      seedBudget(mock.state, 'c', { ...budget, usageLimit: 80, scopeEntityIds: ['claude-opus-5'] });
      const engine = new RestGovernanceEngine({ apiKey: 'offline-mock', baseUrl: mock.baseUrl });

      await engine.upsertEntity('c', entity, { ...base, usageLimitOnCreate: 40, scopeEntityIds: ['claude-opus-5'] });

      assert.ok(mock.state.assignmentPages.length > 1, 'read past the first page');
      const opus = assignmentsOf(mock.state, 'c').find((a) => a.scopeEntityIds.includes('claude-opus-5'));
      assert.equal(opus?.usageLimit, 80, 'the existing limit is left alone');
    } finally {
      await mock.close();
    }
  });

  it("usageLimitOnCreate seeds the agent's whole budget though it has scoped ones", async () => {
    const { engine, sent } = engineWith([{ id: 'opus', usageLimit: 80, scopeEntityIds: ['claude-opus-5'] }]);
    await engine.upsertEntity('c', entity, { ...base, usageLimitOnCreate: 40 });

    assert.equal(sent[0]!.usageLimit, 40, 'a scoped budget is not the whole one');
  });

  it('matches a scope whatever order its ids are listed in', async () => {
    const { engine, sent } = engineWith([{ id: 'pair', usageLimit: 80, scopeEntityIds: ['b', 'a'] }]);
    await engine.upsertEntity('c', entity, { ...base, usageLimitOnCreate: 40, scopeEntityIds: ['a', 'b'] });

    assert.ok(!('usageLimit' in sent[0]!), 'the same scope - left alone');
  });

  it('tells a scope of one id holding a comma from a scope of two ids', async () => {
    const { engine, sent } = engineWith([{ id: 'one', usageLimit: 80, scopeEntityIds: ['a,b'] }]);
    await engine.upsertEntity('c', entity, { ...base, usageLimitOnCreate: 40, scopeEntityIds: ['a', 'b'] });

    assert.equal(sent[0]!.usageLimit, 40, 'a different scope - seeded');
  });

  it("keeps the mock's assignments for ['a,b'] and ['a', 'b'] apart", async () => {
    const mock = await startMockStiggServer();
    try {
      const budget = { entityId: 'agent-1', capabilityId: 'data_credit' };
      seedBudget(mock.state, 'c', { ...budget, usageLimit: 10, scopeEntityIds: ['a,b'] });
      seedBudget(mock.state, 'c', { ...budget, usageLimit: 20, scopeEntityIds: ['a', 'b'] });

      assert.deepEqual(
        assignmentsOf(mock.state, 'c').map((a) => a.usageLimit),
        [10, 20],
      );
    } finally {
      await mock.close();
    }
  });

  it('usageLimitOnCreate leaves an existing budget alone - an admin raise survives the next run', async () => {
    const { engine, sent } = engineWith([{ id: 'existing', usageLimit: 80 }]);
    await engine.upsertEntity('c', entity, { ...base, usageLimitOnCreate: 40 });

    // Omitted, not sent as undefined: the server preserves only fields absent from the payload.
    assert.ok(!('usageLimit' in sent[0]!), 'usageLimit must not be sent');
    assert.ok(!('cadence' in sent[0]!), 'cadence must not be sent either - it is part of the budget');
    // Placement still applies: re-homing an agent is not a budget change.
    assert.equal(sent[0]!.parentId, 'team-1');
  });

  it('still upserts the entity and its placement when no budget is given at all', async () => {
    const { engine, sent, listed } = engineWith([{ id: 'existing' }]);
    await engine.upsertEntity('c', entity, { ...base });

    assert.equal(listed.length, 0);
    assert.equal(sent[0]!.parentId, 'team-1');
    assert.ok(!('usageLimit' in sent[0]!));
  });
});
