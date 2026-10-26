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
} from '../../../src';
import { StiggLangChainCallbackHandler } from '../../../src/integrations/langchain';
import { maybeStartMockServer } from '../../shared/mock-server';
import { maybeStartMockStiggServer } from '../../shared/mock-stigg-server';
import { seedMock } from '../../shared/setup-governance';
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
/** Each agent's budget. Per-entity usage is whole units; the researcher runs dry in turn four offline. */
export const BUDGETS = { lead: 100, researcher: 10, writer: 20, generalist: 20 } as const;
export type AgentName = keyof typeof BUDGETS;
/** The parent every agent is registered under: it caps the graph, just above the agents' sum. */
const PARENT_AGENT = 'agent-orchestrator';
const PARENT_BUDGET = 160;
const EXIT_WORDS = new Set(['exit', 'quit', '']);

/** An agent's last reply. `.text`, because a thinking model replies in blocks. */
export const lastText = (messages: BaseMessage[]): string => messages.at(-1)?.text ?? '';

/** This run's messages: everything after the last user message. */
export function thisRun(messages: BaseMessage[]): BaseMessage[] {
  let start = messages.length;
  while (start > 0 && !HumanMessage.isInstance(messages[start - 1])) start -= 1;
  return messages.slice(start);
}

/** Logs a model call's start and end, so a long answer does not read as a hang. */
export async function timedModelCall(agent: string, call: number, run: () => Promise<AIMessage>): Promise<AIMessage> {
  const at = Date.now();
  logAs(agent, paint('dim', `model call #${call} - waiting for ${MODEL}…`));
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
 * A unit per thousand tokens. A credit currency takes the fraction; a feature's usage report takes
 * whole numbers only, so there each call rounds up rather than being rejected.
 */
const perThousandTokens = (entitlement: Entitlement): MetricsMapper => {
  const units = unitsPerTokens(entitlementId(entitlement), 1_000);
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
  model: ChatAnthropic;
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
const agentNames = Object.keys(BUDGETS) as AgentName[];
const agentIdOf = (agent: AgentName) => `agent-${agent}`;

/**
 * Registers the parent, then each agent under it - once at startup, idempotent. No `deregister`:
 * these agents outlive a turn. A parent and a budget need an entitlement.
 */
async function registerAgents(stigg: StiggAgentSDK, demoEnv: DemoEnv, framework: string): Promise<void> {
  const { agentType, entitlement } = demoEnv;
  if (!agentType) return;
  const register = (agentId: string, displayName: string, limit: number, parentId: string | null) =>
    stigg.register({
      customerId: demoEnv.customerId,
      agentId,
      entityTypeId: agentType.entityTypeId,
      displayName,
      ...(entitlement ? { budget: { entitlement, parentId, limit, cadence: 'P1M' } } : {}),
    });
  await register(PARENT_AGENT, `Orchestrator (${framework})`, PARENT_BUDGET, demoEnv.teamId ?? null);
  for (const agent of agentNames) {
    await register(agentIdOf(agent), `${agent} (${framework})`, BUDGETS[agent], PARENT_AGENT);
  }
}

/**
 * The one handler for the graph: the shared context once, each agent's own under `agents`, by the
 * name its framework knows it by. The customer is not here - it rides each `invoke`. Its hooks
 * print every check and report, and tally them per agent for the summary.
 */
function createStiggHandler(stigg: StiggAgentSDK, demoEnv: DemoEnv, searchName: string) {
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
      usageMapper: entitlement && perThousandTokens(entitlement),
      eventName: demoEnv.ingestEventName,
      // Sync, so the next check sees this call's spend.
      ingestMode: 'sync',
    },
    agents: Object.fromEntries(
      agentNames.map((agent) => [
        agent,
        {
          stiggContext: agentType ? { agentId: agentIdOf(agent) } : undefined,
          tools: agent === 'researcher' && paidSearch ? paidSearch : undefined,
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
function printBanner(framework: string, demoEnv: DemoEnv, searchIsCanned: boolean, langfuse: Langfuse | undefined) {
  const { agentType, entitlement } = demoEnv;
  const agents = agentNames.map(agentIdOf);
  console.log(
    !entitlement
      ? `\n${paint(['yellow', 'bold'], 'metering mode:')} no entitlement, so nothing is checked - every call is ingested for ` +
          (agentType ? agents.join(', ') : `customer ${demoEnv.customerId}, with no agent attributed`)
      : agentType
        ? `\n${paint('bold', PARENT_AGENT)} limit=${paint('bold', String(PARENT_BUDGET))} ${paint('dim', '- parent of:')}\n  ${agentNames
            .map(
              (agent, n) =>
                `${paint([AGENT_STYLES[agent]!, 'bold'], agents[n]!)} limit=${paint('bold', String(BUDGETS[agent]))}`,
            )
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
      `Chatting with a lead agent and its subagents on ${MODEL}, at most ${MAX_CALLS_PER_TOOL} calls per tool ` +
        `per run, searching with ${searchIsCanned ? 'a canned stand-in (no Tavily key, or offline)' : 'Tavily'}. ` +
        `Type "exit", "quit" or an empty line to end.`,
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
  if (stiggMock) {
    // Team and pool dwarf the agents' budgets, so a refusal comes from an agent.
    await seedMock(demoEnv, stiggMock, { agents: [], teamLimit: 1_000, poolMin: 10_000, log: () => undefined });
  }
  console.log(paint('dim', `[governance] ${describeSetup(env, demoEnv)}`));

  // 1. Init, once. 2. Register the agents, once.
  const stigg = stiggMock
    ? new StiggAgentSDK({ baseUrl: stiggMock.baseUrl })
    : new StiggAgentSDK({ apiKey: requireKey(env), baseUrl: env.baseUrl });
  await registerAgents(stigg, demoEnv, framework);

  // Real search only behind a real model - the mock's queries are canned.
  const tavilyApiKey = optionalEnv('AGENT_SDK_TAVILY_API_KEY', 'TAVILY_API_KEY');
  const search = tavilyApiKey && !mock ? new TavilySearch({ maxResults: 3, tavilyApiKey }) : webSearch;
  const model = new ChatAnthropic({
    model: MODEL,
    apiKey: apiKey ?? 'offline-mock',
    anthropicApiUrl: mock?.baseUrl,
    maxTokens: MAX_OUTPUT_TOKENS,
  });

  // 3. One handler for the graph.
  const { handler: stiggHandler, tally } = createStiggHandler(stigg, demoEnv, search.name);
  const graph = build({ stigg, model, search });
  printBanner(framework, demoEnv, search === webSearch, langfuse);

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
          metadata: { stiggCustomerId: demoEnv.customerId },
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
export function startOrchestratorChat(framework: string, build: (kit: OrchestratorKit) => OrchestratorGraph): void {
  runOrchestratorChat(framework, build).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

/** `credits=0.25 input_tokens=900`. */
const describeMetrics = (metrics: Metrics): string =>
  Object.entries(metrics)
    .map(([name, value]) => `${name}=${Math.round(value * 1000) / 1000}`)
    .join(' ') || 'nothing';
