/**
 * A session plus one resolved context, as one object.
 *
 * `GovernanceSession` takes a context on every call, because one session now serves every
 * customer a client is called for. Almost every test here is about a single context, though, so
 * binding the two together keeps those tests about what they are testing rather than about
 * threading an argument - and the handful that do vary the context call the session directly.
 */
import { resolveContext, type ResolvedContext, type StiggContext } from '../src/core/context';
import { GovernanceSession, type SessionSummary, type IngestOptions, type SessionHooks } from '../src/core/session';
import { noopLogger, type Logger } from '../src/logger';
import { FakeEngine } from './fake-engine';
import type { EngineError } from '../src/errors';
import type { ErrorContext } from '../src/config';
import type { GovernanceEngine } from '../src/engine/engine';
import type { AccessDecision, IngestResult, Measurement, Metrics, TokenUsage } from '../src/types';

export type BoundSession = {
  session: GovernanceSession;
  context: ResolvedContext;
  check(requestedUsage?: number): Promise<AccessDecision>;
  warmUp(): Promise<void>;
  ingest(value: number, options?: IngestOptions): Promise<IngestResult>;
  ingestMetrics(metrics: Metrics, options?: IngestOptions): Promise<IngestResult>;
  ingestMeasurement(measurement: Measurement | TokenUsage, options?: IngestOptions): Promise<IngestResult>;
  ingestTokens(usage: TokenUsage, options?: IngestOptions): Promise<IngestResult>;
  failedToMeasure(err: unknown): void;
  drain(): Promise<SessionSummary>;
  summary(): SessionSummary;
  headers(): Record<string, string>;
  readonly lastDecision: AccessDecision | undefined;
  readonly dimensions: Record<string, string>;
  readonly customerId: string;
  readonly correlationId: string;
};

export type BoundSessionOptions = StiggContext & {
  engine?: GovernanceEngine;
  logger?: Logger;
  onError?: (error: EngineError, context: ErrorContext) => void;
  hooks?: SessionHooks;
  onDecision?: SessionHooks['onDecision'];
  onIngest?: SessionHooks['onIngest'];
};

/** The defaults every case shares, so a test states only what it is varying. */
export function newRun(options: BoundSessionOptions = {}): BoundSession {
  const { engine, logger, onError, hooks, onDecision, onIngest, ...ctx } = options;
  const resolved = engine ?? new FakeEngine({ usageLimit: 100 });
  const session = new GovernanceSession({
    // The session resolves its engine at the point of use; a test already has one.
    engine: () => Promise.resolve(resolved),
    logger: logger ?? noopLogger,
    onError: onError ?? (() => undefined),
    hooks: { onDecision, onIngest, ...hooks },
  });
  const context = resolveContext(
    {
      customerId: 'customer-acme',
      entitlement: { currencyId: 'credits' },
      dimensions: { agentId: 'agent-1' },
      ...ctx,
    },
    ctx.correlationId ?? 'run-1',
  );

  return {
    session,
    context,
    check: (requestedUsage) => session.check(context, requestedUsage),
    warmUp: () => session.warmUp(context),
    ingest: (value, opts) => session.ingest(context, value, opts),
    ingestMetrics: (metrics, opts) => session.ingestMetrics(context, metrics, opts),
    ingestMeasurement: (measurement, opts) => session.ingestMeasurement(context, measurement, opts),
    ingestTokens: (usage, opts) => session.ingestTokens(context, usage, opts),
    failedToMeasure: (err) => session.failedToMeasure(context, err),
    drain: () => session.drain(),
    summary: () => session.summary(),
    headers: () => session.headers(context),
    get lastDecision() {
      return session.lastDecision;
    },
    get dimensions() {
      return context.dimensions;
    },
    get customerId() {
      return context.customerId;
    },
    get correlationId() {
      return context.correlationId;
    },
  };
}
