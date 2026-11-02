/**
 * Layer 3: a Google ADK chat whose assistant drops to a cheaper twin once its own model runs out of
 * credits - handed the turn in the same request.
 *
 *   assistant (MODEL) --refused by Stigg--> assistant_lite (FALLBACK_MODEL)
 *
 * An ADK agent has one model, so the cheaper model is a twin: the same instruction on the cheaper
 * model, a sub-agent of the assistant. Each is a Stigg entity with its own budget and price under one
 * parent - the assistant's small and dear, the twin's large and cheap - so the assistant running dry
 * leaves the twin open. `onRefusal` hands a refused assistant's turn to the twin.
 *
 * The assistant never hands off by itself: its function calling is off, so only a refusal moves the
 * turn. The twin has `disallowTransferToParent`, so ADK's Runner does not resume a later request at
 * it: the next request starts at the assistant again, and a top-up or a new period brings it back.
 * Without that flag the twin keeps every later request.
 *
 * The chat around it is `../core/chat.ts`'s, the scenario's budgets `../core/scenarios.ts`'s, and
 * the model, the Runner and the trace `kit.ts`'s.
 * Without a Gemini key it runs against the offline mock.
 *
 * Run:  yarn example-orchestrator-adk-model-fallback
 */
import '../../shared/load-env';
import { LlmAgent } from '@google/adk';
import { FunctionCallingConfigMode } from '@google/genai';
import { StiggAdkPlugin } from '../../../src/integrations/adk';
import { MODEL, startAdkChat } from './kit';
import type { ChatCast } from '../core/chat';
import { MODEL_FALLBACK } from '../core/scenarios';

/** The cheaper model the twin answers with. */
const FALLBACK_MODEL = process.env.AGENT_SDK_GEMINI_FALLBACK_MODEL || 'gemini-3.8-flash-lite';

/** The model-fallback scenario as two agents: the assistant on the expensive model, its twin on the cheap one. */
const MODEL_FALLBACK_CAST: ChatCast = {
  agents: {
    assistant: MODEL_FALLBACK.expensive,
    assistant_lite: MODEL_FALLBACK.cheap,
  },
  description: `Chatting with one assistant on ${MODEL}, its twin on ${FALLBACK_MODEL} answering once its credits run out`,
  parent: 'agent-adk-model-fallback',
  agentIdPrefix: 'agent-adk-',
};

startAdkChat(MODEL_FALLBACK_CAST, ({ stigg, model, governance }) => {
  // The agents - plain ADK.
  const twin = new LlmAgent({
    name: 'assistant_lite',
    model: model(FALLBACK_MODEL),
    description: `The assistant, on ${FALLBACK_MODEL}.`,
    instruction: MODEL_FALLBACK.instruction,
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
  });
  const assistant = new LlmAgent({
    name: 'assistant',
    model: model(MODEL),
    instruction: MODEL_FALLBACK.instruction,
    // It answers itself: the twin is only for when Stigg refuses it.
    generateContentConfig: { toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } } },
    subAgents: [twin],
  });

  // One plugin for the graph, carrying the chat's Stigg options.
  const stiggPlugin = new StiggAdkPlugin({
    stigg,
    ...governance(),
    // The customer, decided on the server from the invocation - here, the user is the demo customer.
    stepContext: ({ adkContext }) => ({ customerId: adkContext.userId }),
    // The graph's decision on a refusal: the assistant's turn goes to its cheaper twin.
    onRefusal: ({ agent }) => (agent === 'assistant' ? { transferTo: 'assistant_lite' } : undefined),
  });

  return { root: assistant, stiggPlugin };
});
