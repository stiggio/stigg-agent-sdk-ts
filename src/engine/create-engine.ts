/**
 * Picks the engine and reports what it picked.
 *
 * The rule is SDK-first: the Node server SDK serves everything it can (it has the cache), and the
 * REST client completes what only governance has. Governance itself is optional - not every
 * account has it - so an account without it still gets a working customer-level engine rather
 * than an error.
 */
import { CompositeEngine } from './composite-engine';
import { NodeSdkEngine } from './node-sdk-engine';
import { RestGovernanceEngine } from './rest-governance-engine';
import type { EngineConfig } from '../config';
import type { CacheOptions, NodeSdkClient } from './node-sdk-engine';
import type { EngineResolution, GovernanceEngine } from './engine';

export type CreatedEngine = { engine: GovernanceEngine; resolution: EngineResolution };

export type EngineClientOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
  /** Both ignored by the REST client, which caches nothing and builds its own transport. */
  cache?: CacheOptions;
  client?: NodeSdkClient;
};

const CUSTOMER_LEVEL_OPS = {
  upsertEntity: 'unavailable',
  check: 'node-sdk',
  report: 'node-sdk',
  archiveEntity: 'unavailable',
} as const;

const GOVERNANCE_OPS = {
  upsertEntity: 'rest',
  check: 'rest',
  // A check with no dimensions resolves no entity, so it is the customer's pool either way -
  // and the cached client can answer that without a round trip.
  unattributedCheck: 'node-sdk',
  report: 'node-sdk',
  archiveEntity: 'rest',
} as const;

export async function createGovernanceEngine(config: EngineConfig): Promise<CreatedEngine> {
  const clientOptions: EngineClientOptions = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    cache: config.cache,
    client: config.client,
  };

  const nodeSdk = new NodeSdkEngine(clientOptions);
  const rest = new RestGovernanceEngine(clientOptions);

  // Governance is assumed, and asked about once here rather than declared by the caller: the
  // account already knows the answer, so making someone configure it only creates a second
  // source of truth that can disagree with the first.
  //
  // Together with the probe, because they are two independent waits at startup and neither needs
  // the other's answer. Warming is not optional work: until the Node SDK reports itself
  // initialized every cache read counts as a miss and refetches, so skipping this would pay a
  // round trip per check for as long as initialization takes.
  const [probe] = await Promise.all([
    rest.probe(),
    nodeSdk.ready().catch((err: unknown) => {
      // Non-fatal by design. An unreachable cache is a slow client, not a broken one - every read
      // falls through to the API - and the first real check is where that surfaces as policy.
      config.logger.warn(`[stigg] the entitlement cache did not finish starting up: ${String(err)}`);
    }),
  ]);

  // REST stays in play either way: it is the complete implementation, so it is what the composite
  // re-routes to if the Node SDK turns out to be unreachable.
  if (probe === 'not-enabled') {
    config.logger.warn(
      '[stigg] governance is not enabled for this account: checks and usage still work at the ' +
        'customer level, but agents cannot be registered. Contact Stigg to enable it.',
    );
    const resolution = customerLevel('governance not enabled for this account');
    return {
      engine: new CompositeEngine({
        delegates: { check: nodeSdk, report: nodeSdk, provisionCustomer: nodeSdk },
        fallback: rest,
        resolution,
        logger: config.logger,
      }),
      resolution,
    };
  }

  const resolution: EngineResolution = {
    mode: 'governance',
    ops: { ...GOVERNANCE_OPS },
    reason: 'governance enabled',
  };
  return {
    engine: new CompositeEngine({
      // An attributed check goes to REST because only it returns chains; an unattributed one has
      // no chain to lose, and ingest prefers the cached SDK either way.
      delegates: {
        upsertEntity: rest,
        check: rest,
        unattributedCheck: nodeSdk,
        report: nodeSdk,
        archiveEntity: rest,
        provisionCustomer: nodeSdk,
      },
      fallback: rest,
      resolution,
      logger: config.logger,
    }),
    resolution,
  };
}

const customerLevel = (reason: string): EngineResolution => ({
  mode: 'customer-level',
  ops: { ...CUSTOMER_LEVEL_OPS },
  reason,
});
