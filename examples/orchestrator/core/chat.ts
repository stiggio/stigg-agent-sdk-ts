/**
 * The governed multi-agent chat both orchestrator examples share - everything but the graph.
 *
 * Setup, registering the agents under one parent, the one Stigg callback handler, Langfuse, the
 * chat loop and the output are the same whether the graph is LangChain's `createAgent` or a
 * hand-built LangGraph `StateGraph`; so is the Stigg integration, which is the point. Each example
 * builds its graph from the kit `runOrchestratorChat` hands it.
 */
import '../../shared/load-env';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { ChatAnthropic } from '@langchain/anthropic';
import { CallbackHandler as LangfuseCallbackHandler } from '@langfuse/langchain';
import { LangfuseSpanProcessor, isDefaultExportSpan } from '@langfuse/otel';
import { propagateAttributes, startActiveObservation } from '@langfuse/tracing';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { TavilySearch } from '@langchain/tavily';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool } from 'langchain';
import { z } from 'zod';
import {
  STIGG_TRACER_NAME,
  StiggAgentSDK,
  entitlementId,
  unitsPerTokens,
  type AccessDecision,
  type Entitlement,
  type MetricsMapper,
  type Metrics,
  type StiggContext,
} from '../../../src';
import { StiggLangChainCallbackHandler } from '../../../src/integrations/langchain';
import { maybeStartMockServer } from '../../shared/mock-server';
import { maybeStartMockStiggServer } from '../../shared/mock-stigg-server';
import { MODEL_DIMENSION, MODEL_ENTITY_TYPE, prepareDemo } from '../../shared/setup-governance';
import { describeSetup, resolveDemoEnv } from '../../shared/demo-env';
import { requireKey, resolveStiggEnv } from '../../shared/stigg-env';
import { optionalEnv } from '../../client/core/vendor';
import { AGENT_STYLES, logAs, logBlocked, logRefused, paint } from './style';

export const MODEL = process.env.AGENT_SDK_ANTHROPIC_MODEL ?? 'claude-opus-5';
/** LangGraph's default of 25 counts steps, and every middleware hook is one - too few for these graphs. */
export const RECURSION_LIMIT = 150;
/** Uncapped, one "research" reply runs to thousands of tokens and a minute and a half. */
const MAX_OUTPUT_TOKENS = 1_500;
/** The guard rail: calls of any one tool per agent per run. */
export const MAX_CALLS_PER_TOOL = 5;
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
};

/**
 * The handoff chat's agents. Per-entity usage is whole units, so each call is at least a credit;
 * the researcher runs dry in turn four offline.
 */
export const HANDOFF_CAST: ChatCast = {
  agents: {
    lead: { budget: 100 },
    researcher: { budget: 10 },
    writer: { budget: 20 },
    generalist: { budget: 20 },
  },
  searcher: 'researcher',
  description: 'Chatting with a lead agent and its subagents',
  parent: 'agent-orchestrator',
};

/** An agent's last reply. `.text`, because a thinking model replies in blocks. */
export const lastText = (messages: BaseMessage[]): string => messages.at(-1)?.text ?? '';

/** This run's messages: everything after the last user message. */
export function thisRun(messages: BaseMessage[]): BaseMessage[] {
  let start = messages.length;
  while (start > 0 && !HumanMessage.isInstance(messages[start - 1])) start -= 1;
  return messages.slice(start);
}

/** Logs a model call's start and end, so a long answer does not read as a hang. */
export async function timedModelCall(
  agent: string,
  call: number,
  run: () => Promise<AIMessage>,
  model = MODEL,
): Promise<AIMessage> {
  const at = Date.now();
  logAs(agent, paint('dim', `model call #${call} - waiting for ${model}…`));
  const reply = await run();
  const usage = reply.usage_metadata;
  logAs(
    agent,
    paint(
      'dim',
      `model call #${call} - ${usage?.input_tokens ?? 0} in / ${usage?.output_tokens ?? 0} out tokens, ${Date.now() - at}ms`,
    ),
  );
  return reply;
}

/** The line a fallback announces itself with, and the note its answer carries. */
export function anotherPass(agent: string, decision: AccessDecision, fallback: string): string {
  logAs(
    'lead',
    `  ${paint(['yellow', 'bold'], 'another pass')} - ` +
      paint('yellow', `${agent} refused (${decision.reason ?? 'denied'} by ${decision.deniedBy ?? 'policy'}), `) +
      `${paint('yellow', 'asking the')} ${paint([AGENT_STYLES[fallback] ?? 'gray', 'bold'], fallback)} ` +
      paint('yellow', 'instead, without search'),
  );
  return `(From general knowledge - the ${agent} was refused by Stigg, so nothing here is sourced.) `;
}

/** A tool call, as a model issued it. */
type ToolCall = { name: string; id?: string };

const failedTool = (call: ToolCall, content: string) =>
  new ToolMessage({ content, tool_call_id: call.id ?? '', name: call.name, status: 'error' });

/** A tool Stigg refused, handed back to the model as the tool's result, so the agent carries on. */
export function refusedTool(agent: string, call: ToolCall, decision: AccessDecision): ToolMessage {
  logRefused(agent, call.name, decision);
  return failedTool(call, `${call.name} was refused: ${decision.message}`);
}

/** A tool call past the guard rail, answered without running. */
export function blockedTool(agent: string, call: ToolCall): ToolMessage {
  logBlocked(agent, call.name, `over ${MAX_CALLS_PER_TOOL} calls this run`);
  return failedTool(call, `${call.name} was not run: over ${MAX_CALLS_PER_TOOL} calls this run.`);
}

/** A stand-in search when there is no Tavily key. Nothing leaves the process. */
const webSearch = tool(
  ({ query }) => `Top result for "${query}": per-agent token spend is the usual first metric to track.`,
  {
    name: 'web_search',
    description: 'Search the web and return the top result.',
    schema: z.object({ query: z.string() }),
  },
);

export const PROMPTS = {
  lead:
    'You are the lead. You do not research or write yourself: delegate to the researcher, then ' +
    'to the writer with what the researcher found, and return the writer’s answer. If the ' +
    'findings say they come from general knowledge, tell the writer, so the answer says it is not sourced.',
  leadBrief: 'You are the lead. Turn the request into a short research brief for the researcher.',
  researcher: (search: string) =>
    `You are the researcher. Use ${search}, then summarise what you found, citing sources.`,
  writer: 'You are the writer. Turn the findings you are given into a short, clear answer.',
  generalist:
    'You are a generalist. You have no search: answer the brief from your own knowledge, briefly, ' +
    'and say plainly that what you give is not sourced.',
};

/**
 * A unit per `tokens` tokens. A credit currency takes the fraction; a feature's usage report takes
 * whole numbers only, so there each call rounds up rather than being rejected.
 */
const perTokens = (entitlement: Entitlement, tokens: number): MetricsMapper => {
  const units = unitsPerTokens(entitlementId(entitlement), tokens);
  if (entitlement.currencyId) return units;
  return (measurement) =>
    Object.fromEntries(Object.entries(units(measurement)).map(([id, value]) => [id, Math.ceil(value)]));
};

/** How many results a search returned: Tavily lists them, the canned search returns one. */
const resultsIn = (output: unknown): number => {
  const results = (output as { results?: unknown } | undefined)?.results;
  return Array.isArray(results) ? results.length : 1;
};

/** What a graph gets to build itself with. */
export type OrchestratorKit = {
  stigg: StiggAgentSDK;
  /** The chat's model, `MODEL`. */
  model: ChatAnthropic;
  /** Another Anthropic model, set up the same way - live or against the offline mock. */
  modelNamed(name: string): ChatAnthropic;
  /**
   * A call's config with that model's `stiggContext`: the model as a dimension, which its scoped
   * budget is matched by, and the price the calling agent pays for it. The handler lays it over the
   * run's own.
   */
  asModel(agent: string, model: string, config: RunnableConfig): RunnableConfig;
  search: typeof webSearch | TavilySearch;
};

/** A graph, as the chat drives it: one turn in, the conversation so far out. */
export type OrchestratorGraph = {
  turn(
    history: BaseMessage[],
    request: string,
    config: { recursionLimit: number; callbacks: BaseCallbackHandler[]; metadata: Record<string, unknown> },
  ): Promise<{ messages: BaseMessage[] }>;
};

/**
 * Optional Langfuse tracing beside Stigg. Both trace through OpenTelemetry, so one provider carries
 * both; Langfuse's filter is widened to keep Stigg's `stigg.check` / `stigg.ingest` spans. Off
 * without both keys, and when forced offline, so tests never send traces.
 */
type Langfuse = NonNullable<ReturnType<typeof startLangfuse>>;

function startLangfuse() {
  const publicKey = optionalEnv('AGENT_SDK_LANGFUSE_PUBLIC_KEY', 'LANGFUSE_PUBLIC_KEY');
  const secretKey = optionalEnv('AGENT_SDK_LANGFUSE_SECRET_KEY', 'LANGFUSE_SECRET_KEY');
  const baseUrl = optionalEnv('AGENT_SDK_LANGFUSE_BASE_URL', 'LANGFUSE_BASE_URL') ?? 'https://cloud.langfuse.com';
  const forcedOffline = ['1', 'true', 'yes'].includes((process.env.AGENT_SDK_OFFLINE ?? '').toLowerCase());
  if (!publicKey || !secretKey || forcedOffline) return undefined;

  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    shouldExportSpan: ({ otelSpan }) =>
      isDefaultExportSpan(otelSpan) || otelSpan.instrumentationScope.name === STIGG_TRACER_NAME,
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  provider.register();
  return {
    baseUrl,
    sessionId: `chat-${randomUUID()}`,
    handler: (sessionId: string, userId: string) => new LangfuseCallbackHandler({ sessionId, userId }),
    /** One turn - the graph's spans and Stigg's - as one trace. */
    turn: <T extends { messages: BaseMessage[] }>(
      input: string,
      sessionId: string,
      userId: string,
      run: () => Promise<T>,
    ): Promise<T> =>
      propagateAttributes({ sessionId, userId, tags: ['stigg-agent-sdk'] }, () =>
        startActiveObservation(
          'chat-turn',
          async (observation) => {
            observation.update({ input });
            try {
              const result = await run();
              observation.update({ output: lastText(result.messages) });
              return result;
            } catch (err) {
              observation.update({ level: 'ERROR', statusMessage: String(err) });
              throw err;
            }
          },
          { asType: 'agent' },
        ),
      ),
    /** Flush before exit. A tracing failure is reported, never thrown. */
    shutdown: async () => {
      try {
        await processor.forceFlush();
        await provider.shutdown();
      } catch (err) {
        console.log(
          paint(
            'yellow',
            `langfuse - traces were not delivered to ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    },
  };
}

type DemoEnv = ReturnType<typeof resolveDemoEnv>;
type Tally = Record<string, { checks: number; ingested: number; failed: number }>;
const agentIdOf = (agent: string) => `agent-${agent}`;
/** The parent's budget: just above what its agents could spend together, so it caps the graph. */
const parentBudget = (cast: ChatCast) =>
  Object.values(cast.agents).reduce((sum, agent) => sum + totalBudget(agent), 0) + 10;
/** What an agent may spend in all: its budget, or its models' together. */
const totalBudget = (agent: ChatCast['agents'][string]) =>
  'models' in agent ? Object.values(agent.models).reduce((sum, { budget }) => sum + budget, 0) : agent.budget;

/**
 * Registers the parent, then each agent under it - once at startup, idempotent. No `deregister`:
 * these agents outlive a turn. A parent and a budget need an entitlement.
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
    if (!('models' in budgets)) {
      await register(agentIdOf(agent), `${agent} (${framework})`, budgets.budget, cast.parent);
      continue;
    }
    // Its whole budget first: the scoped ones below cover only the models they name, so a call
    // naming no model, or another one, is capped here.
    await register(agentIdOf(agent), `${agent} (${framework})`, totalBudget(budgets), cast.parent);
    // A budget per model: each model an entity of the dimensional type, and the agent holding one
    // budget scoped to each - registered once per scope, since each is its own assignment.
    for (const [model, { budget }] of Object.entries(budgets.models)) {
      await stigg.register({
        customerId: demoEnv.customerId,
        defaultPlanId: demoEnv.planId,
        agentId: model,
        entityTypeId: MODEL_ENTITY_TYPE,
      });
      await stigg.register({
        customerId: demoEnv.customerId,
        agentId: agentIdOf(agent),
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
 * The one handler for the graph: the shared context once, each agent's own under `agents`, by the
 * name its framework knows it by. The customer is not here - it rides each `invoke`. Its hooks
 * print every check and report, and tally them per agent for the summary.
 */
function createStiggHandler(stigg: StiggAgentSDK, demoEnv: DemoEnv, cast: ChatCast, searchName: string) {
  const { agentType, entitlement } = demoEnv;
  const tally: Tally = {};
  const tallyOf = (agent = 'customer') => (tally[agent] ??= { checks: 0, ingested: 0, failed: 0 });
  const stiggLine = (agent: string | undefined, line: string) =>
    logAs(agent, `  ${paint(['blueBright', 'bold'], 'stigg')} ${line}`);
  // The researcher's search is a paid tool, priced by what it found: a credit per result.
  const paidSearch = entitlement && {
    [searchName]: {
      entitlement,
      usage: ({ output }: { output: unknown }) => ({ [entitlementId(entitlement)]: resultsIn(output) }),
    },
  };

  const handler = new StiggLangChainCallbackHandler({
    stigg,
    stiggContext: {
      attributionKey: agentType?.attributionKey,
      // Named, every call is checked; left out, the handler only meters.
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
            agentId: agentType ? agentIdOf(agent) : undefined,
            // Its own price, when it has one: the same work costs this agent more. A price per model
            // is the model call's own, in its `stiggContext` - see `asModel`.
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
  });
  return { handler, tally };
}

/** Who is governed and how, then the chat's own header. */
function printBanner(
  framework: string,
  demoEnv: DemoEnv,
  cast: ChatCast,
  searchIsCanned: boolean,
  langfuse: Langfuse | undefined,
) {
  const { agentType, entitlement } = demoEnv;
  const agentNames = Object.keys(cast.agents);
  const agents = agentNames.map(agentIdOf);
  console.log(
    !entitlement
      ? `\n${paint(['yellow', 'bold'], 'metering mode:')} no entitlement, so nothing is checked - every call is ingested for ` +
          (agentType ? agents.join(', ') : `customer ${demoEnv.customerId}, with no agent attributed`)
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
  console.log(
    paint(
      'dim',
      `${cast.description}` +
        (cast.searcher
          ? `, at most ${MAX_CALLS_PER_TOOL} calls per tool per run, searching with ` +
            `${searchIsCanned ? 'a canned stand-in (no Tavily key, or offline)' : 'Tavily'}`
          : '') +
        `. Type "exit", "quit" or an empty line to end.`,
    ),
  );
  console.log(
    langfuse
      ? `${paint(['magenta', 'bold'], 'langfuse')} ${paint('dim', `tracing to ${langfuse.baseUrl}, session ${langfuse.sessionId}`)}\n`
      : `${paint('dim', 'langfuse - not tracing (no AGENT_SDK_LANGFUSE_PUBLIC_KEY / _SECRET_KEY, or offline)')}\n`,
  );
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

/** The governed chat around a graph built by `build`. */
export async function runOrchestratorChat(
  framework: string,
  cast: ChatCast,
  build: (kit: OrchestratorKit) => OrchestratorGraph,
): Promise<void> {
  const apiKey = optionalEnv('AGENT_SDK_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY');
  // First, so its provider exists before the first span.
  const langfuse = startLangfuse();
  const env = resolveStiggEnv();
  // Both optional: no entitlement meters without checking; no agent type runs at the customer level.
  const demoEnv = resolveDemoEnv(env);
  const mock = await maybeStartMockServer(apiKey);
  const stiggMock = await maybeStartMockStiggServer(env.offline);
  console.log(paint('dim', `[governance] ${describeSetup(env, demoEnv)}`));

  // 1. Init, once.
  const stigg = stiggMock
    ? new StiggAgentSDK({ baseUrl: stiggMock.baseUrl })
    : new StiggAgentSDK({ apiKey: requireKey(env), baseUrl: env.baseUrl });
  // 2. What the demo needs in Stigg, created if missing - the plan included, which the customer is
  //    provisioned onto by its first register. The team dwarfs the agents, so a refusal comes from
  //    an agent.
  await prepareDemo(env, demoEnv, stigg, stiggMock, {
    agents: [],
    teamLimit: 1_000,
    log: (line) => console.log(paint('dim', `[setup]${line}`)),
  });
  // 3. Register the agents, once.
  await registerAgents(stigg, demoEnv, cast, framework);

  // Real search only behind a real model - the mock's queries are canned.
  const tavilyApiKey = optionalEnv('AGENT_SDK_TAVILY_API_KEY', 'TAVILY_API_KEY');
  const search = tavilyApiKey && !mock ? new TavilySearch({ maxResults: 3, tavilyApiKey }) : webSearch;
  const modelNamed = (name: string) =>
    new ChatAnthropic({
      model: name,
      apiKey: apiKey ?? 'offline-mock',
      anthropicApiUrl: mock?.baseUrl,
      maxTokens: MAX_OUTPUT_TOKENS,
    });

  // 3. One handler for the graph.
  const { handler: stiggHandler, tally } = createStiggHandler(stigg, demoEnv, cast, search.name);
  const asModel = (agent: string, model: string, config: RunnableConfig): RunnableConfig => {
    const budgets = cast.agents[agent];
    const tokensPerCredit = budgets && 'models' in budgets ? budgets.models[model]?.tokensPerCredit : undefined;
    const stiggContext: StiggContext = {
      dimensions: { [MODEL_DIMENSION]: model },
      ...(demoEnv.entitlement && tokensPerCredit
        ? { usageMapper: perTokens(demoEnv.entitlement, tokensPerCredit) }
        : {}),
    };
    return { ...config, metadata: { ...config.metadata, stiggContext } };
  };
  const graph = build({ stigg, model: modelNamed(MODEL), modelNamed, asModel, search });
  printBanner(framework, demoEnv, cast, search === webSearch, langfuse);

  let history: BaseMessage[] = [];
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
        // 4. Per run: the handler and the customer, handed by LangChain to every call beneath.
        const config = {
          recursionLimit: RECURSION_LIMIT,
          callbacks: langfuse
            ? [stiggHandler, langfuse.handler(langfuse.sessionId, demoEnv.customerId)]
            : [stiggHandler],
          metadata: { stiggContext: { customerId: demoEnv.customerId } },
        };
        const run = () => graph.turn(history, line, config);
        const { messages } = langfuse
          ? await langfuse.turn(line, langfuse.sessionId, demoEnv.customerId, run)
          : await run();
        history = messages;
        console.log(`\n${paint(['cyan', 'bold'], 'assistant>')} ${lastText(messages)}\n`);
      } catch (err) {
        // The lead itself was refused: the turn ends with the remedy and is not kept in history.
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
    await langfuse?.shutdown();
  }
  console.log(paint('dim', '\nConversation ended.'));
}

/** Entry point for the examples beside this one. */
export function startOrchestratorChat(
  framework: string,
  cast: ChatCast,
  build: (kit: OrchestratorKit) => OrchestratorGraph,
): void {
  runOrchestratorChat(framework, cast, build).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

/** `credits=0.25 input_tokens=900`. */
const describeMetrics = (metrics: Metrics): string =>
  Object.entries(metrics)
    .map(([name, value]) => `${name}=${Math.round(value * 1000) / 1000}`)
    .join(' ') || 'nothing';
