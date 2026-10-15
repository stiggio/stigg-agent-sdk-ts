/**
 * Why a check was refused, who decided it, and whether the two agree with Stigg.
 *
 * `remedyFor` switches on reason strings, and `decision.ts` is deliberately pure - it imports no
 * vendor package, because `node-sdk-engine.ts` is the only file in `src/` allowed to. That keeps
 * the switch honest about its dependencies and dishonest about nothing else: the strings in it
 * are hand-typed copies of a server enum, and a hand-typed copy of a server enum drifts.
 *
 * `decision.test.ts` already asserts `remedyFor('InsufficientCredits')`, but with the same typed
 * literal the switch uses - so it would survive a server-side rename intact and still pass while
 * every real denial fell through to "Denied." with no remedy. A test is the only place the two
 * can be compared, because a test may import what `decision.ts` may not.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AccessDeniedReason } from '@stigg/node-server-sdk';
import { NodeSdkEngine } from '../src/engine/node-sdk-engine';
import { remedyFor, toDecision } from '../src/engine/decision';
import type { EngineCheckResult } from '../src/engine/engine';
import type { Remedy } from '../src/types';

/**
 * Every reason Stigg can give, and what the caller should do about it. `undefined` is a real
 * answer - an archived customer has no self-service remedy - but it must be a chosen one, so a
 * reason the server adds later fails here until somebody decides which of the two it is.
 */
const REMEDIES: Record<AccessDeniedReason, Remedy | undefined> = {
  [AccessDeniedReason.BudgetExceeded]: 'raise-budget',
  [AccessDeniedReason.RequestedUsageExceedingLimit]: 'raise-budget',
  [AccessDeniedReason.InsufficientCredits]: 'top-up',
  [AccessDeniedReason.EntitlementNotFound]: 'subscribe',
  [AccessDeniedReason.FeatureNotFound]: 'subscribe',
  [AccessDeniedReason.NoActiveSubscription]: 'subscribe',
  [AccessDeniedReason.NoFeatureEntitlementInSubscription]: 'subscribe',
  [AccessDeniedReason.CustomerIsArchived]: undefined,
  [AccessDeniedReason.CustomerNotFound]: undefined,
  [AccessDeniedReason.CustomerResourceNotFound]: undefined,
  [AccessDeniedReason.FeatureTypeMismatch]: undefined,
  [AccessDeniedReason.RequestedValuesMismatch]: undefined,
  [AccessDeniedReason.Revoked]: undefined,
  [AccessDeniedReason.Unknown]: undefined,
};

/**
 * A NodeSdkEngine wired to a stub client, with no `Stigg.initialize` behind it. Which of the two
 * reads runs is decided by the entitlement's own shape, so both are stubbed with the same state.
 */
const engineReturning = (state: Record<string, unknown>): NodeSdkEngine => {
  const engine = Object.create(NodeSdkEngine.prototype) as NodeSdkEngine;
  return Object.assign(engine, {
    client: {
      getCreditEntitlement: async () => state,
      getMeteredEntitlement: async () => state,
    },
  });
};

const CREDIT = { currencyId: 'data_credit' };
const METERED = { featureId: 'feature-tokens' };
/** The engine forks on entitlement kind before anything else; the dimensions are not read here. */
const DIMENSIONS = { agentId: 'agent-support-bot' };

describe('remedyFor, against the reasons Stigg actually sends', () => {
  it('maps every AccessDeniedReason the server defines', () => {
    for (const [reason, expected] of Object.entries(REMEDIES)) {
      assert.equal(remedyFor(reason), expected, `${reason} should map to ${expected ?? 'no remedy'}`);
    }
  });

  it('names the credit denial the way the server spells it', () => {
    // The engine writes this string itself. If the enum is ever renamed, this is what catches it.
    assert.equal(remedyFor(AccessDeniedReason.InsufficientCredits), 'top-up');
  });

  it('still answers for the reasons the SDK raises on its own', () => {
    // Not server reasons - there is no engine response behind either of these.
    assert.equal(remedyFor('EngineError'), 'retry');
    assert.equal(remedyFor('nonsense-the-server-never-sends'), undefined);
  });
});

describe('the credit check, which the SDK adjudicates itself', () => {
  it('grants when the balance covers the request', async () => {
    const engine = engineReturning({ hasAccess: true, remaining: 10, usageLimit: 100, currentUsage: 90 });
    const result = await engine.check('customer-acme', {
      entitlement: CREDIT,
      requestedUsage: 5,
      dimensions: DIMENSIONS,
    });
    assert.equal(result.isGranted, true);
    assert.equal(result.accessDeniedReason, null);
  });

  it('refuses when it does not, because the credit read never saw the amount', async () => {
    // getCreditEntitlement takes no requestedUsage, so without this comparison a request for 5
    // against a balance of 2 comes back granted and the run overspends.
    const engine = engineReturning({ hasAccess: true, remaining: 2, usageLimit: 100, currentUsage: 98 });
    const result = await engine.check('customer-acme', {
      entitlement: CREDIT,
      requestedUsage: 5,
      dimensions: DIMENSIONS,
    });
    assert.equal(result.isGranted, false);
    assert.equal(result.accessDeniedReason, AccessDeniedReason.InsufficientCredits);
  });

  it('admits the verdict was its own', async () => {
    const engine = engineReturning({ hasAccess: true, remaining: 2, usageLimit: 100, currentUsage: 98 });
    const result = await engine.check('customer-acme', {
      entitlement: CREDIT,
      requestedUsage: 5,
      dimensions: DIMENSIONS,
    });
    assert.equal(result.locallyDerived, true, 'the balance is Stigg’s; the refusal is the SDK’s');
  });

  it('defers to the server when the server refused access outright', async () => {
    const engine = engineReturning({
      hasAccess: false,
      remaining: 0,
      accessDeniedReason: AccessDeniedReason.NoActiveSubscription,
    });
    const result = await engine.check('customer-acme', {
      entitlement: CREDIT,
      requestedUsage: 1,
      dimensions: DIMENSIONS,
    });
    assert.equal(result.accessDeniedReason, AccessDeniedReason.NoActiveSubscription);
  });

  it('claims nothing when the server refused access outright', async () => {
    // The flag exists to separate a verdict the SDK reached from one the server handed down.
    // Pointed at a server denial it would be the same misattribution, facing the other way.
    const engine = engineReturning({
      hasAccess: false,
      remaining: 0,
      accessDeniedReason: AccessDeniedReason.NoActiveSubscription,
    });
    const result = await engine.check('customer-acme', {
      entitlement: CREDIT,
      requestedUsage: 1,
      dimensions: DIMENSIONS,
    });
    assert.equal(result.locallyDerived, false, 'NoActiveSubscription is the server speaking');
  });

  it('claims nothing on the metered path, where Stigg was given the amount', async () => {
    const engine = engineReturning({
      hasAccess: false,
      accessDeniedReason: AccessDeniedReason.BudgetExceeded,
      usageLimit: 100,
      currentUsage: 100,
    });
    const result = await engine.check('customer-acme', {
      entitlement: METERED,
      requestedUsage: 5,
      dimensions: DIMENSIONS,
    });
    assert.equal(result.locallyDerived, undefined, 'the server adjudicated this one');
  });
});

describe('what a locally derived verdict looks like to the caller', () => {
  const decide = (over: Partial<EngineCheckResult>) =>
    toDecision({ isGranted: false, source: 'node-sdk', ...over } as EngineCheckResult, { customerId: 'customer-acme' });

  it('carries the admission through to the decision', () => {
    const decision = decide({ locallyDerived: true, accessDeniedReason: AccessDeniedReason.InsufficientCredits });
    assert.equal(decision.locallyDerived, true);
    assert.equal(decision.remedy, 'top-up');
  });

  it('leaves it off a verdict the server reached', () => {
    const decision = decide({ accessDeniedReason: AccessDeniedReason.BudgetExceeded });
    assert.equal(decision.locallyDerived, undefined);
  });

  /**
   * The summary is what reaches a log, and a log line is all an operator gets - there is no
   * object left to inspect by then. `fallback` is printed for the same reason.
   */
  it('says so in the one line that reaches a log', () => {
    const decision = decide({ locallyDerived: true, accessDeniedReason: AccessDeniedReason.InsufficientCredits });
    assert.match(decision.summary, /local=true/);
  });

  it('says nothing extra when Stigg adjudicated', () => {
    const decision = decide({ accessDeniedReason: AccessDeniedReason.BudgetExceeded });
    assert.doesNotMatch(decision.summary, /local=/);
  });

  /**
   * A denied fallback is rewritten to "could not see live state", which drops `deniedBy` for the
   * same reason: the comparison the SDK made no longer stands behind the answer being returned.
   */
  it('drops it when the fallback rewrite replaces the verdict', () => {
    const decision = decide({
      locallyDerived: true,
      isFallback: true,
      accessDeniedReason: AccessDeniedReason.InsufficientCredits,
    });
    assert.equal(decision.reason, 'EngineUnavailable');
    assert.equal(decision.locallyDerived, undefined);
    assert.equal(decision.deniedBy, undefined);
  });
});

/**
 * Which refusal a denial reads as, when the reason alone cannot say.
 *
 * An exhausted credit pool comes back as `BudgetExceeded`, the same string an admin-set cap
 * produces - so the reason alone maps both to "ask whoever set this budget to raise it". For a
 * customer who has simply run out of credits that is the wrong product: they would have paid, and
 * they are sent to find an administrator instead. One upsell lost per occurrence.
 *
 * What separates them is the chain. An entity's cap denies *in the chain*; the pool denies with
 * nothing in it. So a credit entitlement denied with no chain node is a top-up.
 */
describe('an empty wallet is an upsell, not an escalation', () => {
  const decisionFor = (chains: unknown, entitlement?: { currencyId: string } | { featureId: string }) =>
    toDecision(
      {
        isGranted: false,
        source: 'rest',
        accessDeniedReason: AccessDeniedReason.BudgetExceeded,
        chains,
      } as EngineCheckResult,
      { customerId: 'customer-acme', entitlement },
    );

  it('reads a pool-level denial on a credit entitlement as a top-up', () => {
    const decision = decisionFor(undefined, { currencyId: 'credits' });
    assert.equal(decision.remedy, 'top-up');
    assert.match(decision.message, /Out of credits/);
    assert.doesNotMatch(decision.message, /Budget exhausted/);
  });

  it('leaves an entity-level denial as the escalation it is', () => {
    // An agent's own cap refused this, and somebody administers that number.
    const decision = decisionFor([[{ entityId: 'agent-1', isGranted: false, usageLimit: 5, currentUsage: 5 }]], {
      currencyId: 'credits',
    });
    assert.equal(decision.remedy, 'raise-budget');
    assert.match(decision.message, /Budget exhausted for agent-1/);
  });

  it('leaves a feature entitlement alone, which has no wallet to top up', () => {
    const decision = decisionFor(undefined, { featureId: 'tokens' });
    assert.equal(decision.remedy, 'raise-budget');
  });

  it('leaves a run that gates on nothing alone, having no kind to read', () => {
    assert.equal(decisionFor(undefined).remedy, 'raise-budget');
  });

  it('does not rewrite a reason that already says which it is', () => {
    // `InsufficientCredits` is already a top-up, and `subscribe` must not become one.
    const explicit = toDecision(
      {
        isGranted: false,
        source: 'rest',
        accessDeniedReason: AccessDeniedReason.NoActiveSubscription,
      } as EngineCheckResult,
      { customerId: 'customer-acme', entitlement: { currencyId: 'credits' } },
    );
    assert.equal(explicit.remedy, 'subscribe');
  });
});
