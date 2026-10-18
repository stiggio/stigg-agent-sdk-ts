/**
 * What the constructor's own policy does to a call.
 *
 * Both options here were parsed, stored and then read by nothing: every context fell through to
 * the context module's defaults instead, so a client constructed to fail closed failed open, and
 * one constructed to report synchronously reported events. Nothing in the suite noticed, because
 * every case that cared passed the policy per call - which was the one path that worked.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isEnforced, resolveContext } from '../src/core/context';
import { newStigg, context } from './stigg-harness';
import { seedCreditRate } from '../testing/mock-stigg-server';

describe('the constructor policy reaches the call', () => {
  it('reports through the ingest API the constructor named', async () => {
    const { stigg, mock } = await newStigg({ ingest: 'sync' });
    seedCreditRate(mock.state, 'input_tokens', 1);

    const result = await stigg.report(context, { input_tokens: 12 });

    assert.equal(result.mode, 'sync');
    // The usage API aggregates on arrival, so the counter moved. An event would have left it
    // untouched: this account has no raw-events meter to turn one into usage.
    assert.equal(mock.state.usageByFeature.get('input_tokens'), 12);
  });

  it('still defaults to the event API when the constructor names nothing', async () => {
    const { stigg } = await newStigg();
    const result = await stigg.report(context, { input_tokens: 12 });
    assert.equal(result.mode, 'async');
  });

  // Attributed, so the check routes to the governance surface - the one `failChecks` breaks. An
  // unattributed check is served by the Node SDK instead and would answer fine, proving nothing.
  const attributed = {
    ...context,
    agentId: 'agent-1',
    attributionKey: 'agentId',
  };

  it('fails closed when the constructor said to', async () => {
    const { stigg, mock } = await newStigg({ checkErrorAction: 'deny' });
    await stigg.init();
    // The governance check now answers 503, which is what an unreachable Stigg looks like.
    mock.failChecks = true;

    const decision = await stigg.check(attributed);

    assert.equal(decision.hasAccess, false);
  });

  it('fails open by default, so an outage does not take the application down', async () => {
    const { stigg, mock } = await newStigg();
    await stigg.init();
    mock.failChecks = true;

    const decision = await stigg.check(attributed);

    assert.equal(decision.hasAccess, true);
  });
});

describe('concurrent registration', () => {
  it('writes both descriptions when two calls describe one agent differently', async () => {
    const { stigg, mock } = await newStigg();
    const agentId = 'agent-described-twice';

    // Both in flight at once: the memo cannot help until the first write lands, which is exactly
    // when a process opening its agents in parallel asks.
    await Promise.all([
      stigg.register({ ...context, agentId, entityTypeId: 'agent', displayName: 'First' }),
      stigg.register({ ...context, agentId, entityTypeId: 'agent', displayName: 'Second' }),
    ]);

    const written = mock.state.entityWrites.filter((entity) => entity.id === agentId);
    assert.deepEqual(
      written.map((entity) => entity.displayName).sort(),
      ['First', 'Second'],
      'a shared promise would have returned success to the second caller having written only the first name',
    );
  });

  it('still collapses two identical registrations into one write', async () => {
    const { stigg, mock } = await newStigg();
    const agentId = 'agent-described-once';

    await Promise.all([
      stigg.register({ ...context, agentId, entityTypeId: 'agent', displayName: 'Same' }),
      stigg.register({ ...context, agentId, entityTypeId: 'agent', displayName: 'Same' }),
    ]);

    assert.equal(mock.state.entityWrites.filter((entity) => entity.id === agentId).length, 1);
  });
});

/**
 * What the types already promise, checked anyway at the two public entry points a JS caller
 * reaches without them. The bar is only that the SDK says which argument was wrong - a bare
 * `TypeError` thrown from inside it reads as a bug in the SDK rather than in the call.
 */
describe('input the types forbid and a JS caller can still pass', () => {
  it('names the argument when agentId is not a string', async () => {
    const { stigg } = await newStigg();
    await assert.rejects(
      () => stigg.register({ ...context, agentId: 7 as unknown as string, entityTypeId: 'agent' }),
      /register needs an agentId/,
    );
  });

  it('names the key when metadata is not a record of strings', async () => {
    const { stigg } = await newStigg();
    await assert.rejects(
      () =>
        stigg.register({
          ...context,
          agentId: 'agent-bad-metadata',
          entityTypeId: 'agent',
          metadata: { tier: 2 } as unknown as Record<string, string>,
        }),
      /`tier` is a number/,
    );
  });

  it('treats a null entitlement as none, in every reader', () => {
    const resolved = resolveContext(
      { customerId: 'customer-acme', entitlement: null as unknown as undefined },
      'correlation-1',
    );

    // `isEnforced` asks `!== undefined` while every other reader asks for truthiness, so a null
    // one used to be enforced here and absent everywhere after - a wrapped call that ran the gate
    // and then recorded itself ungated, counting a check nothing could have refused.
    assert.equal(resolved.entitlement, undefined);
    assert.equal(isEnforced(resolved), false);
  });
});
