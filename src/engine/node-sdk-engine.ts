/**
 * The engine half that runs on Stigg's own Node server SDK: cached entitlement reads and usage
 * ingest. This is the only file in the package that imports it at runtime.
 *
 * It knows nothing about entities or chains - the GraphQL surface has no governance on it. What
 * it brings is the cache, which is the reason the composite keeps ingest (and customer-level
 * checks) here rather than sending everything to REST - and the reason nothing above this file
 * caches anything. That cache writes reported usage back from the server's own response,
 * invalidates on realtime updates, resets usage periods at read time, falls back when Stigg is
 * unreachable, and optionally lives in Redis so sibling processes share one view.
 *
 * All of that is configured through {@link CacheOptions}, which is the Node SDK's own
 * configuration passed straight through rather than re-described here.
 */
import Stigg, { AccessDeniedReason, type ClientConfiguration } from '@stigg/node-server-sdk';
import { GovernanceNotEnabledError, asEngineError } from '../errors';
import { AGENT_SDK_CLIENT_NAME, AGENT_SDK_VERSION } from '../sdk-identity';
import type { IngestMode, Metrics } from '../types';
import { creditConsumption, creditResult, missingEventError, reportMetrics, usageEntries, usageResult } from './report';
import type {
  EngineCapabilities,
  EngineCheckParams,
  EngineCheckResult,
  EngineReportParams,
  EngineReportResult,
  GovernanceEngine,
  ProvisionOutcome,
} from './engine';

/**
 * Caching - all of it, and none of it implemented here.
 *
 * This SDK holds no cache. Checks are served by the Node server SDK's entitlement cache, which
 * already does the hard parts: it writes the server's own measurement responses back into cached
 * usage, invalidates on realtime updates, applies usage-period resets at read time, and can be
 * backed by Redis so sibling processes share one view instead of each holding their own.
 *
 * So this is a passthrough rather than a parallel design - the field names are the Node SDK's own,
 * and anything it learns to do lands here without a change. The one thing that does *not* cache is
 * an attributed governance check: it resolves an entity, which only the governance API can do, so
 * it is a live call every time. That is the stricter answer, and it is where per-agent budgets are
 * enforced.
 */
export type CacheOptions = Pick<
  ClientConfiguration,
  | 'redis'
  | 'memoryCacheMaxSizeBytes'
  | 'entitlementsFallback'
  | 'creditEntitlementsFallback'
  | 'realtimeUpdatesEnabled'
  | 'enableEdge'
  | 'offline'
>;

/**
 * The Node server SDK client itself, for an application that already has one.
 *
 * Re-exported from `config.ts` as the public name, so the vendor client stays behind this file.
 */
export type NodeSdkClient = Stigg;

export type NodeSdkEngineOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Everything about caching, passed through to the Node SDK verbatim. Anything set here wins
   * over the localhost-aware defaults below - including `enableEdge` and `realtimeUpdatesEnabled`,
   * which are cache configuration in all but name: the socket is what keeps a cached entitlement
   * from going stale.
   */
  cache?: CacheOptions;
  /**
   * An existing client to use instead of building one. Borrowed, never closed.
   *
   * This is the only way to be *sure* who owns the client, which matters because
   * `Stigg.initialize` keeps one global instance per process and hands it back when the API key
   * matches. Closing a client the application is still using would take its cache and its socket
   * with it, and nothing from out here can tell a client that was just built from one that was
   * handed back: the instance exposes neither its configuration nor its identity.
   */
  client?: NodeSdkClient;
};

/**
 * The API's own code for an error it answered with. Absent when nothing answered - a refused
 * connection, a dropped socket - which is what tells a refusal apart from an outage.
 */
const errorCode = (err: unknown): string | undefined => (err as { errorCode?: string })?.errorCode;

/**
 * The failures that say nothing about the customer - a rate limit, a timeout, an unexpected error -
 * so asking again later may succeed. Every other code Stigg answers with is a final answer about
 * this customer or this configuration - an unknown plan, a key that cannot write, an invalid id -
 * and asking again gets the same one.
 */
const PASSING_FAILURES = new Set([
  'RateLimitExceeded',
  'OperationTimeout',
  'UnexpectedError',
  'RequestTimeout',
  // A lock another request holds on the customer - creating one takes it.
  'ObjectAlreadyBeingUsedByAnotherRequestError',
]);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Drops keys that were never set, so a spread cannot un-set a default.
 *
 * The Node SDK merges its configuration with lodash, which skips an `undefined` source value and
 * keeps its own default - so `{ enableEdge: false, ...cache }` with an unset `cache.enableEdge`
 * would land back on `true` and point a local run at an edge service that was never started.
 */
const defined = <T extends object>(options: T | undefined): Partial<T> =>
  Object.fromEntries(Object.entries(options ?? {}).filter(([, value]) => value !== undefined)) as Partial<T>;

function isLocalhost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return LOCAL_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export class NodeSdkEngine implements GovernanceEngine {
  readonly capabilities: EngineCapabilities = {
    // The SDK serves reads from its own cache, so two processes can each approve the same budget.
    strictCheck: false,
    chains: false,
    provisioning: false,
  };

  /**
   * Whether this engine built the client, and may therefore close it.
   *
   * False for a client that was handed in: it belongs to whoever built it, and its lifecycle is
   * theirs. See `close`.
   */
  readonly ownsClient: boolean;

  private readonly client: Stigg;

  constructor(options: NodeSdkEngineOptions) {
    if (options.client) {
      this.client = options.client;
      this.ownsClient = false;
      return;
    }

    this.ownsClient = true;
    const local = isLocalhost(options.baseUrl);
    this.client = Stigg.initialize({
      apiKey: options.apiKey,
      // So this traffic is attributable to the agent SDK rather than reading as a plain
      // node-server-sdk client. Only applies to a client built here: `Stigg.initialize` returns
      // its existing global instance when the API key matches, and a client handed in through
      // `options.client` keeps whatever name the application gave it.
      clientName: AGENT_SDK_CLIENT_NAME,
      clientVersion: AGENT_SDK_VERSION,
      ...(options.baseUrl ? { baseUri: options.baseUrl } : {}),
      ...(options.timeoutMs ? { entitlementsTimeout: options.timeoutMs } : {}),
      // The edge cache and the realtime socket are separate services from the API, and a Stigg
      // running on localhost usually serves neither - without this a local run fails on
      // ECONNREFUSED against services that were never started.
      enableEdge: !local,
      realtimeUpdatesEnabled: !local,
      // Last, so an explicit choice wins over the defaults above.
      ...defined(options.cache),
    });
  }

  /**
   * Waits for the cache to be usable.
   *
   * Not cosmetic: until the runtime reports itself initialized, every read is treated as a miss
   * and refetched, so a client that starts serving immediately pays a round trip per check for as
   * long as initialization takes. Awaited once at startup instead.
   */
  async ready(): Promise<void> {
    await this.client.waitForInitialization();
  }

  /**
   * Loads this customer's entitlements into the cache, so the checks that follow are local.
   *
   * The whole map, not one decision: a later check against a different entitlement is warm too,
   * and each is evaluated against the amount it actually asks for rather than against whatever
   * amount happened to warm it.
   */
  async preload(customerId: string): Promise<void> {
    await this.client.reloadEntitlements(customerId);
  }

  /**
   * One mutation, no lookup first. Stigg refuses to provision a customer it already has - the
   * whole mutation, subscription included - so an existing customer comes back as a duplicate and
   * is left exactly as they were. Reading first would only add a round trip to every customer's
   * first call in each process, to learn what the create already says.
   *
   * Here rather than on REST because the Node SDK creates the customer and the subscription in one
   * mutation, and writes the entitlements it answers with straight into the cache - so the check
   * that follows reads the new plan locally instead of fetching it.
   *
   * Resolves with a final answer - created, duplicate, or a refusal that will be the same next
   * time. Throws for a passing failure - unreachable, rate limited, timed out - so the customer is
   * asked again later: remembering one as a refusal would deny that customer until the process
   * restarts.
   */
  async provisionCustomer(customerId: string, planId: string): Promise<ProvisionOutcome> {
    try {
      const provisioned = await this.client.provisionCustomer({ customerId, subscriptionParams: { planId } });
      return {
        status: 'created',
        decision: provisioned.subscriptionDecisionStrategy,
        planId: provisioned.subscription?.planId,
      };
    } catch (err) {
      const code = errorCode(err);
      if (code === 'DuplicatedEntityNotAllowed') return { status: 'existing' };
      if (code && !PASSING_FAILURES.has(code)) {
        return { status: 'rejected', code, reason: err instanceof Error ? err.message : String(err) };
      }
      throw asEngineError('provisionCustomer', err);
    }
  }

  async upsertEntity(): Promise<void> {
    throw new GovernanceNotEnabledError(
      'The Node server SDK has no governance surface; entities need the REST client.',
    );
  }

  async archiveEntity(): Promise<void> {
    throw new GovernanceNotEnabledError(
      'The Node server SDK has no governance surface; entities need the REST client.',
    );
  }

  /**
   * The two kinds of entitlement are two different endpoints with two different answers, so each
   * gets its own method and this one only picks. Narrowing on `currencyId` rather than through
   * `entitlementKind` is what lets each branch read its own id without an assertion: a function
   * call cannot narrow a union.
   */
  async check(customerId: string, { entitlement, requestedUsage }: EngineCheckParams): Promise<EngineCheckResult> {
    try {
      return entitlement.currencyId !== undefined
        ? await this.checkCredit(customerId, entitlement.currencyId, requestedUsage)
        : await this.checkFeature(customerId, entitlement.featureId, requestedUsage);
    } catch (err) {
      throw asEngineError('check', err);
    }
  }

  /**
   * `getCreditEntitlement` takes no `requestedUsage` - `CreditEntitlementOptions` has no such
   * field - so unlike the metered path, nobody at Stigg is asked whether this particular amount is
   * affordable. Dropping the comparison is not an option: a check for five units against a balance
   * of two would come back granted and the run would overspend. So the SDK answers it, and says so
   * in `locallyDerived` rather than letting a verdict it reached by subtraction read like one the
   * server handed down.
   */
  private async checkCredit(
    customerId: string,
    currencyId: string,
    requestedUsage: number,
  ): Promise<EngineCheckResult> {
    const state = await this.client.getCreditEntitlement({ customerId, currencyId });
    const affordable = state.remaining >= requestedUsage;
    const denial = state.hasAccess ? AccessDeniedReason.InsufficientCredits : state.accessDeniedReason;
    return {
      isGranted: state.hasAccess && affordable,
      accessDeniedReason: affordable && state.hasAccess ? null : (denial ?? null),
      locallyDerived: state.hasAccess,
      usageLimit: state.usageLimit,
      currentUsage: state.currentUsage,
      isFallback: state.isFallback,
      source: 'node-sdk',
    };
  }

  /** The metered path, where Stigg is asked about this amount and answers for it. */
  private async checkFeature(
    customerId: string,
    featureId: string,
    requestedUsage: number,
  ): Promise<EngineCheckResult> {
    const state = await this.client.getMeteredEntitlement({ customerId, featureId, options: { requestedUsage } });
    return {
      isGranted: state.hasAccess,
      accessDeniedReason: state.accessDeniedReason ?? null,
      usageLimit: state.isUnlimited ? null : (state.usageLimit ?? null),
      currentUsage: state.currentUsage,
      isFallback: state.isFallback,
      source: 'node-sdk',
    };
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

  /** The feature path: bulk, because a turn reports several metrics and this client has one call. */
  private async reportUsage(customerId: string, params: EngineReportParams, metrics: Metrics) {
    const acks = await this.client.reportUsageBulk({ usages: usageEntries(customerId, params, metrics) });
    return usageResult(acks, metrics, 'node-sdk');
  }

  /**
   * The credit path: the currency is drawn from the customer's wallet with no feature mapping,
   * so none of the feature-side setup (a metered feature, a credit rate, an entitling
   * subscription) is involved. Stigg forwards the consumption to governance itself, so per-entity
   * budgets still decrement.
   *
   * `replayed` is always false here: the response carries the wallet's running balance but not
   * this call's own deduction, so a replayed idempotency key is indistinguishable from a fresh
   * one. The server still deduplicates on the key - only our ability to report it is lost.
   */
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
      // The async form takes the same consumption and reconciles it on Stigg's side, so the
      // amount is still ours to state - which is why a run reporting to its own currency keeps
      // an exact local budget in either mode. Only the balance is lost.
      const ack = mode === 'async' ? undefined : await this.client.consumeCredits(consumption);
      if (mode === 'async') await this.client.consumeCreditsAsync({ consumptions: [consumption] });
      return creditResult(featureId, value, ack?.credit?.currentUsage, mode, 'node-sdk');
    } catch (err) {
      throw asEngineError('ingest', err);
    }
  }

  /** The raw-events path: one event for the turn, matched by name, and no balance in the answer. */
  private async reportAsEvent(
    customerId: string,
    params: EngineReportParams,
    metrics: Metrics,
    dimensions: Record<string, string | number | boolean>,
  ): Promise<EngineReportResult> {
    const event = params.event;
    if (!event) throw missingEventError();
    try {
      await this.client.reportEvent({
        customerId,
        eventName: event.name,
        // The turn's own key: one event, so no per-feature suffix to keep them apart.
        idempotencyKey: params.idempotencyKey,
        dimensions,
      });
      // No balance comes back, and aggregation lags by seconds - so `replayed` stays unknown.
      return { reported: metrics, mode: 'async', source: 'node-sdk' };
    } catch (err) {
      throw asEngineError('ingest', err);
    }
  }

  async close(): Promise<void> {
    // The SDK keeps a background cache and sockets alive; without this a CLI never exits. But
    // only for a client this engine built: `close` nulls the Node SDK's global instance and tears
    // down the runtime, so closing a borrowed one would take the application's cache and socket
    // with it.
    if (this.ownsClient) await this.client.close();
  }
}
