/**
 * A literal stand-in for the engine seam. Every collaborator being replaceable by a plain object
 * is the substitution check the interface exists for.
 */
import type { Metrics } from '../src/types';
import type {
  EngineCapabilities,
  EngineCheckParams,
  EngineCheckResult,
  EngineReportParams,
  EngineReportResult,
  EntityInput,
  EntityPlacement,
  GovernanceEngine,
} from '../src/engine/engine';

export type FakeEngineOptions = {
  usageLimit?: number | null;
  capabilities?: Partial<EngineCapabilities>;
  failCheck?: Error;
  failReport?: Error;
  chains?: boolean;
  /** False makes reports come back with no credit balance, as an unmapped feature does. */
  creditBacked?: boolean;
};

export class FakeEngine implements GovernanceEngine {
  readonly capabilities: EngineCapabilities;
  checks = 0;
  reports = 0;
  currentUsage = 0;
  readonly seenKeys = new Set<string>();
  readonly entities: EntityInput[] = [];
  readonly placements: (EntityPlacement | undefined)[] = [];
  readonly archived: string[] = [];
  readonly dimensionsSeen: Record<string, string>[] = [];
  /** What warm-up asked to be loaded. Empty is the right answer for an engine with no cache. */
  readonly preloaded: { customerId: string; dimensions: Record<string, string> }[] = [];
  readonly metricsSeen: Metrics[] = [];

  private readonly options: FakeEngineOptions;

  constructor(options: FakeEngineOptions = {}) {
    this.options = options;
    this.capabilities = { strictCheck: false, chains: true, provisioning: true, ...options.capabilities };
  }

  async upsertEntity(_customerId: string, entity: EntityInput, placement?: EntityPlacement): Promise<void> {
    this.entities.push(entity);
    this.placements.push(placement);
  }

  async archiveEntity(_customerId: string, entityId: string): Promise<void> {
    this.archived.push(entityId);
  }

  async preload(customerId: string, dimensions: Record<string, string>): Promise<void> {
    this.preloaded.push({ customerId, dimensions });
  }

  async check(_customerId: string, params: EngineCheckParams): Promise<EngineCheckResult> {
    this.checks += 1;
    if (this.options.failCheck) throw this.options.failCheck;
    const limit = this.options.usageLimit === undefined ? 3 : this.options.usageLimit;
    const granted = limit === null || this.currentUsage + params.requestedUsage <= limit;
    return {
      isGranted: granted,
      accessDeniedReason: granted ? null : 'BudgetExceeded',
      usageLimit: limit,
      currentUsage: this.currentUsage,
      chains:
        this.options.chains === false
          ? undefined
          : [
              [
                {
                  entityId: 'agent-1',
                  isGranted: granted,
                  usageLimit: limit,
                  currentUsage: this.currentUsage,
                  scopeEntityIds: [],
                },
              ],
            ],
      source: 'rest',
    };
  }

  async report(_customerId: string, params: EngineReportParams): Promise<EngineReportResult> {
    this.reports += 1;
    if (this.options.failReport) throw this.options.failReport;
    this.dimensionsSeen.push(params.dimensions);
    this.metricsSeen.push(params.metrics);

    // One report per metric, keyed per metric - the same shape both real engines send.
    let replayed = true;
    let spent = 0;
    for (const [featureId, value] of Object.entries(params.metrics)) {
      const key = `${params.idempotencyKey}:${featureId}`;
      if (this.seenKeys.has(key)) continue;
      this.seenKeys.add(key);
      replayed = false;
      spent += value;
    }
    if (!replayed) this.currentUsage += spent;

    // Async answers with nothing: no balance, and no way to tell a replay from a first delivery.
    if (params.mode === 'async') {
      return { reported: params.metrics, mode: 'async', source: 'node-sdk' };
    }
    return {
      reported: params.metrics,
      currentUsage: this.currentUsage,
      // Absent when the fake is told the features are not credit-backed, so the unmapped-feature
      // warning has a way to be exercised.
      creditsConsumed: this.options.creditBacked === false ? undefined : spent,
      replayed,
      mode: 'sync' as const,
      source: 'node-sdk',
    };
  }
}
