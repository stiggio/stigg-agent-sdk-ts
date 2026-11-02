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
 * The chat around it - setup, registering the agents, the Stigg options, the loop - is every
 * orchestrator example's, in `../core/chat.ts`, and the scenario's agents and budgets are
 * `../core/scenarios.ts`'s; the model, the Runner and the trace are the ADK examples', in `kit.ts`.
 * What is left here is the user's ADK code, and the plugin on it.
 *
 * Without a Gemini key it runs against the offline mock, which calls each function on offer in turn
 * - so the whole chain runs with no model behind it.
 *
 * Run:  yarn example-orchestrator-adk-handoff
 */
import '../../shared/load-env';
import { FunctionTool, LlmAgent } from '@google/adk';
import { z } from 'zod';
import { StiggAdkPlugin } from '../../../src/integrations/adk';
import { MODEL, startAdkChat } from './kit';
import { HANDOFF, handoffCast } from '../core/scenarios';

/** The handoff scenario, with ADK's coordinator as its top agent. Offline, the researcher spends three a request: two calls and a search. */
const ADK_CAST = handoffCast('coordinator', {
  description: `coordinator -> researcher -> writer on ${MODEL}, a generalist standing in for a refused researcher`,
  parent: 'agent-adk-handoff',
  agentIdPrefix: 'agent-adk-',
});

/** A stand-in search: what a real one costs is the point, not what it finds. */
const webSearch = new FunctionTool({
  name: 'web_search',
  description: 'Search the web and return the top result.',
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => ({
    results: [`Top result for "${query}": per-agent token spend is the usual first metric to track.`],
  }),
});

startAdkChat(ADK_CAST, ({ stigg, model: modelNamed, governance }) => {
  // The agents - plain ADK.
  const model = modelNamed(MODEL);
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

  // One plugin for the graph, carrying the chat's Stigg options.
  const stiggPlugin = new StiggAdkPlugin({
    stigg,
    ...governance(webSearch.name),
    // The customer, decided on the server from the invocation - here, the user is the demo customer.
    // ADK's own API server lets the client choose `userId`: use it only when your server sets it from the login.
    stepContext: ({ adkContext }) => ({ customerId: adkContext.userId }),
    // The graph's decision on a refusal: the researcher's turn goes to the generalist instead of
    // ending; any other agent's ends in an error event.
    onRefusal: ({ agent }) => (HANDOFF.fallback[agent] ? { transferTo: HANDOFF.fallback[agent] } : undefined),
  });

  return { root: coordinator, stiggPlugin };
});
