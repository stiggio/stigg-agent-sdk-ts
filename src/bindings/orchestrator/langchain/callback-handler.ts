/**
 * The LangChain and LangGraph binding: a callback handler over an agent graph's middleware.
 *
 *   const stiggHandler = new StiggLangChainCallbackHandler({ stigg, stiggContext, agents });
 *   await agent.invoke(input, { callbacks: [stiggHandler], metadata: { stiggCustomerId } });
 *
 * Everything here is LangChain's protocol - which hook a step starts on, where the agent's name,
 * the customer and the usage are. Whether a step may run and what it is worth is the middleware's,
 * and the handler keeps no state of its own. LangChain hands a callback to every run beneath the
 * `invoke`, sub-agents and LangGraph nodes included, so one handler governs the whole graph.
 *
 * It blocks by default. LangChain swallows a handler's error unless `raiseError` is set, and runs
 * an async handler in the background unless `awaitHandlers` is set too, so both are set - through
 * the constructor, because `awaitHandlers` is derived inside `super()`. And LangChain copies a
 * handler (`new this.constructor(this)`) on its way into a nested run, so a copy shares the
 * original's middleware rather than billing a sub-agent to a fresh session.
 *
 * The one file in `src/` that imports LangChain, reached only through the
 * `@stigg/agent-sdk-js/langchain` entry.
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { normalizeUsage } from '../../shared/token-usage';
import type { StiggAgentSDK } from '../../../stigg-agent-sdk';
import type { GovernedAgentMiddleware, Measurement, Metrics, MiddlewareOptions } from '../../../types';
import type { StepAttribution } from '../core/agent-middleware';

/**
 * The metadata key a caller names the customer under, on `invoke(input, { metadata })`. It wins
 * over the handler's default, so set it server-side - on LangGraph Platform the client sends
 * `metadata`, so set it in your auth handler, never from the request.
 */
export const CUSTOMER_METADATA_KEY = 'stiggCustomerId';

/** What `createAgent({ name })` stamps on every run of that agent. */
const AGENT_METADATA_KEY = 'lc_agent_name';
/** What LangGraph stamps on every step: the graph node it runs in - the agent, in a hand-built graph. */
const NODE_METADATA_KEY = 'langgraph_node';

/** The counters LangChain's `usage_metadata` states at the top level, reported under its own names. */
const LANGCHAIN_METRICS = ['input_tokens', 'output_tokens', 'total_tokens'] as const;

/** Where a caller puts the customer, for the refusal a step with none raises. */
const MISSING_CUSTOMER =
  `Name it on every run as \`invoke(input, { metadata: { ${CUSTOMER_METADATA_KEY}: customerId } })\`, ` +
  'or give the handler a default in its `stiggContext: { customerId }`.';

export type StiggLangChainCallbackOptions = MiddlewareOptions & {
  /** The SDK this handler governs through - one per environment, shared with everything else. */
  stigg: StiggAgentSDK;
};

type LangChainMessage = {
  id?: string;
  usage_metadata?: Record<string, unknown>;
  tool_calls?: { id?: string; name?: string }[];
};

export class StiggLangChainCallbackHandler extends BaseCallbackHandler {
  name = 'StiggLangChainCallbackHandler';

  /**
   * The graph's middleware, which every hook below drives. Protected, for a subclass that traces:
   * the handler itself exposes nothing more, because what it did is flushed through the SDK it was
   * given (`stigg.flush()`), and reported through the `hooks` it was configured with.
   */
  protected readonly middleware: GovernedAgentMiddleware;

  constructor(options: StiggLangChainCallbackOptions | StiggLangChainCallbackHandler) {
    super({ raiseError: true, _awaitHandler: true });
    if (options instanceof StiggLangChainCallbackHandler) {
      // LangChain's own copy, on its way into a nested run: the same graph, so the same middleware.
      this.middleware = options.middleware;
      return;
    }
    const { stigg, ...middlewareOptions } = options;
    if (!stigg || typeof stigg.middleware !== 'function') {
      throw new Error('`StiggLangChainCallbackHandler` needs `stigg`: the `StiggAgentSDK` it governs through.');
    }
    this.middleware = stigg.middleware({ ...middlewareOptions, missingCustomer: MISSING_CUSTOMER });
  }

  override handleChatModelStart(
    _llm: unknown,
    _messages: unknown,
    runId: string,
    _parentRunId?: string,
    _extraParams?: unknown,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return this.middleware.startModel(runId, attributionOf(metadata), 'langchain.chat_model');
  }

  // The completion-model path, for an LLM that is not a chat model. Same gate, same meter.
  override handleLLMStart(
    _llm: unknown,
    _prompts: unknown,
    runId: string,
    _parentRunId?: string,
    _extraParams?: unknown,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return this.middleware.startModel(runId, attributionOf(metadata), 'langchain.llm');
  }

  override handleLLMEnd(output: unknown, runId: string): Promise<void> {
    const message = (output as { generations?: { message?: LangChainMessage }[][] })?.generations?.[0]?.[0]?.message;
    const issued = (message?.tool_calls ?? []).flatMap((call) =>
      call.id && call.name ? [{ id: call.id, name: call.name }] : [],
    );
    return this.middleware.endModel(runId, measurementOf(message), issued);
  }

  override handleLLMError(_err: unknown, runId: string): void {
    this.middleware.abandon(runId);
  }

  override handleToolStart(
    tool: unknown,
    input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    toolCallId?: string,
  ): Promise<void> {
    // `runName` is set only for a tool built with `tool()`; a class-based one - `TavilySearch`,
    // most packaged integrations - starts with none, and a serialized form that names only its
    // class. The middleware names it from the model's own tool call, or by that class when no
    // model called it.
    const serialized = tool as { name?: string; id?: string[] } | undefined;
    return this.middleware.startTool(
      runId,
      { name: runName ?? serialized?.name, callId: toolCallId, kind: serialized?.id?.at(-1), input: decoded(input) },
      attributionOf(metadata),
    );
  }

  override handleToolEnd(output: unknown, runId: string): Promise<void> {
    // A tool the model called returns a `ToolMessage`, its result serialized into `content`.
    const content = isToolMessage(output) ? output.content : output;
    return this.middleware.endTool(runId, decoded(content));
  }

  override handleToolError(_err: unknown, runId: string): void {
    this.middleware.abandon(runId);
  }
}

/** Who a LangChain step is for: the agent (its `createAgent` name, or its graph node), and the customer. */
function attributionOf(metadata: Record<string, unknown> | undefined): StepAttribution {
  // `createAgent`'s name first: inside one, the node is an internal one (`model_request`). In a
  // hand-built `StateGraph` there is no agent name, and the node is the agent.
  const agent = metadata?.[AGENT_METADATA_KEY] ?? metadata?.[NODE_METADATA_KEY];
  const customerId = metadata?.[CUSTOMER_METADATA_KEY];
  return {
    agent: typeof agent === 'string' ? agent : undefined,
    customerId: typeof customerId === 'string' && customerId ? customerId : undefined,
  };
}

/** LangChain's `ToolMessage`, told by shape - the class is the application's copy, not ours. */
function isToolMessage(value: unknown): value is { content: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'tool' &&
    'tool_call_id' in value &&
    'content' in value
  );
}

/**
 * A tool's input or output as its own author wrote it: LangChain hands both on serialized to JSON,
 * so they are parsed back - and passed as they came when they are not JSON.
 */
function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** One generation's usage as a measurement, in LangChain's own vocabulary and the normalized one. */
function measurementOf(message: LangChainMessage | undefined): Measurement | undefined {
  const usage = message?.usage_metadata;
  if (!usage) return undefined;
  return {
    metrics: pickNumbers(usage, LANGCHAIN_METRICS),
    usage: normalizeUsage(usage),
    raw: usage,
    // The provider's own id - `msg_…` for Anthropic - so a retried graph step that replays the same
    // message is the same report.
    ...(message.id ? { idempotencyKey: message.id } : {}),
  };
}

/** The named counters that are numbers, as they were stated. */
function pickNumbers(source: Record<string, unknown>, names: readonly string[]): Metrics {
  const metrics: Metrics = {};
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'number' && Number.isFinite(value)) metrics[name] = value;
  }
  return metrics;
}
