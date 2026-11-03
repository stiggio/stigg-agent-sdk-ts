/**
 * Makes sure the Stigg objects the examples need exist, in whichever environment is selected -
 * read first, created only when missing, so it runs at the start of every example, live and offline.
 *
 * Two halves, because they hang off different things:
 *
 *   1. The environment - the credit currency or feature the demo gates on, the entity types, and
 *      a free demo plan carrying the demo's monthly credits (or its feature), under a product of its
 *      own and published. Written through the API, before the SDK starts.
 *   2. The customer's tree - the team and the agents, with their budgets. Written through the SDK's
 *      own `register`, with the demo plan as `defaultPlanId`: the customer is provisioned onto it the
 *      first time, by the SDK, which is how a new customer arrives funded.
 *
 * Nothing creates the customer directly and nothing grants credits: the plan does both. Governance
 * is optional - an account without it skips the entity types and the tree, and enforces at the
 * customer level instead.
 *
 * Run:  yarn example-setup [--agent-limit 3] [--no-governance]
 */
import './load-env';
import Stigg from '@stigg/typescript';
import { StiggAgentSDK } from '../../src';
import { looksLikeGovernanceNotEnabled } from '../../src/errors';
import { entitlementId, entitlementKind } from '../../src/types';
import { CLIENT_AGENT_SUFFIXES, agentIdFor, describeSetup, resolveDemoEnv, type DemoEnv } from './demo-env';
import { requireKey, resolveStiggEnv, type StiggEnv } from './stigg-env';
import { seedCreditRate, seedEventMeter, type MockState } from '../../testing/mock-stigg-server';
import { DEFAULT_RECIPES, eventNameFor } from '../../src/internal';
import { maybeStartMockStiggServer, type MockStiggServer } from './mock-stigg-server';

/** The entity type the agents' parent is. */
const TEAM_ENTITY_TYPE = 'team';

/** The dimensional entity type a per-model budget is scoped by, and the dimension it is matched on. */
export const MODEL_ENTITY_TYPE = 'model';
export const MODEL_DIMENSION = 'model';

/**
 * A model's id as Stigg takes it - an entity id, a scope and a dimension value are refIds
 * (`^[a-zA-Z0-9][a-zA-Z0-9_|.-]*$`). A Vertex `models/...`, a versioned `...@...` or a Bedrock
 * `...:...` id is not one, so every other character becomes `-`. The entity, its scope and every
 * call's dimension all go through this, so they still match.
 */
export const modelRefId = (model: string): string =>
  model.replace(/[^a-zA-Z0-9_|.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '');

/** The product the demo plan sits under, and what the plan grants each month. */
const DEMO_PRODUCT_ID = 'product-agent-sdk-demo';
const DEMO_PLAN_CREDITS = 10_000;
const DEMO_PLAN_FEATURE_LIMIT = 10_000;

export type SetupOptions = {
  /**
   * Agents to create under the team, each with `agentLimit`. Defaults to the configured one; pass
   * `[]` when the application provisions its own, which is what the client examples do.
   */
  agents?: string[];
  agentLimit?: number | null;
  teamLimit?: number | null;
  cadence?: string;
  governance?: boolean;
  archive?: boolean;
  log?: (line: string) => void;
};

export type SetupResult = {
  governanceEnabled: boolean;
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

const isNotFound = (err: unknown) => (err as { status?: number }).status === 404;

/**
 * The environment's half: everything that is not a customer's. Idempotent throughout - each object
 * is read first and created only when it is missing, and every creation is said.
 */
export async function ensureEnvironment(
  client: Stigg,
  demoEnv: DemoEnv,
  options: Pick<SetupOptions, 'governance' | 'log'> = {},
): Promise<{ governanceEnabled: boolean }> {
  const log = options.log ?? console.log;
  const entitlement = demoEnv.entitlement;

  // 1. What the demo gates on. A currency is spent from the customer's credits; a feature needs
  //    a meter of its own.
  if (entitlement?.currencyId) {
    const { currencyId } = entitlement;
    if (!(await currencyExists(client, currencyId))) {
      const created = await unlessRaced(
        () => client.v1.credits.customCurrencies.create({ id: currencyId, displayName: currencyId }),
        () => currencyExists(client, currencyId),
      );
      if (created) log(`  created credit currency ${currencyId}`);
    }
  } else if (entitlement?.featureId) {
    const { featureId } = entitlement;
    if (!(await featureExists(client, featureId))) {
      const created = await unlessRaced(
        () =>
          client.v1.features.createFeature({
            id: featureId,
            displayName: featureId,
            featureType: 'NUMBER',
            meterType: 'INCREMENTAL',
          }),
        () => featureExists(client, featureId),
      );
      if (created) log(`  created metered feature ${featureId}`);
    }
  }

  // 2. The demo plan a new customer is provisioned onto - which is what funds them.
  if (demoEnv.planId) await ensureDemoPlan(client, demoEnv.planId, entitlement, log);

  // 3. The entity types, when the account has governance. A 403 here is an account state.
  if (options.governance === false) {
    log('  --no-governance: entity types and budgets skipped (customer-level enforcement only)');
    return { governanceEnabled: false };
  }
  const existing = new Map<string, string[]>();
  try {
    for await (const type of client.v1Beta.entityTypes.list({})) existing.set(type.id, type.attributionKeys);
  } catch (err) {
    if (!looksLikeGovernanceNotEnabled(err)) throw err;
    log('  governance is not enabled for this account - entity types and budgets skipped.');
    log('  The examples still run: enforcement happens at the customer level instead.');
    return { governanceEnabled: false };
  }
  // The SDK has no default for either half, so what the examples configure is what this seeds -
  // and an agent attributed under a key its type does not declare resolves nothing at all.
  const { entityTypeId, attributionKey } = demoEnv.agentType ?? { entityTypeId: 'agent', attributionKey: 'agentId' };
  // One upsert declares both, and the later of two types with one id would replace the other.
  if (entityTypeId === MODEL_ENTITY_TYPE || entityTypeId === TEAM_ENTITY_TYPE) {
    throw new Error(
      `AGENT_SDK_DEMO_ENTITY_TYPE_ID cannot be "${entityTypeId}" - the seed declares that type itself, ` +
        `for the ${entityTypeId === TEAM_ENTITY_TYPE ? "agents' parent" : 'model dimension'}. Pick another.`,
    );
  }
  const wanted = [
    { id: TEAM_ENTITY_TYPE, attributionKeys: ['teamId'], displayName: 'Team' },
    {
      // Declared from the environment, and with it the key a run attributes by - the entity, the
      // type and the dimension have to agree or governance resolves nothing and charges the
      // customer instead, which looks exactly like a run that was never governed.
      id: entityTypeId,
      attributionKeys: [attributionKey],
      displayName: 'Agent',
      description: 'A durable agent; budgets attach here.',
    },
    {
      // A dimensional type beside the tree, so an agent can hold a budget per model.
      id: MODEL_ENTITY_TYPE,
      attributionKeys: [MODEL_DIMENSION],
      displayName: 'Model',
      description: 'An LLM model; a budget scoped to one applies to its calls alone.',
    },
  ];
  // A type the account already has is the account's: never rewritten, only checked against what
  // the demo attributes by.
  for (const type of wanted) {
    const keys = existing.get(type.id);
    if (keys && !type.attributionKeys.every((key) => keys.includes(key))) {
      log(
        `  entity type ${type.id} exists, attributed by [${keys.join(', ')}] rather than ` +
          `${type.attributionKeys.join(', ')} - left as it is, so the demo's ${type.id}s resolve nothing.`,
      );
    }
  }
  const missing = wanted.filter((type) => !existing.has(type.id));
  if (missing.length) {
    await client.v1Beta.entityTypes.upsert({ types: missing });
    log(`  created entity types ${missing.map((type) => type.id).join(', ')}`);
  }
  return { governanceEnabled: true };
}

/** What the seed writes on a plan it creates - the only plans it will ever finish or publish. */
const SEEDED_BY = { createdBy: 'stigg-agent-sdk-examples' };

async function retrievePlan(client: Stigg, planId: string) {
  try {
    return (await client.v1.plans.retrieve(planId)).data;
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

/** Every page, not the first: an account with many currencies has this one past it. */
async function currencyExists(client: Stigg, currencyId: string): Promise<boolean> {
  for await (const currency of client.v1.credits.customCurrencies.list({})) {
    if (currency.id === currencyId) return true;
  }
  return false;
}

async function featureExists(client: Stigg, featureId: string): Promise<boolean> {
  try {
    await client.v1.features.retrieveFeature(featureId);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** Every page, not the first: an account with many products has this one past it. */
async function productExists(client: Stigg): Promise<boolean> {
  for await (const product of client.v1.products.listProducts({})) {
    if (product.id === DEMO_PRODUCT_ID) return true;
  }
  return false;
}

/**
 * A write that may lose a race to another example starting at the same moment: when it fails,
 * the object is read back, and one that exists now counts. Answers whether this call did the work.
 */
async function unlessRaced(write: () => Promise<unknown>, done: () => Promise<boolean>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (err) {
    if (await done()) return false;
    throw err;
  }
}

/**
 * A free plan under the demo product, granting the demo's credits each month - or its feature, up
 * to a limit - published. Only a plan this seed created is ever finished or published: one that
 * already existed - a draft included - may be somebody's, so what it lacks is said, never written.
 */
async function ensureDemoPlan(
  client: Stigg,
  planId: string,
  entitlement: DemoEnv['entitlement'],
  log: (line: string) => void,
): Promise<void> {
  let plan = await retrievePlan(client, planId);

  if (!plan) {
    if (!(await productExists(client))) {
      const created = await unlessRaced(
        () => client.v1.products.createProduct({ id: DEMO_PRODUCT_ID, displayName: 'Agent SDK demo' }),
        () => productExists(client),
      );
      if (created) log(`  created product ${DEMO_PRODUCT_ID}`);
    }
    const created = await unlessRaced(
      () =>
        client.v1.plans.create({
          id: planId,
          displayName: 'Agent SDK demo (free)',
          productId: DEMO_PRODUCT_ID,
          pricingType: 'FREE',
          metadata: SEEDED_BY,
        }),
      async () => (await retrievePlan(client, planId)) !== undefined,
    );
    if (created) log(`  created free plan ${planId}`);
    plan = await retrievePlan(client, planId);
    if (!plan) throw new Error(`plan ${planId} was created but cannot be read back`);
  }

  const id = entitlement && entitlementId(entitlement);
  const type = entitlement && (entitlementKind(entitlement) === 'credit' ? 'CREDIT' : 'FEATURE');
  // A credit and a feature may share an id; only the kind the demo meters counts as granted.
  const grants = () => !id || plan!.entitlements.some((granted) => granted.id === id && granted.type === type);

  if (plan.metadata?.createdBy !== SEEDED_BY.createdBy) {
    // Somebody's plan: never rewritten. Say what keeps it from serving the demo.
    if (!grants()) {
      log(`  plan ${planId} does not grant ${id} - new customers on it arrive unfunded.`);
      log('  Add it to the plan, or point AGENT_SDK_DEMO_PLAN_ID at a plan that grants it.');
    }
    if (plan.status === 'DRAFT') {
      log(`  plan ${planId} is a draft - customers cannot be provisioned onto it until it is published.`);
    }
    return;
  }

  // The seed's own plan: finish what an earlier start - or one racing this one - may have left.
  if (entitlement && id && !grants()) {
    if (plan.status !== 'DRAFT') {
      log(`  plan ${planId} is published without ${id} - new customers on it arrive unfunded.`);
    } else {
      const added = await unlessRaced(
        () =>
          client.v1.plans.entitlements.create(planId, {
            entitlements: [
              entitlementKind(entitlement) === 'credit'
                ? { type: 'CREDIT', id, amount: DEMO_PLAN_CREDITS, cadence: 'MONTH' }
                : { type: 'FEATURE', id, usageLimit: DEMO_PLAN_FEATURE_LIMIT, resetPeriod: 'MONTH' },
            ],
          }),
        async () => ((plan = await retrievePlan(client, planId)), grants()),
      );
      if (added) log(`  plan ${planId} now grants ${id} each month`);
    }
  }

  if (plan.status === 'DRAFT') {
    const published = await unlessRaced(
      () => client.v1.plans.publish(planId, { migrationType: 'NEW_CUSTOMERS' }),
      async () => (await retrievePlan(client, planId))?.status === 'PUBLISHED',
    );
    if (published) log(`  published plan ${planId}`);
  }
}

/**
 * The customer's half: the team and the agents, with their budgets, through the SDK's own
 * `register`. Given the demo plan, the first register provisions the customer onto it - so this is
 * also where a new customer is created, by the SDK, funded by the plan.
 */
export async function seedCustomer(
  stigg: StiggAgentSDK,
  demoEnv: DemoEnv,
  options: SetupOptions = {},
): Promise<string[]> {
  const log = options.log ?? console.log;
  const cadence = options.cadence ?? 'P1M';
  const { entitlement, customerId, planId: defaultPlanId } = demoEnv;
  const { entityTypeId } = demoEnv.agentType ?? { entityTypeId: 'agent' };
  // An explicit [] means the caller provisions its own agents; omitted means the configured one -
  // of which there may be none, when the examples are running against the customer's own pool.
  const agents = options.agents ?? (demoEnv.agentId ? [demoEnv.agentId] : []);
  // Likewise optional: with no team the agents are roots, and the ancestor rule has no second
  // level to demonstrate. The examples that need one say so themselves.
  const team = demoEnv.teamId;
  const agentLimit = options.agentLimit === undefined ? 3 : options.agentLimit;
  // Room for every agent to spend its own budget without the team becoming the binding
  // constraint - the ancestor rule is worth demonstrating deliberately, not by accident.
  const teamLimit =
    options.teamLimit !== undefined ? options.teamLimit : agentLimit === null ? null : agentLimit * (agents.length + 1);
  // An assignment is written over (entity x entitlement): with none named there is nowhere for a
  // budget to land, so the entities stand and the budgets are skipped.
  const budget = (limit: number | null, parentId: string | null) =>
    entitlement ? { budget: { entitlement, limit, cadence, parentId } } : {};

  if (team) {
    await stigg.register({
      customerId,
      defaultPlanId,
      agentId: team,
      entityTypeId: TEAM_ENTITY_TYPE,
      ...budget(teamLimit, null),
    });
  }
  for (const agentId of agents) {
    await stigg.register({ customerId, defaultPlanId, agentId, entityTypeId, ...budget(agentLimit, team ?? null) });
  }
  if (entitlement && (team || agents.length)) {
    log(
      `  budgets: ${team ? `${team}=${teamLimit ?? 'unlimited'}` : '(no team)'}` +
        `${agents.length ? ` -> ${agents.join(', ')} = ${agentLimit ?? 'unlimited'} each` : ', and no agents'}` +
        `, per ${cadence}`,
    );
  }

  if (options.archive) {
    for (const agentId of agents) await stigg.deregister({ customerId, agentId });
    if (team) await stigg.deregister({ customerId, agentId: team });
    log('  archived the agents, then the team');
  }
  return [...(team ? [team] : []), ...agents];
}

/**
 * What every example runs first: the environment, then - with governance - the customer's tree.
 * Against the mock it also seeds what an account configures out of band and the API cannot set:
 * the credit rates a plan's consumption mapping would carry, and the raw-events meters.
 */
export async function prepareDemo(
  env: StiggEnv,
  demoEnv: DemoEnv,
  stigg: StiggAgentSDK,
  mock: MockStiggServer | undefined,
  options: SetupOptions = {},
): Promise<SetupResult> {
  if (mock) seedOfflineAccount(mock.state, demoEnv);
  const client = new Stigg(
    mock ? { apiKey: 'offline-mock', baseURL: mock.baseUrl } : { apiKey: requireKey(env), baseURL: env.baseUrl },
  );
  const { governanceEnabled } = await ensureEnvironment(client, demoEnv, options);
  // With no agent type a run is customer-level: nothing is attributed to an entity, so there is no
  // tree to seed - and the customer is provisioned by the run's first call instead.
  const entities = governanceEnabled && demoEnv.agentType ? await seedCustomer(stigg, demoEnv, options) : [];
  return { governanceEnabled, entities };
}

/**
 * What an account configures out of band and the API cannot set, seeded into the mock: the credit
 * rates a plan's consumption mapping carries, and the raw-events meters. Without the rates the
 * examples would report tokens against features nothing converts, the wallet would never move,
 * and the SDK would (correctly) say so every run.
 */
export function seedOfflineAccount(state: MockState, demoEnv: DemoEnv): void {
  for (const [featureId, rate] of Object.entries(DEMO_CREDIT_RATES)) seedCreditRate(state, featureId, rate);
  seedDemoEventMeters(state, demoEnv);
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
  // token, and both output-side ones - thinking tokens are priced as output - like an output
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
  // reads from a file: the tenant, the agent, what to gate on, the plan a new customer starts on.
  const env = resolveStiggEnv();
  const demoEnv: DemoEnv = resolveDemoEnv(env);
  const mock = await maybeStartMockStiggServer(env.offline);
  const stigg = mock
    ? new StiggAgentSDK({ baseUrl: mock.baseUrl })
    : new StiggAgentSDK({ apiKey: requireKey(env), baseUrl: env.baseUrl });

  console.log(`Seeding Stigg: ${describeSetup(env, demoEnv)}\n`);
  try {
    const result = await prepareDemo(env, demoEnv, stigg, mock, {
      // Every agent the examples use: the shared one for gateway/orchestrator, plus one per
      // client. With no agent id configured there are none to seed, and the examples run against
      // the customer's pool instead - which is a demo too, just a flatter one.
      agents: demoEnv.agentId
        ? [demoEnv.agentId, ...CLIENT_AGENT_SUFFIXES.map((suffix) => agentIdFor(demoEnv, suffix) as string)]
        : [],
      agentLimit: numberFlag(argv, 'agent-limit', 5),
      ...(argv.includes('--team-limit') ? { teamLimit: numberFlag(argv, 'team-limit', 10) } : {}),
      cadence: argv.includes('--cadence') ? argv[argv.indexOf('--cadence') + 1] : 'P1M',
      governance: !flag(argv, 'no-governance'),
      archive: flag(argv, 'archive'),
    });

    const client = new Stigg(
      mock ? { apiKey: 'offline-mock', baseURL: mock.baseUrl } : { apiKey: requireKey(env), baseURL: env.baseUrl },
    );
    if (result.governanceEnabled && !flag(argv, 'archive')) await printTree(client, demoEnv);

    console.log('\nDone. Notes:');
    console.log('  - Budgets reset per cadence window, so a spent agent stays spent until the window rolls.');
    console.log('  - To demo again: re-run with a higher --agent-limit, or set AGENT_SDK_DEMO_AGENT_ID to a new id.');
    if (!result.governanceEnabled) {
      console.log('  - Running customer-level: denials will name the customer, not an agent.');
    }
  } finally {
    await stigg.flush({ close: true });
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
