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
            list: async (_customerId: string, params: Sent) => {
              listed.push(params);
              return { data: existing };
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

    assert.deepEqual(listed[0], { entityId: 'agent-1', currencyId: 'data_credit', limit: 1 });
    assert.equal(sent[0]!.usageLimit, 40);
    assert.equal(sent[0]!.cadence, 'P1M');
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
