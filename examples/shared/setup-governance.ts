/**
 * Seeds whatever the examples need, in whichever environment is selected, idempotently.
 *
 * Governance is optional: steps 1-2 (a customer, a funded credit pool) are what every account
 * needs, and steps 3-4 (entity types, entities, per-entity budgets) only run when the account
 * actually has governance. An account without it still gets a working demo - it just enforces at
 * the customer level, with no per-agent chain.
 *
 * Run:  yarn workspace @stigg/agent-sdk-js run example-setup [--agent-limit 3] [--no-governance]
 */
import './load-env';
import Stigg from '@stigg/typescript';
import { looksLikeGovernanceNotEnabled } from '../../src/errors';
import { entitlementId, entitlementKind, entitlementRef } from '../../src/types';
import { CLIENT_AGENT_SUFFIXES, agentIdFor, describeSetup, resolveDemoEnv, type DemoEnv } from './demo-env';
import { requireKey, resolveStiggEnv } from './stigg-env';
import { seedCreditRate, seedEventMeter, type MockState } from '../../testing/mock-stigg-server';
import { DEFAULT_RECIPES, eventNameFor } from '../../src/internal';
import { maybeStartMockStiggServer } from './mock-stigg-server';

export type SetupOptions = {
  /**
   * Agents to create under the team, each with `agentLimit`. Defaults to the configured one; pass
   * `[]` when the application provisions its own, which is what the client examples do.
   */
  agents?: string[];
  agentLimit?: number | null;
  teamLimit?: number | null;
  cadence?: string;
  poolMin?: number;
  governance?: boolean;
  archive?: boolean;
  log?: (line: string) => void;
};

export type SetupResult = {
  governanceEnabled: boolean;
  poolLimit: number;
  entities: string[];
};

const flag = (argv: string[], name: string): boolean => argv.includes(`--${name}`);

function numberFlag(argv: string[], name: string, fallback: number): number {
  const index = argv.indexOf(`--${name}`);
  const given = index >= 0 ? argv[index + 1] : undefined;
  if (!given) return fallback;

  const value = Number(given);
  // `Number('nope')` is `NaN`, and `JSON.stringify` writes that as `null` - which this API reads
  // as "no limit". So a typo in a limit asked for the opposite of a limit, and the demo whose
  // whole point is a denial would quietly never deny.
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} needs a non-negative number - got "${given}", which would ask for no limit at all.`);
  }
  return value;
}

/**
 * Idempotent throughout: entity types, entities and assignments are upserts, and the credit
 * grant is guarded by a balance read (grants themselves are not idempotent - a blind re-run
 * would keep topping the wallet up).
 */
export async function setupGovernance(
  client: Stigg,
  demoEnv: DemoEnv,
  options: SetupOptions = {},
): Promise<SetupResult> {
  const log = options.log ?? console.log;
  const cadence = options.cadence ?? 'P1M';
  const poolMin = options.poolMin ?? 500;
  // Optional throughout: an entitlement is what a budget is written over, so without one there is
  // a tree to build but nothing to fund and nothing to assign. Steps 1 and 3-4's entities still run.
  const entitlement = demoEnv.entitlement;
  const capabilityId = entitlement && entitlementId(entitlement);
  // The SDK has no default for either half, so what the examples configure is what this seeds -
  // and an agent attributed under a key its type does not declare resolves nothing at all.
  const { entityTypeId, attributionKey } = demoEnv.agentType ?? { entityTypeId: 'agent', attributionKey: 'agentId' };

  // 1. The customer. Everything else hangs off it, governance or not.
  try {
    await client.v1.customers.retrieve(demoEnv.customerId);
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
    await client.v1.customers.provision({ id: demoEnv.customerId, name: demoEnv.customerId });
    log(`  created customer ${demoEnv.customerId}`);
  }

  // 2. A funded pool, for a credit entitlement. The pool must dwarf the per-agent budget, or the demo
  //    denial would come from an empty wallet rather than from the agent's own cap.
  let poolLimit = 0;
  if (entitlement && capabilityId && entitlementKind(entitlement) === 'credit') {
    const checked = await client.v1.customers.checkEntitlement(demoEnv.customerId, { currencyId: capabilityId });
    const data = checked.data as { usageLimit?: number; currentUsage?: number };
    poolLimit = data.usageLimit ?? 0;
    const remaining = poolLimit - (data.currentUsage ?? 0);
    if (remaining < poolMin) {
      await client.v1.credits.grants.create({
        customerId: demoEnv.customerId,
        currencyId: capabilityId,
        amount: poolMin * 2,
        displayName: 'agent-sdk example grant',
        grantType: 'PROMOTIONAL',
      });
      poolLimit += poolMin * 2;
      log(`  granted ${poolMin * 2} ${capabilityId} (balance was ${remaining})`);
    } else {
      log(`  pool already funded: ${remaining} ${capabilityId} remaining`);
    }
  }

  // 3. Is governance available at all? A 403 here is an account state, not a failure.
  if (options.governance === false) {
    log('  --no-governance: entity and budget steps skipped (customer-level enforcement only)');
    return { governanceEnabled: false, poolLimit, entities: [] };
  }
  try {
    await client.v1Beta.entityTypes.list({ limit: 1 });
  } catch (err) {
    if (!looksLikeGovernanceNotEnabled(err)) throw err;
    log('  governance is not enabled for this account - entity and budget steps skipped.');
    log('  The examples still run: enforcement happens at the customer level instead.');
    return { governanceEnabled: false, poolLimit, entities: [] };
  }

  // 4. The tree. Two levels, so a denial can demonstrate the ancestor rule.
  await client.v1Beta.entityTypes.upsert({
    types: [
      { id: 'team', attributionKeys: ['teamId'], displayName: 'Team' },
      {
        // Declared from the environment, and with it the key a run attributes by - the entity, the
        // type and the dimension have to agree or governance resolves nothing and bills the
        // customer instead, which looks exactly like a run that was never governed.
        id: entityTypeId,
        attributionKeys: [attributionKey],
        displayName: 'Agent',
        description: 'A durable agent; budgets attach here.',
      },
    ],
  });

  // An explicit [] means the caller provisions its own agents; omitted means the configured one -
  // of which there may be none, when the examples are running against the customer's own pool.
  const agents = options.agents ?? (demoEnv.agentId ? [demoEnv.agentId] : []);
  // Likewise optional: with no team the agents are roots, and the ancestor rule has no second
  // level to demonstrate. The examples that need one say so themselves.
  const team = demoEnv.teamId;

  await client.v1Beta.customers.entities.upsert(demoEnv.customerId, {
    entities: [
      ...(team ? [{ id: team, entityTypeId: 'team', displayName: team }] : []),
      ...agents.map((id) => ({ id, entityTypeId, displayName: id })),
    ],
  });

  // An assignment is written over (entity x entitlement). With no entitlement named there is
  // nowhere for a budget to land, so the tree above stands and the budgets are simply skipped.
  if (!entitlement || !capabilityId) {
    log('  no entitlement configured - the entities exist, but no assignment was written and no');
    log('  budget was set, because an assignment is written over (entity x entitlement) and there');
    log('  is no entitlement to write it against. The runs themselves gate nothing. Set');
    log('  AGENT_SDK_DEMO_CURRENCY_ID or AGENT_SDK_DEMO_FEATURE_ID to enforce.');
    // The budgets are what this branch skips, not the entities - which were written above and
    // would otherwise outlive the `--archive` that was asked for.
    if (options.archive) await archiveEntities(client, demoEnv.customerId, team, agents, log);
    return { governanceEnabled: true, poolLimit, entities: [...(team ? [team] : []), ...agents] };
  }

  const capability = entitlementRef(entitlement);
  const agentLimit = options.agentLimit === undefined ? 3 : options.agentLimit;
  // Room for every agent to spend its own budget without the team becoming the binding
  // constraint - the ancestor rule is worth demonstrating deliberately, not by accident.
  const teamLimit =
    options.teamLimit !== undefined ? options.teamLimit : agentLimit === null ? null : agentLimit * (agents.length + 1);

  await client.v1Beta.customers.assignments.upsert(demoEnv.customerId, {
    assignments: [
      ...(team ? [{ entityId: team, ...capability, usageLimit: teamLimit, cadence, parentId: null }] : []),
      // parentId rides the assignment: the entity upsert rejects it outright. `null` rather than
      // undefined with no team - these agents are roots, not agents whose parent is left alone.
      ...agents.map((id) => ({ entityId: id, ...capability, usageLimit: agentLimit, cadence, parentId: team ?? null })),
    ],
  });
  log(
    `  budgets: ${team ? `${team}=${teamLimit ?? 'unlimited'}` : '(no team)'}` +
      `${agents.length ? ` -> ${agents.join(', ')} = ${agentLimit ?? 'unlimited'} each` : ', and no agents'}` +
      `, per ${cadence}`,
  );

  if (options.archive) await archiveEntities(client, demoEnv.customerId, team, agents, log);

  return { governanceEnabled: true, poolLimit, entities: [...(team ? [team] : []), ...agents] };
}

/**
 * Seeds the in-process mock so an example runs end-to-end with no account at all. The real
 * environments are seeded by running this file as a script instead.
 */
export async function seedMock(
  demoEnv: DemoEnv,
  mock: { baseUrl: string; state?: MockState },
  options: SetupOptions = {},
): Promise<SetupResult> {
  // What a unit of each metric costs in credits - the mock's stand-in for the consumption mapping
  // a real plan carries. Without it the examples would report tokens against features nothing
  // converts, the wallet would never move, and the SDK would (correctly) say so every run.
  if (mock.state) {
    for (const [featureId, rate] of Object.entries(DEMO_CREDIT_RATES)) seedCreditRate(mock.state, featureId, rate);
    seedDemoEventMeters(mock.state, demoEnv);
  }
  const client = new Stigg({ apiKey: 'offline-mock', baseURL: mock.baseUrl });
  return setupGovernance(client, demoEnv, { poolMin: 500, ...options });
}

/**
 * The raw-events meters a feature entitlement needs offline - the mock's stand-in for the ones an
 * account configures.
 *
 * Only a feature needs them. A metric naming the run's own credit currency draws the wallet
 * directly, which is why the default demo enforced correctly without any of this. A feature under
 * the default `'async'` ingest goes out as an event, and an event that matches no meter is
 * accepted and converted to nothing - so every check passed, every ingest answered `ok`, the
 * budget never moved, and the example demonstrated the one failure this SDK exists to make
 * visible. Nothing warns, either: an event report comes back empty, so the SDK cannot tell a
 * meter that did nothing from one that has not run yet.
 */
function seedDemoEventMeters(state: MockState, demoEnv: DemoEnv): void {
  const entitlement = demoEnv.entitlement;
  if (!entitlement || entitlementKind(entitlement) === 'credit') return;

  // One field, because the examples map everything they measure onto the entitlement they gate on.
  const featureId = entitlementId(entitlement);
  for (const eventName of demoEventNames(demoEnv)) {
    // Seeded once per name. `seedEventMeter` appends, and the mock applies *every* matching meter
    // to an event - so a second seeding of the same mock would charge the feature twice for one
    // call, which is the one way this file could break the idempotence it promises.
    const already = state.eventMeters.some((meter) => meter.eventName === eventName && meter.featureId === featureId);
    if (!already) seedEventMeter(state, { eventName, featureId, aggregation: { function: 'SUM', field: featureId } });
  }
}

/**
 * What the examples name their events: the configured one if there is any, and otherwise the
 * `vendor.path` each recipe derives. Read off the recipes rather than listed here, so a binding
 * added later is seeded by existing.
 */
function demoEventNames(demoEnv: DemoEnv): string[] {
  if (demoEnv.ingestEventName) return [demoEnv.ingestEventName.name];
  // Every method of every recipe `wrap` can match, which is what makes the promise above hold for
  // a new vendor and not just a new method. A binding missing from here is one whose events match
  // no meter - accepted, converted to nothing, and silent under a feature entitlement.
  return [
    ...DEFAULT_RECIPES.flatMap((recipe) => recipe.methods.map((method) => eventNameFor(recipe, method))),
    ...PROXY_EVENT_NAMES,
  ];
}

/**
 * What a gateway you operate names its events, which no recipe derives: out there the call is
 * observed rather than wrapped, so `ingestFromHeaders` names it after the vendor the proxy
 * declared - or `agent.usage` when it declared none. `example-gateway.test.ts` pins these against
 * what the proxy actually sends, because two lists describing one thing drift.
 */
export const PROXY_EVENT_NAMES = [
  'agent.usage',
  'openai.proxied',
  'openai-responses.proxied',
  'anthropic.proxied',
  'typesafe.proxied',
  'gemini.proxied',
];

/**
 * Priced so one chat turn costs about one credit, which is what keeps the demo's arithmetic
 * legible: a five-credit agent lasts about five turns. Output is dearer than input and cache
 * reads are nearly free, as most vendors price them.
 */
export const DEMO_CREDIT_RATES: Record<string, number> = {
  input_tokens: 0.002,
  output_tokens: 0.02,
  cache_read_input_tokens: 0.0002,
  cache_creation_input_tokens: 0.002,
  prompt_tokens: 0.002,
  completion_tokens: 0.02,
  cached_tokens: 0.0002,
  // Gemini's own names, on the same scale: its two input-side counters priced like an input
  // token, and both output-side ones - thinking tokens are billed as output - like an output
  // token. `promptTokenCount` overlaps `cachedContentTokenCount` the way `prompt_tokens` already
  // overlaps `cached_tokens` above, so the demo prices them the same way it prices OpenAI's.
  promptTokenCount: 0.002,
  toolUsePromptTokenCount: 0.002,
  candidatesTokenCount: 0.02,
  thoughtsTokenCount: 0.02,
  cachedContentTokenCount: 0.0002,
  // The gateways report real spend too, already scaled by their recipe.
  cost: 0.001,
};

/** Undoes what this script wrote, bottom-up: archiving a parent orphans its active children. */
async function archiveEntities(
  client: Stigg,
  customerId: string,
  team: string | undefined,
  agents: string[],
  log: (message: string) => void,
): Promise<void> {
  if (agents.length) await client.v1Beta.customers.entities.archive(customerId, { ids: agents });
  if (team) await client.v1Beta.customers.entities.archive(customerId, { ids: [team] });
  log('  archived the agents, then the team');
}

/** Reads back what was just written. The tree lags by minutes in a real environment. */
async function printTree(client: Stigg, demoEnv: DemoEnv): Promise<void> {
  // The read is per-entitlement, so there is no tree to print without one - and nothing was
  // assigned either, which the setup above already said.
  if (!demoEnv.entitlement) return;
  const capabilityId = entitlementId(demoEnv.entitlement);
  const params =
    entitlementKind(demoEnv.entitlement) === 'credit'
      ? { currencyIds: [capabilityId] }
      : { featureIds: [capabilityId] };
  const tree = await client.v1.events.beta.customers.retrieveGovernance(demoEnv.customerId, params);

  console.log('\nGovernance tree:');
  for (const node of tree.data) {
    const limit = node.usageLimit === null ? 'unlimited' : node.usageLimit;
    const parent = node.parentId ? ` parent=${node.parentId}` : '';
    console.log(`  ${node.entityId} (${node.entityTypeId})${parent} usage=${node.currentUsage}/${limit}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // `env` is what any application has - which Stigg to talk to. `demoEnv` is what only a demo
  // reads from a file: the tenant, the agent, what to gate on.
  const env = resolveStiggEnv();
  const demoEnv: DemoEnv = resolveDemoEnv(env);
  const mock = await maybeStartMockStiggServer(env.offline);
  const baseUrl = mock?.baseUrl ?? env.baseUrl;
  const apiKey = mock ? 'offline-mock' : requireKey(env);

  console.log(`Seeding Stigg: ${describeSetup(env, demoEnv)}\n`);
  const client = new Stigg({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });

  try {
    const result = await setupGovernance(client, demoEnv, {
      // Every agent the examples use: the shared one for gateway/orchestrator, plus one per
      // client. With no agent id configured there are none to seed, and the examples run against
      // the customer's pool instead - which is a demo too, just a flatter one.
      agents: demoEnv.agentId
        ? [demoEnv.agentId, ...CLIENT_AGENT_SUFFIXES.map((suffix) => agentIdFor(demoEnv, suffix) as string)]
        : [],
      agentLimit: numberFlag(argv, 'agent-limit', 5),
      ...(argv.includes('--team-limit') ? { teamLimit: numberFlag(argv, 'team-limit', 10) } : {}),
      cadence: argv.includes('--cadence') ? argv[argv.indexOf('--cadence') + 1] : 'P1M',
      poolMin: numberFlag(argv, 'pool-min', 500),
      governance: !flag(argv, 'no-governance'),
      archive: flag(argv, 'archive'),
    });

    if (result.governanceEnabled && !flag(argv, 'archive')) await printTree(client, demoEnv);

    console.log('\nDone. Notes:');
    console.log('  - Budgets reset per cadence window, so a spent agent stays spent until the window rolls.');
    console.log('  - To demo again: re-run with a higher --agent-limit, or set AGENT_SDK_DEMO_AGENT_ID to a new id.');
    if (!result.governanceEnabled) {
      console.log('  - Running customer-level: denials will name the customer, not an agent.');
    }
  } finally {
    await mock?.close();
  }
}

// Only run as a script; importing it for the mock path must not start a CLI.
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
