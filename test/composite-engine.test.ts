/**
 * The composite forwards each operation to its own delegate and stamps the result with whoever
 * served it, so a decision can always be traced back to a client.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CompositeEngine } from '../src/engine/composite-engine';
import { isGovernanceNotEnabled } from '../src/errors';
import type { EngineResolution, GovernanceEngine } from '../src/engine/engine';
import { FakeEngine } from './fake-engine';

const resolution: EngineResolution = {
  mode: 'governance',
  ops: { upsertEntity: 'rest', check: 'rest', report: 'node-sdk', archiveEntity: 'rest' },
  reason: 'test',
};

describe('CompositeEngine', () => {
  it('sends each operation to its own delegate', async () => {
    const rest = new FakeEngine();
    const node = new FakeEngine();
    const composite = new CompositeEngine({
      delegates: { upsertEntity: rest, check: rest, report: node, archiveEntity: rest },
      resolution,
    });

    await composite.upsertEntity('c', { id: 'agent-1', entityTypeId: 'agent' });
    const decision = await composite.check('c', {
      entitlement: { currencyId: 'credits' },
      requestedUsage: 1,
      dimensions: {},
    });
    await composite.report('c', {
      entitlement: { currencyId: 'credits' },
      mode: 'sync',
      metrics: { credits: 1 },
      dimensions: {},
      idempotencyKey: 'k',
    });
    await composite.archiveEntity('c', 'agent-1');

    assert.deepEqual([rest.entities.length, rest.checks, rest.reports], [1, 1, 0]);
    assert.deepEqual([node.checks, node.reports], [0, 1]);
    assert.deepEqual(rest.archived, ['agent-1']);
    assert.equal(decision.source, 'rest', 'the result names the client that answered');
  });

  /**
   * Warm-up follows the check routing, because warming anything else fills a cache this context
   * will never read. Under governance an attributed check goes to REST, which caches nothing.
   */
  describe('preload', () => {
    const governed = () => {
      const rest = new FakeEngine();
      const node = new FakeEngine();
      const composite = new CompositeEngine({
        delegates: { upsertEntity: rest, check: rest, unattributedCheck: node, report: node, archiveEntity: rest },
        resolution: { ...resolution, ops: { ...resolution.ops, unattributedCheck: 'node-sdk' } },
      });
      return { rest, node, composite };
    };

    it('warms the cached client for a check it would serve', async () => {
      const { rest, node, composite } = governed();
      await composite.preload('customer-acme', {});
      assert.deepEqual(node.preloaded, [{ customerId: 'customer-acme', dimensions: {} }]);
      assert.deepEqual(rest.preloaded, []);
    });

    it('warms nothing for an attributed check, which no cache can answer', async () => {
      const { rest, node, composite } = governed();
      // `rest` here is a FakeEngine, which does implement `preload` - so this asserts the routing
      // rather than the real REST client merely not having the method.
      await composite.preload('customer-acme', { agentId: 'agent-1' });
      assert.deepEqual(node.preloaded, [], 'a cache this check never reads must not be filled');
      assert.deepEqual(rest.preloaded, [{ customerId: 'customer-acme', dimensions: { agentId: 'agent-1' } }]);
    });

    it('is a no-op rather than an error when the delegate caches nothing', async () => {
      const backing = new FakeEngine();
      // The governance REST client's shape: every operation, and no `preload` at all. Spelled out
      // rather than deleted off a FakeEngine, where `preload` lives on the prototype and survives.
      const cacheless: GovernanceEngine = {
        capabilities: backing.capabilities,
        upsertEntity: (...args) => backing.upsertEntity(...args),
        check: (...args) => backing.check(...args),
        report: (...args) => backing.report(...args),
        archiveEntity: (...args) => backing.archiveEntity(...args),
      };
      const composite = new CompositeEngine({ delegates: { check: cacheless, report: backing }, resolution });

      await composite.preload('customer-acme', { agentId: 'agent-1' });

      assert.deepEqual(backing.preloaded, [], 'nothing was warmed, and nothing threw');
    });
  });

  it('reports provisioning as unavailable when nothing can provision', async () => {
    const node = new FakeEngine({ capabilities: { provisioning: false } });
    const composite = new CompositeEngine({
      delegates: { check: node, report: node },
      resolution: { ...resolution, mode: 'customer-level' },
    });
    assert.equal(composite.capabilities.provisioning, false);
    await assert.rejects(
      () => composite.upsertEntity('c', { id: 'agent-1', entityTypeId: 'agent' }),
      (err) => isGovernanceNotEnabled(err),
    );
  });

  it('believes the delegate rather than the method, which every engine implements', async () => {
    const node = new FakeEngine({ capabilities: { provisioning: false } });
    const composite = new CompositeEngine({
      delegates: { upsertEntity: node, check: node, report: node },
      resolution,
    });
    assert.equal(composite.capabilities.provisioning, false, 'having the method is not being able to');
    await assert.rejects(
      () => composite.upsertEntity('c', { id: 'agent-1', entityTypeId: 'agent' }),
      (err) => isGovernanceNotEnabled(err),
    );
    assert.equal(node.entities.length, 0, 'and the delegate it cannot use is never called');
  });
});

describe('CompositeEngine transport demotion', () => {
  /**
   * A delegate whose transport is gone: the shape the Node SDK produces against a dead endpoint.
   * It counts its own calls, because replacing `report` bypasses the counter FakeEngine keeps.
   */
  const unreachable = () => {
    const engine = new FakeEngine();
    const calls = { count: 0 };
    engine.report = async () => {
      calls.count += 1;
      throw new Error('Failed to consume credits: Response not successful: Received status code 404');
    };
    return { engine, calls };
  };

  const params = {
    mode: 'sync' as const,
    entitlement: { currencyId: 'credits' } as const,
    metrics: { credits: 1 },
    dimensions: {},
    idempotencyKey: 'k',
  };

  it('re-routes to the complete implementation when its preferred transport is unreachable', async () => {
    const rest = new FakeEngine();
    const composite = new CompositeEngine({
      delegates: { check: rest, report: unreachable().engine },
      fallback: rest,
      resolution,
    });

    const result = await composite.report('c', params);
    assert.equal(result.source, 'rest', 'the answer names who actually served it');
    assert.equal(rest.reports, 1);
  });

  it('remembers, so the dead transport is tried once and not on every call', async () => {
    const rest = new FakeEngine();
    const dead = unreachable();
    const composite = new CompositeEngine({
      delegates: { check: rest, report: dead.engine },
      fallback: rest,
      resolution,
    });

    await composite.report('c', { ...params, idempotencyKey: 'a' });
    await composite.report('c', { ...params, idempotencyKey: 'b' });
    assert.equal(dead.calls.count, 1, 'the second call went straight to the fallback');
    assert.equal(rest.reports, 2);
  });

  it('does not re-route a business failure - that would hide a real problem', async () => {
    const rest = new FakeEngine();
    const rejecting = new FakeEngine();
    rejecting.report = async () => {
      throw Object.assign(new Error('value must be a whole number'), { status: 400 });
    };
    const composite = new CompositeEngine({
      delegates: { check: rest, report: rejecting },
      fallback: rest,
      resolution,
    });

    await assert.rejects(() => composite.report('c', params), /whole number/);
    assert.equal(rest.reports, 0, 'the fallback was never asked');
  });

  it('never demotes the fallback itself - it is the complete implementation, not an optimization', async () => {
    const rest = unreachable();
    const composite = new CompositeEngine({
      delegates: { check: rest.engine, report: rest.engine },
      fallback: rest.engine,
      resolution,
    });
    await assert.rejects(() => composite.report('c', params), /status code 404/);
    assert.equal(rest.calls.count, 1, 'tried once, not retried against itself');
  });
});

describe('CompositeEngine routes a check on its attribution', () => {
  const governance: EngineResolution = {
    mode: 'governance',
    ops: {
      upsertEntity: 'rest',
      check: 'rest',
      unattributedCheck: 'node-sdk',
      report: 'node-sdk',
      archiveEntity: 'rest',
    },
    reason: 'test',
  };

  const wired = () => {
    const rest = new FakeEngine();
    const node = new FakeEngine();
    const composite = new CompositeEngine({
      delegates: { upsertEntity: rest, check: rest, unattributedCheck: node, report: node, archiveEntity: rest },
      fallback: rest,
      resolution: governance,
    });
    return { rest, node, composite };
  };

  const check = (dimensions: Record<string, string>) => ({
    entitlement: { currencyId: 'credits' } as const,
    requestedUsage: 1,
    dimensions,
  });

  it('sends an attributed check to the client that can return chains', async () => {
    const { rest, node, composite } = wired();
    const decision = await composite.check('c', check({ agentId: 'agent-1' }));

    assert.deepEqual([rest.checks, node.checks], [1, 0]);
    assert.equal(decision.source, 'rest', 'and the answer names who served it');
  });

  it('sends an unattributed one to the cached client, which answers the same question', async () => {
    const { rest, node, composite } = wired();
    const decision = await composite.check('c', check({}));

    assert.deepEqual([rest.checks, node.checks], [0, 1]);
    assert.equal(decision.source, 'node-sdk');
  });

  it('falls back to the chain client when nothing is wired for the unattributed case', async () => {
    const rest = new FakeEngine();
    const composite = new CompositeEngine({
      delegates: { check: rest, report: new FakeEngine() },
      resolution,
    });
    await composite.check('c', check({}));
    assert.equal(rest.checks, 1);
  });

  it('demotes one operation without disabling the other the same client serves', async () => {
    const rest = new FakeEngine();
    const node = new FakeEngine();
    let reportCalls = 0;
    node.report = async () => {
      reportCalls += 1;
      throw new Error('Failed to consume credits: Response not successful: Received status code 404');
    };
    const composite = new CompositeEngine({
      delegates: { upsertEntity: rest, check: rest, unattributedCheck: node, report: node, archiveEntity: rest },
      fallback: rest,
      resolution: governance,
    });

    // GraphQL ingest is gone; the entitlement read it also serves never went there.
    await composite.report('c', {
      entitlement: { currencyId: 'credits' },
      mode: 'sync',
      metrics: { credits: 1 },
      dimensions: {},
      idempotencyKey: 'k',
    });
    assert.equal(reportCalls, 1);
    assert.equal(rest.reports, 1, 'report re-routed');

    const decision = await composite.check('c', check({}));
    assert.equal(node.checks, 1, 'the unattributed check still goes to the cached client');
    assert.equal(decision.source, 'node-sdk');
  });
});
