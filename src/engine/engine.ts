/**
 * The engine seam. Deliberately narrow, so engine-specific caching behaviour cannot leak into the
 * public API and v1 can ship on the simplest client and swap later.
 *
 * Caching lives entirely behind this seam. Nothing above it caches a decision, so an engine is
 * free to hold as much state as it can keep correct - which is why `preload` is optional here and
 * `strictCheck` is per engine rather than a property of the SDK.
 */
import type { Entitlement, IngestMode, Metrics } from '../types';

/** Which client actually served an operation. Reported back so callers can see what ran. */
export type EngineOpSource = 'rest' | 'node-sdk' | 'unavailable';

export type EngineCapabilities = {
  /**
   * False when a check can be served from cached state. Two instances can then each approve a
   * decrement against a balance a sibling already spent, so the SDK promises the weaker semantics
   * rather than documenting hard limits as hard.
   *
   * True for the governance REST client, which holds no cache: every check it serves is a live
   * question to Stigg, and Stigg is fail-closed.
   */
  strictCheck: boolean;
  /** Whether checks carry per-entity governance chains. */
  chains: boolean;
  /** Whether entities and assignments can be written at all. */
  provisioning: boolean;
};

export type EngineChainNode = {
  entityId: string;
  isGranted: boolean;
  usageLimit: number | null;
  currentUsage: number;
  scopeEntityIds: string[];
};

export type EngineCheckResult = {
  isGranted: boolean;
  accessDeniedReason?: string | null;
  usageLimit?: number | null;
  currentUsage?: number;
  /** One chain per resolved dimension, root to leaf. Absent when governance is not in play. */
  chains?: EngineChainNode[][];
  isFallback?: boolean;
  /**
   * True when the engine reached this verdict itself rather than reading one off a response.
   * A separate axis from `isFallback`, which is about whether the state was live.
   */
  locallyDerived?: boolean;
  source: EngineOpSource;
};

export type EngineCheckParams = {
  /**
   * Required, and deliberately so: a run that names no entitlement never reaches here at all -
   * `RunHandle.check` answers it before the engine is consulted. Keeping it required is what makes
   * a future caller that tries to check against nothing a compile error at the seam, rather than an
   * allow invented inside a transport.
   */
  entitlement: Entitlement;
  requestedUsage: number;
  dimensions: Record<string, string>;
};

/**
 * How to report a raw-events meter, for features Stigg aggregates from events rather than from
 * values your app computes. The meter is matched by `name`, never by feature id.
 */
export type EventIngest = {
  /**
   * What the event is called. Every metric rides one event under its own dimension name, so a
   * meter picks its number with `aggregation.field` and this is only what its filter matches on.
   */
  name: string;
};

export type EngineReportParams = {
  /** One report per metric under `'sync'`; one event carrying all of them under `'async'`. */
  metrics: Metrics;
  /** Which of Stigg's ingest APIs to use. Chosen by the caller, never by a rejection. */
  mode: IngestMode;
  /** The vendor's own usage object, flattened to scalars. Rides an event; ignored by `'sync'`. */
  raw?: Record<string, string | number | boolean>;
  /**
   * What the run checks against, when it checks anything. A metric named after this credit currency
   * draws the wallet directly; every other metric is a feature, which Stigg converts on its own
   * side. Absent for a metering-only run, where there is no wallet and therefore nothing that is
   * not a feature.
   */
  entitlement?: Entitlement;
  dimensions: Record<string, string>;
  /**
   * Under `'sync'` each metric is keyed `${idempotencyKey}:${featureId}`, so they dedupe
   * independently. Under `'async'` the turn is one event and this key is the whole of it.
   */
  idempotencyKey: string;
  event?: EventIngest;
};

export type EngineReportResult = {
  /** What actually landed, by feature id. A metric missing here did not report. */
  reported: Metrics;
  /**
   * Credits this report drew, when Stigg answered with a credit balance. Absent means the
   * features reported are not credit-backed - so the budget the run checks will not drain.
   */
  creditsConsumed?: number;
  currentUsage?: number;
  /** Which API answered. `'async'` is eventually consistent and says nothing about the balance. */
  mode: IngestMode;
  /**
   * Every key had already been ingested - Stigg reported nothing consumed. Undefined under
   * `'async'`, whose empty response cannot tell a first delivery from a replay.
   */
  replayed?: boolean;
  source: EngineOpSource;
};

/** Where an entity sits in the tree and what it may spend. Placement rides the assignment. */
export type EntityPlacement = {
  parentId?: string | null;
  /**
   * Required: an assignment is written over `(entity x entitlement)`, so a placement with nothing to
   * write it against has nowhere to land. `register` refuses that case upstream, which is what keeps
   * this required rather than optional-and-guarded in every transport.
   */
  entitlement: Entitlement;
  /** Set the budget on every provision, overwriting whatever it was. */
  usageLimit?: number | null;
  /**
   * Set the budget only when the assignment does not exist yet. An existing one keeps its limit
   * and cadence, so a raise made in the dashboard survives the next run. Mutually exclusive with
   * `usageLimit` - it costs one extra read, which is why it is not the default.
   */
  usageLimitOnCreate?: number;
  cadence?: string;
};

export type EntityInput = {
  id: string;
  entityTypeId: string;
  displayName?: string;
  metadata?: Record<string, string>;
};

export interface GovernanceEngine {
  readonly capabilities: EngineCapabilities;
  upsertEntity(customerId: string, entity: EntityInput, placement?: EntityPlacement): Promise<void>;
  check(customerId: string, params: EngineCheckParams): Promise<EngineCheckResult>;
  report(customerId: string, params: EngineReportParams): Promise<EngineReportResult>;
  archiveEntity(customerId: string, entityId: string): Promise<void>;
  /**
   * Loads whatever state this engine caches for a customer, so the checks that follow are local.
   *
   * Optional, and absent is not a failure: an engine that caches nothing has nothing to warm, and
   * the caller treats that as a no-op. `dimensions` is passed so a router can warm the engine that
   * would actually serve this check rather than whichever one happens to hold a cache.
   */
  preload?(customerId: string, dimensions: Record<string, string>): Promise<void>;
  /** Releases whatever the engine holds open (background caches, sockets). */
  close?(): Promise<void>;
}

/** Which client serves each operation, and why. Returned by the factory as "the used solution". */
export type EngineResolution = {
  mode: 'governance' | 'customer-level';
  ops: {
    upsertEntity: EngineOpSource;
    check: EngineOpSource;
    /** Serves a check carrying no attribution, where there is no chain to lose. */
    unattributedCheck?: EngineOpSource;
    report: EngineOpSource;
    archiveEntity: EngineOpSource;
  };
  reason: string;
};

export const describeResolution = (resolution: EngineResolution): string => {
  const { ops } = resolution;
  // Only worth saying when the two differ; in customer-level mode one client serves both.
  const unattributed =
    ops.unattributedCheck && ops.unattributedCheck !== ops.check ? ` (${ops.unattributedCheck} when unattributed)` : '';
  return (
    `mode=${resolution.mode} check=${ops.check}${unattributed} report=${ops.report} ` +
    `provisioning=${ops.upsertEntity} (${resolution.reason})`
  );
};
