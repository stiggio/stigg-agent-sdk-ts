/**
 * A flat error hierarchy with `isX()` guards, so callers can branch without `instanceof`
 * surviving across bundles or duplicated copies of this package.
 */
import type { AccessDecision, Metrics } from './types';

const MARKER = Symbol.for('stigg.agent-sdk.error');

type Marked = { [MARKER]: string };

const mark = <T extends Error>(err: T, kind: string): T => {
  Object.defineProperty(err, MARKER, { value: kind, enumerable: false });
  return err;
};

const isKind = (err: unknown, kind: string): boolean =>
  typeof err === 'object' && err !== null && (err as Marked)[MARKER] === kind;

/**
 * Thrown only where there is no return path for a decision - inside a wrapped client method,
 * which must hand back the vendor's own response type or nothing at all. Everywhere else a
 * denial is a returned `AccessDecision`.
 */
export class AccessDeniedError extends Error {
  readonly decision: AccessDecision;

  constructor(decision: AccessDecision) {
    const by = decision.deniedBy ? ` by ${decision.deniedBy}` : '';
    super(`Denied${by}: ${decision.reason ?? 'no budget remaining'}`);
    this.name = 'AccessDeniedError';
    this.decision = decision;
    mark(this, 'denied');
  }
}

/** Anything the engine could not complete: transport, timeout, 4xx/5xx, bad input. */
export class EngineError extends Error {
  readonly status?: number;
  readonly operation: string;
  /**
   * What the server had already accepted when this failed.
   *
   * An ingest is up to two calls - the features, then the wallet - so a rejection on the second
   * leaves the first one's spend sitting at Stigg. Reporting that turn as nothing landed would
   * understate a bill the customer is going to see, which is the one direction a meter must not
   * be wrong in.
   */
  readonly reported?: Metrics;
  /**
   * Whether what landed was a replay. Carried with `reported`, because counting those metrics
   * again is the one thing a caller must not do with keys Stigg had already seen - and
   * `undefined` means here what it means everywhere: the event API could not say.
   */
  readonly replayed?: boolean;

  constructor(
    operation: string,
    message: string,
    options?: { status?: number; cause?: unknown; reported?: Metrics; replayed?: boolean },
  ) {
    super(`${operation}: ${message}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EngineError';
    this.operation = operation;
    this.status = options?.status;
    this.reported = options?.reported;
    this.replayed = options?.replayed;
    mark(this, 'engine');
  }
}

/**
 * Per-agent budgets are not enabled for this Stigg environment. An account state, not a transient
 * failure, and the class keeps the platform's own name because that is what has to be turned on.
 *
 * The message says what to do rather than what is missing. "Governance is not enabled" names an
 * internal capability to someone who was trying to charge for agent usage and has no reason to
 * know the two are the same thing - so the first line is the fix, and the feature name follows it
 * for whoever has to go and find the setting.
 */
export class GovernanceNotEnabledError extends Error {
  constructor(
    detail = 'Per-agent budgets are not enabled for this Stigg environment, so an agent cannot be ' +
      'given an identity or a budget. Enable Governance for the account to use them - or drop ' +
      '`agentId` and the budget fields, and checks and usage apply to the customer instead.',
  ) {
    super(detail);
    this.name = 'GovernanceNotEnabledError';
    mark(this, 'not-enabled');
  }
}

/**
 * How far down a wrapped error is searched. Each LangChain middleware that wraps a model call adds
 * one `MiddlewareError` around a denial, and a sub-agent's run nests its own inside its parent's,
 * so a handful of levels is ordinary. The bound is only there so a cyclic `cause` cannot spin.
 */
const MAX_CAUSE_DEPTH = 16;

/**
 * Returns the decision when `err` is a governance denial - the one-liner for a binding catch.
 *
 * Frameworks rarely let an error through untouched. Vendor SDKs wrap callback errors, LangChain
 * wraps a model call's error once per middleware, and LangGraph reports two branches that failed
 * in one step as an `AggregateError` - so the denial is looked for down the whole `cause` chain and
 * inside every aggregated error, not only at the top.
 */
export function isAccessDenied(err: unknown): AccessDecision | undefined {
  return findDenial(err, 0);
}

function findDenial(err: unknown, depth: number): AccessDecision | undefined {
  if (isKind(err, 'denied')) return (err as AccessDeniedError).decision;
  if (typeof err !== 'object' || err === null || depth >= MAX_CAUSE_DEPTH) return undefined;
  const { cause, errors } = err as { cause?: unknown; errors?: unknown };
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      const decision = findDenial(inner, depth + 1);
      if (decision) return decision;
    }
  }
  return cause === undefined ? undefined : findDenial(cause, depth + 1);
}

export const isEngineError = (err: unknown): err is EngineError => isKind(err, 'engine');

export const isGovernanceNotEnabled = (err: unknown): err is GovernanceNotEnabledError => isKind(err, 'not-enabled');

/**
 * True when Stigg refused a usage report because the feature is backed by a raw-events meter.
 * Ingest forks by meter type, and this error is the definitive signal for which fork to take -
 * `meterType` alone does not say (a raw-events feature can report `INCREMENTAL`).
 */
export function isMeterMismatchError(err: unknown): boolean {
  const any = err as { code?: string; error?: { code?: string }; message?: string } | undefined;
  const code = any?.code ?? any?.error?.code ?? '';
  if (code.startsWith('CannotReportUsageForEntitlementWithMeter')) return true;
  const message = any?.message ?? '';
  return message.includes('report usage for entitlement with meter') || message.includes('use reportEvent');
}

/** Whatever a client threw, as the seam's own error - keeping the status where there was one. */
export function asEngineError(
  operation: string,
  err: unknown,
  partial?: { reported?: Metrics; replayed?: boolean },
): EngineError {
  const status = (err as { status?: number })?.status;
  // Re-wrapping must not drop a partial acknowledgement: the run handle wraps again on its way
  // out, and whatever landed is just as true one frame up.
  const landed = partial ?? (err instanceof EngineError ? { reported: err.reported, replayed: err.replayed } : {});
  return new EngineError(operation, err instanceof Error ? err.message : String(err), {
    status,
    cause: err,
    reported: landed.reported,
    replayed: landed.replayed,
  });
}

/**
 * True when a failure looks like "this transport is not answering" rather than "Stigg refused".
 *
 * The distinction decides whether another transport is worth trying: a 404 on the GraphQL
 * endpoint or a refused connection says nothing about the request, while a 400 or a 403 says the
 * request itself is wrong and would be wrong on any transport. Deliberately narrow - demoting on
 * a business error would hide a real problem behind a silent re-route.
 */
export function isTransportFailure(err: unknown): boolean {
  const any = err as { status?: number; message?: string; cause?: { code?: string; message?: string } } | undefined;
  if (any?.status && [404, 500, 502, 503, 504].includes(any.status)) return true;

  const code = any?.cause?.code ?? '';
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(code)) return true;

  const message = `${any?.message ?? ''} ${any?.cause?.message ?? ''}`;
  if (/status code (404|5\d\d)/i.test(message)) return true;
  return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed|network error/i.test(message);
}

/**
 * The seam's error for an operation that only governance can serve.
 *
 * Entities and assignments exist nowhere else, so a 403 on one of them is the account saying the
 * feature is off - a state the caller can act on - rather than a call that failed. Every other
 * failure is an ordinary engine error.
 */
export function asGovernanceError(operation: string, err: unknown): Error {
  if (looksLikeGovernanceNotEnabled(err)) return new GovernanceNotEnabledError();
  return asEngineError(operation, err);
}

/** Recognizes the account-state 403 in whatever shape the transport surfaced it. */
export function looksLikeGovernanceNotEnabled(err: unknown): boolean {
  if (isGovernanceNotEnabled(err)) return true;
  const any = err as { status?: number; code?: string; error?: { code?: string }; message?: string } | undefined;
  if (any?.code === 'GovernanceNotEnabled' || any?.error?.code === 'GovernanceNotEnabled') return true;
  return any?.status === 403 && (any.message ?? '').includes('Governance is not enabled');
}
