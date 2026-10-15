/**
 * How a decision reads to a human. Kept next to the decision itself rather than in a binding,
 * because every binding needs the same words and none of them should invent their own.
 */
import type { AccessDecision } from './types';

/**
 * Denial -> what to tell the user.
 *
 * An entitlement refusal is a commercial event, not an incident: an empty wallet is an upsell, an
 * admin-set cap is an escalation to that admin, and the two must not be collapsed into one
 * "you have been blocked" string.
 */
export function remedyMessage(decision: AccessDecision | undefined): string {
  if (!decision || decision.hasAccess) return 'Allowed.';
  const who = decision.deniedBy ? ` for ${decision.deniedBy}` : '';

  switch (decision.remedy) {
    case 'top-up':
      return `Out of credits${who}. Top up the balance to continue.`;
    case 'raise-budget':
      return `Budget exhausted${who}. Ask whoever set this budget to raise it, or wait for the next reset.`;
    case 'subscribe':
      return `No entitlement${who}. An active subscription including this capability is required.`;
    case 'retry':
      return 'Governance is temporarily unavailable and the run was held back. Retry shortly.';
    default:
      return `Denied${who}${decision.reason ? ` (${decision.reason})` : ''}.`;
  }
}

/** One-line decision summary for logs. */
export function describeDecision(decision: Omit<AccessDecision, 'summary' | 'message'>): string {
  // Every field the line below is built from - remaining, who denied, which client answered - is
  // absent on an unenforced decision, and a line assembled from what is left reads as an allow with
  // a budget behind it. There is no budget behind it, so the line says that instead.
  if (decision.source === 'unenforced') {
    return 'hasAccess=true source=unenforced - this run named no entitlement, so nothing was checked';
  }

  const parts = [`hasAccess=${decision.hasAccess}`];
  if (decision.remaining !== undefined) parts.push(`remaining=${decision.remaining}`);
  if (decision.deniedBy) parts.push(`deniedBy=${decision.deniedBy}`);
  if (decision.reason) parts.push(`reason=${decision.reason}`);
  if (decision.remedy) parts.push(`remedy=${decision.remedy}`);
  parts.push(`source=${decision.source}`);
  if (decision.isFallback) parts.push('fallback=true');
  // Printed for the same reason `fallback` is: both say how much the line can be trusted, and an
  // operator reading it back has no object to inspect - only this.
  if (decision.locallyDerived) parts.push('local=true');
  return parts.join(' ');
}
