/**
 * Offline stand-in for the Stigg REST API, so the whole governance lifecycle runs with no
 * account and no keys.
 *
 * It implements the parts the SDK actually calls - entity types, entities, assignments, the
 * dimensions-aware check, usage ingest, credit grants - with a real hierarchy and real budgets,
 * so a caller can genuinely hit a denial and see which entity caused it. Only the storage is fake.
 *
 * Shared by the examples and the test suite, which is why its state is per server rather than
 * per module: two servers in one process must not see each other's entities. The tests assert
 * against `mock.state` directly, so this is also the recording of what the SDK actually sent.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockStiggServer = {
  baseUrl: string;
  close: () => Promise<void>;
  /** Everything the server has been told, for assertions. */
  state: MockState;
  /** Answer the governance surface with 403 GovernanceNotEnabled, as an account without it does. */
  governance: boolean;
  /** Answer the governance check with 503, to exercise the fail-closed path. */
  failChecks: boolean;
  /**
   * Fail every customer provisioning: `'unreachable'` answers 503, as an outage does, and
   * `'rejected'` answers an API error, as an unknown plan or a key that cannot write does.
   */
  failProvisioning: false | 'unreachable' | 'rejected';
  /**
   * The subscription decision a provisioning answers with. `REQUESTED_PLAN` by default - set it to
   * show a server that put the customer somewhere other than the plan they asked for.
   */
  provisionDecision: string;
  /**
   * Answer a check for a customer nothing has created with `CustomerNotFound`, as a real account
   * does. Off by default: the rest of the suite checks customers it never seeds, and reads them as
   * an empty pool.
   */
  strictCustomers: boolean;
};

export type MockOptions = { governance?: boolean; failChecks?: boolean };

type EntityType = { id: string; attributionKeys: string[]; displayName: string };
type Entity = { id: string; entityTypeId: string; displayName?: string; archivedAt?: string };
type Assignment = {
  entityId: string;
  capabilityId: string;
  usageLimit: number | null;
  cadence: string;
  parentId: string | null;
};

type CustomerState = {
  entities: Map<string, Entity>;
  assignments: Map<string, Assignment>;
  usageByEntity: Map<string, number>;
  pool: { usageLimit: number; currentUsage: number };
  seenKeys: Set<string>;
};

/**
 * A raw-events meter: which events it reads, and what number it takes from each one.
 *
 * This is the piece that lives in Stigg rather than in the SDK, and modelling it is what keeps the
 * offline examples honest. One event feeds every meter whose filter it passes, so a turn reporting
 * four counters under one name drives four features - which is why the async path sends one event
 * rather than one per metric.
 */
export type EventMeter = {
  eventName: string;
  /** The feature this meter fills. */
  featureId: string;
  aggregation: { function: 'SUM' | 'COUNT' | 'MAX' | 'UNIQUE'; field?: string };
  /** Conditions on the event's dimensions, ANDed. Omitted means every event of that name. */
  conditions?: { field: string; value: string | number | boolean }[];
};

/** One server's whole world. Per instance, so two servers in one process stay independent. */
export type MockState = {
  entityTypes: Map<string, EntityType>;
  customers: Map<string, CustomerState>;
  /** Every attribution map that reached an ingest, in order. */
  dimensionsSeen: Record<string, string>[];
  /**
   * The write log, as opposed to the stored result. An upsert is idempotent, so the store cannot
   * tell one write from three - and "the SDK did not repeat this write" is exactly what several
   * callers need to know.
   */
  /**
   * What a unit of each feature costs in credits, as a plan's consumption mapping would say.
   * A feature with no rate here is not credit-backed: its usage is recorded and the wallet does
   * not move - which is exactly the case the SDK warns about.
   */
  creditRates: Map<string, number>;
  /**
   * The currency ids this account knows, so a metric naming one is spent at par while every
   * other metric is a feature priced by `creditRates`. Derived from grants rather than from
   * assignments, which carry feature ids too.
   */
  currencies: Set<string>;
  /** The raw feature counters, recorded truthfully whether or not they convert to credits. */
  usageByFeature: Map<string, number>;
  /**
   * The raw-events meters this environment has configured. Without one, an event is accepted and
   * meters nothing - which is exactly what Stigg does, and the failure the SDK warns about.
   */
  eventMeters: EventMeter[];
  /** Per-meter state for the aggregations that are not a running sum. */
  eventAggregates: Map<string, { max: number; unique: Set<string> }>;
  entityWrites: Entity[];
  assignmentWrites: Assignment[];
  archived: string[];
  /**
   * Every provisioning the SDK asked for, in order - including the ones refused as duplicates. The
   * write log for customers: it is what shows a repeated attempt, which the store cannot.
   */
  provisionAttempts: string[];
  /** Every subscription a customer was actually provisioned with, in order. */
  subscriptionWrites: { customerId: string; planId: string }[];
};

const newState = (): MockState => ({
  entityTypes: new Map(),
  customers: new Map(),
  eventMeters: [],
  eventAggregates: new Map(),
  dimensionsSeen: [],
  creditRates: new Map(),
  currencies: new Set(['credits']),
  usageByFeature: new Map(),
  entityWrites: [],
  assignmentWrites: [],
  archived: [],
  provisionAttempts: [],
  subscriptionWrites: [],
});

const customer = (mock: MockState, id: string): CustomerState => {
  let state = mock.customers.get(id);
  if (!state) {
    state = {
      entities: new Map(),
      assignments: new Map(),
      usageByEntity: new Map(),
      pool: { usageLimit: 0, currentUsage: 0 },
      seenKeys: new Set(),
    };
    mock.customers.set(id, state);
  }
  return state;
};

/** The entities a customer holds, in insertion order - what `register` wrote. */
export const entitiesOf = (mock: MockState, customerId: string): Entity[] => [
  ...(mock.customers.get(customerId)?.entities.values() ?? []),
];

/** The assignments a customer holds - the budgets, which is where placement lives. */
export const assignmentsOf = (mock: MockState, customerId: string): Assignment[] => [
  ...(mock.customers.get(customerId)?.assignments.values() ?? []),
];

// ----------------------------------------------------------------------------------------
// Seeding. Writes state directly rather than over HTTP, so the write log stays a record of
// what the SDK itself did - the account's own setup is not part of that.
// ----------------------------------------------------------------------------------------

/** Declares the types whose attribution keys the check resolves entities by. */
export function seedEntityTypes(mock: MockState, types: EntityType[]): void {
  for (const type of types) mock.entityTypes.set(type.id, type);
}

/**
 * What a unit of `featureId` costs in credits - the mock's stand-in for a plan's consumption
 * mapping. Seed it and reporting that feature drains the wallet; leave it out and the feature is
 * metered but nothing is spent, which is the silent failure the SDK exists to warn about.
 */
export function seedCreditRate(mock: MockState, featureId: string, creditsPerUnit: number): void {
  mock.creditRates.set(featureId, creditsPerUnit);
}

/**
 * Configures a raw-events meter, the way an account would in Stigg before reporting events.
 *
 * Nothing aggregates without one: events are accepted, 200 comes back, and the budget never moves.
 * Seeding it here is what lets a test prove the async path denies rather than only that it posts.
 */
export function seedEventMeter(mock: MockState, meter: EventMeter): void {
  mock.eventMeters.push(meter);
}

/** Funds the customer's credit pool. Without this every check denies with InsufficientCredits. */
export function fundPool(mock: MockState, customerId: string, usageLimit: number, currencyId = 'credits'): void {
  customer(mock, customerId).pool.usageLimit = usageLimit;
  mock.currencies.add(currencyId);
}

/** An entity with a budget already in place, as an account provisioned out of band would have. */
export function seedBudget(
  mock: MockState,
  customerId: string,
  input: {
    entityId: string;
    entityTypeId?: string;
    capabilityId: string;
    usageLimit: number | null;
    cadence?: string;
    parentId?: string | null;
  },
): void {
  const state = customer(mock, customerId);
  state.entities.set(input.entityId, { id: input.entityId, entityTypeId: input.entityTypeId ?? 'agent' });
  state.assignments.set(assignmentKey(input.entityId, input.capabilityId), {
    entityId: input.entityId,
    capabilityId: input.capabilityId,
    usageLimit: input.usageLimit,
    cadence: input.cadence ?? 'P1M',
    parentId: input.parentId ?? null,
  });
}

const assignmentKey = (entityId: string, capabilityId: string) => `${entityId}::${capabilityId}`;
const isTruthy = (value: string | undefined) => ['1', 'true', 'yes'].includes((value ?? '').toLowerCase());

// ----------------------------------------------------------------------------------------
// Attribution: dimensions -> entity -> its chain to the root
// ----------------------------------------------------------------------------------------

/**
 * The entity a request attributes to. Several dimensions can match at once - a request usually
 * carries both the agent and its team - and the subject is the deepest of them, because the
 * shallower ones are already on its chain.
 */
function resolveEntity(
  mock: MockState,
  state: CustomerState,
  dimensions: Record<string, string>,
  capabilityId: string,
): Entity | undefined {
  const candidates: Entity[] = [];
  for (const type of mock.entityTypes.values()) {
    for (const key of type.attributionKeys) {
      const value = dimensions[key];
      const entity = value ? state.entities.get(value) : undefined;
      if (entity && !entity.archivedAt) candidates.push(entity);
    }
  }
  return candidates.sort((a, b) => chainOf(state, b, capabilityId).length - chainOf(state, a, capabilityId).length)[0];
}

/** Root -> leaf, following parentId off the assignments, which is where placement lives. */
function chainOf(state: CustomerState, leaf: Entity, capabilityId: string): Entity[] {
  const chain: Entity[] = [];
  let current: Entity | undefined = leaf;
  const guard = new Set<string>();

  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    chain.unshift(current);
    const parentId: string | null | undefined = state.assignments.get(
      assignmentKey(current.id, capabilityId),
    )?.parentId;
    current = parentId ? state.entities.get(parentId) : undefined;
  }
  return chain;
}

function chainNodes(state: CustomerState, chain: Entity[], capabilityId: string, requested: number) {
  return chain
    .map((entity) => ({ entity, assignment: state.assignments.get(assignmentKey(entity.id, capabilityId)) }))
    .filter((pair): pair is { entity: Entity; assignment: Assignment } => Boolean(pair.assignment))
    .map(({ entity, assignment }) => {
      const currentUsage = state.usageByEntity.get(entity.id) ?? 0;
      return {
        entityId: entity.id,
        // A null limit counts usage but never blocks - the observe-only rollout.
        isGranted: assignment.usageLimit === null || currentUsage + requested <= assignment.usageLimit,
        usageLimit: assignment.usageLimit,
        currentUsage,
        scopeEntityIds: [] as string[],
      };
    });
}

// ----------------------------------------------------------------------------------------
// Request plumbing
// ----------------------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** Accepts both the bracket form the SDK serializes (`dimensions[agentId]=x`) and raw JSON. */
function readDimensions(query: URLSearchParams): Record<string, string> {
  const dimensions: Record<string, string> = {};
  for (const [key, value] of query.entries()) {
    const bracket = /^dimensions\[(.+)\]$/.exec(key);
    if (bracket) dimensions[bracket[1]!] = value;
    else if (key === 'dimensions') {
      try {
        Object.assign(dimensions, JSON.parse(value));
      } catch {
        // A malformed value simply attributes to nothing, same as the real API.
      }
    }
  }
  return dimensions;
}

const capabilityOf = (query: URLSearchParams) => query.get('currencyId') ?? query.get('featureId') ?? '';

// ----------------------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------------------

function checkResponse(mock: MockState, customerId: string, query: URLSearchParams) {
  const state = customer(mock, customerId);
  const capabilityId = capabilityOf(query);
  const requested = Number(query.get('requestedUsage') ?? 1);
  const dimensions = readDimensions(query);

  const leaf = resolveEntity(mock, state, dimensions, capabilityId);
  const nodes = leaf ? chainNodes(state, chainOf(state, leaf, capabilityId), capabilityId, requested) : [];

  // Only a credit check is drawn from the wallet. A feature is entitled by a subscription and
  // capped by its assignment, so gating one on the pool denied every feature-mode run offline -
  // the pool is funded for credit entitlements and stays at zero otherwise.
  const isCredit = query.get('currencyId') !== null;
  const poolGranted = !isCredit || state.pool.currentUsage + requested <= state.pool.usageLimit;
  const chainGranted = nodes.every((node) => node.isGranted);
  const isGranted = poolGranted && chainGranted;

  return {
    data: {
      type: query.get('currencyId') ? 'CREDIT' : 'FEATURE',
      isGranted,
      // The pool running dry and an admin-set cap are different products - keep them distinct.
      accessDeniedReason: isGranted ? null : !poolGranted ? 'InsufficientCredits' : 'BudgetExceeded',
      ...(query.get('currencyId') ? { currency: { currencyId: capabilityId, displayName: capabilityId } } : {}),
      usageLimit: state.pool.usageLimit,
      currentUsage: state.pool.currentUsage,
      usageUpdatedAt: new Date().toISOString(),
      ...(leaf ? { chains: [nodes] } : {}),
    },
  };
}

/**
 * The write half, shared by both ingest routes: Stigg meters features and credits through
 * different endpoints, but the pool arithmetic and the chain roll-up behind them are the same.
 */
function applyUsage(
  mock: MockState,
  customerId: string,
  capabilityId: string,
  value: number,
  key: string | undefined,
  dimensions: any,
  // The usage report's DTO takes whole units - `POST /api/v1/usage` answers
  // `400 Expected integer, received float`. Nothing else does: a meter reading a dimension off an
  // event sums what it finds, and the credit wallet accepts a fractional `amount` outright.
  integerOnly = true,
) {
  const state = customer(mock, customerId);
  mock.dimensionsSeen.push(dimensions ?? {});
  if (integerOnly && !Number.isInteger(value)) {
    throw Object.assign(new Error('value must be a whole number'), { status: 400 });
  }

  // Keyed per capability: one call reports several metrics under one key, and they must dedupe
  // against their own earlier report rather than against each other.
  const seen = key === undefined || key === '' ? undefined : `${capabilityId}::${key}`;
  const replayed = seen !== undefined && state.seenKeys.has(seen);
  // A currency is spent at par; a feature is spent at whatever the plan says a unit costs, and
  // a feature with no rate spends nothing at all.
  const isCurrency = mock.currencies.has(capabilityId);
  const rate = isCurrency ? 1 : mock.creditRates.get(capabilityId);
  const credits = rate === undefined ? 0 : Math.round(value * rate * 1e4) / 1e4;

  if (!replayed) {
    if (seen) state.seenKeys.add(seen);
    // The feature counter is the truth about what was metered, rate or no rate.
    mock.usageByFeature.set(capabilityId, (mock.usageByFeature.get(capabilityId) ?? 0) + value);
    state.pool.currentUsage = Math.round((state.pool.currentUsage + credits) * 1e4) / 1e4;
    const leaf = resolveEntity(mock, state, dimensions ?? {}, capabilityId);
    // Usage rolls up the whole chain at once - that is what one dimensions map buys.
    if (leaf) {
      for (const entity of chainOf(state, leaf, capabilityId)) {
        const spent = (state.usageByEntity.get(entity.id) ?? 0) + credits;
        state.usageByEntity.set(entity.id, Math.round(spent * 1e4) / 1e4);
      }
    }
  }
  return { state, replayed, credits, creditBacked: rate !== undefined };
}

/**
 * One event, every meter that matches it.
 *
 * This is the whole of what Stigg does on the other side of `events.report`, reduced to the part
 * the SDK's behaviour depends on: an event is matched by name and by its dimensions, each matching
 * meter takes one number out of it, and that number becomes usage for that meter's feature. The
 * fan-out is the reason the async path sends one event for a whole turn - four counters under one
 * name feed four features without four requests.
 *
 * Deduplication is per event rather than per feature: one event now stands for the whole turn, so
 * two meters fed by it must not collide on one key.
 */
function reportEvents(mock: MockState, events: any[]): void {
  for (const event of events ?? []) {
    const state = customer(mock, event.customerId);
    const key = event.idempotencyKey ? `event::${event.idempotencyKey}` : undefined;
    if (key && state.seenKeys.has(key)) continue;
    if (key) state.seenKeys.add(key);

    const dimensions = event.dimensions ?? {};
    for (const meter of mock.eventMeters) {
      if (meter.eventName !== event.eventName) continue;
      if (meter.conditions?.some((condition) => dimensions[condition.field] !== condition.value)) continue;
      const value = meteredValue(mock, meter, dimensions);
      if (value <= 0) continue;
      // No key: the event deduped already, and the meter's own write is not separately replayable.
      applyUsage(mock, event.customerId, meter.featureId, value, undefined, dimensions, false);
    }
  }
}

/** What one meter takes from one event - a running sum, a count, or the increase in a high-water mark. */
function meteredValue(mock: MockState, meter: EventMeter, dimensions: Record<string, any>): number {
  const field = meter.aggregation.field;
  const raw = field ? Number(dimensions[field]) : 0;
  const id = `${meter.eventName}::${meter.featureId}::${meter.aggregation.function}::${field ?? ''}`;
  const seen = mock.eventAggregates.get(id) ?? { max: 0, unique: new Set<string>() };
  mock.eventAggregates.set(id, seen);

  switch (meter.aggregation.function) {
    case 'COUNT':
      return 1;
    case 'MAX': {
      if (!Number.isFinite(raw) || raw <= seen.max) return 0;
      // A MAX meter's usage is the new peak, so only the increase is new spend.
      const increase = raw - seen.max;
      seen.max = raw;
      return increase;
    }
    case 'UNIQUE': {
      const value = field ? String(dimensions[field]) : '';
      if (!value || seen.unique.has(value)) return 0;
      seen.unique.add(value);
      return 1;
    }
    default:
      return Number.isFinite(raw) ? raw : 0;
  }
}

function reportUsage(mock: MockState, body: any) {
  const results = (body.usages ?? []).map((usage: any) => {
    const capabilityId = usage.featureId;
    const value = usage.value;
    const { state, replayed, credits, creditBacked } = applyUsage(
      mock,
      usage.customerId,
      capabilityId,
      value,
      usage.idempotencyKey,
      usage.dimensions,
    );

    return {
      id: `meas_${Math.random().toString(16).slice(2, 10)}`,
      customerId: usage.customerId,
      featureId: capabilityId,
      value,
      timestamp: new Date().toISOString(),
      currentUsage: state.pool.currentUsage,
      // Null when the feature converts to nothing, exactly as a real account answers for a
      // feature with no consumption mapping. That absence is what the SDK warns on.
      credit: creditBacked
        ? {
            currencyId: [...mock.currencies][0] ?? 'credits',
            consumed: replayed ? 0 : credits,
            currentUsage: state.pool.currentUsage,
            usageLimit: state.pool.usageLimit,
          }
        : null,
    };
  });
  return { data: results };
}

function governanceTree(mock: MockState, customerId: string, query: URLSearchParams) {
  const state = customer(mock, customerId);
  const wanted = [...query.getAll('featureIds'), ...query.getAll('currencyIds')];
  const rows = [...state.assignments.values()]
    .filter((assignment) => wanted.length === 0 || wanted.includes(assignment.capabilityId))
    .map((assignment) => {
      const currentUsage = state.usageByEntity.get(assignment.entityId) ?? 0;
      return {
        entityId: assignment.entityId,
        entityTypeId: state.entities.get(assignment.entityId)?.entityTypeId ?? '',
        displayName: state.entities.get(assignment.entityId)?.displayName ?? assignment.entityId,
        parentId: assignment.parentId,
        usageLimit: assignment.usageLimit,
        currentUsage,
        utilization: assignment.usageLimit ? currentUsage / assignment.usageLimit : 0,
        cadence: assignment.cadence,
        scopeEntityIds: [],
        currencyId: assignment.capabilityId,
      };
    });
  return { data: rows, pagination: {} };
}

/**
 * The GraphQL half, for the Node server SDK.
 *
 * Only the three operations that SDK actually sends. It is here rather than in a second mock
 * because the two transports share one world: an ingest through GraphQL has to be visible to a
 * check through REST, which is the whole point of the composite engine.
 *
 * Note it never fails: a 404 here does not surface as an error, because the SDK answers from its
 * own fallback entitlement instead - so a missing route would read as "denied", not "broken".
 */
function graphql(mock: MockState, body: any, provisionDecision = 'REQUESTED_PLAN'): unknown {
  // Before the lookup below, which creates whatever customer a request names: provisioning is the
  // one operation whose answer depends on the customer not existing yet.
  if (body.operationName === 'ProvisionCustomer') {
    const { refId, subscriptionParams } = body.variables.input;
    // Stigg refuses the whole mutation for a customer it has - subscription included - which is
    // what leaves an existing customer on the plan they were already on.
    if (mock.customers.has(refId)) {
      return {
        data: null,
        errors: [{ message: 'customer already exists', extensions: { code: 'DuplicatedEntityNotAllowed' } }],
      };
    }
    customer(mock, refId);
    const requested = provisionDecision;
    const planId = requested === 'REQUESTED_PLAN' ? subscriptionParams?.planId : 'plan-predefined';
    if (planId) mock.subscriptionWrites.push({ customerId: refId, planId });
    const now = new Date().toISOString();
    // Every field the mutation selects, even as null: Apollo logs each one a response leaves out.
    const slimCustomer = {
      __typename: 'Customer',
      id: refId,
      refId,
      customerId: refId,
      name: null,
      email: null,
      billingId: null,
      additionalMetaData: null,
      awsMarketplaceCustomerId: null,
      createdAt: now,
      updatedAt: now,
    };
    return {
      data: {
        provisionCustomer: {
          __typename: 'ProvisionedCustomer',
          customer: slimCustomer,
          subscriptionDecisionStrategy: requested,
          subscription: planId
            ? {
                __typename: 'CustomerSubscription',
                id: `sub_${mock.subscriptionWrites.length}`,
                refId: `sub_${mock.subscriptionWrites.length}`,
                subscriptionId: `sub_${mock.subscriptionWrites.length}`,
                status: 'ACTIVE',
                additionalMetaData: null,
                billingId: null,
                billingLinkUrl: null,
                effectiveEndDate: null,
                cancellationDate: null,
                currentBillingPeriodEnd: null,
                pricingType: 'FREE',
                latestInvoice: null,
                paymentCollection: 'NOT_REQUIRED',
                billingSyncError: null,
                resource: null,
                experimentInfo: null,
                prices: [],
                totalPrice: null,
                addons: [],
                plan: { __typename: 'Plan', id: planId, refId: planId },
                customer: { __typename: 'Customer', id: refId, refId },
              }
            : null,
          entitlements: [],
          entitlementsV2: [],
        },
      },
    };
  }

  const state = customer(mock, body.variables?.query?.customerId ?? body.variables?.input?.customerId ?? '');

  switch (body.operationName) {
    case 'GetSdkConfiguration':
      return {
        data: {
          sdkConfiguration: {
            sentryDsn: null,
            isWidgetWatermarkEnabled: false,
            showWatermark: false,
            __typename: 'SdkConfiguration',
          },
        },
      };

    case 'GetEntitlementsState':
      return {
        data: {
          entitlementsState: {
            __typename: 'EntitlementsState',
            accessDeniedReason: null,
            entitlements: [],
            // The customer-level view: the pool, with no chain. Exactly what the Node SDK can
            // see, and why an account without governance gets no `deniedBy`.
            entitlementsV2: [...creditCurrencies(mock)].map((currencyId) => ({
              __typename: 'CreditEntitlement',
              isGranted: state.pool.currentUsage < state.pool.usageLimit,
              accessDeniedReason: null,
              currency: {
                currencyId,
                displayName: currencyId,
                description: null,
                unitSingular: 'credit',
                unitPlural: 'credits',
                additionalMetaData: null,
              },
              usageLimit: state.pool.usageLimit,
              currentUsage: state.pool.currentUsage,
              hasSoftLimit: false,
              usageUpdatedAt: new Date().toISOString(),
              entitlementUpdatedAt: new Date().toISOString(),
              usagePeriodEnd: null,
              validUntil: null,
            })),
          },
        },
      };

    case 'ReportUsageBulk': {
      // The node SDK's bulk path. Same arithmetic as the REST one, so a metric costs the same
      // whichever transport carried it.
      const usages = body.variables?.input?.usages ?? [];
      return {
        data: {
          reportUsageBulk: usages.map((usage: any) => {
            const { state, replayed, credits, creditBacked } = applyUsage(
              mock,
              usage.customerId,
              usage.featureId,
              Number(usage.value),
              usage.idempotencyKey,
              usage.dimensions,
            );
            return {
              __typename: 'UsageMeasurementWithCurrentUsage',
              id: `meas_${Math.random().toString(16).slice(2, 10)}`,
              featureId: usage.featureId,
              customerId: usage.customerId,
              resourceId: null,
              currentUsage: state.pool.currentUsage,
              // Null when nothing converts it, which is what the SDK warns on.
              credit: creditBacked
                ? {
                    __typename: 'Credit',
                    currencyId: [...mock.currencies][0] ?? 'credits',
                    currentUsage: state.pool.currentUsage,
                    usagePeriodEnd: null,
                    timestamp: new Date().toISOString(),
                    consumed: replayed ? 0 : credits,
                  }
                : null,
            };
          }),
        },
      };
    }

    case 'ConsumeCredits': {
      const input = body.variables.input;
      const { state: after } = applyUsage(
        mock,
        input.customerId,
        input.currencyId,
        Number(input.amount),
        input.idempotencyKey,
        input.dimensions,
        // The wallet takes fractions - verified against the API, which answers 200 to a
        // fractional `amount` and reports a fractional balance back.
        false,
      );
      return {
        data: {
          consumeCredits: {
            __typename: 'CreditConsumptionResponse',
            customerId: input.customerId,
            currencyId: input.currencyId,
            resourceId: null,
            amount: input.amount,
            timestamp: new Date().toISOString(),
            credit: {
              __typename: 'Credit',
              currencyId: input.currencyId,
              currentUsage: after.pool.currentUsage,
              usageLimit: after.pool.usageLimit,
              usagePeriodEnd: null,
              timestamp: new Date().toISOString(),
            },
          },
        },
      };
    }

    case 'ReportEvent':
      // The GraphQL input nests the batch under `usageEvents`; REST sends `events`. Same events.
      reportEvents(mock, body.variables.input?.usageEvents ?? body.variables.input?.events ?? []);
      return { data: { reportEvent: null } };

    case 'ConsumeCreditsAsync': {
      for (const consumption of body.variables.input?.consumptions ?? []) {
        applyUsage(
          mock,
          consumption.customerId,
          consumption.currencyId,
          Number(consumption.amount),
          consumption.idempotencyKey,
          consumption.dimensions,
          // The wallet takes fractions; only the usage report is integer-only.
          false,
        );
      }
      return { data: { consumeCreditsAsync: true } };
    }

    default:
      return { data: {} };
  }
}

/** Every currency the server has heard of - from an assignment, or from a grant. */
function creditCurrencies(mock: MockState): Set<string> {
  const ids = new Set<string>();
  for (const state of mock.customers.values()) {
    for (const assignment of state.assignments.values()) ids.add(assignment.capabilityId);
  }
  if (ids.size === 0) ids.add('credits');
  return ids;
}

function route(server: MockStiggServer, req: IncomingMessage, res: ServerResponse, body: any): void {
  const mock = server.state;
  const url = new URL(req.url ?? '/', 'http://mock');
  const path = url.pathname;
  const query = url.searchParams;
  const method = req.method ?? 'GET';

  if (path === '/graphql') {
    if (body.operationName === 'ProvisionCustomer') {
      // Logged here, ahead of the failure modes: a refused or unanswered attempt is still one the
      // SDK made, and counting it is how a test sees whether the SDK retried.
      mock.provisionAttempts.push(body.variables.input.refId);
      if (server.failProvisioning === 'unreachable') {
        send(res, 503, { code: 'ServiceUnavailable', message: 'service unavailable' });
        return;
      }
      if (server.failProvisioning === 'rejected') {
        send(res, 200, { data: null, errors: [{ message: 'plan not found', extensions: { code: 'PlanNotFound' } }] });
        return;
      }
    }
    const unknown = body.variables?.query?.customerId;
    if (server.strictCustomers && body.operationName === 'GetEntitlementsState' && !mock.customers.has(unknown)) {
      send(res, 200, {
        data: {
          entitlementsState: {
            __typename: 'EntitlementsState',
            accessDeniedReason: 'CustomerNotFound',
            entitlements: [],
            entitlementsV2: [],
          },
        },
      });
      return;
    }
    send(res, 200, graphql(mock, body, server.provisionDecision));
    return;
  }

  // Lets a caller demonstrate the fail-closed path and the error policy that answers it. Only
  // the runtime gate fails: the seed reads the pool through the v1 check and must still work.
  if (
    (server.failChecks || isTruthy(process.env.AGENT_SDK_DEMO_MOCK_GOVERNANCE_FAIL)) &&
    path === `/api/v1-beta/customers/${path.split('/')[4]}/entitlements/check`
  ) {
    send(res, 503, { code: 'GovernanceCacheUnavailable', message: 'governance cache unavailable' });
    return;
  }

  // An account without governance. It gates the governance surface only - the entitlements check
  // still answers, because gating access is not a governance feature. The probe is how the SDK
  // finds out, so turning this off here is what exercises the customer-level engine.
  if (!server.governance && path.startsWith('/api/v1-beta/') && !path.endsWith('/entitlements/check')) {
    send(res, 403, { code: 'GovernanceNotEnabled', message: 'governance is not enabled for this account' });
    return;
  }

  if (path === '/api/v1-beta/entity-types') {
    if (method === 'PUT') {
      for (const type of body.types ?? []) mock.entityTypes.set(type.id, type);
      send(res, 200, { data: [...mock.entityTypes.values()] });
      return;
    }
    send(res, 200, { data: [...mock.entityTypes.values()], pagination: {} });
    return;
  }

  const betaCustomer = /^\/api\/v1-beta\/customers\/([^/]+)(\/.*)?$/.exec(path);
  if (betaCustomer) {
    const customerId = decodeURIComponent(betaCustomer[1]!);
    const rest = betaCustomer[2] ?? '';
    const state = customer(mock, customerId);

    if (rest === '/entities' && method === 'PUT') {
      for (const entity of body.entities ?? []) {
        const existing = state.entities.get(entity.id);
        state.entities.set(entity.id, { ...existing, ...entity, archivedAt: undefined });
        mock.entityWrites.push(entity);
      }
      send(res, 200, { data: [...state.entities.values()] });
      return;
    }
    if (rest === '/entities/archive' && method === 'POST') {
      for (const id of body.ids ?? []) {
        const entity = state.entities.get(id);
        if (entity) entity.archivedAt = new Date().toISOString();
        mock.archived.push(id);
      }
      send(res, 200, { data: { ids: body.ids ?? [] } });
      return;
    }
    // `usageLimitOnCreate` asks whether an assignment exists before deciding to write one.
    if (rest === '/assignments' && method === 'GET') {
      const entityId = query.get('entityId');
      const capabilityId = capabilityOf(query);
      const matches = [...state.assignments.values()].filter(
        (assignment) =>
          (!entityId || assignment.entityId === entityId) &&
          (!capabilityId || assignment.capabilityId === capabilityId),
      );
      send(res, 200, { data: matches, pagination: {} });
      return;
    }
    if (rest === '/assignments' && method === 'PUT') {
      for (const input of body.assignments ?? []) {
        const capabilityId = input.currencyId ?? input.featureId;
        const key = assignmentKey(input.entityId, capabilityId);
        const existing = state.assignments.get(key);
        const written: Assignment = {
          entityId: input.entityId,
          capabilityId,
          // Omitted fields are preserved on update, required on create - as the real API does.
          usageLimit: input.usageLimit === undefined ? (existing?.usageLimit ?? null) : input.usageLimit,
          cadence: input.cadence ?? existing?.cadence ?? 'P1M',
          parentId: input.parentId === undefined ? (existing?.parentId ?? null) : input.parentId,
        };
        state.assignments.set(key, written);
        mock.assignmentWrites.push(written);
      }
      send(res, 200, { data: [...state.assignments.values()] });
      return;
    }
    if (rest === '/entitlements/check') {
      send(res, 200, checkResponse(mock, customerId, query));
      return;
    }
    if (rest === '/governance') {
      send(res, 200, governanceTree(mock, customerId, query));
      return;
    }
  }

  const v1Customer = /^\/api\/v1\/customers\/([^/]+)(\/.*)?$/.exec(path);
  if (v1Customer) {
    const customerId = decodeURIComponent(v1Customer[1]!);
    const rest = v1Customer[2] ?? '';
    if (rest === '/entitlements/check') {
      // The customer-level check: same pool arithmetic, no chains.
      const response = checkResponse(mock, customerId, query) as any;
      delete response.data.chains;
      send(res, 200, response);
      return;
    }
    if (rest === '') {
      customer(mock, customerId);
      send(res, 200, { data: { id: customerId, name: customerId, createdAt: new Date().toISOString() } });
      return;
    }
  }

  if (path === '/api/v1/usage' && method === 'POST') {
    try {
      send(res, 200, reportUsage(mock, body));
    } catch (err) {
      send(res, (err as { status?: number }).status ?? 500, { code: 'BadRequest', message: (err as Error).message });
    }
    return;
  }

  if (path === '/api/v1/events' && method === 'POST') {
    reportEvents(mock, body.events ?? []);
    // Empty on purpose: the event API confirms receipt and nothing else. A balance here would let
    // a test pass that production could not.
    send(res, 200, { data: {} });
    return;
  }

  // The async wallet draw. Same arithmetic as the sync route above, and no balance in the answer.
  if (path === '/api/v1/credits/consumption/async' && method === 'POST') {
    try {
      for (const consumption of body.consumptions ?? []) {
        applyUsage(
          mock,
          consumption.customerId,
          consumption.currencyId,
          Number(consumption.amount),
          consumption.idempotencyKey,
          consumption.dimensions,
          // The wallet takes fractions; only the usage report is integer-only.
          false,
        );
      }
      send(res, 200, { data: {} });
    } catch (err) {
      send(res, (err as { status?: number }).status ?? 500, { code: 'BadRequest', message: (err as Error).message });
    }
    return;
  }

  // A credit entitlement ingests here, not through /usage - see the REST engine's consumeCredits.
  if (path === '/api/v1/credits/consumption' && method === 'POST') {
    try {
      const { state, replayed } = applyUsage(
        mock,
        body.customerId,
        body.currencyId,
        Number(body.amount),
        body.idempotencyKey,
        body.dimensions,
        // The wallet takes fractions - verified against the API, which answers 200 to a
        // fractional `amount` and reports a fractional balance back.
        false,
      );
      send(res, 200, {
        data: {
          id: `cons_${Math.random().toString(16).slice(2, 10)}`,
          customerId: body.customerId,
          credit: {
            currencyId: body.currencyId,
            consumed: replayed ? 0 : Number(body.amount),
            currentUsage: state.pool.currentUsage,
            usageLimit: state.pool.usageLimit,
          },
        },
      });
    } catch (err) {
      send(res, (err as { status?: number }).status ?? 500, { code: 'BadRequest', message: (err as Error).message });
    }
    return;
  }

  if (path === '/api/v1/credits/grants' && method === 'POST') {
    const state = customer(mock, body.customerId);
    state.pool.usageLimit += Number(body.amount ?? 0);
    if (body.currencyId) mock.currencies.add(body.currencyId);
    send(res, 200, {
      data: {
        id: `grant_${Math.random().toString(16).slice(2, 10)}`,
        amount: body.amount,
        currencyId: body.currencyId,
      },
    });
    return;
  }

  send(res, 404, { code: 'NotFound', message: `mock Stigg has no route for ${method} ${path}` });
}

export async function startMockStiggServer(options: MockOptions = {}): Promise<MockStiggServer> {
  const mock: MockStiggServer = {
    baseUrl: '',
    close: async () => undefined,
    state: newState(),
    governance: options.governance ?? true,
    failChecks: options.failChecks ?? false,
    failProvisioning: false,
    provisionDecision: 'REQUESTED_PLAN',
    strictCustomers: false,
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        route(mock, req, res, await readBody(req));
      } catch (err) {
        send(res, 500, { code: 'MockFailure', message: (err as Error).message });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  mock.baseUrl = `http://127.0.0.1:${port}`;
  mock.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return mock;
}
