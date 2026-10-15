/**
 * The client binding: a drop-in wrapper that gates before the call and meters after it.
 *
 * Two properties matter and pull in opposite directions. Metering must never break the caller's
 * call, so ingest failures are swallowed into `onError`. Enforcement must never be swallowed, so
 * a denial is raised. They are deliberately separate code paths here: a failed check becomes a
 * policy decision, never an accidental "allowed".
 *
 * Methods are patched onto a copy rather than proxied or subclassed: a Proxy needs a nested proxy
 * per namespace and has to keep `this` intact for helpers that re-enter the client, and
 * subclassing breaks on the next SDK release. The copy is what leaves `wrap()`; the object the
 * caller built is never mutated, so it keeps working ungoverned.
 *
 * ## The per-call context, and why it is read the way it is
 *
 * A gated call sits directly in front of a network request the application pays for, so the SDK's
 * own work has to disappear next to it. The hot path below does exactly this much when a call
 * carries no `stiggContext`: one property read and one truthiness test. Nothing is destructured,
 * merged, validated or allocated - the context `wrap` resolved is used as it stands.
 */
import { AccessDeniedError } from '../../../errors';
import { isEnforced, noCustomer, overrideContext, type ResolvedContext } from '../../../core/context';
import type { GovernanceSession } from '../../../core/session';
import { toMeasurement } from '../../../types';
import type { Measurement, TokenUsage } from '../../../types';
import { eventNameFor } from './types';
import type { ClientRecipe, MethodRecipe } from './types';

const WRAPPED = Symbol.for('stigg.agent-sdk.wrapped');

export function wrapClient<T extends object>(
  client: T,
  recipe: ClientRecipe,
  session: GovernanceSession,
  context: ResolvedContext,
): T {
  const already = (client as T & { [WRAPPED]?: string })[WRAPPED];
  if (already) {
    throw new Error(
      `This client is already governed (${already}). Wrap the client you built, not one that ` +
        '`wrap(...)` handed back - the context travels with each call, so one wrapped client ' +
        'already serves every customer and agent.',
    );
  }

  const copy = Object.create(client) as T;
  let patched = 0;
  for (const method of recipe.methods) {
    if (patch(copy, client, session, context, method, eventNameFor(recipe, method))) patched += 1;
  }

  // A recipe whose paths resolve to nothing produces a client that is stamped, looks governed,
  // and gates nothing - the same outcome `wrap` already refuses when no recipe matches at all,
  // reached by a different road. Partial is fine and expected: `openAIRecipe` declares both
  // surfaces because one client can speak either, and a client built for one has no other.
  if (!patched) {
    throw new Error(
      `The ${recipe.vendor} recipe gates ${recipe.methods.map((m) => m.path.join('.')).join(', ')}, and this ` +
        'client has none of them. Nothing would be checked or metered, so this is refused rather ' +
        'than handed back looking governed. Check the recipe matches the client you passed.',
    );
  }

  Object.defineProperty(copy, WRAPPED, { value: recipe.vendor, enumerable: false });
  return copy;
}

/** Whether this client is one `wrap(...)` handed back. */
export function isGoverned(client: object): boolean {
  return (client as { [WRAPPED]?: string })[WRAPPED] !== undefined;
}

/**
 * Gives the copy its own objects along one gated path.
 *
 * `Object.create(client)` alone is not enough: the copy would *inherit* `messages`, so patching
 * `copy.messages.create` would write straight into the namespace the original shares. Only the
 * objects on a gated path are copied; everything else is inherited, so a namespace the vendor
 * builds lazily still resolves.
 */
function ownPath(copy: any, source: any, path: string[]): { owner: any; realOwner: any } | undefined {
  let owner = copy;
  let realOwner = source;

  for (const key of path) {
    const next = realOwner?.[key];
    if (next === null || typeof next !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(owner, key)) {
      Object.defineProperty(owner, key, {
        value: Object.create(next),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    owner = owner[key];
    realOwner = next;
  }

  return { owner, realOwner };
}

function patch(
  copy: object,
  source: object,
  session: GovernanceSession,
  base: ResolvedContext,
  method: MethodRecipe,
  eventName: string,
): boolean {
  const resolved = ownPath(copy, source, method.path.slice(0, -1));
  if (!resolved) return false;
  const { owner, realOwner } = resolved;

  const key = method.path[method.path.length - 1]!;
  const original = realOwner?.[key];
  if (typeof original !== 'function') return false;

  // How much to ask permission for before the call - Stigg's `requestedUsage`. The recipe owns
  // it: only the adapter can read a cost off that vendor's own parameters. Defaults to 1,
  // "is there any budget left at all?" - the ingest afterwards is what makes the balance right.
  const estimate = method.estimate ?? (() => 1);
  // Folded in once per method rather than per call. The event name is the only part of a context
  // that depends on which method was gated - it is what a Stigg meter filters on, and one client
  // can reach two APIs a meter should be able to tell apart - so resolving it here is what lets
  // the common call read a context with nothing left to decide.
  const defaults: ResolvedContext = base.eventName ? base : { ...base, eventName: { name: eventName } };

  owner[key] = function gated(...args: any[]) {
    // Whatever the vendor's own signature takes. Naming the first two and forwarding only those
    // would quietly drop the rest of a call the recipe never claimed to reshape.
    // Argument 0 unless the method says otherwise: a vendor whose first argument is not its
    // options object would otherwise have a caller's context forwarded to it verbatim.
    const contextArg = method.contextArg ?? 0;
    let params = args[contextArg];
    let context = defaults;
    // The context rides inside the vendor's own parameter object, so it has to come back out
    // before anything - the recipe's own hooks included - ever sees those parameters. Both the
    // copy and the merge happen only for a call that actually carried one.
    if (params?.stiggContext !== undefined) {
      const { stiggContext, ...rest } = params;
      params = rest;
      args = args.map((arg, i) => (i === contextArg ? rest : arg));
      context = overrideContext(defaults, stiggContext);
    }

    const callOptions = args[1];

    // The vendor's own object is the receiver, never the copy: an SDK method reading a private
    // field off `this` would throw on an object that only delegates to the real one.
    const target = realOwner as object;
    if (method.passthrough?.(params, callOptions)) {
      return original.apply(target, args);
    }

    const settled = (async (): Promise<Settled> => {
      // The one field a call cannot proceed without, refused here rather than three frames down.
      // `wrap` deliberately allows a client with no customer - its calls each name their own, and
      // the types say which still owe one - but a type is not a guarantee at runtime, and a
      // framework that owns the call site cannot satisfy one. Left to reach the engine, the empty
      // id comes back as a verdict about a customer that is not there, worded as confidently as
      // any other and attributed to nobody.
      //
      // Inside the async body on purpose: this method stands in for the vendor's, which returns a
      // promise, so a caller's `.catch()` has to see this the way it sees a denial.
      if (!context.customerId) throw noCustomer();

      // The context owns the check policy; this only decides how much to ask for. A context that
      // names no entitlement has nothing to ask against, so the gate is skipped outright rather
      // than asked and ignored: `estimate` is the recipe reading the caller's own parameters, and
      // paying for one per call to throw the answer away is not what metering-only promises - nor
      // would a client whose every call checked still report the `checks: 0` an operator reads.
      if (isEnforced(context)) {
        const decision = await session.check(context, requestedUnits(estimate, params));
        // No return path here for a structured refusal - the vendor's signature owns the return
        // type - so this is the one place the SDK raises instead of returning a decision.
        if (!decision.hasAccess) throw new AccessDeniedError(decision);
      }

      const result = await collect(original.apply(target, args), params);

      // Whatever the recipe reports - tokens for most vendors, real spend plus the model that
      // served it for one that knows better. The wrapper stays out of that judgement.
      const ingest = (measured: TokenUsage | Measurement) => {
        const measurement = toMeasurement(measured);
        void session.ingestMeasurement(context, measurement);
        // Reported what it could, and said what it could not. A measurement that does not cover
        // everything the vendor charged for is a metering failure even though the ingest itself
        // succeeded - so it goes out *and* is raised, rather than one or the other.
        if (measurement.incomplete) session.failedToMeasure(context, new Error(measurement.incomplete));
      };
      try {
        const measurement = method.extractUsage?.(result.data, result.response);
        if (measurement) ingest(measurement);
        else method.attachStream?.(result.data, ingest, result.response);
      } catch (err) {
        // The vendor already answered. A recipe that cannot read its response is a metering
        // failure, not the caller's - turning it into a rejection would fail a call that worked.
        session.failedToMeasure(context, err);
      }

      return result;
    })();

    // Marks the inner promise handled; the stand-in below still surfaces the rejection to callers.
    settled.catch(() => undefined);
    return gatedPromise(settled);
  };

  return true;
}

/**
 * How much to ask permission for, with the one answer a gate must never send.
 *
 * `estimate` is the application's own callback - a gateway recipe takes it as an option - and a
 * negative one is worse than a wrong one: `remaining >= requestedUsage` is true at any balance,
 * so an unaffordable call is granted by a budget that had nothing left. `NaN` and `Infinity` fail
 * the same comparison in the other direction. Zero and fractions are left alone: a credit
 * currency is spent in fractions, and asking for nothing is a legitimate "may I at all".
 */
function requestedUnits(estimate: (params: any) => number, params: any): number {
  const units = estimate(params);
  return Number.isFinite(units) && units >= 0 ? units : 1;
}

type Settled = { data: any; response?: any; spare?: any };

/**
 * Awaits the vendor's own promise, keeping the caller's response readable where it can.
 *
 * A body can be read once, and the recipes need it parsed to find usage in - so a gated call used
 * to hand `asResponse()` a response nobody could read afterwards. `asResponse()` gives the
 * response over before anything has touched it, which is early enough to take a copy: the SDK
 * parses the original exactly as it always did, and the untouched clone is what the caller gets.
 *
 * Not for a stream, whose body *is* the stream - copying it would tee an open connection into
 * memory. Nothing is lost there, because a stream is metered off its own events rather than off
 * the response.
 */
async function collect(pending: any, params: any): Promise<Settled> {
  if (typeof pending?.withResponse !== 'function') return { data: await pending };

  // Only a promise that hands over the unparsed response can be copied, and only a body that is
  // not itself a stream is worth copying.
  const spare = params?.stream ? undefined : await spareResponse(pending);

  // `withResponse()` after the copy, so the vendor still supplies its own request id alongside
  // the parse rather than this having to guess which header it came from.
  return { ...(await pending.withResponse()), spare };
}

async function spareResponse(pending: any): Promise<any> {
  if (typeof pending.asResponse !== 'function') return undefined;
  const response = await pending.asResponse();
  // The request parameter says what was asked for; the response says what was sent, and only the
  // second is worth trusting with an open connection. A stream is an event stream, and teeing one
  // would buffer a live body to serve a copy nobody asked for.
  if (String(response?.headers?.get?.('content-type') ?? '').includes('event-stream')) return undefined;
  return typeof response?.clone === 'function' && response.bodyUsed === false ? response.clone() : undefined;
}

/**
 * A real promise, because the gate has to return one before the vendor's exists.
 *
 * The check is asynchronous and the vendor is not called until it passes, so at the moment the
 * caller receives a value there is nothing yet to hand over. What stands in is a `Promise`
 * subclass carrying the helpers the vendor's own promise declares - a plain object with a `then`
 * is not a promise: `instanceof Promise` is false on it, and everything past `then`/`catch`
 * silently does not exist despite the type saying otherwise.
 */
class GatedPromise<T> extends Promise<T> {
  // `then` must hand back a plain promise. The default builds another of these through the
  // constructor, which has no settled result to hang the helpers off.
  static get [Symbol.species](): PromiseConstructor {
    return Promise;
  }
}

function gatedPromise(settled: Promise<Settled>): any {
  const promise: any = new GatedPromise<any>((resolve, reject) => {
    settled.then((result) => resolve(result.data), reject);
  });
  // A caller that only wants the response asks `withResponse()` and never touches this one -
  // Anthropic's stream helper does exactly that. Left alone, a refusal would reject a promise
  // nobody is holding, which Node reports as unhandled and, by default, exits on. Marking it
  // handled costs nothing: the rejection is still delivered to whoever does await it.
  promise.catch(() => undefined);
  // The copy is ours; the caller is handed it in place of the response the parse consumed.
  promise.asResponse = () => settled.then((result) => result.spare ?? result.response);
  promise.withResponse = () => settled.then(({ spare: _spare, ...rest }) => rest);
  promise._thenUnwrap = (transform: (data: any, result: Settled) => any) =>
    gatedPromise(settled.then((result) => ({ ...result, data: transform(result.data, result) })));
  return promise;
}
