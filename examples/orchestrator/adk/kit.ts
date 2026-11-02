/**
 * The Google ADK side of the governed chat, which the ADK examples share: the Gemini model, live or
 * against the offline mock, the Runner and its session, and reading ADK's events into each agent's
 * trace. Each example builds its agents and its `StiggAdkPlugin` from the kit `startAdkChat` hands
 * it; the rest of the chat is `../core/chat.ts`'s.
 */
import { Gemini, InMemoryRunner, LogLevel, setLogLevel, type BaseAgent, type Event } from '@google/adk';
import type { StiggAgentSDK } from '../../../src';
import type { StiggAdkPlugin } from '../../../src/integrations/adk';
import { optionalEnv } from '../../client/core/vendor';
import { startGovernedChat, type ChatCast, type ChatKit } from '../core/chat';
import { logAs, logRefused, logToolCall, paint, preview } from '../core/style';

export const MODEL = process.env.AGENT_SDK_GEMINI_MODEL || 'gemini-3.8-flash';
const APP = 'stigg-adk-chat';

/** What an example gets to build its agents with. */
export type AdkKit = {
  stigg: StiggAgentSDK;
  /** A Gemini model - live, or against the offline mock without a key. */
  model(name: string): Gemini;
  /** The chat's Stigg options, for the example's own `StiggAdkPlugin`. */
  governance: ChatKit['governance'];
};

/** The agents, as an example built them: the one a turn starts at, and the plugin for the Runner. */
export type AdkGraph = { root: BaseAgent; stiggPlugin: StiggAdkPlugin };

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

/** The text an event answers with, thoughts left out. */
const textOf = (event: Event): string =>
  (event.content?.parts ?? [])
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join('');

/** The governed chat around the ADK agents `build` returns. */
export function startAdkChat(cast: ChatCast, build: (kit: AdkKit) => AdkGraph): void {
  const apiKey = optionalEnv('AGENT_SDK_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY');

  startGovernedChat(cast, {
    framework: 'Google ADK',
    apiKey,
    start: async ({ stigg, demoEnv, mock, governance }) => {
      // ADK logs every model request at INFO; the trace says what happened instead.
      setLogLevel(LogLevel.WARN);
      // ADK builds its own Gemini client, which reads its base URL from the environment.
      if (mock) process.env.GOOGLE_GEMINI_BASE_URL = mock.baseUrl;

      const { root, stiggPlugin } = build({
        stigg,
        model: (name) => new Gemini({ model: name, apiKey: apiKey ?? 'offline-mock' }),
        governance,
      });
      const runner = new InMemoryRunner({ agent: root, appName: APP, plugins: [stiggPlugin] });
      const userId = demoEnv.customerId;
      const session = await runner.sessionService.createSession({ appName: APP, userId });

      return {
        turn: async (request) => {
          // Per request: the plugin is already on the Runner, so a run is plain ADK.
          let answer = '';
          for await (const event of runner.runAsync({
            userId,
            sessionId: session.id,
            newMessage: { role: 'user', parts: [{ text: request }] },
          })) {
            logEvent(event, stiggPlugin);
            const decision = stiggPlugin.denialOf(event);
            answer =
              decision && event.errorCode
                ? `(refused by ${decision.deniedBy ?? 'policy'}) ${decision.message}`
                : textOf(event) || answer;
          }
          return answer;
        },
      };
    },
  });
}
