/**
 * The governance context: who a call is for, what gates it, and what it reports.
 *
 * One shape, given in two places. `wrap(client, { stiggContext })` sets the defaults for every
 * call through that client; `client.messages.create({ ..., stiggContext })` overrides them for one
 * call. That is the whole of the configuration surface - there is no run to open and nothing to
 * keep in sync between a setup step and a call site.
 *
 * ## Why resolution is split in two
 *
 * A gated call sits directly in front of a network request the application is paying for, so the
 * SDK's own work has to disappear next to it. The split below is what makes that true:
 *
 *   `resolveContext`  - runs once, at `wrap`. Validates, folds the agent into the dimensions,
 *                       and precomputes everything a call would otherwise derive: the cache key,
 *                       the entitlement id, the mapper.
 *   `overrideContext` - runs only when a call actually carries a `stiggContext`, and only touches
 *                       the keys that call named.
 *
 * So a call that overrides nothing does no merging, no validation and no allocation: it reads the
 * object `wrap` already built. A client wrapped without a customer is the exception - its calls
 * each name their own, so each one carries an override and pays for the merge.
 */
import { entitlementError, entitlementId, vendorMetrics } from '../types';
import type { CheckErrorAction, Entitlement, IngestMode, Metrics, MetricsMapper } from '../types';
import type { EventIngest } from '../engine/engine';

/**
 * What a call is governed by. Every field is optional here because each one may have been given
 * at `wrap` instead - `customerId` is the only one that has to come from somewhere, and the
 * wrapped client's types say which calls still owe it.
 */
export type StiggContext = {
  // -- base: who this call is for. Both the check and the report need all of it. ----------------
  /** The tenant. Every governance call is scoped to one customer. */
  customerId?: string;
  /**
   * The agent this call spends as. Travels as a dimension under
   * {@link StiggContext.attributionKey}, which is the entire mechanism by which an agent is
   * attributed - so naming one without a key is refused rather than guessed at.
   *
   * Omitted, the call resolves no entity and is checked against the customer's own budget.
   */
  agentId?: string;
  /**
   * The key the agent's entity type declares, under which `agentId` is sent on every call.
   * Required whenever `agentId` is given, and not defaulted: a guessed key resolves no entity, so
   * the spend lands on the customer looking exactly like a call that was never governed.
   *
   * `register` takes an `entityTypeId` as well, because that call creates the entity. Attributing
   * a call does not need to know what type it was created as - only what key to send it under.
   */
  attributionKey?: string;
  /**
   * Extra attribution, sent verbatim on the check and the report. Every key must be an attribution
   * key on one of the entity types involved, or it matches nothing and the usage rolls up to the
   * customer instead.
   *
   * Overriding this **merges** per key over the wrap's own, so a per-call `{ tenantId }` does not
   * silently drop a client-wide `{ region }`.
   */
  dimensions?: Record<string, string>;

  // -- check: what gates the call --------------------------------------------------------------
  /**
   * What this call **gates on** - a credit currency or a metered feature, never both. **Omit it
   * and the call gates nothing**: no check leaves the process, nothing can be refused, and
   * metering is unchanged. The presence of this field is the enforcement switch, because a call
   * with nothing to check against cannot be enforced, and a separate flag would only be a second
   * place for the two to disagree.
   */
  entitlement?: Entitlement;
  /**
   * What a check resolves to when the engine could not answer it. Defaults to `'allow'` - a soft
   * limit, so an outage does not take the application down with it.
   *
   * Worth knowing what that trades: reporting fails in the same outage and is swallowed, so the
   * spend allowed through is neither capped nor recorded afterwards. `'deny'` mirrors governance,
   * which is fail-closed server-side.
   */
  checkErrorAction?: CheckErrorAction;

  // -- metering: what the call reports afterwards ----------------------------------------------
  /**
   * What to report for each completed call. Defaults to the vendor's own metric names and values
   * exactly as they came back, so what lands in Stigg reconciles against that vendor's invoice.
   *
   * The name on the left is a Stigg feature or credit id, and metering the one the call checks -
   * {@link StiggContext.entitlement} - is what makes the budget move.
   */
  usageMapper?: MetricsMapper;
  /** Which of Stigg's ingest APIs this call reports through. Defaults to `'async'`. */
  ingestMode?: IngestMode;
  /**
   * The event name to report under in `'async'` mode. Defaults to the vendor call that produced
   * the usage - `anthropic.messages.create` - which is what a Stigg meter filters on.
   */
  eventName?: EventIngest;
  /**
   * The key that deduplicates this report. Defaults to the vendor's own request id when it has
   * one - stable across the vendor's retries, which a local counter cannot be - and to a
   * generated key otherwise.
   */
  idempotencyKey?: string;
  /**
   * Correlates work that continues in another process, as `x-stigg-run-id`. Defaults to the id
   * the wrap generated, so a gateway sees one value per client unless a call says otherwise.
   */
  correlationId?: string;
};

/**
 * A context with everything decided and everything derivable already derived.
 *
 * Nothing here is optional that the call path would otherwise have to default, and nothing is
 * computed that a call could be asked to compute twice.
 */
export type ResolvedContext = {
  /**
   * Empty only for a client wrapped without one, whose calls each name their own. Every path that
   * reaches the engine resolves it first, so nothing downstream has to re-check it.
   */
  customerId: string;
  entitlement?: Entitlement;
  /** The agent folded in, so the check and the report send one object and neither re-derives it. */
  dimensions: Record<string, string>;
  checkErrorAction: CheckErrorAction;
  ingestMode: IngestMode;
  eventName?: EventIngest;
  usageMapper: MetricsMapper;
  idempotencyKey?: string;
  correlationId: string;
  /** The entitlement's own id, resolved once - undefined when this context gates on nothing. */
  checkedId?: string;
  /**
   * Kept so a per-call `agentId` can inherit it.
   *
   * The key belongs to the entity type, which is a property of the client, while the agent varies
   * per call - so naming it once at `wrap` and then only the agent per call is the shape a
   * multi-agent server wants. The folded dimension alone would not do: an override needs the key
   * itself to build its own.
   */
  attributionKey?: string;
};

/**
 * What nobody told the SDK, and it will not guess.
 *
 * Exported because the constructor's own schema defaults to these: two copies of "what happens
 * when nothing says" is how a configured `deny` came to be parsed, stored and then ignored in
 * favour of an `allow` written somewhere else.
 *
 * `allow` is the soft limit - an unreachable Stigg does not take the application down with it.
 */
export const CONTEXT_DEFAULTS = { checkErrorAction: 'allow', ingestMode: 'async' } as const;

/**
 * The agent, as the dimension it travels as.
 *
 * Refused rather than defaulted when the type is missing: a guessed attribution key resolves no
 * entity, so the spend lands on the customer and the output is indistinguishable from a call that
 * was never governed. There is no error to read later, which is why there is one here.
 */
function agentDimension(context: StiggContext): Record<string, string> | undefined {
  if (context.agentId === undefined) return undefined;
  if (!context.agentId.trim()) {
    throw new Error('stiggContext.agentId is empty - an agent nobody can name is also one nothing can bill.');
  }
  if (!context.attributionKey?.trim()) {
    throw new Error(
      `stiggContext.agentId is '${context.agentId}' but no attributionKey says which key to send ` +
        "it under. Pass the key the agent's entity type declares. Without it the agent resolves " +
        'no entity and the spend lands on the customer, which looks exactly like a call that was ' +
        'never governed.',
    );
  }
  return { [context.attributionKey]: context.agentId };
}

/**
 * Validates and derives, once. Everything expensive about a context happens here rather than on
 * the call path - see the note at the top of this file for why that split exists.
 */
/** The one field a call cannot proceed without, said the same way wherever it is missing. */
export const noCustomer = (): Error =>
  new Error(
    'No customerId - every governance call is scoped to a tenant. Give `wrap(client, ' +
      '{ stiggContext: { customerId } })` a default for every call through this client, or name ' +
      'one per call in `stiggContext`.',
  );

/**
 * The client-wide policy a context falls back to before the SDK's own defaults.
 *
 * The chain is per-call, then `wrap`, then the constructor, then {@link CONTEXT_DEFAULTS}. The
 * constructor link is this parameter: without it a configured policy is inert, because every
 * context would land on the defaults instead.
 */
export type ContextDefaults = { checkErrorAction?: CheckErrorAction; ingestMode?: IngestMode };

export function resolveContext(
  context: StiggContext,
  correlationId: string,
  // `wrap` passes false: a client whose calls each name their own customer is legal, and its
  // types already say which calls still owe one. Every path that reaches the engine resolves it.
  { requireCustomer = true, defaults }: { requireCustomer?: boolean; defaults?: ContextDefaults } = {},
): ResolvedContext {
  // Checked here as well as in `overrideContext`, and this is the half that matters more: `wrap`
  // names an agent and its entitlement once for every call through the client, so a typo here
  // governs *everything* by the fallback rather than one call.
  assertKnownContext(context, requireCustomer ? 'stiggContext' : "wrap's stiggContext");
  // A key that deduplicates *one report* cannot be a property of a client. Set at `wrap`, every
  // call through that client reports under the same key, Stigg dedupes them, and every call after
  // the first moves no budget at all - silently, because nothing errors and the usage simply
  // never lands. Refused here rather than ignored, because a caller who passed one meant
  // something by it.
  if (!requireCustomer && context.idempotencyKey !== undefined) {
    throw new Error(
      "wrap's stiggContext cannot set `idempotencyKey` - it deduplicates a single report, so one " +
        'key shared by every call through the client would bill the first and discard the rest. ' +
        'Pass it per call instead, or leave it out and let the vendor request id stand in.',
    );
  }
  const customerId = context.customerId?.trim() ?? '';
  if (!customerId && requireCustomer) throw noCustomer();
  // Naming none is legal and means ungated. Naming an empty one is a typo that would meter into
  // the dark, so it is refused here rather than three calls later.
  const invalid = entitlementError(context.entitlement);
  if (invalid) throw invalid;

  const agent = agentDimension(context);
  const dimensions = agent ? { ...context.dimensions, ...agent } : (context.dimensions ?? {});

  return {
    customerId,
    // Normalized, not passed through: `isEnforced` asks `!== undefined` while every other reader
    // asks for truthiness, so a JS caller's `entitlement: null` would be enforced by one and
    // absent to the rest - a call that runs the gate and then reports itself ungated.
    entitlement: context.entitlement ?? undefined,
    dimensions,
    checkErrorAction: context.checkErrorAction ?? defaults?.checkErrorAction ?? CONTEXT_DEFAULTS.checkErrorAction,
    ingestMode: context.ingestMode ?? defaults?.ingestMode ?? CONTEXT_DEFAULTS.ingestMode,
    eventName: context.eventName,
    usageMapper: context.usageMapper ?? vendorMetrics,
    idempotencyKey: context.idempotencyKey,
    correlationId: context.correlationId?.trim() || correlationId,
    checkedId: context.entitlement ? entitlementId(context.entitlement) : undefined,
    attributionKey: context.attributionKey,
  };
}

/**
 * Every field a `stiggContext` may carry.
 *
 * Typed as a total record of `keyof StiggContext` rather than written as a list, so a field added
 * to the context without being added here is a compile error instead of a key this rejects.
 */
const CONTEXT_KEYS: Record<keyof StiggContext, true> = {
  customerId: true,
  agentId: true,
  attributionKey: true,
  dimensions: true,
  entitlement: true,
  checkErrorAction: true,
  usageMapper: true,
  ingestMode: true,
  eventName: true,
  idempotencyKey: true,
  correlationId: true,
};

/**
 * Refuses a context carrying a field this SDK does not read.
 *
 * Almost always a typo, and a silent one without this: the context is read key by key, so an
 * unknown key simply never arrives. A call meaning to spend as one agent spends as whatever
 * `wrap` was given instead, and the only trace is a bill against the wrong entity.
 *
 * The types catch it everywhere but `messages.stream`, which Anthropic declares generic -
 * `stream<Params extends MessageStreamParams>(body: Params, ...)` - and a generic parameter
 * infers from its argument rather than checking it for excess properties. `WrappedClient`
 * intersects the overlay with the vendor's own type to stay assignable to it, and an intersection
 * of call signatures is an overload set resolved in order, so a context the overlay rejects falls
 * through to that signature and is taken. Hence the runtime guarantee, which covers every surface
 * as well as JS callers and hand-typed call sites.
 *
 * Thrown rather than warned, like the other guards in this file: the call it would have governed
 * is in front of money, and a warning is read after the bill.
 *
 * `Object.hasOwn` rather than `in`, which walks the prototype chain and so answers true for
 * `toString`, `constructor` and `hasOwnProperty` - the names likeliest to arrive from a JS caller
 * building a context out of an object it did not create.
 */
function assertKnownContext(context: StiggContext, where: 'stiggContext' | "wrap's stiggContext"): void {
  for (const key of Object.keys(context)) {
    if (Object.hasOwn(CONTEXT_KEYS, key)) continue;
    throw new Error(
      `${where} has no field \`${key}\` - this SDK would ignore it, and the call would be ` +
        `governed by whatever remained instead. Valid fields: ${Object.keys(CONTEXT_KEYS).join(', ')}.`,
    );
  }
}

/**
 * One call's override, applied over what `wrap` already resolved.
 *
 * Only reached when a call actually carried a `stiggContext`; a call that did not reuses the
 * resolved object as-is. The ordering below is the one the caller asked for: the base identity
 * first, because a changed customer or agent changes which budget is consulted, and the metering
 * fields last, because nothing before the response depends on them.
 */
export function overrideContext(base: ResolvedContext, override: StiggContext): ResolvedContext {
  assertKnownContext(override, 'stiggContext');
  // The cheap test first: these are the only fields that can change which budget is consulted,
  // so a call overriding only, say, `idempotencyKey` re-derives nothing.
  const rebased =
    override.customerId !== undefined ||
    override.agentId !== undefined ||
    override.dimensions !== undefined ||
    override.entitlement !== undefined;

  let customerId = base.customerId;
  let dimensions = base.dimensions;
  let entitlement = base.entitlement;
  let checkedId = base.checkedId;

  if (rebased) {
    // Absent inherits; present-but-blank throws. `||` used to collapse the two, so a call that
    // named a customer and got the name wrong - an empty string out of a config, a trimmed-away
    // id - was billed to the client's default tenant instead. That is someone else's invoice,
    // and nothing said so. The same mistake on `agentId` has always thrown.
    if (override.customerId !== undefined) {
      // `trim()` on its own turns `null` into "Cannot read properties of null" and a number into
      // "trim is not a function" - the two shapes a JavaScript caller actually passes by accident.
      // Anything that is not a non-empty string gets the message that says what went wrong.
      const named = typeof override.customerId === 'string' ? override.customerId.trim() : '';
      if (!named) {
        throw new Error(
          'stiggContext.customerId is empty - a call that names a customer must name one. Leave ' +
            "the field out to bill the client's own customer; passing an empty value would bill " +
            'that customer for work the call said belonged to someone else.',
        );
      }
      customerId = named;
    }
    if (override.entitlement !== undefined) {
      const invalid = entitlementError(override.entitlement);
      if (invalid) throw invalid;
      entitlement = override.entitlement;
      checkedId = entitlementId(override.entitlement);
    }
    // The key falls back to the client's own, so a call naming a different agent of the same type
    // need only name the agent - which is the multi-agent case, and the common one.
    const attributionKey = override.attributionKey ?? base.attributionKey;
    const agent = agentDimension({ ...override, attributionKey });
    // Merged per key, not replaced: a per-call tenant must not drop the client's own attribution.
    //
    // With one exception. An override naming a *different* entity type writes its agent under a
    // different key, and the client's own key would otherwise ride along beside it - two agent
    // dimensions on one call, which governance resolves as two entities and bills accordingly.
    // That one is dropped by name: it describes an agent this call is not acting as. Every other
    // dimension the client set is kept, because none of them is claiming to be the agent.
    const inherited =
      agent && base.attributionKey && attributionKey !== base.attributionKey
        ? Object.fromEntries(Object.entries(base.dimensions).filter(([key]) => key !== base.attributionKey))
        : base.dimensions;
    dimensions = override.dimensions || agent ? { ...inherited, ...override.dimensions, ...agent } : base.dimensions;
  }

  return {
    customerId,
    entitlement,
    dimensions,
    checkedId,
    checkErrorAction: override.checkErrorAction ?? base.checkErrorAction,
    ingestMode: override.ingestMode ?? base.ingestMode,
    eventName: override.eventName ?? base.eventName,
    usageMapper: override.usageMapper ?? base.usageMapper,
    idempotencyKey: override.idempotencyKey ?? base.idempotencyKey,
    correlationId: override.correlationId?.trim() || base.correlationId,
    attributionKey: override.attributionKey ?? base.attributionKey,
  };
}

/** Whether a context gates at all. The enforcement switch, read on every call. */
export const isEnforced = (context: ResolvedContext): boolean => context.entitlement !== undefined;

/** Reported metrics, accumulated across a client's calls. */
export const addMetrics = (into: Metrics, add: Metrics): void => {
  for (const [name, value] of Object.entries(add)) into[name] = (into[name] ?? 0) + value;
};
