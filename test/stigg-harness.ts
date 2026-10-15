/**
 * The shared harness for the client-surface tests.
 *
 * There is no way to hand this client an engine - it builds its own from the account it is
 * pointed at - so every case points it at the in-process Stigg mock and asserts on what the SDK
 * actually sent. That is the stronger test anyway: the REST payloads are part of the contract,
 * and a fake engine could never have caught a wrong one.
 */
import { after } from 'node:test';
import { StiggAgentSDK } from '../src/stigg-agent-sdk';
import type { StiggAgentSDKOptions } from '../src';
import { newRun, type BoundSession, type BoundSessionOptions } from './session-harness';
import {
  fundPool,
  seedBudget,
  seedEntityTypes,
  startMockStiggServer,
  type MockStiggServer,
} from '../testing/mock-stigg-server';

let keySeed = 0;
/** A distinct key per case, so what a test sent is never confused with what another one did. */
export const uniqueKey = () => `server-test-${++keySeed}`;

/** The context every governed call carries, instead of the client holding it. */
export const context = { customerId: 'customer-acme', entitlement: { currencyId: 'credits' } } as const;

export type MockOptions = {
  /** False makes the account answer the probe with 403, as an account without governance does. */
  governance?: boolean;
  /** The credit pool. Large by default: a denial should come from a budget, not an empty wallet. */
  pool?: number;
  /** A budget already on `agent-1`, as an account provisioned out of band would have. */
  agentBudget?: number | null;
};

const open: { stigg: StiggAgentSDK; mock: MockStiggServer }[] = [];

/** A client pointed at its own Stigg, seeded the way the case under test needs it. */
export async function newStigg(options: MockOptions & StiggAgentSDKOptions = {}) {
  const { governance, pool, agentBudget, ...config } = options;
  const mock = await startMockStiggServer({ governance: governance ?? true });
  seedEntityTypes(mock.state, [
    { id: 'agent', attributionKeys: ['agentId'], displayName: 'Agent' },
    { id: 'bot', attributionKeys: ['botId'], displayName: 'Bot' },
    { id: 'team', attributionKeys: ['teamId'], displayName: 'Team' },
  ]);
  fundPool(mock.state, context.customerId, pool ?? 1_000);
  if (agentBudget !== undefined) {
    seedBudget(mock.state, context.customerId, {
      entityId: 'agent-1',
      capabilityId: 'credits',
      usageLimit: agentBudget,
    });
  }
  const stigg = new StiggAgentSDK({
    apiKey: uniqueKey(),
    baseUrl: mock.baseUrl,
    // The SDK narrates to the console by default. A test asserting on output passes its own
    // logger; the rest would just be noise between the assertions.
    logger: 'none',
    // The mock answers both transports, but the node SDK still opens its own cache and poller.
    // A short timeout keeps a cold read from costing seconds.
    timeoutMs: 200,
    ...config,
  });
  open.push({ stigg, mock });
  return { stigg, mock };
}

after(async () => {
  for (const { stigg, mock } of open) {
    await stigg.close();
    await mock.close();
  }
});

/**
 * A session over the engine an SDK built, bound to one context.
 *
 * The replacement for what `stigg.run(...)` used to hand back: these cases want a real engine
 * talking to the mock, not a fake one, but still a single context to make calls against.
 */
export async function runOn(stigg: StiggAgentSDK, ctx: BoundSessionOptions = {}): Promise<BoundSession> {
  await stigg.init();
  // The SDK's own logger and error sink, so a case that configures them on `newStigg` observes
  // what a wrapped client would - the session is the only thing that reports through them.
  return newRun({ engine: stigg.engine, logger: stigg.config.logger, onError: stigg.config.onError, ...ctx });
}
