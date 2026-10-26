/**
 * Layer 3: the same governed multi-agent chat as the LangChain example, as a hand-built LangGraph.
 *
 *   START -> lead (writes the brief) -> researcher <-> tools (paid search)
 *                                         |- refused by Stigg -> generalist -\
 *                                         \- answered ---------------------- writer -> END
 *
 * Each node is an agent: LangGraph stamps its name on every step, so the Stigg integration is the
 * LangChain example's word for word - one `StiggLangChainCallbackHandler`, `agents` keyed by node
 * name. The paid search runs in the `tools` node and is still billed to the researcher, the agent
 * whose model called it. A refusal is routed by the graph itself: the researcher node records it,
 * and an edge sends the turn to the generalist instead of the writer.
 *
 * Run:  yarn example-orchestrator-langgraph
 */
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { Annotation, END, START, StateGraph, messagesStateReducer } from '@langchain/langgraph';
import {
  MAX_CALLS_PER_TOOL,
  PROMPTS,
  anotherPass,
  blockedTool,
  refusedTool,
  startOrchestratorChat,
  timedModelCall,
} from './core/chat';
import { logBlocked, logDone, logStart, logToolCall, logToolResult, preview } from './core/style';

/** What one turn carries from node to node. */
const Turn = Annotation.Root({
  history: Annotation<BaseMessage[]>(),
  request: Annotation<string>(),
  brief: Annotation<string>(),
  /** The researcher's own loop: its replies and the tool results between them. */
  research: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  /** Set by the researcher node when Stigg refuses it, so an edge can route around it. */
  refused: Annotation<boolean>(),
  findings: Annotation<string>(),
  answer: Annotation<string>(),
});
type TurnState = typeof Turn.State;

const replies = (messages: BaseMessage[]) => messages.filter((m): m is AIMessage => AIMessage.isInstance(m));

startOrchestratorChat('LangGraph', ({ stigg, model, search }) => {
  const researcherModel = model.bindTools([search]);

  /** An agent that is one model call: start, answer, done. */
  const answerAs = async (agent: string, input: string, messages: BaseMessage[], config: RunnableConfig) => {
    logStart(agent, input);
    const reply = await timedModelCall(agent, 1, () => model.invoke(messages, config));
    logDone(agent, 'model calls=1');
    return reply.text;
  };

  const lead = async ({ history, request }: TurnState, config: RunnableConfig) => {
    logStart('lead', request);
    const reply = await timedModelCall('lead', 1, () =>
      model.invoke([new SystemMessage(PROMPTS.leadBrief), ...history, new HumanMessage(request)], config),
    );
    return { brief: reply.text };
  };

  const researcher = async ({ brief, research }: TurnState, config: RunnableConfig) => {
    if (!research.length) logStart('researcher', brief);
    // The guard rail: past the limit, one last call with no tools, so the run ends on an answer.
    const tools = research.filter((m) => ToolMessage.isInstance(m)).length < MAX_CALLS_PER_TOOL;
    if (!tools) logBlocked('researcher', undefined, 'search limit reached; tools off');
    const messages = [new SystemMessage(PROMPTS.researcher(search.name)), new HumanMessage(brief), ...research];
    try {
      const reply = await timedModelCall('researcher', replies(research).length + 1, () =>
        (tools ? researcherModel : model).invoke(messages, config),
      );
      for (const call of reply.tool_calls ?? []) logToolCall('researcher', call.name, call.args);
      return { research: [reply] };
    } catch (err) {
      // Stigg refused the researcher's own model call: record it, and let an edge decide.
      const decision = stigg.denial(err);
      if (!decision) throw err;
      return { refused: true, findings: anotherPass('researcher', decision, 'generalist') };
    }
  };

  /** Runs the researcher's tool calls. A refused search goes back to the model as the tool's result. */
  const runTools = async ({ research }: TurnState, config: RunnableConfig) => {
    const calls = replies(research).at(-1)?.tool_calls ?? [];
    // The guard rail holds for a parallel batch too: the calls past the limit are answered, not run.
    const left = MAX_CALLS_PER_TOOL - research.filter((m) => ToolMessage.isInstance(m)).length;
    const results = await Promise.all(
      calls.map(async (call, n) => {
        if (n >= left) return blockedTool('researcher', call);
        try {
          const result: ToolMessage = await (search as StructuredToolInterface).invoke(
            { ...call, type: 'tool_call' },
            config,
          );
          logToolResult('researcher', call.name, `returned: ${preview(result.content, 70)}`);
          return result;
        } catch (err) {
          const decision = stigg.denial(err);
          if (!decision) throw err;
          return refusedTool('researcher', call, decision);
        }
      }),
    );
    return { research: results };
  };

  /** The researcher's last reply is its findings. */
  const summarise = ({ research }: TurnState) => {
    logDone('researcher', `model calls=${replies(research).length}`);
    return { findings: replies(research).at(-1)?.text ?? '' };
  };

  /** The second pass when the researcher is refused: no search, its own budget. */
  const generalist = async ({ brief, findings: note }: TurnState, config: RunnableConfig) => ({
    findings:
      note +
      (await answerAs('generalist', brief, [new SystemMessage(PROMPTS.generalist), new HumanMessage(brief)], config)),
  });

  const writer = async ({ request, findings }: TurnState, config: RunnableConfig) => ({
    answer: await answerAs(
      'writer',
      findings,
      [new SystemMessage(PROMPTS.writer), new HumanMessage(`Request: ${request}\n\nFindings: ${findings}`)],
      config,
    ),
  });

  const graph = new StateGraph(Turn)
    .addNode('lead', lead)
    .addNode('researcher', researcher)
    .addNode('tools', runTools)
    .addNode('summarise', summarise)
    .addNode('generalist', generalist)
    .addNode('writer', writer)
    .addEdge(START, 'lead')
    .addEdge('lead', 'researcher')
    // The graph decides what a refusal means: the generalist, not a failed turn.
    .addConditionalEdges('researcher', (state: TurnState) =>
      state.refused ? 'generalist' : replies(state.research).at(-1)?.tool_calls?.length ? 'tools' : 'summarise',
    )
    .addEdge('tools', 'researcher')
    .addEdge('summarise', 'writer')
    .addEdge('generalist', 'writer')
    .addEdge('writer', END)
    .compile();

  return {
    turn: async (history, request, config) => {
      const { answer } = await graph.invoke({ history, request }, config);
      return { messages: [...history, new HumanMessage(request), new AIMessage(answer)] };
    },
  };
});
