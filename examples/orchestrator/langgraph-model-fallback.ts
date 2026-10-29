/**
 * Layer 3: a LangGraph chat whose one agent drops to a cheaper model once the expensive one runs out
 * of credits - decided inside the node, in the same turn.
 *
 *   START -> assistant: Opus --refused by Stigg--> Haiku -> END
 *
 * One agent, one node, and a budget per model: each model is an entity of a `model` type, and the
 * agent's budget is scoped to each - Opus's small and dear, Haiku's large and cheap. The node states
 * each call's model in that call's `stiggContext`, as a dimension, so a check for Opus is answered by
 * Opus's budget alone, and Opus running dry leaves Haiku open. The node catches the refusal and
 * calls Haiku; the next turn tries Opus first again, so a top-up or a new period brings it back.
 *
 * Run:  yarn example-orchestrator-langgraph-model-fallback
 */
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { MODEL, startOrchestratorChat, timedModelCall, type ChatCast } from './core/chat';
import { logAs, logStart, paint } from './core/style';

/** The cheaper model the agent falls back to. */
const FALLBACK_MODEL = process.env.AGENT_SDK_ANTHROPIC_FALLBACK_MODEL || 'claude-haiku-5-5';

/** Opus runs dry within a few turns offline: a credit buys it a hundred tokens, and Haiku two thousand. */
const MODEL_FALLBACK_CAST: ChatCast = {
  agents: {
    assistant: {
      models: {
        [MODEL]: { budget: 4, tokensPerCredit: 100 },
        [FALLBACK_MODEL]: { budget: 50, tokensPerCredit: 2_000 },
      },
    },
  },
  description: `Chatting with one assistant on ${MODEL}, falling back to ${FALLBACK_MODEL} once its credits run out`,
  parent: 'agent-model-fallback',
};

const SYSTEM = 'You are a helpful assistant. Answer briefly and clearly.';

/** What one turn carries. */
const Turn = Annotation.Root({
  history: Annotation<BaseMessage[]>(),
  request: Annotation<string>(),
  answer: Annotation<string>(),
});
type TurnState = typeof Turn.State;

startOrchestratorChat('LangGraph', MODEL_FALLBACK_CAST, ({ stigg, modelNamed, asModel }) => {
  const [expensive, cheap] = [modelNamed(MODEL), modelNamed(FALLBACK_MODEL)];

  const assistant = async ({ history, request }: TurnState, config: RunnableConfig) => {
    logStart('assistant', request);
    const messages = [new SystemMessage(SYSTEM), ...history, new HumanMessage(request)];
    try {
      const reply = await timedModelCall(
        'assistant',
        1,
        () => expensive.invoke(messages, asModel('assistant', MODEL, config)),
        MODEL,
      );
      return { answer: reply.text };
    } catch (err) {
      // Stigg refused the expensive model's budget - not the agent's: the cheap one is still open.
      const decision = stigg.denial(err);
      if (!decision) throw err;
      logAs(
        'assistant',
        `  ${paint(['yellow', 'bold'], 'switching model')} - ` +
          paint('yellow', `${MODEL} ${decision.reason ?? 'denied'}, `) +
          `${paint('yellow', 'answering with')} ${paint('bold', FALLBACK_MODEL)}`,
      );
      const reply = await timedModelCall(
        'assistant',
        2,
        () => cheap.invoke(messages, asModel('assistant', FALLBACK_MODEL, config)),
        FALLBACK_MODEL,
      );
      return { answer: reply.text };
    }
  };

  const graph = new StateGraph(Turn)
    .addNode('assistant', assistant)
    .addEdge(START, 'assistant')
    .addEdge('assistant', END)
    .compile();

  return {
    turn: async (history, request, config) => {
      const { answer } = await graph.invoke({ history, request }, config);
      return { messages: [...history, new HumanMessage(request), new AIMessage(answer)] };
    },
  };
});
