/**
 * The LangChain side of the governed chat, which the LangChain and LangGraph examples share: the
 * model, the search, the prompts, Langfuse, and the one `StiggLangChainCallbackHandler` that carries
 * the chat's Stigg options to every call beneath an `invoke`. Each example builds its graph from the
 * kit `startOrchestratorChat` hands it; the rest of the chat is `../core/chat.ts`'s, and the
 * scenarios it runs `../core/scenarios.ts`'s.
 */
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
import { STIGG_TRACER_NAME, type AccessDecision, type StiggAgentSDK, type StiggContext } from '../../../src';
import { StiggLangChainCallbackHandler } from '../../../src/integrations/langchain';
import { MODEL_DIMENSION, modelRefId } from '../../shared/setup-governance';
import { optionalEnv } from '../../client/core/vendor';
import { perTokens, startGovernedChat, type ChatCast } from '../core/chat';
import { handoffCast } from '../core/scenarios';
import { AGENT_STYLES, logAs, logBlocked, logRefused, paint } from '../core/style';

export const MODEL = process.env.AGENT_SDK_ANTHROPIC_MODEL ?? 'claude-opus-5';
/** LangGraph's default of 25 counts steps, and every middleware hook is one - too few for these graphs. */
export const RECURSION_LIMIT = 150;
/** Uncapped, one "research" reply runs to thousands of tokens and a minute and a half. */
const MAX_OUTPUT_TOKENS = 1_500;
/** The guard rail: calls of any one tool per agent per run. */
export const MAX_CALLS_PER_TOOL = 5;

/** The handoff scenario, with LangChain's lead as its top agent. */
export const HANDOFF_CAST: ChatCast = handoffCast('lead', {
  description: 'Chatting with a lead agent and its subagents',
  parent: 'agent-orchestrator',
});

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

/** The governed chat around a LangChain graph built by `build`. */
export function startOrchestratorChat(
  framework: string,
  cast: ChatCast,
  build: (kit: OrchestratorKit) => OrchestratorGraph,
): void {
  const apiKey = optionalEnv('AGENT_SDK_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY');
  // First, so its provider exists before the first span.
  const langfuse = startLangfuse();

  startGovernedChat(cast, {
    framework,
    apiKey,
    start: ({ stigg, demoEnv, mock, governance }) => {
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

      // One handler for the graph, carrying the chat's Stigg options.
      const stiggHandler = new StiggLangChainCallbackHandler({ stigg, ...governance(search.name) });
      const asModel = (agent: string, model: string, config: RunnableConfig): RunnableConfig => {
        const budgets = cast.agents[agent];
        const tokensPerCredit = budgets && 'models' in budgets ? budgets.models[model]?.tokensPerCredit : undefined;
        const stiggContext: StiggContext = {
          dimensions: { [MODEL_DIMENSION]: modelRefId(model) },
          ...(demoEnv.entitlement && tokensPerCredit
            ? { usageMapper: perTokens(demoEnv.entitlement, tokensPerCredit) }
            : {}),
        };
        return { ...config, metadata: { ...config.metadata, stiggContext } };
      };
      const graph = build({ stigg, model: modelNamed(MODEL), modelNamed, asModel, search });

      let history: BaseMessage[] = [];
      return {
        notes: [
          ...(cast.searcher
            ? [
                `at most ${MAX_CALLS_PER_TOOL} calls per tool per run, searching with ` +
                  `${search === webSearch ? 'a canned stand-in (no Tavily key, or offline)' : 'Tavily'}`,
              ]
            : []),
          langfuse
            ? `tracing to Langfuse at ${langfuse.baseUrl}, session ${langfuse.sessionId}`
            : 'not tracing to Langfuse (no AGENT_SDK_LANGFUSE_PUBLIC_KEY / _SECRET_KEY, or offline)',
        ],
        turn: async (request) => {
          // Per run: the handler and the customer, handed by LangChain to every call beneath.
          const config = {
            recursionLimit: RECURSION_LIMIT,
            callbacks: langfuse
              ? [stiggHandler, langfuse.handler(langfuse.sessionId, demoEnv.customerId)]
              : [stiggHandler],
            metadata: { stiggContext: { customerId: demoEnv.customerId } },
          };
          const run = () => graph.turn(history, request, config);
          const { messages } = langfuse
            ? await langfuse.turn(request, langfuse.sessionId, demoEnv.customerId, run)
            : await run();
          history = messages;
          return lastText(messages);
        },
        close: async () => langfuse?.shutdown(),
      };
    },
  });
}
