/**
 * The engine half that runs on the REST client: everything governance-only.
 *
 * Entities, assignments and the dimensions-aware check that returns `chains` exist only here -
 * the GraphQL SDK has no governance surface at all. This is the only file in the package that
 * imports `@stigg/typescript`, so the beta API's drift is contained to one file.
 */
import Stigg from '@stigg/typescript';
import { asEngineError, asGovernanceError, looksLikeGovernanceNotEnabled } from '../errors';
import { entitlementRef } from '../types';
import { AGENT_SDK_REST_HEADERS } from '../sdk-identity';
import { creditConsumption, creditResult, missingEventError, reportMetrics, usageEntries, usageResult } from './report';
import type { IngestMode, Metrics } from '../types';
import type {
  EngineCapabilities,
  EngineCheckParams,
  EngineCheckResult,
  EngineChainNode,
  EngineReportParams,
  EngineReportResult,
  EntityInput,
  EntityPlacement,
  GovernanceEngine,
} from './engine';

export type RestGovernanceEngineOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
};

/** The governance check endpoint is `/api/v1-beta/` and flagged experimental. */
export class RestGovernanceEngine implements GovernanceEngine {
  /**
   * `strictCheck: true`, and it only became true by deletion.
   *
   * This client holds no cache and never did - every check it serves is a live question to a
   * fail-closed API. What made the promise weak was a decision cache above it, and with that gone
   * there is no window in which two processes can each approve the same budget here. It
   * implements no `preload` for the same reason: there is nothing a round trip would fill.
   *
   * This is the path attributed governance checks take - per-agent budgets - which is exactly
   * where the stricter answer is worth a round trip per call.
   */
  readonly capabilities: EngineCapabilities = { strictCheck: true, chains: true, provisioning: true };

  private readonly client: Stigg;

  constructor(options: RestGovernanceEngineOptions) {
    this.client = new Stigg({
      apiKey: options.apiKey,
      // This client sends no Stigg identity of its own - only a generic user agent - so without
      // these the governance half of an agent-sdk process is unattributable. Attributed checks
      // go only here, which makes it the half worth being able to see.
      defaultHeaders: AGENT_SDK_REST_HEADERS,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      // A fail-closed 503 should reach the error policy quickly, not after two backoffs.
      timeout: options.timeoutMs ?? 3_000,
      maxRetries: 1,
    });
  }

  /** Is governance enabled for this account? A 403 here is an account state, not a failure. */
  async probe(): Promise<'enabled' | 'not-enabled'> {
    try {
      await this.client.v1Beta.entityTypes.list({ limit: 1 });
      return 'enabled';
    } catch (err) {
      if (looksLikeGovernanceNotEnabled(err)) return 'not-enabled';
      throw asEngineError('probe', err);
    }
  }

  /**
   * Upsert is idempotent, so this is safe to call on every sight of an agent. Placement is a
   * second call because `parentId` lives on the assignment, not the entity - the entity upsert
   * rejects it outright.
   */
  async upsertEntity(customerId: string, entity: EntityInput, placement?: EntityPlacement): Promise<void> {
    try {
      await this.client.v1Beta.customers.entities.upsert(customerId, {
        entities: [
          {
            id: entity.id,
            entityTypeId: entity.entityTypeId,
            ...(entity.displayName ? { displayName: entity.displayName } : {}),
            ...(entity.metadata ? { metadata: entity.metadata } : {}),
          },
        ],
      });

      if (!placement) return;
      const capability = entitlementRef(placement.entitlement);

      // `usageLimitOnCreate` seeds a budget without ever overwriting one. The server preserves
      // omitted fields on update, so the only question is whether this is an update - hence the
      // read. A budget raised by an admin between runs therefore survives the next provision.
      const budget = await this.resolveBudget(customerId, entity.id, capability, placement);

      await this.client.v1Beta.customers.assignments.upsert(customerId, {
        assignments: [
          {
            entityId: entity.id,
            ...capability,
            // Tri-state: omitted leaves the parent alone, null makes it a root, an id re-homes it.
            ...(placement.parentId === undefined ? {} : { parentId: placement.parentId }),
            ...budget,
          },
        ],
      });
    } catch (err) {
      throw asGovernanceError('provision', err);
    }
  }

  /**
   * The `usageLimit`/`cadence` half of an assignment upsert. `usageLimit` is sent as given;
   * `usageLimitOnCreate` is sent only when no assignment exists yet, because governance requires
   * both fields on create and preserves both when they are omitted on update.
   */
  private async resolveBudget(
    customerId: string,
    entityId: string,
    capability: { currencyId: string } | { featureId: string },
    placement: EntityPlacement,
  ): Promise<{ usageLimit?: number | null; cadence?: string }> {
    const cadence = placement.cadence ? { cadence: placement.cadence } : {};
    if (placement.usageLimit !== undefined) return { usageLimit: placement.usageLimit, ...cadence };
    if (placement.usageLimitOnCreate === undefined) return cadence;

    const existing = await this.client.v1Beta.customers.assignments.list(customerId, {
      entityId,
      ...capability,
      limit: 1,
    });
    // Already assigned: leave the limit and its window exactly as they are.
    if (existing.data.length > 0) return {};
    return { usageLimit: placement.usageLimitOnCreate, ...cadence };
  }

  async check(
    customerId: string,
    { entitlement, requestedUsage, dimensions }: EngineCheckParams,
  ): Promise<EngineCheckResult> {
    try {
      const response = await this.client.v1Beta.customers.entitlements.check(customerId, {
        ...entitlementRef(entitlement),
        requestedUsage,
        // One dimensions map does three jobs: resolves the entity, attributes usage up every
        // level of the tree, and selects any dimension-scoped sub-budget.
        dimensions,
      });

      const data = response.data;
      return {
        isGranted: data.isGranted,
        accessDeniedReason: data.accessDeniedReason,
        usageLimit: data.usageLimit ?? null,
        currentUsage: data.currentUsage,
        chains: data.chains?.map((chain): EngineChainNode[] =>
          chain.map((node) => ({
            entityId: node.entityId,
            isGranted: node.isGranted,
            usageLimit: node.usageLimit,
            currentUsage: node.currentUsage,
            scopeEntityIds: node.scopeEntityIds,
          })),
        ),
        source: 'rest',
      };
    } catch (err) {
      throw asEngineError('check', err);
    }
  }

  /** The four calls this client makes; `reportMetrics` decides which of them each metric is. */
  async report(customerId: string, params: EngineReportParams): Promise<EngineReportResult> {
    return reportMetrics(params, {
      credits: (featureId, value) => this.consumeCredits(customerId, params, featureId, value),
      creditsAsync: (featureId, value) => this.consumeCredits(customerId, params, featureId, value, 'async'),
      event: (metrics, dimensions) => this.reportAsEvent(customerId, params, metrics, dimensions),
      usage: (metrics) => this.reportUsage(customerId, params, metrics),
    });
  }

  /** The feature path: one bulk call, because a turn's metrics are otherwise four round trips. */
  private async reportUsage(customerId: string, params: EngineReportParams, metrics: Metrics) {
    const response = await this.client.v1.usage.report({
      // Explicit here and defaulted on the SDK: a report is a delta on this turn's own usage, not
      // the running total, which is the one place these two clients could be read as disagreeing.
      usages: usageEntries(customerId, params, metrics).map((usage) => ({ ...usage, updateBehavior: 'DELTA' })),
    });
    return usageResult(response.data ?? [], metrics, 'rest');
  }

  /** The credit path - no feature mapping. See the Node SDK engine's `consumeCredits`. */
  private async consumeCredits(
    customerId: string,
    params: EngineReportParams,
    featureId: string,
    value: number,
    mode: IngestMode = 'sync',
  ): Promise<EngineReportResult> {
    // The wallet's own id. A metric only reaches this path when it names the currency the run
    // checks, so the metric name and the currency are the same string.
    const consumption = creditConsumption(customerId, params, featureId, value);
    try {
      // Same consumption either way - the amount is ours to state, so a run reporting to its own
      // currency keeps an exact local budget in both modes. The async form just loses the balance.
      const response = mode === 'async' ? undefined : await this.client.v1.credits.consumption.consume(consumption);
      if (mode === 'async') await this.client.v1.credits.consumption.consumeAsync({ consumptions: [consumption] });
      return creditResult(featureId, value, response?.data.credit?.currentUsage, mode, 'rest');
    } catch (err) {
      throw asEngineError('ingest', err);
    }
  }

  private async reportAsEvent(
    customerId: string,
    params: EngineReportParams,
    metrics: Metrics,
    dimensions: Record<string, string | number | boolean>,
  ): Promise<EngineReportResult> {
    const event = params.event;
    if (!event) throw missingEventError();
    try {
      await this.client.v1.events.report({
        events: [
          {
            customerId,
            eventName: event.name,
            // The turn's own key: one event, so no per-feature suffix to keep them apart.
            idempotencyKey: params.idempotencyKey,
            dimensions,
          },
        ],
      });
      return { reported: metrics, mode: 'async', source: 'rest' };
    } catch (err) {
      throw asEngineError('ingest', err);
    }
  }

  async close(): Promise<void> {
    // Nothing held open - fetch-based, no background cache. Declared so the composite can close
    // every delegate without asking which kind it is.
  }

  async archiveEntity(customerId: string, entityId: string): Promise<void> {
    try {
      // Soft delete: still readable by id, and not leaf-gated - archive children yourself.
      await this.client.v1Beta.customers.entities.archive(customerId, { ids: [entityId] });
    } catch (err) {
      throw asGovernanceError('archive', err);
    }
  }
}
