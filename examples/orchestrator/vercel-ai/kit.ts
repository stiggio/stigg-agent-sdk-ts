/**
 * The Vercel AI SDK side of the governed chat: the Anthropic model, live or against the offline
 * mock, each agent's model governed as that agent, and the chat's turns with their history. Each
 * example builds its agents from the kit `startVercelAIChat` hands it; the rest of the chat is
 * `../core/chat.ts`'s.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { wrapLanguageModel, type LanguageModel, type ModelMessage, type ToolLoopAgent } from 'ai';
import { z } from 'zod';
import { stiggVercelMiddleware, type SessionHooks, type StiggAgentSDK } from '../../../src';
import { optionalEnv } from '../../client/core/vendor';
import { startGovernedChat, type ChatCast } from '../core/chat';
import { logDone, logStart } from '../core/style';

export const MODEL = process.env.AGENT_SDK_ANTHROPIC_MODEL ?? 'claude-opus-5';

/** Who a request is for: each agent's call option, and each delegating tool's context. */
export const Request = z.object({ customerId: z.string() });
export type Request = z.infer<typeof Request>;

/** What an example gets to build its agents with. */
export type VercelAIKit = {
  stigg: StiggAgentSDK;
  /** The agent's model, governed as that agent: `wrapLanguageModel` with Stigg's middleware. */
  model(agent: string): LanguageModel;
};

/** An agent the chat can run: a `ToolLoopAgent` whose call options are the request. */
export type Agent = ToolLoopAgent<Request, any, any>;

/** Runs an agent on a prompt or a conversation, and logs it as it goes. */
export async function runAgent(
  name: string,
  agent: Agent,
  input: { prompt: string } | { messages: ModelMessage[] },
  request: Request,
) {
  logStart(name, 'prompt' in input ? input.prompt : String(input.messages.at(-1)?.content ?? ''));
  const result = await agent.generate({ ...input, options: request });
  logDone(name, `model calls=${result.steps.length}  tokens=${result.totalUsage.totalTokens ?? 0}`);
  return result;
}

/** The chat's hooks, told which agent each call was: a model is one agent, so its middleware says so. */
const asAgent = (hooks: SessionHooks = {}, agent: string): SessionHooks => ({
  onDecision: (decision, context) => hooks.onDecision?.(decision, { ...context, agent }),
  onIngest: (result, context) => hooks.onIngest?.(result, { ...context, agent }),
});

/** Only the fields set: an agent's context leaves the shared one's alone where it names nothing. */
const defined = <T extends object>(value: T | undefined): Partial<T> =>
  Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

/** The governed chat around the lead agent `build` returns. */
export function startVercelAIChat(cast: ChatCast, build: (kit: VercelAIKit) => Agent): void {
  const apiKey = optionalEnv('AGENT_SDK_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY');

  startGovernedChat(cast, {
    framework: 'Vercel AI SDK',
    apiKey,
    start: ({ stigg, demoEnv, mock, governance }) => {
      const anthropic = createAnthropic({
        apiKey: apiKey ?? 'offline-mock',
        ...(mock ? { baseURL: `${mock.baseUrl}/v1` } : {}),
      });
      // The chat's Stigg options, per agent: the AI SDK names no agents, so each model is one.
      const { stiggContext, agents, hooks } = governance();
      const model = (agent: string) =>
        wrapLanguageModel({
          model: anthropic(MODEL),
          middleware: stiggVercelMiddleware({
            stigg,
            stiggContext: { ...stiggContext, ...defined(agents?.[agent]?.stiggContext) },
            hooks: asAgent(hooks, agent),
          }),
        });
      const lead = build({ stigg, model });

      let history: ModelMessage[] = [];
      return {
        turn: async (request) => {
          const messages: ModelMessage[] = [...history, { role: 'user', content: request }];
          // Per request: the customer, decided on the server - here, the demo customer.
          const { text, response } = await runAgent('lead', lead, { messages }, { customerId: demoEnv.customerId });
          history = [...messages, ...response.messages];
          return text;
        },
      };
    },
  });
}
