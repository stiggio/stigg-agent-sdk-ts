/**
 * Routes each of the four operations to whichever delegate serves it, and re-routes on its own
 * when one stops answering.
 *
 * The delegates are not equals. REST can serve everything; the Node SDK is an optimization - it
 * has the cache, so ingest prefers it - and the governance surface exists only on REST. So the
 * demotion rule is one-directional: an optimization that proves unreachable is dropped in favour
 * of the complete implementation, never the other way around. Demoting REST for a transport blip
 * would silently trade chains for no chains, which is a worse answer, not a slower one.
 */
import { isTransportFailure } from '../errors';
import { GovernanceNotEnabledError } from '../errors';
import type { Logger } from '../logger';
import type {
  EngineCapabilities,
  EngineOpSource,
  EngineCheckParams,
  EngineCheckResult,
  EngineReportParams,
  EngineReportResult,
  EngineResolution,
  EntityInput,
  EntityPlacement,
  GovernanceEngine,
} from './engine';

export type CompositeDelegates = {
  upsertEntity?: GovernanceEngine;
  check: GovernanceEngine;
  /**
   * Serves a check that carries no attribution. With no dimensions there is no entity to resolve
   * and no chain to lose, so the question is the customer's pool - which the cached client can
   * answer without a round trip. Unset, every check goes to `check`.
   */
  unattributedCheck?: GovernanceEngine;
  report: GovernanceEngine;
  archiveEntity?: GovernanceEngine;
};

/**
 * Whether this check is about an entity at all.
 *
 * `dimensions` is the only attribution a check carries - the REST call sends nothing else that
 * could resolve one - so an empty map means the governance tree is never consulted and the answer
 * is the customer's pool either way. Registration is deliberately NOT the signal: an agent
 * provisioned last week is governed by a run that registers nothing today.
 */
export const isAttributed = (params: { dimensions: Record<string, string> }): boolean =>
  Object.keys(params.dimensions).length > 0;

export type CompositeDeps = {
  delegates: CompositeDelegates;
  resolution: EngineResolution;
  /** The complete implementation. Takes over from any delegate that proves unreachable. */
  fallback?: GovernanceEngine;
  logger?: Logger;
};

export class CompositeEngine implements GovernanceEngine {
  readonly capabilities: EngineCapabilities;

  private readonly delegates: CompositeDelegates;
  private readonly resolution: EngineResolution;
  private readonly fallback?: GovernanceEngine;
  private readonly logger?: Logger;
  /**
   * Which `operation::client` pairs have failed in a way another transport could survive. Keyed
   * by the pair rather than by the engine: one client can serve two operations over two different
   * services, and a GraphQL outage must not disable an entitlement read that never went there.
   */
  private readonly demoted = new Set<string>();
  /** What each delegate is, so a result names the client that actually answered it. */
  private readonly sourceOf = new Map<GovernanceEngine, EngineOpSource>();

  constructor(deps: CompositeDeps) {
    this.delegates = deps.delegates;
    this.resolution = deps.resolution;
    this.fallback = deps.fallback;
    this.logger = deps.logger;

    const { ops } = deps.resolution;
    const label = (engine: GovernanceEngine | undefined, source: EngineOpSource) => {
      if (engine) this.sourceOf.set(engine, source);
    };
    label(deps.delegates.upsertEntity, ops.upsertEntity);
    label(deps.delegates.check, ops.check);
    label(deps.delegates.unattributedCheck, ops.unattributedCheck ?? ops.check);
    label(deps.delegates.report, ops.report);
    label(deps.delegates.archiveEntity, ops.archiveEntity);
    // Last, so the complete implementation wins where it also serves as a delegate.
    label(deps.fallback, 'rest');

    this.capabilities = {
      strictCheck: deps.delegates.check.capabilities.strictCheck,
      chains: deps.delegates.check.capabilities.chains,
      // What the delegate says it can do, not merely that it has the method: every engine
      // implements `upsertEntity`, and one that cannot provision must not be routed to.
      provisioning: deps.delegates.upsertEntity?.capabilities.provisioning ?? false,
    };
  }

  // async, so a missing provisioner surfaces as a rejection like every other failure here -
  // a promise-returning method that throws synchronously splits every caller's error handling.
  async upsertEntity(customerId: string, entity: EntityInput, placement?: EntityPlacement): Promise<void> {
    await this.run('upsertEntity', this.provisioner(), (engine) => engine.upsertEntity(customerId, entity, placement));
  }

  async archiveEntity(customerId: string, entityId: string): Promise<void> {
    await this.run('archiveEntity', this.provisioner(), (engine) => engine.archiveEntity(customerId, entityId));
  }

  async check(customerId: string, params: EngineCheckParams): Promise<EngineCheckResult> {
    const delegate = isAttributed(params)
      ? this.delegates.check
      : (this.delegates.unattributedCheck ?? this.delegates.check);
    return this.run('check', delegate, (engine) => engine.check(customerId, params));
  }

  async report(customerId: string, params: EngineReportParams): Promise<EngineReportResult> {
    return this.run('report', this.delegates.report, (engine) => engine.report(customerId, params));
  }

  /**
   * Warms the delegate that would serve this check - not every delegate that holds a cache.
   *
   * Routed by the same rule `check` uses, because warming anything else is a round trip spent on
   * a cache this context will never read: an attributed check under governance goes to REST,
   * which caches nothing, so the honest answer there is to do nothing. Deliberately not run
   * through `run()`: a warm-up that cannot reach its transport is not worth demoting an operation
   * over, and the first real check will discover the same outage and apply the error policy.
   */
  async preload(customerId: string, dimensions: Record<string, string>): Promise<void> {
    const delegate = isAttributed({ dimensions })
      ? this.delegates.check
      : (this.delegates.unattributedCheck ?? this.delegates.check);
    await delegate.preload?.(customerId, dimensions);
  }

  async close(): Promise<void> {
    const unique = new Set<GovernanceEngine>(
      [...Object.values(this.delegates), this.fallback].filter(Boolean) as GovernanceEngine[],
    );
    await Promise.all([...unique].map((engine) => engine.close?.()));
  }

  /**
   * Runs an operation on its delegate, and once - and only once per delegate - retries on the
   * complete implementation if the failure says the transport is unreachable rather than the
   * request wrong.
   */
  private async run<T>(
    operation: string,
    preferred: GovernanceEngine,
    call: (engine: GovernanceEngine) => Promise<T>,
  ): Promise<T> {
    const key = `${operation}::${this.sourceOf.get(preferred) ?? 'unknown'}`;
    const engine = this.demoted.has(key) && this.fallback ? this.fallback : preferred;
    try {
      return await this.stamp(engine, await call(engine));
    } catch (err) {
      const canRetry = this.fallback && engine !== this.fallback && isTransportFailure(err);
      if (!canRetry) throw err;

      this.demoted.add(key);
      this.logger?.warn(
        `[stigg] ${operation} could not reach its usual transport and was re-routed for the rest of this process: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return this.stamp(this.fallback!, await call(this.fallback!));
    }
  }

  /** Results carry the client that actually answered, which is not always the one planned. */
  private stamp<T>(engine: GovernanceEngine, result: T): T {
    if (!result || typeof result !== 'object' || !('source' in result)) return result;
    return { ...result, source: this.sourceOf.get(engine) ?? 'rest' };
  }

  private provisioner(): GovernanceEngine {
    const delegate = this.delegates.upsertEntity;
    if (!delegate?.capabilities.provisioning) throw new GovernanceNotEnabledError();
    return delegate;
  }
}
