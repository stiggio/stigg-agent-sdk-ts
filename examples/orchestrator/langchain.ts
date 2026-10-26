/**
 * Layer 3: a multi-agent LangChain chat, each agent governed on its own through one callback handler.
 *
 * A lead delegates to a researcher (Tavily, or a canned search offline) and a writer, held as tools.
 * Every agent is a Stigg entity under one parent agent, with a budget of its own; a step is checked
 * and billed as the agent that took it, so one agent running dry stops only that agent:
 *
 *   - a refused search comes back to the researcher as the tool's result;
 *   - a refused researcher makes the lead take another pass with a generalist (plain Claude, no
 *     search), so the turn degrades instead of failing;
 *   - a refused lead ends the turn with the remedy, and the chat goes on.
 *
 * The Stigg side - setup, the handler, the chat - is shared with the LangGraph example in `core/`.
 * Entitlement and agent type are both optional: blank `AGENT_SDK_DEMO_CURRENCY_ID` for metering
 * only, or the agent type for a customer-level run. Set `AGENT_SDK_LANGFUSE_*` to trace to Langfuse.
 * LangChain logs `Error in handler ...` for each refusal; that is its own line, and it is handled.
 *
 * Run:  yarn example-orchestrator-langchain
 */
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { createAgent, createMiddleware, tool, toolCallLimitMiddleware } from 'langchain';
import { z } from 'zod';
import type { StiggAgentSDK } from '../../src';
import {
  MAX_CALLS_PER_TOOL,
  PROMPTS,
  RECURSION_LIMIT,
  anotherPass,
  lastText,
  refusedTool,
  startOrchestratorChat,
  thisRun,
  timedModelCall,
} from './core/chat';
import { logAs, logBlocked, logDone, logStart, logToolCall, logToolResult, paint, preview } from './core/style';

/** A call `toolCallLimitMiddleware` refused - its error result, as opposed to a tool that failed. */
const isBlocked = (m: BaseMessage): m is ToolMessage =>
  ToolMessage.isInstance(m) && m.status === 'error' && String(m.content).includes('limit exceeded');

/** Logs an agent's run as it happens. Listed first, so its `afterModel` sees what the guard rail blocked. */
function trace(agent: string, stigg: StiggAgentSDK) {
  return createMiddleware({
    name: `Trace[${agent}]`,

    beforeAgent: (state) => {
      logStart(agent, lastText(state.messages));
      return undefined;
    },

    // Counted off the run's own messages: the same agent can run twice in parallel.
    wrapModelCall: async (request, handler) => {
      const calls = thisRun(request.messages).filter((m) => AIMessage.isInstance(m)).length + 1;
      return timedModelCall(agent, calls, async () => (await handler(request)) as AIMessage);
    },

    afterModel: (state) => {
      const run = thisRun(state.messages);
      const reply = run.filter((m): m is AIMessage => AIMessage.isInstance(m)).at(-1);
      if (!reply) return undefined;

      if (!reply.tool_calls?.length) {
        logAs(agent, `  ${paint(['green', 'bold'], 'answers:')} ${preview(reply.text)}`);
        return undefined;
      }
      const blocked = new Set(run.filter(isBlocked).map((m) => m.tool_call_id));
      for (const call of reply.tool_calls) {
        if (blocked.has(call.id ?? '')) logBlocked(agent, call.name, `over ${MAX_CALLS_PER_TOOL} calls this run`);
        else logToolCall(agent, call.name, call.args);
      }
      return undefined;
    },

    wrapToolCall: async (request, handler) => {
      const at = Date.now();
      try {
        const result = await handler(request);
        const content = ToolMessage.isInstance(result) ? result.content : result;
        logToolResult(agent, request.toolCall.name, `returned in ${Date.now() - at}ms: ${preview(content, 70)}`);
        return result;
      } catch (err) {
        // A Stigg refusal inside the tool goes back to the model as the tool's result.
        const decision = stigg.denial(err);
        if (!decision) throw err;
        return refusedTool(agent, request.toolCall, decision);
      }
    },

    afterAgent: (state) => {
      const replies = thisRun(state.messages).filter((m): m is AIMessage => AIMessage.isInstance(m));
      const tokens = replies.reduce((sum, m) => sum + (m.usage_metadata?.total_tokens ?? 0), 0);
      logDone(agent, `model calls=${replies.length}  tokens=${tokens}`);
      return undefined;
    },
  });
}

/**
 * The guard rail: `toolCallLimitMiddleware` per tool, plus a wrap-up. When every call in a reply is
 * blocked, the wrap-up gives the model one last call with tools off, so the run ends on an answer
 * rather than the limiter's error. Listed first: `afterModel` hooks run in reverse.
 */
function guardRail(agent: string, toolNames: string[]) {
  const wrapUp = createMiddleware({
    name: 'GuardRailWrapUp',
    afterModel: {
      canJumpTo: ['model'],
      hook: (state) => {
        const run = thisRun(state.messages);
        const reply = run.filter((m): m is AIMessage => AIMessage.isInstance(m)).at(-1);
        const blocked = new Set(run.filter(isBlocked).map((m) => m.tool_call_id));
        const allBlocked = !!reply?.tool_calls?.length && reply.tool_calls.every((call) => blocked.has(call.id ?? ''));
        if (!allBlocked) return undefined;
        // The jump skips the trace's `afterModel`, so the block is logged here.
        const names = reply.tool_calls!.map((call) => call.name).join(', ');
        logBlocked(agent, names, `over ${MAX_CALLS_PER_TOOL} calls this run; one last call, tools off`);
        return { jumpTo: 'model' as const };
      },
    },
    // After a block, the run's remaining model calls answer rather than call tools.
    wrapModelCall: (request, handler) =>
      handler(thisRun(request.messages).some(isBlocked) ? { ...request, toolChoice: 'none' } : request),
  });
  return [wrapUp, ...toolNames.map((toolName) => toolCallLimitMiddleware({ toolName, runLimit: MAX_CALLS_PER_TOOL }))];
}

/** What the lead needs of a subagent: hand it a brief, get its conversation back. */
type Subagent = {
  invoke(
    input: { messages: { role: 'user'; content: string }[] },
    config: { recursionLimit: number },
  ): Promise<{ messages: BaseMessage[] }>;
};

startOrchestratorChat('LangChain', ({ stigg, model, search }) => {
  const researcher = createAgent({
    name: 'researcher',
    model,
    tools: [search],
    systemPrompt: PROMPTS.researcher(search.name),
    middleware: [trace('researcher', stigg), ...guardRail('researcher', [search.name])],
  });
  const writer = createAgent({
    name: 'writer',
    model,
    tools: [],
    systemPrompt: PROMPTS.writer,
    middleware: [trace('writer', stigg)],
  });
  /** The second pass when the researcher is refused: no search, its own budget. */
  const generalist = createAgent({
    name: 'generalist',
    model,
    tools: [],
    systemPrompt: PROMPTS.generalist,
    middleware: [trace('generalist', stigg)],
  });

  const runAgent = async (agent: Subagent, brief: string): Promise<string> => {
    const { messages } = await agent.invoke(
      { messages: [{ role: 'user', content: brief }] },
      { recursionLimit: RECURSION_LIMIT },
    );
    return lastText(messages);
  };

  /**
   * A subagent as one of the lead's tools. When Stigg refuses it, `fallback` takes another pass and
   * the answer says so - the graph deciding what a refusal means.
   */
  const delegate = (name: string, description: string, agent: Subagent, fallback?: { name: string; agent: Subagent }) =>
    tool(
      async ({ brief }) => {
        try {
          return await runAgent(agent, brief);
        } catch (err) {
          const decision = stigg.denial(err);
          if (!decision || !fallback) throw err;
          const note = anotherPass(name, decision, fallback.name);
          return note + (await runAgent(fallback.agent, brief));
        }
      },
      { name, description, schema: z.object({ brief: z.string().describe('What this subagent should do.') }) },
    );

  const lead = createAgent({
    name: 'lead',
    model,
    tools: [
      delegate('researcher', 'Research a question and report the findings.', researcher, {
        name: 'generalist',
        agent: generalist,
      }),
      delegate('writer', 'Write the final answer from findings you pass in the brief.', writer),
    ],
    systemPrompt: PROMPTS.lead,
    middleware: [trace('lead', stigg), ...guardRail('lead', ['researcher', 'writer'])],
  });

  return {
    turn: (history, request, config) =>
      lead.invoke({ messages: [...history, { role: 'user', content: request }] }, config),
  };
});
