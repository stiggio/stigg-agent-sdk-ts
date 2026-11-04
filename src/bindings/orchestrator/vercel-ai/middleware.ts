/**
 * The Vercel AI SDK binding: a language model middleware, for `wrapLanguageModel`.
 *
 *   const model = wrapLanguageModel({ model: anthropic(MODEL), middleware: stiggVercelMiddleware({ stigg, stiggContext }) });
 *   await generateText({ model, prompt, providerOptions: { stigg: { customerId } } });
 *
 * Every step of `generateText`, `streamText` and an agent's loop is one model call, so each one is
 * checked before it runs and reported after, through the same core as the LangChain and ADK
 * bindings. A call's own `stiggContext` rides `providerOptions.stigg`, and is taken out before the
 * provider sees the call. Nothing here imports `ai`: a middleware is a plain object. See
 * docs/vercel-ai.md.
 *
 * A model middleware never sees a tool run, so the paid tools are governed by `tools()`, which wraps
 * each one's `execute`. A tool call is governed as the model step that asked for it.
 */
import type { StiggAgentSDK } from '../../../stigg-agent-sdk';
import type { StiggContext } from '../../../core/context';
import type { SessionHooks } from '../../../core/session';
import { isAccessDenied } from '../../../errors';
import { safely } from '../../../core/hooks';
import type { ClientContext, GovernedAgentMiddleware, Measurement, MiddlewareTools } from '../../../types';
import { ALL_TOOLS, type StepAttribution } from '../core/agent-middleware';
import { NO_USAGE, contentChars, estimated, measurementOf, type ModelUsage } from './usage';

export { VERCEL_AI_METRICS, measurementOf } from './usage';
export type { VercelAIMetric, VercelAIMetrics } from './usage';

const MISSING_CUSTOMER =
  'Name it on every call as `providerOptions: { stigg: { customerId } }`, ' +
  'or give the middleware a default in its `stiggContext: { customerId }`.';

export type StiggVercelMiddlewareOptions = {
  stigg: StiggAgentSDK;
  /** Every call's context - typically the agent's `agentId` and what it gates on. A call's `providerOptions.stigg` is laid over it. */
  stiggContext?: ClientContext;
  /**
   * The paid tools, by tool name - `'*'` for every tool not named, `false` to exempt one. Governed
   * once wrapped by `tools()`. A sub-agent run inside a tool is metered by its own model calls, so
   * give it `false` under `'*'`.
   */
  tools?: MiddlewareTools;
  hooks?: SessionHooks;
};

/**
 * What `wrapLanguageModel` takes, typed here so this package does not import `ai`. `v3` is what
 * `ai` 6 requires; `ai` 7 accepts any version and runs it the same way.
 */
export type StiggVercelMiddleware = {
  readonly specificationVersion: 'v3';
  transformParams(options: { params: any }): Promise<any>;
  wrapGenerate(options: { doGenerate: () => PromiseLike<any>; params: any; model?: any }): Promise<any>;
  wrapStream(options: { doStream: () => PromiseLike<any>; params: any; model?: any }): Promise<any>;
  /**
   * The same tools, each paid one's `execute` wrapped: checked before it runs, and reported after it
   * succeeds. A refused tool does not run; it fails with a message that names the tool and why, and
   * `stigg.denial(error)` returns the decision. Tools with no `execute` are returned as they are.
   */
  tools<T extends Record<string, any>>(tools: T): T;
  /** What this middleware did, and what is still in flight. */
  readonly stigg: GovernedAgentMiddleware['stigg'];
};

/** A tool call a model step asked for: who it is for, and the call whose reports it waits on. */
type IssuedCall = { context?: StiggContext; call: unknown };

/** How many asked-for tool calls are remembered. One that never runs - a client-side tool - is dropped past it. */
const ISSUED_CALLS_LIMIT = 1_000;

export function stiggVercelMiddleware({
  stigg,
  stiggContext,
  tools: toolConfig,
  hooks,
}: StiggVercelMiddlewareOptions): StiggVercelMiddleware {
  if (!stigg || typeof stigg.middleware !== 'function') {
    throw new Error('stiggVercelMiddleware needs `stigg`: the StiggAgentSDK instance to govern through.');
  }
  const governance = stigg.middleware({ stiggContext, tools: toolConfig, hooks, missingCustomer: MISSING_CUSTOMER });
  // `doGenerate()` takes no arguments: the model is called with what `transformParams` returned.
  // So the context comes out there, and is found again by that params object.
  const contexts = new WeakMap<object, StiggContext>();
  // A step's id is also its AUDR span, so it is unique across middlewares, not only among this
  // one's steps in flight: one id per middleware, and a counter under it.
  const prefix = crypto.randomUUID();
  let steps = 0;
  // A stream reports when it ends, after `wrapStream` has returned - so the call's next step waits
  // for those reports here, and is checked against their spend. Keyed by the call: the AI SDK hands
  // every step of one call the same `providerOptions.stigg` object, so other calls - other users
  // of the same customer included - never queue behind it. A call with no context of its own falls
  // back to its customer and agent. `endModel` never rejects.
  const reporting = new Map<unknown, Set<Promise<void>>>();
  const defaultCall = JSON.stringify([stiggContext?.customerId, stiggContext?.agentId]);
  const callOf = (params: any): unknown => contexts.get(params) ?? defaultCall;
  /** Waits for a call's stream reports in flight, so its next check sees their spend. */
  const settle = (call: unknown) => Promise.all(reporting.get(call) ?? []);

  // A tool's `execute` is handed only the call id, so each tool call a model step asks for is kept
  // by its id - before the AI SDK can start the tool - and taken when it runs.
  // Only for tools `tools()` wrapped: another's call - client-side, run by the provider - never runs
  // here, and would only fill the map.
  // ponytail: keyed by the provider's id alone. First-party providers make each id unique; a
  // backend that reuses ids (`call_0`) across concurrent calls would let one call's entry replace
  // another's - scope the key by call if one shows up. A call `experimental_repairToolCall` renames
  // is not kept either, and is governed as one no step asked for.
  const issued = new Map<string, IssuedCall>();
  const wrapped = new Set<string>();
  const ask = (
    params: any,
    part: { type?: string; toolCallId?: unknown; toolName?: unknown; providerExecuted?: unknown } | null | undefined,
  ): void => {
    if (part?.type !== 'tool-call' || typeof part.toolCallId !== 'string' || part.providerExecuted) return;
    if (typeof part.toolName !== 'string' || !wrapped.has(part.toolName)) return;
    issued.delete(part.toolCallId);
    issued.set(part.toolCallId, { context: contexts.get(params), call: callOf(params) });
    if (issued.size > ISSUED_CALLS_LIMIT) issued.delete(issued.keys().next().value!);
  };

  /**
   * Said once per tool: a call no model step of this middleware asked for - approved after a pause
   * (`needsApproval` runs it at the start of the next call, before any model step), answered on
   * another instance, or asked by another middleware's model - and whose own context names no
   * `stigg`, is governed by this middleware's own `stiggContext`, and reported for its customer.
   */
  const warned = new Set<string>();
  const warnOnce = (name: string): void => {
    if (warned.has(name)) return;
    warned.add(name);
    // A logger that throws must not fail the tool it only reports on.
    safely(
      () =>
        stigg.config?.logger?.warn(
          `[stigg] tool "${name}" ran without a model step this middleware saw asking for it, and its ` +
            "context names no `stigg`, so it is governed by the middleware's own stiggContext. An approved " +
            `tool does this: name its customer in \`toolsContext: { ${name}: { stigg: { customerId } } }\`.`,
        ),
      () => undefined,
    );
  };

  /** Checks a tool call as the step that asked for it. Refused: an error the model may read. */
  const startTool = async (name: string, input: unknown, options: any): Promise<string> => {
    const callId = typeof options?.toolCallId === 'string' ? options.toolCallId : undefined;
    const issuedCall = callId === undefined ? undefined : issued.get(callId);
    if (callId !== undefined) issued.delete(callId);
    // No model step asked for it here - an approved tool runs at the start of the next call - so
    // the tool's own context may name who it is for: `toolsContext` (ai 7), `experimental_context` (ai 6).
    const stated = issuedCall ? undefined : toolContextOf(options);
    const asked = issuedCall ?? (stated ? { context: stated, call: stated } : undefined);
    if (!asked) warnOnce(name);
    // A stream reports when it ends, and the AI SDK runs its tools before that: the tool's check
    // waits, so it sees the spend of the step that asked for it.
    await settle(asked?.call ?? defaultCall);
    const runId = `${prefix}:tool:${++steps}`;
    try {
      await governance.startTool(
        runId,
        { name, callId, input },
        { stiggContexts: asked?.context ? [asked.context] : [] },
      );
    } catch (err) {
      const decision = isAccessDenied(err);
      if (!decision) throw err;
      // The AI SDK hands a failed tool's message to the model, so it says why, not who refused or
      // what is left. The decision rides along as the cause, for `stigg.denial(error)`.
      throw new Error(`${name} is not available: ${decision.reason ?? 'access denied'}.`, { cause: err });
    }
    return runId;
  };

  /**
   * A tool whose `execute` is checked and reported. An `async function*` streams its results, and is
   * reported by its last one, as the AI SDK takes it.
   * ponytail: any other function returns a promise here, since the check is awaited first - so an
   * async iterable it returns is run to its end and answered by its last value, without the
   * preliminary results. Write it as `async function*` to stream them.
   */
  const governTool = (name: string, tool: any) => {
    const execute = tool.execute as (input: unknown, options: unknown) => any;
    if (Object.prototype.toString.call(execute) === '[object AsyncGeneratorFunction]') {
      return async function* (input: unknown, options: unknown) {
        const runId = await startTool(name, input, options);
        let output: unknown;
        let finished = false;
        try {
          for await (const value of execute.call(tool, input, options)) {
            output = value;
            yield value;
          }
          finished = true;
        } finally {
          if (!finished) governance.abandon(runId);
        }
        await governance.endTool(runId, output, name);
      };
    }
    return async (input: unknown, options: unknown) => {
      const runId = await startTool(name, input, options);
      let output: unknown;
      try {
        output = await execute.call(tool, input, options);
        if (isAsyncIterable(output)) {
          let last: unknown;
          for await (const value of output) last = value;
          output = last;
        }
      } catch (err) {
        governance.abandon(runId);
        throw err;
      }
      // Awaited, and the AI SDK waits for every tool before the next step: that step's check sees it.
      await governance.endTool(runId, output, name);
      return output;
    };
  };

  /** Checks the step, as the agent and customer this call names. Refused: `AccessDeniedError`. */
  const start = async (params: any, model: any, event: string) => {
    // Once: a call's steps run one after another, so nothing of its own lands while this waits.
    await settle(callOf(params));
    const runId = `${prefix}:${++steps}`;
    const context = contexts.get(params);
    // Kept by the middleware until the step ends, so the model the reply names can still land on it.
    const trace = audrOf(model);
    await governance.startModel(runId, { stiggContexts: context ? [context] : [], audr: trace }, event);
    return { runId, trace };
  };

  return {
    specificationVersion: 'v3',
    stigg: governance.stigg,

    tools(tools) {
      if (!toolConfig || Object.keys(toolConfig).length === 0) {
        throw new Error(
          "stiggVercelMiddleware's tools() needs a `tools` option: the paid tools by name, '*' for the rest.",
        );
      }
      // Only a tool the config governs - by name, else through `'*'` - as the core looks it up. An
      // exempt or unpriced one is left as it is: nothing would check it, so nothing should wait.
      const governed = (name: string) => {
        const entry = Object.hasOwn(toolConfig, name) ? toolConfig[name] : toolConfig[ALL_TOOLS];
        return entry !== undefined && entry !== false;
      };
      return Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => {
          if (typeof tool?.execute !== 'function' || !governed(name)) return [name, tool];
          wrapped.add(name);
          return [name, { ...tool, execute: governTool(name, tool) }];
        }),
      ) as typeof tools;
    },

    async transformParams({ params }) {
      const options = params?.providerOptions;
      if (!options || typeof options !== 'object' || !('stigg' in options)) return params;
      // The AI Gateway posts call options whole, and the customer and agent ids are not Vercel's to receive.
      const { stigg: context, ...rest } = options;
      if (context !== null && (typeof context !== 'object' || Array.isArray(context))) {
        throw new TypeError(
          `\`providerOptions.stigg\` must be a stiggContext object, or null for none - got ${typeof context}.`,
        );
      }
      const stripped = { ...params, providerOptions: rest };
      if (context) contexts.set(stripped, context as StiggContext);
      return stripped;
    },

    async wrapGenerate({ doGenerate, params, model }) {
      const { runId, trace } = await start(params, model, 'vercel-ai.generate');
      let result: any;
      try {
        result = await doGenerate();
      } catch (err) {
        governance.abandon(runId);
        throw err;
      }
      // Awaited, so the agent's next step is checked against this one's spend. Never throws. No
      // usage stated: estimated from the reply, as a stream is, and counted as a metering failure.
      const responseId = result?.response?.id;
      const chars = contentChars(result?.content);
      served(trace, result?.response?.modelId);
      for (const part of Array.isArray(result?.content) ? result.content : []) ask(params, part);
      await governance.endModel(
        runId,
        measurementOf(result?.usage, responseId) ?? (chars ? estimated(chars, NO_USAGE, responseId) : undefined),
      );
      return result;
    },

    async wrapStream({ doStream, params, model }) {
      const { runId, trace } = await start(params, model, 'vercel-ai.stream');
      let result: any;
      try {
        result = await doStream();
      } catch (err) {
        governance.abandon(runId);
        throw err;
      }
      observeStream(
        result,
        params?.abortSignal,
        (measurement, modelId) => {
          if (!measurement) return governance.abandon(runId);
          served(trace, modelId);
          const call = callOf(params);
          const pending = reporting.get(call) ?? new Set<Promise<void>>();
          reporting.set(call, pending);
          const report = governance.endModel(runId, measurement);
          pending.add(report);
          void report.finally(() => {
            pending.delete(report);
            if (pending.size === 0 && reporting.get(call) === pending) reporting.delete(call);
          });
        },
        (part) => ask(params, part),
      );
      return result;
    },
  };
}

/**
 * What an AUDR record names for the model the AI SDK called. Its `provider` is the provider and the
 * API it went through - `anthropic.messages`, `openai.chat` - and the vendor is the part before the dot.
 */
function audrOf(model: any): NonNullable<StepAttribution['audr']> {
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  return {
    provider: text(model?.provider)?.split('.')[0],
    model: text(model?.modelId),
  };
}

/** The model the reply says served, over the one the call asked for: a gateway or an alias can differ. */
function served(trace: NonNullable<StepAttribution['audr']>, modelId: unknown): void {
  if (typeof modelId === 'string' && modelId) trace.model = modelId;
}

type StreamPart = { type?: string; id?: string; modelId?: unknown; delta?: unknown; usage?: ModelUsage };

/** How a stream ended. Only `stopped` - the caller's own stop - is not a gap in metering. */
type StreamEnd = 'ended' | 'failed' | 'timedOut' | 'stopped';

/** What `incomplete` says for a stream that ended without its usage, by how it ended. */
const STREAM_GAPS: Record<StreamEnd, string> = {
  ended: NO_USAGE,
  failed: 'the stream failed before the model stated its usage, so its output was estimated',
  timedOut: 'the call timed out before the model stated its usage, so its output was estimated',
  stopped: 'the call was stopped before any output, so its input was not measured',
};

/** A timeout's abort is not the caller stopping. */
const isTimeout = (reason: unknown) => (reason as Error | undefined)?.name === 'TimeoutError';

/**
 * Why a reader cancelled: the AI SDK cancels an attempt it retries with the provider's error, which
 * is a failure; any other reason is the caller stopping.
 */
function cancelEnd(reason: unknown): StreamEnd {
  if (isTimeout(reason)) return 'timedOut';
  return reason instanceof Error && reason.name !== 'AbortError' ? 'failed' : 'stopped';
}

/** What a stream has told us so far. */
function streamTally() {
  let usage: ModelUsage | undefined;
  let responseId: string | undefined;
  let modelId: string | undefined;
  let chars = 0;
  return {
    /** The model the stream's metadata said served, if it said. */
    modelId: () => modelId,
    /** Never throws: a malformed part is simply not counted. */
    record(part: StreamPart | null | undefined): void {
      if (part?.type === 'finish') usage = part.usage;
      else if (part?.type === 'response-metadata') {
        if (typeof part.id === 'string') responseId = part.id;
        if (typeof part.modelId === 'string') modelId = part.modelId;
      } else if (typeof part?.delta === 'string') chars += part.delta.length;
    },
    /**
     * The usage the model stated; else an estimate; else nothing, for an attempt that produced
     * nothing. A stream the caller stopped is estimated without counting as a metering failure -
     * unless there was nothing to estimate, while the provider still counted its input.
     */
    measurement(end: StreamEnd): Measurement | undefined {
      const measured = measurementOf(usage, responseId);
      if (measured) return measured;
      if (chars === 0 && responseId === undefined) return undefined;
      const gap = end === 'stopped' && chars > 0 ? undefined : STREAM_GAPS[end];
      return estimated(chars, gap, responseId);
    },
  };
}

/**
 * Calls `done` once, when the stream ends: read to the end, failed, cancelled, or stopped by the
 * call's `abortSignal` - which is how the AI SDK stops a stream, without cancelling it.
 * ponytail: a reader that stops with no `abortSignal` is not reported; nothing tells this layer.
 */
export function observeStream(
  result: any,
  signal: AbortSignal | undefined,
  done: (measurement: Measurement | undefined, modelId?: string) => void,
  /** Each part, before the AI SDK reads it - so a tool call is known before its tool can start. */
  onPart?: (part: StreamPart & { toolCallId?: unknown }) => void,
): void {
  const source = result?.stream as ReadableStream<StreamPart> | undefined;
  if (typeof source?.getReader !== 'function') {
    done(undefined);
    return;
  }

  const tally = streamTally();
  let reported = false;
  const report = (end: StreamEnd) => {
    if (reported) return;
    reported = true;
    // Every step of a loop shares the signal, which may live as long as the process.
    signal?.removeEventListener('abort', onAbort);
    done(tally.measurement(end), tally.modelId());
  };
  const onAbort = () => report(isTimeout(signal?.reason) ? 'timedOut' : 'stopped');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  // A source of its own rather than a TransformStream, whose flush never runs on a cancel.
  const reader = source.getReader();
  result.stream = new ReadableStream<StreamPart>({
    async pull(controller) {
      const next = await reader.read().catch((err: unknown) => {
        report('failed');
        throw err;
      });
      if (next.done) {
        report('ended');
        controller.close();
        return;
      }
      tally.record(next.value);
      onPart?.(next.value);
      // The AI SDK starts a step's tools on its `finish` part, before the stream closes - which, from
      // an HTTP provider, is a later read. So the step reports here, and its tools' checks see it.
      if (next.value?.type === 'finish') report('ended');
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      report(cancelEnd(reason));
      await reader.cancel(reason);
    },
  });
}

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof (value as AsyncIterable<unknown> | null)?.[Symbol.asyncIterator] === 'function';

/** The `stigg` a tool's own context states - its `toolsContext` entry on ai 7, `experimental_context` on ai 6. */
function toolContextOf(options: any): StiggContext | undefined {
  const context = options?.context?.stigg ?? options?.experimental_context?.stigg;
  if (context === undefined || context === null) return undefined;
  if (typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError(`A tool's context \`stigg\` must be a stiggContext object - got ${typeof context}.`);
  }
  // On ai 6 the context is the whole app's, and `stigg` there may be the SDK instance itself: only
  // a plain object is a stiggContext. Anything else names no one, and the SDK says so.
  const proto = Object.getPrototypeOf(context);
  return proto === Object.prototype || proto === null ? (context as StiggContext) : undefined;
}
