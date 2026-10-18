/**
 * What a client binding needs to know about one vendor - and nothing more.
 *
 * Everything vendor-specific lives in a recipe: which methods to gate, how to read usage off a
 * response, how a streamed response reports it later. The wrapper itself stays generic, so a new
 * provider is a recipe file rather than a second copy of the gate.
 */
import type { Measurement, TokenUsage } from '../../../types';

/**
 * Just enough of a fetch `Response` for a recipe that has to read a header off it.
 *
 * Structural on purpose: core must not depend on a vendor's response class, nor on the DOM lib.
 * Most vendors put everything a meter needs in the body, but not all - LiteLLM computes the cost
 * and reports it beside the body, in `x-litellm-response-cost`, so a body-only extractor cannot
 * see the one number that matters.
 */
export type MeteredResponse = { headers?: { get: (name: string) => string | null } };

/** A single method to gate, addressed by its property path from the client root. */
export type MethodRecipe = {
  /**
   * e.g. `['messages', 'create']` - the owner object is everything but the last segment.
   *
   * The method must return the vendor's request promise - an `APIPromise`, in both SDKs' terms:
   * a promise that also offers `asResponse()` and `withResponse()`. The gate cannot hand over the
   * vendor's own object, because the check it runs first is asynchronous and the object does not
   * exist until it has passed, so it returns a stand-in shaped like one. A method that returns
   * anything else - a paginated list, a stream helper, a bare value - would lose whatever that
   * shape offers beyond a promise.
   */
  path: readonly string[];
  /**
   * Which argument carries `stiggContext`, when it is not the first.
   *
   * Most vendor methods take one options object, so the context rides in argument 0 and this is
   * left alone. A method whose first argument is not that object needs to say so - Cloudflare's
   * `ai.run(model, inputs)` names the model first - or a caller's per-call context is forwarded
   * to the vendor as an unknown field and the gate silently uses the wrap-time one instead.
   */
  contextArg?: number;
  /**
   * True when this call is an internal leg of another wrapped method and must not be gated
   * twice. Vendors mark these differently, so only the recipe can tell.
   */
  passthrough?: (params: any, options: any) => boolean;
  /** Units to ask for before the call. Defaults to 1 - "is there any budget left at all?". */
  estimate?: (params: any) => number;
  /**
   * Read straight off a completed response. Undefined when the result is a stream.
   *
   * `response` is the transport response the body came in on, for the vendors that report spend
   * in a header rather than in the body. It is absent when the client's promise exposes no
   * `withResponse()`, so a recipe that needs it must say what it does without it.
   */
  extractUsage?: (result: any, response?: MeteredResponse) => TokenUsage | Measurement | undefined;
  /**
   * Hooks a result that reports usage later. Wrap the iterator in place and call `ingest` once
   * the stream completes, so one completed response emits exactly one measurement.
   */
  attachStream?: (
    result: any,
    ingest: (measurement: TokenUsage | Measurement) => void,
    response?: MeteredResponse,
  ) => void;
  /**
   * The event name for this call, when async ingest should report it as something other than the
   * derived `vendor.path` - a proxy standing in for another vendor's API, say.
   */
  event?: string;
};

export type ClientRecipe<M extends string = string> = {
  vendor: string;
  /**
   * The *name* of whichever metric is this vendor's total - not the number, which rides the
   * measurement as `TokenUsage.total`.
   *
   * Declared rather than inferred, because the name differs per vendor - `totalTokenCount` for
   * Gemini, `total_tokens` for everyone else - and a caller pricing metrics otherwise has no way
   * to tell the total apart from the counters underneath it except by knowing each vendor by
   * heart. Which matters: billing this *and* a component double-charges those tokens.
   *
   * Absent for a vendor that publishes no total and whose counters overlap, where there is
   * nothing honest to put here.
   */
  totalTokensMetric?: M;
  /**
   * Every metric name this recipe can report, across all of its surfaces.
   *
   * What a mapper of your own can price, and what `weightedMetrics` types its table against. The
   * union rather than one list per surface: a client speaks whichever API it likes, and a table
   * covering both prices either - a name the call did not report is simply absent.
   */
  metrics: readonly M[];
  methods: MethodRecipe[];
  /**
   * Duck-typed guard: does this recipe fit that client? Lets `wrap(client)` take one argument
   * instead of asking the caller to name a vendor it can see for itself.
   */
  matches?: (client: unknown) => boolean;
};

/** The metric names a recipe reports, for naming the union without repeating it. */
export type MetricsOf<R> = R extends ClientRecipe<infer M> ? M : never;

/**
 * What a mapper reads for that recipe: its metric names, each possibly absent.
 *
 * Partial because a counter the response did not carry is missing rather than zero - a vendor
 * reports cache reads only when there were some. Each client binding exports this ready-made for
 * its own vendor, so a hand-written mapper names the shape instead of building it.
 */
export type MetricsFor<R> = Partial<Record<MetricsOf<R>, number>>;

/** The set of recipes a client can be matched against. */
export interface ClientRegistry {
  register(recipe: ClientRecipe): void;
  find(client: unknown): ClientRecipe | undefined;
  vendors(): string[];
}

/**
 * What one call is called, for the event an async ingest reports.
 *
 * The vendor's own words for its own call - `anthropic.messages.create` - because the name is not
 * an internal label: a Stigg raw-events meter filters on it, so it has to be something whoever
 * configures that meter would recognise and could have guessed. Derived from what the recipe
 * already declares, so a new binding names its events by existing.
 */
export const eventNameFor = (recipe: { vendor: string }, method: MethodRecipe): string =>
  method.event ?? `${recipe.vendor}.${method.path.join('.')}`;
