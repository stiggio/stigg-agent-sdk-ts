/**
 * The chains-to-decision mapping. Pure, so every case is a literal - no engine, no network.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { policyDecision, remedyFor, toDecision, unenforcedDecision } from '../src/engine/decision';
import { isMeterMismatchError } from '../src/errors';
import type { EngineCheckResult } from '../src/engine/engine';

const CUSTOMER = 'customer-acme';
const decide = (result: Partial<EngineCheckResult>) =>
  toDecision({ isGranted: true, source: 'rest', ...result } as EngineCheckResult, { customerId: CUSTOMER });

const node = (
  over: Partial<{ entityId: string; isGranted: boolean; usageLimit: number | null; currentUsage: number }>,
) => ({
  entityId: 'agent-1',
  isGranted: true,
  usageLimit: 10 as number | null,
  currentUsage: 0,
  scopeEntityIds: [] as string[],
  ...over,
});

describe('toDecision', () => {
  it('allows with no assignment: governance is opt-in, so an empty chain is not a denial', () => {
    const decision = decide({ isGranted: true, chains: [], usageLimit: 100, currentUsage: 40 });
    assert.equal(decision.hasAccess, true);
    assert.equal(decision.deniedBy, undefined);
    assert.equal(decision.remaining, 60);
  });

  it('names the leaf that denied', () => {
    const decision = decide({
      isGranted: false,
      accessDeniedReason: 'BudgetExceeded',
      chains: [[node({ entityId: 'team-eng' }), node({ entityId: 'agent-1', isGranted: false, currentUsage: 10 })]],
    });
    assert.equal(decision.deniedBy, 'agent-1');
    assert.equal(decision.remedy, 'raise-budget');
    assert.equal(decision.remaining, 0);
  });

  it('names the ancestor when the leaf still has budget: any exhausted ancestor blocks the subtree', () => {
    const decision = decide({
      isGranted: false,
      accessDeniedReason: 'BudgetExceeded',
      chains: [
        [
          node({ entityId: 'team-eng', isGranted: false, usageLimit: 10, currentUsage: 10 }),
          node({ entityId: 'agent-1', isGranted: true, usageLimit: 5, currentUsage: 0 }),
        ],
      ],
    });
    assert.equal(decision.deniedBy, 'team-eng');
    assert.equal(decision.remaining, 0, 'the tightest bound wins, not the leaf');
  });

  it('leaves remaining undefined in observe-only mode (usageLimit null counts but never blocks)', () => {
    const decision = decide({ isGranted: true, usageLimit: null, chains: [[node({ usageLimit: null })]] });
    assert.equal(decision.hasAccess, true);
    assert.equal(decision.remaining, undefined);
  });

  it('falls back to the customer when a denial carries no chain', () => {
    const decision = decide({
      isGranted: false,
      accessDeniedReason: 'InsufficientCredits',
      usageLimit: 5,
      currentUsage: 5,
    });
    assert.equal(decision.deniedBy, CUSTOMER);
    assert.equal(decision.remedy, 'top-up', 'an empty wallet is an upsell, not an admin escalation');
  });

  it('keeps the two denial reasons distinct', () => {
    assert.equal(remedyFor('InsufficientCredits'), 'top-up');
    assert.equal(remedyFor('BudgetExceeded'), 'raise-budget');
    assert.equal(remedyFor('RequestedUsageExceedingLimit'), 'raise-budget');
    assert.equal(remedyFor('NoActiveSubscription'), 'subscribe');
    assert.equal(remedyFor('Unknown'), undefined);
  });

  it('marks a fallback read so callers know the state was not live', () => {
    assert.equal(decide({ isFallback: true }).isFallback, true);
  });
});

describe('policyDecision', () => {
  it('is always attributable to the engine failure, allow or deny', () => {
    const denied = policyDecision(false);
    assert.deepEqual({ hasAccess: denied.hasAccess, source: denied.source }, { hasAccess: false, source: 'policy' });
    assert.equal(denied.deniedBy, undefined, 'no entity actually refused this');
    assert.equal(policyDecision(true).hasAccess, true);
    assert.equal(policyDecision(true).remedy, 'retry');
  });
});

describe('unenforcedDecision', () => {
  it('describes an unenforced decision as what it is, not as an allow with a budget behind it', () => {
    const decision = unenforcedDecision();

    assert.equal(decision.hasAccess, true);
    assert.equal(decision.source, 'unenforced');
    assert.equal(decision.reason, undefined, 'nothing failed, so there is nothing to retry');
    assert.equal(decision.remedy, undefined);
    assert.equal(decision.remaining, undefined, 'and no budget to have a remainder of');
    assert.equal(
      decision.summary,
      'hasAccess=true source=unenforced - this run named no entitlement, so nothing was checked',
    );
    assert.equal(decision.message, 'Allowed.', 'from where the end user sits, allowed is the whole truth');
  });
});

describe('isMeterMismatchError', () => {
  it('recognizes the raw-events meter rejection in whatever shape the transport surfaced it', () => {
    assert.equal(isMeterMismatchError({ code: 'CannotReportUsageForEntitlementWithMeterError' }), true);
    assert.equal(isMeterMismatchError({ error: { code: 'CannotReportUsageForEntitlementWithMeter' } }), true);
    assert.equal(
      isMeterMismatchError(
        new Error(
          'Failed to report usage: Can not report usage for entitlement with meter, use reportEvent method instead',
        ),
      ),
      true,
    );
  });

  it('does not mistake an unrelated failure for a meter-type fork', () => {
    assert.equal(isMeterMismatchError(new Error('503 governance cache unavailable')), false);
    assert.equal(isMeterMismatchError({ code: 'CustomerNotFound' }), false);
    assert.equal(isMeterMismatchError(undefined), false);
  });
});

describe('fallback readings', () => {
  it('reads a denied fallback as unavailable, not as a budget verdict', () => {
    const decision = decide({ isGranted: false, isFallback: true, accessDeniedReason: null, usageLimit: 0 });
    assert.equal(decision.remedy, 'retry');
    assert.equal(decision.reason, 'EngineUnavailable');
    assert.equal(decision.deniedBy, undefined, 'no entity refused this - none was consulted');
    assert.match(decision.message, /temporarily unavailable/);
  });

  it('leaves a fallback that still grants access alone', () => {
    const decision = decide({ isGranted: true, isFallback: true, usageLimit: 100, currentUsage: 0 });
    assert.equal(decision.hasAccess, true);
    assert.equal(decision.isFallback, true);
    assert.equal(decision.reason, undefined);
  });
});
