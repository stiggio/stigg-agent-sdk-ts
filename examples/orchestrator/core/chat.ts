/**
 * The governed multi-agent chat every orchestrator example shares - everything but the orchestrator.
 *
 * Setup, registering the agents under one parent, the Stigg options for the graph, the chat loop
 * and the output are the same whether the graph is LangChain's, LangGraph's or Google ADK's; so is
 * the Stigg integration, which is the point. Only how those options attach differs - a LangChain
 * callback handler, an ADK Runner plugin - and each orchestrator brings its own, in `start`.
 */
import '../../shared/load-env';
import { createInterface } from 'node:readline';
import {
  StiggAgentSDK,
  entitlementId,
  unitsPerTokens,
  type Entitlement,
  type MetricsMapper,
  type Metrics,
  type MiddlewareOptions,
} from '../../../src';
import { maybeStartMockServer } from '../../shared/mock-server';
import { maybeStartMockStiggServer } from '../../shared/mock-stigg-server';
import { MODEL_ENTITY_TYPE, modelRefId, prepareDemo } from '../../shared/setup-governance';
import { describeSetup, resolveDemoEnv } from '../../shared/demo-env';
import { requireKey, resolveStiggEnv } from '../../shared/stigg-env';
import { AGENT_STYLES, logAs, paint } from './style';

const EXIT_WORDS = new Set(['exit', 'quit', '']);

/** A budget, and - when it is not the default of a credit per thousand tokens - what a credit buys. */
type Priced = { budget: number; tokensPerCredit?: number };

/** Who a chat governs, and how - each example's own; the rest of the chat is shared. */
export type ChatCast = {
  /**
   * Each agent, by the name the graph knows it by: its budget and price - or, with `models`, a
   * budget and price per model it calls, scoped to that model, so one model running dry leaves the
   * others open. Each call is then checked and reported with its model as a dimension.
   */
  agents: Record<string, Priced | { models: Record<string, Priced> }>;
  /** The agent whose web search is a paid tool, priced by what it found. */
  searcher?: string;
  /** One line for the banner: what the chat is. */
  description: string;
  /**
   * The parent agent every agent is registered under: it caps the graph, just above the agents'
   * sum. Each example's own, so one example's run never rewrites another's cap or shares its count.
   */
  parent: string;
  /** What each agent's id starts with, so two examples' agents of one name are not one entity. */
  agentIdPrefix?: string;
};

export type DemoEnv = ReturnType<typeof resolveDemoEnv>;

/** What an orchestrator gets to start its graph with. */
export type ChatKit = {
  stigg: StiggAgentSDK;
  demoEnv: DemoEnv;
  /** The offline model mock, running when there is no vendor key. */
  mock: { baseUrl: string } | undefined;
  /**
   * The options every binding takes - the shared context once, each agent's own by its name, the
   * searcher's `search` priced per result, and hooks that print every check and report. Hand them
   * to the orchestrator's own binding.
   */
  governance(search?: string): MiddlewareOptions;
};

/** A started graph, as the chat drives it. */
export type ChatSession = {
  /** One request in, the answer out. */
  turn(request: string): Promise<string>;
  /** Lines the banner adds after the chat's description. */
  notes?: string[];
  /** Flushes whatever the orchestrator keeps open, once the chat is over. */
  close?(): Promise<void>;
};

/** The orchestrator a chat runs. */
export type Orchestrator = {
  /** Its name, for the banner and the agents' display names. */
  framework: string;
  /** The model vendor's key. Without one, the vendor runs as the offline mock. */
  apiKey: string | undefined;
  start(kit: ChatKit): Promise<ChatSession> | ChatSession;
};

/**
 * A unit per `tokens` tokens. A credit currency takes the fraction; a feature's usage report takes
 * whole numbers only, so there each call rounds up rather than being rejected.
 */
export const perTokens = (entitlement: Entitlement, tokens: number): MetricsMapper => {
  const units = unitsPerTokens(entitlementId(entitlement), tokens);
  if (entitlement.currencyId) return units;
  return (measurement) =>
    Object.fromEntries(Object.entries(units(measurement)).map(([id, value]) => [id, Math.ceil(value)]));
};

/** How many results a search returned: a list counts its results, anything else is one. */
const resultsIn = (output: unknown): number => {
  const results = (output as { results?: unknown } | undefined)?.results;
  return Array.isArray(results) ? results.length : 1;
};

type Tally = Record<string, { checks: number; ingested: number; failed: number }>;
const agentIdOf = (cast: ChatCast, agent: string) => `${cast.agentIdPrefix ?? 'agent-'}${agent}`;
/** The parent's budget: just above what its agents could spend together, so it caps the graph. */
const parentBudget = (cast: ChatCast) =>
  Object.values(cast.agents).reduce((sum, agent) => sum + totalBudget(agent), 0) + 10;
/** What an agent may spend in all: its budget, or its models' together. */
const totalBudget = (agent: ChatCast['agents'][string]) =>
  'models' in agent ? Object.values(agent.models).reduce((sum, { budget }) => sum + budget, 0) : agent.budget;

/**
 * Registers the parent, then each agent under it - once at startup, idempotent. No `deregister`:
 * these agents outlive a turn. A parent and a budget need an entitlement. Called only when the
 * account has governance: without it there is nowhere to write them, and the server checks every
 * step against the customer's own entitlement instead.
 */
async function registerAgents(
  stigg: StiggAgentSDK,
  demoEnv: DemoEnv,
  cast: ChatCast,
  framework: string,
): Promise<void> {
  const { agentType, entitlement } = demoEnv;
  if (!agentType) return;
  const register = (agentId: string, displayName: string, limit: number, parentId: string | null) =>
    stigg.register({
      customerId: demoEnv.customerId,
      defaultPlanId: demoEnv.planId,
      agentId,
      entityTypeId: agentType.entityTypeId,
      displayName,
      ...(entitlement ? { budget: { entitlement, parentId, limit, cadence: 'P1M' } } : {}),
    });
  await register(cast.parent, `Orchestrator (${framework})`, parentBudget(cast), demoEnv.teamId ?? null);
  for (const [agent, budgets] of Object.entries(cast.agents)) {
    const agentId = agentIdOf(cast, agent);
    if (!('models' in budgets)) {
      await register(agentId, `${agent} (${framework})`, budgets.budget, cast.parent);
      continue;
    }
    // Its whole budget first: the scoped ones below cover only the models they name, so a call
    // naming no model, or another one, is capped here.
    await register(agentId, `${agent} (${framework})`, totalBudget(budgets), cast.parent);
    // A budget per model: each model an entity of the dimensional type, and the agent holding one
    // budget scoped to each - registered once per scope, since each is its own assignment.
    for (const [name, { budget }] of Object.entries(budgets.models)) {
      const model = modelRefId(name);
      await stigg.register({
        customerId: demoEnv.customerId,
        defaultPlanId: demoEnv.planId,
        agentId: model,
        entityTypeId: MODEL_ENTITY_TYPE,
      });
      await stigg.register({
        customerId: demoEnv.customerId,
        agentId,
        entityTypeId: agentType.entityTypeId,
        displayName: `${agent} (${framework})`,
        ...(entitlement
          ? { budget: { entitlement, parentId: cast.parent, limit: budget, cadence: 'P1M', scope: [model] } }
          : {}),
      });
    }
  }
}

/**
 * The options for the graph: the shared context once, each agent's own under `agents`, by the
 * name its framework knows it by. The customer is not here - each orchestrator states it per run
 * its own way. The hooks print every check and report, and tally them per agent for the summary.
 */
function governanceOptions(demoEnv: DemoEnv, cast: ChatCast, tally: Tally, search?: string): MiddlewareOptions {
  const { agentType, entitlement } = demoEnv;
  const tallyOf = (agent = 'customer') => (tally[agent] ??= { checks: 0, ingested: 0, failed: 0 });
  const stiggLine = (agent: string | undefined, line: string) =>
    logAs(agent, `  ${paint(['blueBright', 'bold'], 'stigg')} ${line}`);
  // The researcher's search is a paid tool, priced by what it found: a credit per result.
  const paidSearch = entitlement &&
    search && {
      [search]: {
        entitlement,
        usage: ({ output }: { output: unknown }) => ({ [entitlementId(entitlement)]: resultsIn(output) }),
      },
    };

  return {
    stiggContext: {
      attributionKey: agentType?.attributionKey,
      // Named, every call is checked; left out, the graph is only metered.
      entitlement,
      usageMapper: entitlement && perTokens(entitlement, 1_000),
      eventName: demoEnv.ingestEventName,
      // Sync, so the next check sees this call's spend.
      ingestMode: 'sync',
      // A customer Stigg has never seen starts on the demo plan, provisioned by the first call.
      defaultPlanId: demoEnv.planId,
    },
    agents: Object.fromEntries(
      Object.entries(cast.agents).map(([agent, budgets]) => [
        agent,
        {
          stiggContext: {
            agentId: agentType ? agentIdOf(cast, agent) : undefined,
            // Its own price, when it has one: the same work costs this agent more. A price per model
            // is the model call's own, in its `stiggContext`.
            usageMapper:
              entitlement && 'tokensPerCredit' in budgets && budgets.tokensPerCredit
                ? perTokens(entitlement, budgets.tokensPerCredit)
                : undefined,
          },
          tools: agent === cast.searcher && paidSearch ? paidSearch : undefined,
        },
      ]),
    ),
    hooks: {
      onDecision: (decision, { agent }) => {
        tallyOf(agent).checks += 1;
        const remaining = paint('dim', `remaining=${decision.remaining ?? '-'}`);
        stiggLine(
          agent,
          decision.hasAccess
            ? `${paint('green', 'check allowed')} ${remaining}`
            : `${paint(['red', 'bold'], 'check REFUSED')} ${remaining}`,
        );
      },
      onIngest: (result, { agent }) => {
        tallyOf(agent)[result.ok ? 'ingested' : 'failed'] += 1;
        const line = `ingest ${describeMetrics(result.reported)} ok=${result.ok}`;
        stiggLine(agent, paint(result.ok ? 'dim' : 'red', line));
      },
    },
  };
}

/** Who is governed and how, then the chat's own header. */
function printBanner(framework: string, demoEnv: DemoEnv, cast: ChatCast, notes: string[], governed: boolean) {
  const { agentType, entitlement } = demoEnv;
  const agentNames = Object.keys(cast.agents);
  const agents = agentNames.map((agent) => agentIdOf(cast, agent));
  console.log(
    !entitlement
      ? `\n${paint(['yellow', 'bold'], 'metering mode:')} no entitlement, so nothing is checked - every call is ingested for ` +
          (agentType ? agents.join(', ') : `customer ${demoEnv.customerId}, with no agent attributed`)
      : agentType && !governed
        ? `\nno governance on this account, so no budgets were registered - every check is against customer ${paint('bold', demoEnv.customerId)}'s own ${entitlementId(entitlement)}`
        : agentType
          ? `\n${paint('bold', cast.parent)} limit=${paint('bold', String(parentBudget(cast)))} ${paint('dim', '- parent of:')}\n  ${agentNames
              .map((agent, n) => {
                const budgets = cast.agents[agent]!;
                const limits =
                  'models' in budgets
                    ? Object.entries(budgets.models)
                        .map(([model, { budget }]) => `${model} limit=${paint('bold', String(budget))}`)
                        .join(' ')
                    : `limit=${paint('bold', String(budgets.budget))}`;
                return `${paint([AGENT_STYLES[agent] ?? 'gray', 'bold'], agents[n]!)} ${limits}`;
              })
              .join(paint('dim', '  |  '))} ${paint('dim', entitlementId(entitlement))}`
          : `\nno agent type, so every check is against customer ${paint('bold', demoEnv.customerId)}'s own ${entitlementId(entitlement)}`,
  );

  const rule = paint('dim', '─'.repeat(72));
  console.log(
    `\n${rule}\n${paint(['bold', 'blueBright'], ' Stigg')}${paint('bold', ` × ${framework}`)} ${paint('dim', '- a governed multi-agent chat')}\n${rule}`,
  );
  console.log(paint('dim', [cast.description, ...notes].join(', ') + '. Type "exit", "quit" or an empty line to end.'));
  console.log();
}

/** Each agent's checks and reports, once the chat is over. */
function printSummary(tally: Tally): void {
  for (const [agent, { checks, ingested, failed }] of Object.entries(tally)) {
    const failures = failed ? paint(['red', 'bold'], `failed=${failed}`) : paint('dim', `failed=${failed}`);
    console.log(
      `${paint('dim', '[summary]')} ${paint([AGENT_STYLES[agent] ?? 'gray', 'bold'], agent)}: ` +
        `checks=${paint('bold', String(checks))} ingested=${paint('bold', String(ingested))} ${failures}`,
    );
  }
}

/** The governed chat around the graph `orchestrator` starts. */
export async function runGovernedChat(cast: ChatCast, orchestrator: Orchestrator): Promise<void> {
  const { framework } = orchestrator;
  const env = resolveStiggEnv();
  // Both optional: no entitlement meters without checking; no agent type runs at the customer level.
  const demoEnv = resolveDemoEnv(env);
  const mock = await maybeStartMockServer(orchestrator.apiKey);
  const stiggMock = await maybeStartMockStiggServer(env.offline);
  console.log(paint('dim', `[governance] ${describeSetup(env, demoEnv)}`));

  // 1. Init, once.
  const stigg = stiggMock
    ? new StiggAgentSDK({ baseUrl: stiggMock.baseUrl })
    : new StiggAgentSDK({ apiKey: requireKey(env), baseUrl: env.baseUrl });
  // 2. What the demo needs in Stigg, created if missing - the plan included, which the customer is
  //    provisioned onto by its first register. The team dwarfs the agents, so a refusal comes from
  //    an agent.
  const { governanceEnabled } = await prepareDemo(env, demoEnv, stigg, stiggMock, {
    agents: [],
    teamLimit: 1_000,
    log: (line) => console.log(paint('dim', `[setup]${line}`)),
  });
  // 3. Register the agents, once.
  if (governanceEnabled) await registerAgents(stigg, demoEnv, cast, framework);

  // 4. The orchestrator's graph, with the Stigg options attached its own way.
  const tally: Tally = {};
  const session = await orchestrator.start({
    stigg,
    demoEnv,
    mock,
    governance: (search) => governanceOptions(demoEnv, cast, tally, search),
  });
  printBanner(framework, demoEnv, cast, session.notes ?? [], governanceEnabled);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: paint(['green', 'bold'], 'you> '),
  });
  rl.on('SIGINT', () => rl.close());

  try {
    rl.prompt();
    for await (const answer of rl) {
      const line = answer.trim();
      if (EXIT_WORDS.has(line.toLowerCase())) break;

      try {
        console.log(`\n${paint(['cyan', 'bold'], 'assistant>')} ${await session.turn(line)}\n`);
      } catch (err) {
        // The first agent itself was refused: the turn ends with the remedy.
        const decision = stigg.denial(err);
        if (!decision) throw err;
        console.log(
          `\n${paint(['cyan', 'bold'], 'assistant>')} ${paint(['red', 'bold'], `(refused by ${decision.deniedBy ?? 'policy'})`)} ` +
            `${paint('red', decision.message)}\n`,
        );
      }
      rl.prompt();
    }
  } finally {
    rl.close();
    await stigg.flush();
    printSummary(tally);
    await stigg.flush({ close: true });
    await mock?.close();
    await stiggMock?.close();
    await session.close?.();
  }
  console.log(paint('dim', '\nConversation ended.'));
}

/** Entry point for the examples beside this one. */
export function startGovernedChat(cast: ChatCast, orchestrator: Orchestrator): void {
  runGovernedChat(cast, orchestrator).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

/** `credits=0.25 input_tokens=900`. */
const describeMetrics = (metrics: Metrics): string =>
  Object.entries(metrics)
    .map(([name, value]) => `${name}=${Math.round(value * 1000) / 1000}`)
    .join(' ') || 'nothing';
