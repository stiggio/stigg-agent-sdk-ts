/**
 * The Google ADK binding: a Runner plugin that governs every agent the Runner runs.
 *
 *   const stiggPlugin = new StiggAdkPlugin({ stigg, stiggContext, agents, stepContext });
 *   const runner = new InMemoryRunner({ agent, appName, plugins: [stiggPlugin] });
 *
 * How it works:
 *
 *   - Before each model call and each tool call, the plugin asks Stigg whether the agent may run it.
 *     The agent is `callbackContext.agentName` - set by the agent tree the app built, so a request
 *     cannot change it. The customer comes from `stepContext`, because ADK has no per-run metadata.
 *   - After a model call, the plugin reports its token usage as that agent. After a tool call, it
 *     reports the tool. Failed calls report nothing.
 *   - ADK does not let a plugin throw a refusal (it turns the throw into an `UNKNOWN_ERROR` event), so
 *     a refusal is returned as the step's answer instead:
 *       - a refused model call returns `onRefusal`'s answer - `{ transferTo }` hands the turn to
 *         another agent - or else an error response with `errorCode: 'STIGG_ACCESS_DENIED'`. The
 *         model is never called;
 *       - a refused tool returns a short error as its result. The tool never runs, and the model
 *         carries on without it.
 *     `plugin.denialOf(event)` returns the decision behind either.
 *
 * Put this plugin first in `plugins`: ADK stops at the first plugin that returns a value, so a
 * plugin before it that answers a step hides that step from Stigg.
 *
 * The one file in `src/` that imports ADK, reached only through the `@stigg/agent-sdk-js/adk` entry.
 */
import {
  BasePlugin,
  isAgentTool,
  type BaseAgent,
  type BaseTool,
  type Context,
  type InvocationContext,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { safely } from '../../../core/hooks';
import { isAccessDenied } from '../../../errors';
import { GEMINI_METRICS, normalizeUsage, pickMetrics } from '../../shared/token-usage';
import type { StiggAgentSDK } from '../../../stigg-agent-sdk';
import type {
  AccessDecision,
  ClientContext,
  GovernedAgentMiddleware,
  Measurement,
  MiddlewareOptions,
} from '../../../types';
import type { StepAttribution } from '../core/agent-middleware';

/** How many model calls or refused tools are remembered at once. Past it, the oldest is dropped. */
const MEMORY_LIMIT = 10_000;

const TRANSFER_TOOL = 'transfer_to_agent';

/**
 * ADK's own control tools. They are never checked, not even by `tools: { '*': ... }`: they do no
 * work, and refusing one would break the agent - a refused `exit_loop` keeps a loop running.
 */
const CONTROL_TOOLS = new Set([TRANSFER_TOOL, 'exit_loop', 'set_model_response', 'finish_task']);

/** The `errorCode` of a model call Stigg refused, on its `LlmResponse` and the event ADK makes of it. */
export const DENIED_ERROR_CODE = 'STIGG_ACCESS_DENIED';

/** Where a refused model call's decision is kept: its response's `customMetadata`, never seen by the model. */
const DECISION_KEY = 'stiggDecision';

/** Where a caller puts the customer, for the refusal a step with none raises. */
const MISSING_CUSTOMER =
  'Resolve it per step with `stepContext: ({ adkContext }) => ({ customerId })`, ' +
  'or give the plugin a default in its `stiggContext: { customerId }`.';

/** One step the plugin is about to check, for `stepContext` to resolve its `stiggContext` from. */
export type AdkStep = {
  /** The agent ADK runs the step under. */
  agent: string;
  /** ADK's context for the step: the invocation's `userId`, `sessionId`, `invocationId`, and state. */
  adkContext: Context;
  /** The model about to be called, on a model step - for a budget per model, as a dimension. */
  model?: string;
  /** The tool about to run, on a tool step. */
  tool?: string;
};

/** A model call Stigg refused, for `onRefusal` to decide what the agent answers instead. */
export type AdkRefusal = AdkStep & { decision: AccessDecision };

/**
 * What a refused model call answers with: `{ transferTo }` to hand the turn to another agent the
 * refused one can transfer to, any `LlmResponse` of your own, or nothing for the error response.
 */
export type AdkRefusalAnswer = { transferTo: string } | LlmResponse | undefined;

export type StiggAdkPluginOptions = MiddlewareOptions & {
  /** The SDK this plugin governs through - one per environment, shared with everything else. */
  stigg: StiggAgentSDK;
  /** The plugin's name in ADK's plugin manager, which refuses two of the same name. */
  name?: string;
  /**
   * The `stiggContext` a step states - typically the customer, from the invocation's user. Applied
   * over the plugin's and the agent's, the way a LangChain run's `metadata.stiggContext` is. A
   * tool's price from `tools` still applies over it.
   *
   * Resolve it from what your server knows, never from what a client sends: ADK's own API server
   * lets the client choose `userId` and send a `stateDelta` with every run. `adkContext.userId` is
   * only safe when your server sets it from the login. No `idempotencyKey`: every report beneath
   * the step would share it.
   */
  stepContext?: (step: AdkStep) => ClientContext | undefined | Promise<ClientContext | undefined>;
  /**
   * What a refused model call answers with instead - the graph's decision, as a LangGraph edge is.
   * Return `{ transferTo: 'generalist' }` to hand the turn to an agent the refused one can transfer
   * to, so the turn goes on without it. An agent hands off at most once per run, so two agents
   * refused in turn cannot pass the turn back and forth forever; the second refusal ends in the error
   * response. Left out, or returning nothing, the refused agent's turn ends in an error event.
   */
  onRefusal?: (refusal: AdkRefusal) => AdkRefusalAnswer | Promise<AdkRefusalAnswer>;
};

/** One model call, from its check until its usage is reported. */
type ModelCall = {
  runId: string;
  invocationId: string;
  agent: string;
  /** Whether any response came back. A call with none was never made, so it costs nothing. */
  answered: boolean;
  /** The latest `usageMetadata`. Streamed responses carry a running total, so the latest is the whole call. */
  usage?: Record<string, unknown>;
};

export class StiggAdkPlugin extends BasePlugin {
  /**
   * The graph's middleware, which every callback below drives. Protected, for a subclass that
   * traces: what the plugin did is flushed through the SDK it was given (`stigg.flush()`), and
   * reported through the `hooks` it was configured with.
   */
  protected readonly middleware: GovernedAgentMiddleware;
  private readonly stepContext: StiggAdkPluginOptions['stepContext'];
  private readonly onRefusal: StiggAdkPluginOptions['onRefusal'];
  private readonly warn: (message: string) => void;
  private readonly warned = new Set<string>();

  /** Model calls by their `EventActions` - the one object ADK passes to every callback of a call. */
  private readonly callsByActions = new WeakMap<object, ModelCall>();
  /** Model calls whose usage is not reported yet, oldest first. */
  private readonly openCalls = new Map<string, ModelCall>();
  /**
   * Usage reports still in flight, by invocation. Each check waits for them first, so it sees the
   * spend - including spend reported by another branch of a parallel agent.
   */
  private readonly reporting = new Map<string, Set<Promise<void>>>();
  /** Tool steps by their `Context`, which ADK builds once per tool call. */
  private readonly toolRuns = new WeakMap<object, string>();
  /**
   * The decision behind each refused tool, by invocation and function call id - kept here, away from
   * the model. Scoped like the tool's run id, since a model may reuse call ids across turns.
   */
  private readonly toolDenials = new Map<string, AccessDecision>();
  /** The agents that already handed off a refused turn, by invocation. */
  private readonly handedOff = new Map<string, Set<string>>();
  private seq = 0;

  constructor(options: StiggAdkPluginOptions) {
    const { stigg, name, stepContext, onRefusal, ...middlewareOptions } = options;
    super(name ?? 'stigg');
    if (!stigg || typeof stigg.middleware !== 'function') {
      throw new Error('`StiggAdkPlugin` needs `stigg`: the `StiggAgentSDK` it governs through.');
    }
    if (stepContext !== undefined && typeof stepContext !== 'function') {
      throw new Error('`stepContext` must be a function of the step, returning its `stiggContext`.');
    }
    if (onRefusal !== undefined && typeof onRefusal !== 'function') {
      throw new Error('`onRefusal` must be a function of the refusal, returning what the agent answers.');
    }
    this.middleware = stigg.middleware({ ...middlewareOptions, missingCustomer: MISSING_CUSTOMER });
    this.stepContext = stepContext;
    this.onRefusal = onRefusal;
    this.warn = (message) => stigg.config.logger.warn(message);
  }

  override async beforeRunCallback({ invocationContext }: { invocationContext: InvocationContext }) {
    // A Set in ADK, kept in registration order.
    const plugins = (invocationContext.pluginManager as unknown as { plugins?: Iterable<BasePlugin> }).plugins;
    if (plugins && [...plugins][0] !== this) {
      this.warnOnce(
        `[stigg] list the Stigg plugin first in the Runner's \`plugins\`: ADK stops at the first plugin that ` +
          'returns a value, so a plugin before it that answers a step hides that step from Stigg.',
      );
    }
    return undefined;
  }

  override async beforeModelCallback({
    callbackContext,
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const { invocationId, agentName } = callbackContext;
    // This agent's earlier calls are over by now. Report any still open, and wait for every report in
    // flight, so the check below sees the spend.
    await this.settle(invocationId, (call) => call.agent === agentName);
    const runId = `adk:${invocationId}:${++this.seq}`;
    const step = { agent: agentName, adkContext: callbackContext, model: llmRequest.model };
    try {
      await this.middleware.startModel(runId, await this.attributionOf(step), 'adk.model');
    } catch (err) {
      const decision = isAccessDenied(err);
      if (!decision) throw err;
      return this.answerRefusal({ ...step, decision }, llmRequest, (err as Error).message);
    }
    const call: ModelCall = { runId, invocationId, agent: agentName, answered: false };
    this.callsByActions.set(callbackContext.actions, call);
    this.open(call);
    return undefined;
  }

  override async afterModelCallback({
    callbackContext,
    llmResponse,
  }: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    const call = this.callsByActions.get(callbackContext.actions);
    if (!call || !this.openCalls.has(call.runId)) return undefined;
    call.answered = true;
    if (llmResponse.usageMetadata) call.usage = llmResponse.usageMetadata as Record<string, unknown>;
    // A response with a finish reason is the call's last. Report it now, before ADK hands the event
    // to the caller - a caller that stops reading or aborts after the answer still has it reported.
    // A streamed call's earlier responses (text so far, a function call) have none: their usage is a
    // running total, so the call waits for its end.
    if (llmResponse.finishReason !== undefined || llmResponse.turnComplete) {
      await this.report([call], call.invocationId);
    }
    return undefined;
  }

  override async onModelErrorCallback({
    callbackContext,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    // A call that failed reports nothing, as a failed step does everywhere in the SDK.
    const call = this.callsByActions.get(callbackContext.actions);
    if (call && this.openCalls.delete(call.runId)) this.middleware.abandon(call.runId);
    return undefined;
  }

  override async beforeToolCallback({
    tool,
    toolArgs,
    toolContext,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    const { invocationId, agentName, functionCallId } = toolContext;
    if (CONTROL_TOOLS.has(tool.name)) return undefined;
    if (isAgentTool(tool)) {
      this.warnOnce(
        `[stigg] ${tool.name} is an AgentTool: ADK runs its agent in a Runner of its own, without this ` +
          "plugin, so that agent's model calls are not checked or reported. Add it as a sub-agent instead.",
      );
    }
    // Wait for usage reports in flight. Open calls are left alone: the call that asked for this tool
    // may still be streaming.
    await this.settle(invocationId, () => false);
    const runId = `adk:${invocationId}:tool:${functionCallId ?? ++this.seq}`;
    const step = { agent: agentName, adkContext: toolContext, tool: tool.name };
    try {
      await this.middleware.startTool(
        runId,
        // Scoped to the invocation: a model that reuses call ids across turns must not merge their reports.
        { name: tool.name, callId: runId, input: toolArgs },
        await this.attributionOf(step),
      );
    } catch (err) {
      const decision = isAccessDenied(err);
      if (!decision) throw err;
      if (functionCallId !== undefined) keep(this.toolDenials, `${invocationId}:${functionCallId}`, decision);
      // What the model reads: why, but not who refused or what is left - those stay with the plugin.
      return { error: `${tool.name} is not available: ${decision.reason ?? 'access denied'}.` };
    }
    // An earlier refusal of a call that reused this id no longer describes it.
    if (functionCallId !== undefined) this.toolDenials.delete(`${invocationId}:${functionCallId}`);
    this.toolRuns.set(toolContext, runId);
    return undefined;
  }

  // ADK calls this for a failed tool too, with `{ error }` as its result. By then
  // `onToolErrorCallback` has forgotten the step, so nothing is reported.
  override async afterToolCallback({
    tool,
    toolContext,
    result,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    const runId = this.toolRuns.get(toolContext);
    if (runId === undefined) return undefined;
    this.toolRuns.delete(toolContext);
    const report = this.middleware.endTool(runId, result, tool.name);
    // Tracked like a model call's report, so a parallel branch's next check waits for it too.
    this.track(toolContext.invocationId, report);
    await report;
    return undefined;
  }

  override async onToolErrorCallback({
    toolContext,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    error: Error;
  }): Promise<Record<string, unknown> | undefined> {
    const runId = this.toolRuns.get(toolContext);
    if (runId === undefined) return undefined;
    this.toolRuns.delete(toolContext);
    this.middleware.abandon(runId);
    return undefined;
  }

  override async afterAgentCallback({
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<undefined> {
    const { invocationId, agentName } = callbackContext;
    await this.settle(invocationId, (call) => call.agent === agentName);
    return undefined;
  }

  override async afterRunCallback({ invocationContext }: { invocationContext: InvocationContext }): Promise<void> {
    const { invocationId } = invocationContext;
    this.handedOff.delete(invocationId);
    await this.settle(invocationId, () => true);
  }

  /**
   * The decision behind an event a refusal ended in - a refused model call's event (the error, or
   * the answer `onRefusal` chose), or the function response of a refused tool - and `undefined` for
   * any other event.
   */
  denialOf(event: {
    invocationId?: string;
    customMetadata?: Record<string, unknown>;
    content?: { parts?: { functionResponse?: { id?: string } }[] };
  }): AccessDecision | undefined {
    const refused = asDecision(event.customMetadata?.[DECISION_KEY]);
    if (refused) return refused;
    for (const part of event.content?.parts ?? []) {
      const id = part.functionResponse?.id;
      const decision = id === undefined ? undefined : this.toolDenials.get(`${event.invocationId}:${id}`);
      if (decision) return decision;
    }
    return undefined;
  }

  /**
   * What a refused model call answers: `onRefusal`'s choice, or the error response - with the
   * decision in `customMetadata` either way, for `denialOf`. A transfer is a `transfer_to_agent`
   * call, which ADK runs as if the model had made it.
   */
  private async answerRefusal(refusal: AdkRefusal, llmRequest: LlmRequest, message: string): Promise<LlmResponse> {
    const withDecision = (response: LlmResponse): LlmResponse => ({
      ...response,
      customMetadata: { ...response.customMetadata, [DECISION_KEY]: refusal.decision },
    });
    const denied = withDecision({ errorCode: DENIED_ERROR_CODE, errorMessage: message });
    const answer = this.onRefusal ? await this.onRefusal(refusal) : undefined;
    if (!answer) return denied;
    if (!('transferTo' in answer)) return withDecision(answer);

    // A wrong target is a configuration error, so it throws rather than being answered.
    const targets = transferTargets(llmRequest);
    if (!targets.includes(answer.transferTo)) {
      throw new Error(
        `\`onRefusal\` hands ${refusal.agent}'s turn to "${answer.transferTo}", which ${refusal.agent} cannot ` +
          `transfer to${targets.length ? ` - it can reach ${targets.join(', ')}` : ''}.`,
      );
    }
    // Once per agent per run: a refused handoff runs no model, so ADK's `maxLlmCalls` never stops
    // two refused agents handing the turn to each other.
    const { invocationId } = refusal.adkContext;
    const agents = this.handedOff.get(invocationId) ?? new Set<string>();
    if (agents.has(refusal.agent)) return denied;
    agents.add(refusal.agent);
    keep(this.handedOff, invocationId, agents);
    return withDecision({
      content: {
        role: 'model',
        parts: [{ functionCall: { name: TRANSFER_TOOL, args: { agent_name: answer.transferTo } } }],
      },
    });
  }

  /** Who a step is for: the agent ADK runs it under, and the `stiggContext` `stepContext` resolves. */
  private async attributionOf(step: AdkStep): Promise<StepAttribution> {
    const stated = this.stepContext ? await this.stepContext(step) : undefined;
    if (stated !== undefined && (typeof stated !== 'object' || stated === null || Array.isArray(stated))) {
      throw new Error(`\`stepContext\` must return a \`stiggContext\` object, not ${String(stated)}.`);
    }
    return { agent: step.agent, stiggContexts: stated ? [stated] : [] };
  }

  /**
   * Opens a model call. When too many are open - runs that were aborted mid-stream - the oldest is
   * reported with the usage it has, rather than dropped.
   */
  private open(call: ModelCall): void {
    this.openCalls.set(call.runId, call);
    if (this.openCalls.size <= MEMORY_LIMIT) return;
    const oldest = this.openCalls.values().next().value!;
    this.warnOnce(
      `[stigg] more than ${MEMORY_LIMIT} ADK model calls are open at once, so the oldest are reported with ` +
        'the usage they have so far: a run that stops midway leaves its last call open.',
    );
    void this.report([oldest], oldest.invocationId);
  }

  /**
   * Reports the invocation's open calls that `match`, then waits for every report of the invocation
   * still in flight - its own, and ones another branch started.
   */
  private async settle(invocationId: string, match: (call: ModelCall) => boolean): Promise<void> {
    const due = [...this.openCalls.values()].filter((call) => call.invocationId === invocationId && match(call));
    await this.report(due, invocationId);
  }

  /** Reports each call once, and waits for the invocation's reports in flight. */
  private async report(calls: ModelCall[], invocationId: string): Promise<void> {
    for (const call of calls) {
      this.openCalls.delete(call.runId);
      // No response came back: something answered in the model's place, so it costs nothing.
      if (!call.answered) {
        this.middleware.abandon(call.runId);
        continue;
      }
      this.track(invocationId, this.middleware.endModel(call.runId, measurementOf(call)));
    }
    await Promise.all(this.reporting.get(invocationId) ?? []);
  }

  /** Keeps a usage report in flight until it lands, so the invocation's next check waits for it. */
  private track(invocationId: string, report: Promise<void>): void {
    // Never rejects: a failed ingest is reported through the hooks.
    const pending = this.reporting.get(invocationId) ?? new Set<Promise<void>>();
    this.reporting.set(invocationId, pending);
    pending.add(report);
    void report.finally(() => {
      pending.delete(report);
      if (pending.size === 0 && this.reporting.get(invocationId) === pending) this.reporting.delete(invocationId);
    });
  }

  /** Says a thing once per process - and never fails a step for the logger's sake. */
  private warnOnce(message: string): void {
    if (this.warned.has(message) || this.warned.size >= 100) return;
    this.warned.add(message);
    safely(
      () => this.warn(message),
      () => undefined,
    );
  }
}

/** Adds an entry to a map, dropping the oldest past `MEMORY_LIMIT`. */
function keep<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MEMORY_LIMIT) map.delete(map.keys().next().value!);
}

/**
 * A call's usage as a measurement. ADK states every model's usage in Gemini's `usageMetadata`
 * shape, whichever model served it. The call's own run id is the idempotency key, so a call
 * reported twice counts once.
 */
function measurementOf(call: ModelCall): Measurement | undefined {
  const usage = call.usage;
  if (!usage) return undefined;
  return {
    metrics: pickMetrics(usage, GEMINI_METRICS),
    usage: normalizeUsage(usage),
    raw: usage,
    idempotencyKey: call.runId,
  };
}

/**
 * The agents this call may transfer to, exactly as ADK offers them to the model: the `agent_name`
 * values of the `transfer_to_agent` tool on the request. No tool, no targets.
 */
function transferTargets(llmRequest: LlmRequest): string[] {
  const tool = llmRequest.toolsDict?.[TRANSFER_TOOL] as
    | { _getDeclaration?: () => { parameters?: { properties?: { agent_name?: { enum?: unknown } } } } | undefined }
    | undefined;
  const names = tool?._getDeclaration?.()?.parameters?.properties?.agent_name?.enum;
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [];
}

const asDecision = (value: unknown): AccessDecision | undefined =>
  typeof value === 'object' && value !== null && (value as AccessDecision).hasAccess === false
    ? (value as AccessDecision)
    : undefined;
