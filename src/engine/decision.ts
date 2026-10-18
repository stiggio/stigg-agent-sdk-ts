/**
 * Turns an engine result into the structured refusal callers branch on.
 *
 * The `chains` array IS the refusal: it names which entity in the hierarchy denied and by how
 * much, so no new primitive is needed on top of it.
 */
import { describeDecision, remedyMessage } from '../decision-text';
import { entitlementKind } from '../types';
import type { AccessDecision, Entitlement, Remedy } from '../types';
import type { EngineCheckResult, EngineChainNode } from './engine';

/**
 * Denial reasons map to different products, so they must not be collapsed: an empty wallet is an
 * upsell, an admin-set cap is an escalation, and a missing subscription is neither.
 */
export function remedyFor(reason: string | null | undefined): Remedy | undefined {
  switch (reason) {
    case 'InsufficientCredits':
      return 'top-up';
    case 'BudgetExceeded':
    case 'RequestedUsageExceedingLimit':
      return 'raise-budget';
    case 'NoActiveSubscription':
    case 'NoFeatureEntitlementInSubscription':
    case 'EntitlementNotFound':
    case 'FeatureNotFound':
      return 'subscribe';
    case 'EngineError':
      return 'retry';
    default:
      return undefined;
  }
}

/**
 * Credits are fractional, and a subtraction of two of them is not: `5 - 4.4258` lands on
 * 0.5742000000000003, which then reads back to a user as the balance. Rounded to four places,
 * which is finer than any credit currency prices and coarser than the noise.
 */
const remainingOf = (limit: number | null | undefined, used: number | undefined): number | undefined =>
  limit === null || limit === undefined ? undefined : Math.round(Math.max(0, limit - (used ?? 0)) * 1e4) / 1e4;

const tightest = (values: (number | undefined)[]): number | undefined => {
  const bounded = values.filter((value): value is number => value !== undefined);
  return bounded.length ? Math.min(...bounded) : undefined;
};

export type DecisionContext = {
  customerId: string;
  /**
   * What the run gates on, when it gates on anything. Only its *kind* is read - see
   * {@link toDecision} for why a denial needs it.
   */
  entitlement?: Entitlement;
};

/**
 * `remaining` is the tightest bound across the pool and every chain node, because the binding
 * constraint is whichever runs out first. It stays undefined when nothing is bounded - the
 * observe-only rollout, where usage is counted but never blocks.
 */
export function toDecision(result: EngineCheckResult, { customerId, entitlement }: DecisionContext): AccessDecision {
  const nodes: EngineChainNode[] = (result.chains ?? []).flat();
  const denied = nodes.find((node) => !node.isGranted);
  const reason = result.accessDeniedReason ?? undefined;

  const decision: Omit<AccessDecision, 'summary' | 'message'> = {
    hasAccess: result.isGranted,
    remaining: tightest([
      remainingOf(result.usageLimit, result.currentUsage),
      ...nodes.map((node) => remainingOf(node.usageLimit, node.currentUsage)),
    ]),
    usageLimit: result.usageLimit,
    currentUsage: result.currentUsage,
    source: result.source === 'unavailable' ? 'policy' : result.source,
    checkedAt: Date.now(),
  };

  if (result.isFallback) decision.isFallback = true;
  if (result.locallyDerived) decision.locallyDerived = true;
  if (reason) {
    decision.reason = reason;
    // An exhausted credit pool comes back as a budget denial, so the reason alone cannot tell an
    // empty wallet from an admin-set cap - and the two are different products. Nothing in the
    // chain denied means nothing anyone administers refused this: the pool did. On a credit
    // entitlement that is a top-up, and saying "ask whoever set this budget to raise it" instead
    // sends a customer who would have paid to go and find an administrator.
    const poolLevel = !denied && entitlement !== undefined && entitlementKind(entitlement) === 'credit';
    decision.remedy = poolLevel && remedyFor(reason) === 'raise-budget' ? 'top-up' : remedyFor(reason);
  }
  if (!result.isGranted) {
    // With no chain (governance off, or a pool-level denial) the customer is what blocked.
    decision.deniedBy = denied?.entityId ?? customerId;
  }
  if (result.isFallback && !result.isGranted) {
    // A denied fallback is not a budget verdict - nobody's limit was consulted, the engine just
    // could not see live state. Saying "raise the budget" here would send the reader somewhere
    // there is nothing to fix.
    decision.reason = 'EngineUnavailable';
    decision.remedy = 'retry';
    delete decision.deniedBy;
    // Nor was it the SDK's arithmetic: whatever the comparison said has just been replaced by
    // "could not see live state", and claiming authorship of a verdict that no longer stands
    // would point a reader at the wrong thing to fix.
    delete decision.locallyDerived;
  }
  return withDecisionText(decision);
}

/**
 * Attaches the human-readable halves, so every caller prints the same words. Exported because
 * anything that adjusts a decision after the fact has to refresh them too - a stale summary is
 * worse than none.
 */
export function withDecisionText(decision: Omit<AccessDecision, 'summary' | 'message'>): AccessDecision {
  const full = decision as AccessDecision;
  full.summary = describeDecision(decision);
  full.message = remedyMessage(full);
  return full;
}

/**
 * The decision to return when the engine itself failed and policy resolved the outcome. No
 * `deniedBy`: nobody's budget refused this, so naming an entity would be a lie - the failure
 * detail goes to the `onError` hook instead.
 */
export function policyDecision(hasAccess: boolean): AccessDecision {
  return withDecisionText({
    hasAccess,
    reason: 'EngineError',
    remedy: 'retry',
    source: 'policy',
    checkedAt: Date.now(),
  });
}

/**
 * The decision a run that named no entitlement hands back.
 *
 * Not `policyDecision(true)`: that one says the engine was asked and failed, which is why it carries
 * `reason: 'EngineError'` and `remedy: 'retry'`. Nothing failed here and nothing was asked - there
 * is no budget to ask about - so the only fields true of it are the allow and the source that says
 * why it is one. No `remaining`, because nothing is bounded; no `deniedBy`, because nothing refused.
 */
export function unenforcedDecision(): AccessDecision {
  return withDecisionText({ hasAccess: true, source: 'unenforced', checkedAt: Date.now() });
}
