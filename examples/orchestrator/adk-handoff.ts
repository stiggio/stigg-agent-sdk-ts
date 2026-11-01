/**
 * Layer 3: a Google ADK chat in which a coordinator hands each request down a chain of sub-agents,
 * each governed as itself.
 *
 *   coordinator --transfer--> researcher (web_search) --transfer--> writer
 *                                  |                                ^
 *                                  +--refused--> generalist --------+
 *
 * One `StiggAdkPlugin` on the Runner governs every agent beneath it. ADK names the agent each model
 * and tool call belongs to, so the researcher running dry refuses the researcher's steps alone. The
 * customer is resolved from the invocation's user, on the server - ADK has no per-run metadata.
 *
 * A refused tool comes back as a result the model reads. A refused model call is answered by
 * `onRefusal`: here a refused researcher hands the turn to a generalist, which answers from what it
 * knows and passes it on to the writer - the ADK counterpart of the LangGraph example's edge.
 * `stiggPlugin.denialOf(event)` finds the decision behind either.
 *
 * The coordinator answers small talk itself and sends questions down the chain. The sub-agents may
 * not transfer back up, so every message starts at the coordinator - ADK would otherwise resume the
 * chat at the last agent that answered - and the writer is the end of the chain. The researcher's
 * budget lasts three questions.
 *
 * Without a Gemini key it runs against the offline mock, which calls each function on offer in turn
 * - so the whole chain runs with no model behind it.
 *
 * Run:  yarn example-orchestrator-adk-handoff
 */
import '../shared/load-env';
import { createInterface } from 'node:readline';
import { FunctionTool, Gemini, InMemoryRunner, LlmAgent, LogLevel, setLogLevel, type Event } from '@google/adk';
import { z } from 'zod';
import { StiggAgentSDK, entitlementId, unitsPerTokens, type Metrics } from '../../src';
import { StiggAdkPlugin } from '../../src/integrations/adk';
import { optionalEnv } from '../client/core/vendor';
import { describeSetup, resolveDemoEnv } from '../shared/demo-env';
import { maybeStartMockServer } from '../shared/mock-server';
import { maybeStartMockStiggServer } from '../shared/mock-stigg-server';
import { prepareDemo } from '../shared/setup-governance';
import { requireKey, resolveStiggEnv } from '../shared/stigg-env';
import { logAs, logRefused, logToolCall, paint, preview } from './core/style';

const MODEL = process.env.AGENT_SDK_GEMINI_MODEL || 'gemini-3.8-flash';
const APP = 'adk-handoff';
const EXIT_WORDS = new Set(['exit', 'quit', '']);

/** Each agent's budget in credits. Offline, the researcher spends three a request: two calls and a search. */
const BUDGETS: Record<string, number> = { coordinator: 50, researcher: 10, writer: 50, generalist: 50 };
const PARENT = 'agent-adk-handoff';
const agentIdOf = (agent: string) => `agent-adk-${agent}`;

/** A stand-in search: what a real one costs is the point, not what it finds. */
const webSearch = new FunctionTool({
  name: 'web_search',
  description: 'Search the web and return the top result.',
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => ({
    results: [`Top result for "${query}": per-agent token spend is the usual first metric to track.`],
  }),
});

/** `credits=1 input_tokens=900`. */
const describeMetrics = (metrics: Metrics): string =>
  Object.entries(metrics)
    .map(([id, value]) => `${id}=${value}`)
    .join(' ') || '(nothing)';

/** What one event says, as a line of the agent's trace. */
function logEvent(event: Event, stiggPlugin: StiggAdkPlugin): void {
  const agent = event.author ?? 'unknown';
  const decision = stiggPlugin.denialOf(event);
  if (decision && event.errorCode) {
    logAs(agent, `  ${paint(['red', 'bold'], 'REFUSED')} - ${paint('red', decision.message)}`);
    return;
  }
  for (const part of event.content?.parts ?? []) {
    const { functionCall, functionResponse } = part;
    if (functionCall?.name === 'transfer_to_agent' && decision) {
      logAs(
        agent,
        `  ${paint(['red', 'bold'], 'REFUSED')} - ${paint('red', `${decision.reason ?? 'denied'} by ${decision.deniedBy ?? 'policy'}`)}, ` +
          `${paint('yellow', 'hands off to')} ${paint('bold', String(functionCall.args?.agent_name))}`,
      );
    } else if (functionCall?.name === 'transfer_to_agent') {
      logAs(agent, `  ${paint('blue', 'hands off to')} ${paint('bold', String(functionCall.args?.agent_name))}`);
    } else if (functionCall?.name) {
      logToolCall(agent, functionCall.name, functionCall.args);
    } else if (functionResponse?.name && decision) {
      logRefused(agent, functionResponse.name, decision);
    } else if (part.text && !part.thought) {
      logAs(agent, `${paint('bold', 'says')} - ${paint('italic', preview(part.text))}`);
    }
  }
}

async function main(): Promise<void> {
  // ADK logs every model request at INFO; the trace below says what happened instead.
  setLogLevel(LogLevel.WARN);
  const apiKey = optionalEnv('AGENT_SDK_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY');
  const env = resolveStiggEnv();
  const demoEnv = resolveDemoEnv(env);
  const { agentType, entitlement } = demoEnv;
  const mock = await maybeStartMockServer(apiKey);
  // ADK builds its own Gemini client, which reads its base URL from the environment.
  if (mock) process.env.GOOGLE_GEMINI_BASE_URL = mock.baseUrl;
  const stiggMock = await maybeStartMockStiggServer(env.offline);
  console.log(paint('dim', `[governance] ${describeSetup(env, demoEnv)}`));

  // 1. Init, once - and what the demo needs in Stigg, created if missing.
  const stigg = stiggMock
    ? new StiggAgentSDK({ baseUrl: stiggMock.baseUrl })
    : new StiggAgentSDK({ apiKey: requireKey(env), baseUrl: env.baseUrl });
  const { governanceEnabled } = await prepareDemo(env, demoEnv, stigg, stiggMock, {
    agents: [],
    teamLimit: 1_000,
    log: (line) => console.log(paint('dim', `[setup]${line}`)),
  });

  // 2. Register the agents under one parent, once. Without governance there is nowhere to write a
  //    budget, so every step is governed at the customer level instead.
  if (agentType && governanceEnabled) {
    const register = (agentId: string, displayName: string, limit: number, parentId: string | null) =>
      stigg.register({
        customerId: demoEnv.customerId,
        defaultPlanId: demoEnv.planId,
        agentId,
        entityTypeId: agentType.entityTypeId,
        displayName,
        ...(entitlement ? { budget: { entitlement, parentId, limit, cadence: 'P1M' } } : {}),
      });
    const total = Object.values(BUDGETS).reduce((sum, limit) => sum + limit, 0);
    await register(PARENT, 'Orchestrator (ADK)', total + 10, demoEnv.teamId ?? null);
    for (const [agent, limit] of Object.entries(BUDGETS)) {
      await register(agentIdOf(agent), `${agent} (ADK)`, limit, PARENT);
    }
  }

  // 3. The agents - plain ADK.
  const model = new Gemini({ model: MODEL, apiKey: apiKey ?? 'offline-mock' });
  const writer = new LlmAgent({
    name: 'writer',
    model,
    description: 'Turns research notes into a short, clear answer.',
    instruction: 'Rewrite the research notes as a three-sentence answer to the request.',
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
  });
  const researcher = new LlmAgent({
    name: 'researcher',
    model,
    description: 'Looks things up on the web.',
    instruction: 'Use web_search, summarise what you found, then transfer to writer.',
    tools: [webSearch],
    disallowTransferToParent: true,
  });
  const generalist = new LlmAgent({
    name: 'generalist',
    model,
    description: 'Answers from general knowledge, with no search, when the researcher cannot.',
    instruction:
      "The researcher could not take the user's last message. Answer it in two sentences from what " +
      'you know, say the answer is not sourced, then transfer to writer.',
    disallowTransferToParent: true,
  });
  const coordinator = new LlmAgent({
    name: 'coordinator',
    model,
    instruction:
      'Answer greetings and small talk yourself, in one sentence. Transfer any question that needs ' +
      'facts to researcher.',
    // The researcher hands on to the writer, the first peer it can reach - and the generalist, last,
    // only steps in when `onRefusal` sends it the turn.
    subAgents: [researcher, writer, generalist],
  });

  // 4. One plugin for the graph: the shared context once, each agent's own by its ADK name.
  const stiggLine = (agent: string | undefined, line: string) =>
    logAs(agent, `  ${paint(['blueBright', 'bold'], 'stigg')} ${line}`);
  const stiggPlugin = new StiggAdkPlugin({
    stigg,
    stiggContext: {
      attributionKey: agentType?.attributionKey,
      // Named, every step is checked; left out, the plugin only meters.
      entitlement,
      usageMapper: entitlement && unitsPerTokens(entitlementId(entitlement), 1_000),
      eventName: demoEnv.ingestEventName,
      // Sync, so the next check sees this step's spend.
      ingestMode: 'sync',
      // A customer Stigg has never seen starts on the demo plan, provisioned by the first call.
      defaultPlanId: demoEnv.planId,
    },
    agents: Object.fromEntries(
      Object.keys(BUDGETS).map((agent) => [
        agent,
        { stiggContext: { agentId: agentType ? agentIdOf(agent) : undefined } },
      ]),
    ),
    // The researcher's search is a priced tool: a credit a search.
    tools: entitlement ? { web_search: entitlement } : undefined,
    // The customer, decided on the server from the invocation - here, the user is the demo customer.
    // ADK's own API server lets the client choose `userId`: use it only when your server sets it from the login.
    stepContext: ({ adkContext }) => ({ customerId: adkContext.userId }),
    // The graph's decision on a refusal: the researcher's turn goes to the generalist instead of
    // ending; any other agent's ends in an error event.
    onRefusal: ({ agent }) => (agent === 'researcher' ? { transferTo: 'generalist' } : undefined),
    hooks: {
      onDecision: (decision, { agent }) =>
        stiggLine(
          agent,
          `${decision.hasAccess ? paint('green', 'check allowed') : paint(['red', 'bold'], 'check REFUSED')} ` +
            paint('dim', `remaining=${decision.remaining ?? '-'}`),
        ),
      onIngest: (result, { agent }) =>
        stiggLine(
          agent,
          paint(result.ok ? 'dim' : 'red', `ingest ${describeMetrics(result.reported)} ok=${result.ok}`),
        ),
    },
  });

  const runner = new InMemoryRunner({ agent: coordinator, appName: APP, plugins: [stiggPlugin] });
  const userId = demoEnv.customerId;
  const session = await runner.sessionService.createSession({ appName: APP, userId });

  const rule = paint('dim', '─'.repeat(72));
  console.log(`\n${rule}\n${paint(['bold', 'blueBright'], ' Stigg')}${paint('bold', ' × Google ADK')}\n${rule}`);
  console.log(
    paint(
      'dim',
      `coordinator -> researcher -> writer on ${MODEL}, a generalist standing in for a refused researcher. ` +
        'Type "exit", "quit" or an empty line to end.',
    ),
  );

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
      // 5. Per request: the plugin is already on the Runner, so a run is plain ADK.
      for await (const event of runner.runAsync({
        userId,
        sessionId: session.id,
        newMessage: { role: 'user', parts: [{ text: line }] },
      })) {
        logEvent(event, stiggPlugin);
      }
      rl.prompt();
    }
  } finally {
    rl.close();
    await stigg.flush({ close: true });
    await mock?.close();
    await stiggMock?.close();
  }
  console.log(paint('dim', '\nConversation ended.'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
