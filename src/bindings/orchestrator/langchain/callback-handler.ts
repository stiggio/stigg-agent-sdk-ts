/**
 * The LangChain and LangGraph binding: a callback handler over an agent graph's middleware.
 *
 *   const stiggHandler = new StiggLangChainCallbackHandler({ stigg, stiggContext, agents });
 *   await agent.invoke(input, { callbacks: [stiggHandler], metadata: { stiggContext: { customerId } } });
 *
 * Everything here is LangChain's protocol - which hook a step starts on, where the run's
 * `stiggContext` and the usage are, which agent a step belongs to. Whether a step may run and what it is worth is the
 * middleware's. LangChain hands a callback to every run beneath the `invoke`, sub-agents and
 * LangGraph nodes included, so one handler governs the whole graph.
 *
 * A step belongs to the nearest run above it named for a configured agent: a `createAgent` or
 * `createReactAgent` by its `name`, a hand-built graph's node by its own. That is LangChain's run
 * tree, not metadata - `lc_agent_name` in metadata is inherited by an unnamed sub-agent, carried
 * into a sub-agent by a tool that passes its own config, and settable by whoever sends the run's
 * metadata, so it would charge the wrong agent or let a client pick whose budget pays.
 *
 * It blocks by default. LangChain swallows a handler's error unless `raiseError` is set, and runs
 * an async handler in the background unless `awaitHandlers` is set too, so both are set - through
 * the constructor, because `awaitHandlers` is derived inside `super()`. And LangChain copies a
 * handler (`new this.constructor(this)`) on its way into a nested run, so a copy shares the
 * original's middleware and run tree rather than billing a sub-agent to a fresh session.
 *
 * The one file in `src/` that imports LangChain, reached only through the
 * `@stigg/agent-sdk-js/langchain` entry.
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { safely } from '../../../core/hooks';
import { normalizeUsage } from '../../shared/token-usage';
import type { StiggAgentSDK } from '../../../stigg-agent-sdk';
import type { GovernedAgentMiddleware, Measurement, Metrics, MiddlewareOptions } from '../../../types';
import type { StepAttribution } from '../core/agent-middleware';
import type { StiggContext } from '../../../core/context';

/**
 * The metadata key a run states its `stiggContext` under, on `invoke(input, { metadata })` - the
 * same override `wrap` takes per call, applied over the handler's and the agent's. On `invoke` it
 * names only the customer and `correlationId` (`RUN_FIELDS`); a node's own config may state more.
 * On LangGraph Platform the client sends `metadata`, so set the customer in your auth handler,
 * never from the request.
 */
export const CONTEXT_METADATA_KEY = 'stiggContext';

/**
 * What the `stiggContext` of a run with no parent - `invoke`'s own metadata - may state. On LangGraph
 * Platform the request's client writes that metadata, so it names who the run is for and nothing that
 * prices it or says which agent it is. The rest belongs on the handler, under `agents`, or in a
 * node's own config.
 */
const RUN_FIELDS: ReadonlySet<string> = new Set(['customerId', 'correlationId']);

/** @deprecated The customer alone, from before a run took a whole `stiggContext`. Read as `stiggContext.customerId`. */
export const CUSTOMER_METADATA_KEY = 'stiggCustomerId';

/**
 * What `createAgent({ name })` and LangGraph stamp in metadata. Never what a step is reported as -
 * see the top of this file - only the label an unlisted agent is reported under.
 */
const AGENT_METADATA_KEY = 'lc_agent_name';
const NODE_METADATA_KEY = 'langgraph_node';

/** How many runs can be open at once before the oldest is forgotten - a run whose end never came. */
const OPEN_RUNS_LIMIT = 10_000;

/** The counters LangChain's `usage_metadata` states at the top level, reported under its own names. */
const LANGCHAIN_METRICS = ['input_tokens', 'output_tokens', 'total_tokens'] as const;

/** Where a caller puts the customer, for the refusal a step with none raises. */
const MISSING_CUSTOMER =
  `Name it on every run as \`invoke(input, { metadata: { ${CONTEXT_METADATA_KEY}: { customerId } } })\`, ` +
  'or give the handler a default in its `stiggContext: { customerId }`.';

export type StiggLangChainCallbackOptions = MiddlewareOptions & {
  /** The SDK this handler governs through - one per environment, shared with everything else. */
  stigg: StiggAgentSDK;
  /**
   * The agent the top-level run is - one of `agents`. Set it when the graph's entry point is itself
   * an agent: the caller names the top-level run (`invoke(input, { runName })`), so without this its
   * name would let them pick whose budget pays, or step outside any agent's.
   */
  rootAgent?: string;
};

type LangChainMessage = {
  id?: string;
  usage_metadata?: Record<string, unknown>;
  tool_calls?: { id?: string; name?: string }[];
};

/** What `handleLLMEnd` receives: the generations, and - from a completion model - `llmOutput`. */
type LLMResult = {
  generations?: { message?: LangChainMessage }[][];
  llmOutput?: { tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } };
};

/**
 * The runs LangChain has open, each with its name and parent, so a step can be traced up to the
 * agent it belongs to. Shared by a handler and every copy LangChain makes of it.
 */
class RunTree {
  private readonly open = new Map<string, { name?: string; parent?: string; stiggContext?: StiggContext }>();
  private warnedFull = false;
  private readonly warned = new Set<string>();

  /**
   * `rootAgent`, when set, is what a top-level run is, whatever it was named: the caller names that
   * run (`invoke(input, { runName })`), so its name alone would let them pick whose budget pays.
   * `warn` is the SDK's logger, for what is said once.
   */
  constructor(
    private readonly agents: ReadonlySet<string>,
    private readonly rootAgent: string | undefined,
    private readonly warn: (message: string) => void,
  ) {}

  start(runId: string, parent: string | undefined, name: string | undefined, stiggContext?: StiggContext): void {
    this.open.set(runId, {
      name: parent === undefined && this.rootAgent ? this.rootAgent : name,
      parent,
      stiggContext,
    });
    if (this.open.size <= OPEN_RUNS_LIMIT) return;
    // A forgotten run breaks the walk for the steps beneath it: they fall back to the shared
    // context - still checked and reported, but not as their agent - so that is said.
    this.open.delete(this.open.keys().next().value!);
    if (!this.warnedFull) {
      this.warnedFull = true;
      this.warnOnce(
        `[stigg] more than ${OPEN_RUNS_LIMIT} LangChain runs are open at once, so the oldest are being ` +
          'forgotten: a step beneath one is governed by the shared context rather than as its agent.',
      );
    }
  }

  /** Says a thing once per process - and never fails a step for the logger's sake. */
  warnOnce(message: string): void {
    if (this.warned.has(message) || this.warned.size >= 100) return;
    this.warned.add(message);
    safely(
      () => this.warn(message),
      () => undefined,
    );
  }

  end(runId: string): void {
    this.open.delete(runId);
  }

  /** The agent a run belongs to: itself when it is one, otherwise whatever its parent belongs to. */
  agentAt(runId: string | undefined): string | undefined {
    const run = runId === undefined ? undefined : this.open.get(runId);
    if (!run) return undefined; // the top of the tree, or a run this handler never saw start
    if (run.name !== undefined && this.isAgent(run.name)) return run.name;
    return this.agentAt(run.parent);
  }

  /** The top of the tree above a run, as far as this handler saw it start. */
  rootOf(runId: string): string {
    let current = runId;
    for (let parent = this.open.get(current)?.parent; parent !== undefined; parent = this.open.get(current)?.parent) {
      current = parent;
    }
    return current;
  }

  isAgent(name: string): boolean {
    return this.agents.has(name);
  }

  isOpen(runId: string): boolean {
    return this.open.has(runId);
  }

  /**
   * The `stiggContext`s stated from the top of the tree down to a run, outermost first. LangChain
   * merges `metadata` one key deep, so a node that sets its own `stiggContext` replaces the run's
   * rather than adding to it - walking the tree puts the run's back underneath. A context a run
   * merely inherited is the same object as its parent's, and is applied once.
   */
  stiggContextsAt(runId: string | undefined): StiggContext[] {
    const run = runId === undefined ? undefined : this.open.get(runId);
    if (!run) return [];
    const above = this.stiggContextsAt(run.parent);
    return run.stiggContext && run.stiggContext !== above.at(-1) ? [...above, run.stiggContext] : above;
  }
}

export class StiggLangChainCallbackHandler extends BaseCallbackHandler {
  name = 'StiggLangChainCallbackHandler';

  /**
   * The graph's middleware, which every hook below drives. Protected, for a subclass that traces:
   * the handler itself exposes nothing more, because what it did is flushed through the SDK it was
   * given (`stigg.flush()`), and reported through the `hooks` it was configured with.
   */
  protected readonly middleware: GovernedAgentMiddleware;
  private readonly runs: RunTree;

  constructor(options: StiggLangChainCallbackOptions | StiggLangChainCallbackHandler) {
    super({ raiseError: true, _awaitHandler: true });
    if (options instanceof StiggLangChainCallbackHandler) {
      // LangChain's own copy, on its way into a nested run: the same graph, so the same state.
      this.middleware = options.middleware;
      this.runs = options.runs;
      return;
    }
    const { stigg, rootAgent, ...middlewareOptions } = options;
    if (rootAgent !== undefined && !options.agents?.[rootAgent]) {
      throw new Error(`\`rootAgent\` names "${rootAgent}", which \`agents\` does not list - it must be one of them.`);
    }
    if (!stigg || typeof stigg.middleware !== 'function') {
      throw new Error('`StiggLangChainCallbackHandler` needs `stigg`: the `StiggAgentSDK` it governs through.');
    }
    this.middleware = stigg.middleware({ ...middlewareOptions, missingCustomer: MISSING_CUSTOMER });
    this.runs = new RunTree(new Set(Object.keys(options.agents ?? {})), rootAgent, (message) =>
      stigg.config.logger.warn(message),
    );
  }

  // The declared signature puts `runType` fourth and `parentRunId` last, but the callback manager
  // calls this with `parentRunId` fourth and `runName` eighth - so it is read by what is passed.
  // True of `@langchain/core` 1.2; the attribution tests run against the real manager, so a release
  // that changes either side fails them.
  override handleChainStart(...args: Parameters<NonNullable<BaseCallbackHandler['handleChainStart']>>): void {
    const [, , runId, parentRunId, , metadata, , runName] = args as unknown as [
      unknown,
      unknown,
      string,
      string?,
      unknown?,
      Record<string, unknown>?,
      unknown?,
      string?,
    ];
    this.runs.start(runId, parentRunId, runName, this.stiggContextOf(metadata, parentRunId));
  }

  override handleChainEnd(_outputs: unknown, runId: string): void {
    this.runs.end(runId);
  }

  override handleChainError(_err: unknown, runId: string): void {
    this.runs.end(runId);
  }

  override handleChatModelStart(
    _llm: unknown,
    _messages: unknown,
    runId: string,
    parentRunId?: string,
    _extraParams?: unknown,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return this.middleware.startModel(
      runId,
      this.modelAttributionOf(runId, parentRunId, metadata),
      'langchain.chat_model',
    );
  }

  // The completion-model path, for an LLM that is not a chat model. Same gate, same meter.
  override handleLLMStart(
    _llm: unknown,
    _prompts: unknown,
    runId: string,
    parentRunId?: string,
    _extraParams?: unknown,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return this.middleware.startModel(runId, this.modelAttributionOf(runId, parentRunId, metadata), 'langchain.llm');
  }

  override handleLLMEnd(output: unknown, runId: string): Promise<void> {
    const result = output as LLMResult | undefined;
    const message = result?.generations?.[0]?.[0]?.message;
    const issued = (message?.tool_calls ?? []).flatMap((call) =>
      call.id && call.name ? [{ id: call.id, name: call.name }] : [],
    );
    return this.middleware.endModel(runId, measurementOf(message) ?? completionMeasurement(result, runId), issued);
  }

  override handleLLMError(_err: unknown, runId: string): void {
    this.middleware.abandon(runId);
  }

  override handleToolStart(
    tool: unknown,
    input: string,
    runId: string,
    parentRunId?: string,
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
    const name = runName ?? serialized?.name;
    // A tool is a run too: a sub-agent it starts belongs below it in the tree.
    this.runs.start(runId, parentRunId, name, this.stiggContextOf(metadata, parentRunId));
    return this.middleware.startTool(
      runId,
      { name, callId: toolCallId, kind: serialized?.id?.at(-1), input: decoded(input) },
      this.attributionOf(parentRunId, metadata),
    );
  }

  override handleToolEnd(output: unknown, runId: string): Promise<void> {
    this.runs.end(runId);
    // A tool the model called returns a `ToolMessage`, its result serialized into `content` - and
    // its name, for a tool that started without one.
    const message = isToolMessage(output) ? output : undefined;
    return this.middleware.endTool(runId, decoded(message ? message.content : output), message?.name);
  }

  override handleToolError(_err: unknown, runId: string): void {
    this.runs.end(runId);
    this.middleware.abandon(runId);
  }

  /**
   * A model step's attribution, plus what its AUDR record names: the provider and model LangChain
   * states in its `ls_*` metadata, and the step's place in the run tree - the top-level run as the
   * AUDR run, the run directly above as the parent span.
   */
  private modelAttributionOf(
    runId: string,
    parentRunId: string | undefined,
    metadata: Record<string, unknown> | undefined,
  ): StepAttribution {
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    return {
      ...this.attributionOf(parentRunId, metadata),
      audr: {
        provider: text(metadata?.ls_provider),
        model: text(metadata?.ls_model_name),
        runId: parentRunId === undefined ? runId : this.runs.rootOf(parentRunId),
        parentSpanId: parentRunId,
      },
    };
  }

  /**
   * Who a step is for: the configured agent above it in the run tree, and the `stiggContext`s the
   * run stated on the way down. With no agent above it, a name from metadata is passed on only as a
   * label for the "not listed" warning - never a configured agent's name, which the tree alone can
   * confer.
   */
  private attributionOf(
    parentRunId: string | undefined,
    metadata: Record<string, unknown> | undefined,
  ): StepAttribution {
    const label = metadata?.[AGENT_METADATA_KEY] ?? metadata?.[NODE_METADATA_KEY];
    const unlisted = typeof label === 'string' && !this.runs.isAgent(label) ? label : undefined;
    const agent = this.runs.agentAt(parentRunId);
    // Metadata naming a configured agent the tree does not find is a misconfiguration - a subgraph
    // node named apart from its agent, a top-level agent with no `rootAgent` - or a caller's attempt.
    if (agent === undefined && typeof label === 'string' && this.runs.isAgent(label)) {
      this.runs.warnOnce(
        `[stigg] a step's metadata names agent "${label}", but no run above it is named "${label}" - it is ` +
          'governed by the shared context. Name the node or the agent after it, or set `rootAgent` if it is ' +
          'the top-level agent.',
      );
    }
    const above = this.runs.stiggContextsAt(parentRunId);
    const own = this.stiggContextOf(metadata, parentRunId);
    // A step's own `stiggContext` replaced the run's in its metadata; only the tree puts the run's
    // back. A parent this handler never saw start - the handler given to a model rather than to
    // `invoke` - leaves the step with its own context alone, and the run's customer gone.
    if (own && own.customerId === undefined && parentRunId !== undefined && !this.runs.isOpen(parentRunId)) {
      this.runs.warnOnce(
        "[stigg] a step's own stiggContext names no customer, and the run above it was never seen by this " +
          "handler - so the run's stiggContext is lost. Pass the handler at `invoke` (`callbacks: [handler]`), " +
          'not to a model or tool.',
      );
    }
    return {
      agent: agent ?? unlisted,
      stiggContexts: own && own !== above.at(-1) ? [...above, own] : above,
    };
  }

  /**
   * The `stiggContext` a run's metadata states, with the customer the deprecated key names. That key
   * is what a server's auth handler was told to set, so it is the one trusted: a `stiggContext`
   * naming another customer beside it is refused rather than charged to someone else. A run with no
   * parent - `invoke`'s own metadata - states only `RUN_FIELDS`, with the deprecated key or without.
   */
  private stiggContextOf(
    metadata: Record<string, unknown> | undefined,
    parentRunId: string | undefined,
  ): StiggContext | undefined {
    const stated = metadata?.[CONTEXT_METADATA_KEY];
    const customerId = metadata?.[CUSTOMER_METADATA_KEY];
    if (stated !== undefined && (typeof stated !== 'object' || stated === null || Array.isArray(stated))) {
      throw new Error(`metadata.${CONTEXT_METADATA_KEY} must be a \`stiggContext\` object, not ${String(stated)}.`);
    }
    const unlisted =
      parentRunId === undefined && stated ? Object.keys(stated as object).filter((key) => !RUN_FIELDS.has(key)) : [];
    if (unlisted.length) {
      throw new Error(
        `metadata.${CONTEXT_METADATA_KEY} on a run's \`invoke\` names only the customer and \`correlationId\`, not ` +
          `${unlisted.join(', ')} - a client can write that metadata. Set the rest on the handler, under \`agents\`, ` +
          "or in a node's own config.",
      );
    }
    if (typeof customerId !== 'string' || !customerId) return stated as StiggContext | undefined;
    this.runs.warnOnce(
      `[stigg] metadata.${CUSTOMER_METADATA_KEY} is deprecated - pass \`metadata: { ${CONTEXT_METADATA_KEY}: { customerId } }\` instead.`,
    );
    const context = stated as StiggContext | undefined;
    if (context?.customerId !== undefined && context.customerId !== customerId) {
      throw new Error(
        `metadata.${CONTEXT_METADATA_KEY}.customerId (${String(context.customerId)}) differs from metadata.${CUSTOMER_METADATA_KEY} ` +
          `(${customerId}) - name the customer once, in metadata.${CONTEXT_METADATA_KEY}.`,
      );
    }
    return { ...context, customerId };
  }
}

/** LangChain's `ToolMessage`, told by shape - the class is the application's copy, not ours. */
function isToolMessage(value: unknown): value is { content: unknown; name?: string } {
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

/**
 * A completion model's usage, which LangChain reports on `llmOutput.tokenUsage` rather than on a
 * message - in camelCase, so it is mapped onto the same names a chat model reports under.
 */
function completionMeasurement(result: LLMResult | undefined, runId: string): Measurement | undefined {
  const usage = result?.llmOutput?.tokenUsage;
  if (!usage) return undefined;
  const raw = {
    input_tokens: usage.promptTokens,
    output_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };
  // An empty `tokenUsage` - a streamed completion's - says nothing, and is no measurement: reported
  // as zero it would look like a call that cost nothing, rather than one nobody measured.
  if (!Object.values(raw).some((value) => typeof value === 'number')) return undefined;
  // No provider message id to key on, so the run's own: the same run reported twice is one report.
  return { metrics: pickNumbers(raw, LANGCHAIN_METRICS), usage: normalizeUsage(raw), raw, idempotencyKey: runId };
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
