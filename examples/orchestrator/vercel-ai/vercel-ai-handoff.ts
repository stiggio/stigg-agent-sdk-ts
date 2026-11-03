/**
 * Layer 3: a multi-agent Vercel AI SDK chat, each agent governed on its own.
 *
 *   lead --tool--> researcher (web_search)  --refused--> generalist
 *        --tool--> writer
 *
 * Each agent is a `ToolLoopAgent`, and the lead holds the others as tools: it calls the researcher,
 * hands what came back to the writer, and returns the writer's answer. The AI SDK names no agents,
 * so each agent's model is governed as that agent: `wrapLanguageModel` with `stiggVercelMiddleware`.
 * A refused researcher makes the lead's tool ask a generalist (no search) instead.
 *
 * The customer is a call option, typed by the agent's `callOptionsSchema`: `prepareCall` puts it in
 * `providerOptions.stigg` for the agent's own model calls, and in each tool's context for the
 * subagents the tool runs.
 *
 * The chat around it - setup, registering the agents, the Stigg options, the loop - is every
 * orchestrator example's, in `../core/chat.ts`, and the scenario's agents and budgets are
 * `../core/scenarios.ts`'s; the model and the turns are the Vercel AI SDK examples', in `kit.ts`.
 * What is left here is the user's AI SDK code.
 *
 * Without an Anthropic key it runs against the offline mock, which calls each tool on offer once
 * per turn - so the lead reaches both subagents with no model behind it.
 *
 * Run:  yarn example-orchestrator-vercel-ai-handoff
 */
import '../../shared/load-env';
import { ToolLoopAgent, stepCountIs, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { HANDOFF, handoffCast } from '../core/scenarios';
import { logAs, logToolCall, logToolResult, paint, preview } from '../core/style';
import { MODEL, Request, runAgent, startVercelAIChat, type Agent } from './kit';

/**
 * The handoff scenario, with the lead as its top agent. Only model calls are governed here, so the
 * researcher spends two a request offline, not three: its budget is cut to run dry on the fourth.
 */
const cast = handoffCast('lead', {
  description: `lead -> researcher -> writer on ${MODEL}, a generalist standing in for a refused researcher`,
  parent: 'agent-vercel-ai-handoff',
  agentIdPrefix: 'agent-vercel-ai-',
});
cast.agents.researcher = { budget: 6 };

const MAX_OUTPUT_TOKENS = 1_500;
/** Model calls per agent per run: a tool loop that never answers stops here. */
const MAX_STEPS = 10;

const PROMPTS = {
  lead:
    'You are the lead. You do not research or write yourself: delegate to the researcher, then ' +
    'to the writer with what the researcher found, and return the writer’s answer. If the ' +
    'findings say they come from general knowledge, tell the writer, so the answer says it is not sourced.',
  researcher: 'You are the researcher. Use web_search, then summarise what you found, citing sources.',
  writer: 'You are the writer. Turn the findings you are given into a short, clear answer.',
  generalist:
    'You are a generalist. You have no search: answer the brief from your own knowledge, briefly, ' +
    'and say plainly that what you give is not sourced.',
};

/** A stand-in search. Nothing leaves the process. */
const webSearch = tool({
  description: 'Search the web and return the top result.',
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    logToolCall('researcher', 'web_search', { query });
    return `Top result for "${query}": per-agent token spend is the usual first metric to track.`;
  },
});

startVercelAIChat(cast, ({ stigg, model }) => {
  // The agents - plain AI SDK, each on its own governed model.
  const agentNamed = (name: keyof typeof PROMPTS, tools: ToolSet = {}): Agent =>
    new ToolLoopAgent({
      model: model(name),
      instructions: PROMPTS[name],
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      callOptionsSchema: Request,
      // The request's customer: in `providerOptions.stigg` for this agent's own model calls, and
      // in each tool's context for the subagents a tool runs.
      prepareCall: ({ options, ...call }) => ({
        ...call,
        providerOptions: { ...call.providerOptions, stigg: { customerId: options.customerId } },
        toolsContext: Object.fromEntries(Object.keys(tools).map((tool) => [tool, options])),
      }),
    });
  const agents: Record<string, Agent> = {
    researcher: agentNamed('researcher', { web_search: webSearch }),
    writer: agentNamed('writer'),
    generalist: agentNamed('generalist'),
  };

  /**
   * A subagent as one of the lead's tools. When Stigg refuses it, its fallback takes another pass
   * and the answer says so - the lead's code deciding what a refusal means.
   */
  const delegate = (name: string, description: string) =>
    tool({
      description,
      inputSchema: z.object({ brief: z.string().describe('What this subagent should do.') }),
      contextSchema: Request,
      execute: async ({ brief }, { context }) => {
        logToolCall('lead', name, { brief });
        try {
          const { text } = await runAgent(name, agents[name]!, { prompt: brief }, context);
          logToolResult('lead', name, preview(text, 70));
          return text;
        } catch (err) {
          const decision = stigg.denial(err);
          if (!decision) throw err;
          // Thrown, a refusal's message would reach the lead's model as the tool's result. So the
          // model is told something neutral instead.
          const fallback = HANDOFF.fallback[name];
          if (!fallback) return `The ${name} is not available right now.`;
          logAs(
            'lead',
            `  ${paint(['yellow', 'bold'], 'another pass')} - ` +
              paint(
                'yellow',
                `${name} refused (${decision.reason ?? 'denied'} by ${decision.deniedBy ?? 'policy'}), `,
              ) +
              `asking the ${fallback} instead, without search`,
          );
          const { text } = await runAgent(fallback, agents[fallback]!, { prompt: brief }, context);
          return `(The ${name} was unavailable; these findings come from general knowledge, not sources.)\n${text}`;
        }
      },
    });

  return agentNamed('lead', {
    researcher: delegate('researcher', 'Research a question and report the findings.'),
    writer: delegate('writer', 'Write the final answer from findings you pass in the brief.'),
  });
});
