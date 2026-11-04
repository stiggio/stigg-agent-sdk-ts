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
 */
import type { StiggAgentSDK } from '../../../stigg-agent-sdk';
import type { StiggContext } from '../../../core/context';
import type { SessionHooks } from '../../../core/session';
import type { ClientContext, GovernedAgentMiddleware, Measurement } from '../../../types';
import type { StepAttribution } from '../core/agent-middleware';
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
  /** What this middleware did, and what is still in flight. */
  readonly stigg: GovernedAgentMiddleware['stigg'];
};

export function stiggVercelMiddleware({
  stigg,
  stiggContext,
  hooks,
}: StiggVercelMiddlewareOptions): StiggVercelMiddleware {
  if (!stigg || typeof stigg.middleware !== 'function') {
    throw new Error('stiggVercelMiddleware needs `stigg`: the StiggAgentSDK instance to govern through.');
  }
  const governance = stigg.middleware({ stiggContext, hooks, missingCustomer: MISSING_CUSTOMER });
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
  const callOf = (params: any): unknown =>
    contexts.get(params) ?? JSON.stringify([stiggContext?.customerId, stiggContext?.agentId]);

  /** Checks the step, as the agent and customer this call names. Refused: `AccessDeniedError`. */
  const start = async (params: any, model: any, event: string) => {
    // Once: a call's steps run one after another, so nothing of its own lands while this waits.
    await Promise.all(reporting.get(callOf(params)) ?? []);
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
      observeStream(result, params?.abortSignal, (measurement, modelId) => {
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
      });
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
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      report(cancelEnd(reason));
      await reader.cancel(reason);
    },
  });
}
