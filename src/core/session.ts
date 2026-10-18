/**
 * The governance session: one per wrapped client, and the two operations every binding needs.
 *
 *   check(context, requestedUsage)      - before the call. Returns a decision, never throws.
 *   ingest(context, measurement)        - after it. Never throws, never fails the caller's call.
 *
 * Everything that used to belong to a run belongs here instead, with one difference that matters:
 * nothing is scoped to a single customer or budget. A context arrives with every operation, so one
 * session serves every tenant a client is called for.
 *
 * ## What is deliberately not here
 *
 * No cache. This package holds no decision cache of its own, and that is the whole design: the
 * Node server SDK underneath already caches entitlement state, and does it far better than a TTL
 * over decisions ever could - write-through from the server's own measurement responses, realtime
 * invalidation, usage-period resets applied at read time, fallbacks, and an optional Redis store
 * that two processes can share.
 *
 * An earlier design cached decisions here for `cacheTtlMs`. It duplicated that machinery and
 * degraded it: a cached allow outlived the report that spent the budget, and it could not hear an
 * invalidation. What is left is a straight call to the engine, which is the thing that knows.
 * {@link GovernanceSession.warmUp} primes the engine's cache rather than one of its own.
 */
import { policyDecision, toDecision, unenforcedDecision } from '../engine/decision';
import { EngineError } from '../errors';
import { GOVERNANCE_HEADERS, type GovernanceHeaders } from '../headers';
import { flattenRaw } from './dimensions';
import { safely } from './hooks';
import { addMetrics, isEnforced, type ResolvedContext } from './context';
import type { EngineReportResult, GovernanceEngine } from '../engine/engine';
import type { ErrorContext } from '../config';
import type { Logger } from '../logger';
import {
  entitlementKind,
  toMeasurement,
  usageValueError,
  wholeUnitsForGovernance,
  type AccessDecision,
  type IngestResult,
  type Measurement,
  type Metrics,
  type TokenUsage,
} from '../types';

/** Everything the session reports back while it works. Set once, at `wrap`. */
/**
 * Who the observation was for, which the observation itself cannot say.
 *
 * Neither an {@link AccessDecision} nor an {@link IngestResult} names the caller: `deniedBy`
 * appears only on a refusal and names the entity that blocked, not the agent that asked. So one
 * client serving several agents produced a stream of events nothing could attribute, and the only
 * way to tell them apart was a separate wrapped client per agent - each with its own session
 * state, which is a real cost rather than an inconvenience.
 *
 * `correlationId` is the one to reach for when reconciling: it ties a decision to the ingest that
 * followed it, which is what anyone chasing a billing discrepancy actually needs.
 */
export type HookContext = {
  /** The tenant this call was scoped to. */
  customerId: string;
  /** What it was attributed by - the agent under its entity type's own key, plus any extra. */
  dimensions: Record<string, string>;
  /** Shared by every observation of one call, and sent on the wire as `x-stigg-run-id`. */
  correlationId: string;
  /** What the call gated on, when it gated on anything. Undefined on a metering-only run. */
  entitlementId?: string;
};

/** What a context looks like to a hook: the attribution, and nothing a hook could change. */
const hookContext = (context: ResolvedContext): HookContext => ({
  customerId: context.customerId,
  dimensions: context.dimensions,
  correlationId: context.correlationId,
  entitlementId: context.checkedId,
});

export type SessionHooks = {
  /** Every check this client makes. The whole decision, already formatted as `.summary`. */
  onDecision?: (decision: AccessDecision, context: HookContext) => void;
  /** Every ingest this client makes - including the ones that failed. */
  onIngest?: (result: IngestResult, context: HookContext) => void;
};

/** A metric nobody can bill: refused where the mapper that invented it can still be found. */
const emptyMetricNameError = (): EngineError =>
  new EngineError('measure', 'a metric needs a name - an empty one reports to no feature at all.');

export type SessionDeps = {
  /**
   * Resolved at the point of use, not at construction.
   *
   * Building the engine is a network round trip - a probe that decides which transport serves
   * which operation - and `wrap` is a setup call that reads as instant. So it starts that work
   * and hands the session the promise: the first call that needs an engine awaits it, and every
   * call after that gets one already resolved. The latency moves to the first request rather
   * than disappearing.
   */
  engine: () => Promise<GovernanceEngine>;
  logger: Logger;
  onError: (error: EngineError, context: ErrorContext) => void;
  hooks: SessionHooks;
};

/** What a client did, for whoever wants to print it. Spans every context it served. */
export type SessionSummary = {
  checks: number;
  ingested: number;
  /**
   * Everything this client reported, summed per feature id - what it sent, not what it was billed.
   *
   * Under `'sync'` Stigg says whether a delivery was a replay, and a replay is left out: it
   * consumed nothing. Under `'async'` it cannot say, so a retry Stigg deduplicated still counts
   * here. Stigg remains the record of what was actually charged; this is the client's own tally.
   */
  reported: Metrics;
  ingestFailures: number;
  lastDecision?: AccessDecision;
};

export type IngestOptions = {
  /** Overrides the context's own name for this one report - the vendor method that was gated. */
  event?: { name: string };
  /** The vendor's usage object, for the event to carry. Ignored under `'sync'`. */
  raw?: Record<string, unknown>;
  /**
   * What deduplicates this report. Overrides the context's own, and is what a caller reaches for
   * when one logical turn is reported twice - a retry, or a resumed stream.
   */
  idempotencyKey?: string;
};

/**
 * What a report is called when nothing names it.
 *
 * A gated call is named after the vendor method it wrapped - `anthropic.messages.create` - which
 * is what a Stigg meter filters on. This is the floor underneath that, for the paths with no
 * wrapped method behind them: `stigg.report(...)`, and a gateway's own ingest. Without it an
 * `'async'` report would reach the event API with no name at all.
 */
const DEFAULT_EVENT_NAME = 'agent.usage';

export class GovernanceSession {
  private readonly deps: SessionDeps;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly reported: Metrics = {};
  private checks = 0;
  private ingested = 0;
  private ingestFailures = 0;
  private step = 0;
  private decision?: AccessDecision;
  /** The unmapped-feature warning is said once per client, not once per call. */
  private warnedUnmapped = false;
  /** Said once per client: the reason is the same every call, and so is the fix. */
  private warnedRounded = false;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  get lastDecision(): AccessDecision | undefined {
    return this.decision;
  }

  /** The attribution to send downstream when part of the work happens in another process. */
  headers(context: ResolvedContext): GovernanceHeaders {
    return {
      [GOVERNANCE_HEADERS.customer]: context.customerId,
      [GOVERNANCE_HEADERS.dimensions]: JSON.stringify(context.dimensions),
      [GOVERNANCE_HEADERS.run]: context.correlationId,
      // Which of those dimensions is the agent. Only this side knows: the receiver sees a flat
      // map and cannot tell attribution from metadata. Empty when the run names no agent, which
      // is a receiver that should round nothing.
      [GOVERNANCE_HEADERS.attributionKey]: context.attributionKey ?? '',
    };
  }

  /**
   * Primes the cache that actually serves these checks, so the calls that follow read local state.
   *
   * It primes the *engine's* cache, not one here - there isn't one. The engine loads the
   * customer's whole entitlement state, so every entitlement is warm rather than one decision,
   * and each check is still evaluated against the amount it actually asks for. An engine with no
   * cache (the governance REST client) implements nothing and this is a no-op, which is the
   * honest answer: there would be nothing for the round trip to fill.
   *
   * Failures are logged rather than thrown: the client works either way, and the first real check
   * applies the error policy.
   */
  async warmUp(context: ResolvedContext): Promise<void> {
    if (!isEnforced(context)) return;
    try {
      await (await this.deps.engine()).preload?.(context.customerId, context.dimensions);
    } catch (err) {
      this.deps.logger.warn(`[stigg] warm-up failed for ${context.customerId}: ${String(err)}`);
    }
  }

  /**
   * The enforcement path. Returns a decision, never throws - a refusal is a commercial event the
   * application routes on, not an exception it recovers from.
   */
  async check(context: ResolvedContext, requestedUsage = 1): Promise<AccessDecision> {
    this.checks += 1;
    const { entitlement } = context;
    // Asked and answered, with nobody to ask: this context named no entitlement, so there is no
    // budget to consult and no refusal that could come back. Still counted and recorded, because
    // the caller did ask and `lastDecision` is where they read what they got.
    if (!entitlement) return this.record(unenforcedDecision(), context);

    try {
      const engine = await this.deps.engine();
      const result = await engine.check(context.customerId, {
        entitlement,
        requestedUsage,
        dimensions: context.dimensions,
      });
      return this.record(
        toDecision(result, { customerId: context.customerId, entitlement: context.entitlement }),
        context,
      );
    } catch (err) {
      const error = asEngineError('check', err);
      this.reportError(error, 'check', context);
      // Governance is fail-closed server-side; `'deny'` mirrors that, and `'allow'` - the default -
      // is the soft limit that keeps the application up while Stigg is unreachable.
      return this.record(policyDecision(context.checkErrorAction === 'allow'), context);
    }
  }

  /** Applies the context's mapper to a token measurement. The path every binding uses. */
  ingestTokens(context: ResolvedContext, usage: TokenUsage, options: IngestOptions = {}): Promise<IngestResult> {
    return this.ingestMeasurement(context, { usage }, options);
  }

  /**
   * Ingests whatever a binding measured, through the context's mapper.
   *
   * The mapper runs inside the boundary that never throws, because it is the application's own
   * function over a vendor's object and either half is free to change shape - a throw there would
   * put an exception where the contract promises a result.
   */
  ingestMeasurement(
    context: ResolvedContext,
    measurement: Measurement | TokenUsage,
    options: IngestOptions = {},
  ): Promise<IngestResult> {
    const measured = toMeasurement(measurement);
    // Merged, not replaced: a measurement names what only it can know - the model that served -
    // and the caller's own attribution is not an alternative to that. The measurement wins a key
    // they both set, because it saw the call.
    const dimensions = measured.dimensions ? { ...context.dimensions, ...measured.dimensions } : context.dimensions;
    const idempotencyKey =
      measured.idempotencyKey ?? options.idempotencyKey ?? context.idempotencyKey ?? this.nextKey(context);
    try {
      return this.send(context, context.usageMapper(measured), {
        dimensions,
        idempotencyKey,
        raw: measured.raw ?? options.raw,
        event: options.event ?? context.eventName,
      });
    } catch (err) {
      return Promise.resolve(this.failedIngest(context, idempotencyKey, asEngineError('measure', err)));
    }
  }

  /**
   * Reports one value against the entitlement this context checks.
   *
   * The narrow case, and the only one where the SDK knows what a report costs the budget it gates
   * on - which is why it is also the only one that can name the feature for you.
   */
  ingest(context: ResolvedContext, value: number, options: IngestOptions = {}): Promise<IngestResult> {
    if (!context.checkedId) {
      // There is no feature id to put this under: the whole point of this overload is that the
      // value names what the context checks, and this one checks nothing. Failing the way a broken
      // metric fails - counted, reported, handed back as a result - is what keeps the one promise
      // ingest makes, that metering never breaks the caller's call.
      const key = options.idempotencyKey ?? context.idempotencyKey ?? this.nextKey(context);
      return Promise.resolve(
        this.failedIngest(
          context,
          key,
          new EngineError(
            'ingest',
            'ingest(value) reports against the entitlement the call checks, and this context named ' +
              'none - so there is no feature id to report it under. Report by name with ' +
              'ingestMetrics({ [featureId]: value }), or name an entitlement.',
          ),
        ),
      );
    }
    return this.ingestMetrics(context, { [context.checkedId]: value }, options);
  }

  /**
   * Reports named metrics directly, skipping the mapper. The path a gateway and a hand-rolled
   * binding use, where the numbers are already in Stigg's own vocabulary.
   */
  ingestMetrics(context: ResolvedContext, metrics: Metrics, options: IngestOptions = {}): Promise<IngestResult> {
    return this.send(context, metrics, {
      dimensions: context.dimensions,
      idempotencyKey: options.idempotencyKey ?? context.idempotencyKey ?? this.nextKey(context),
      raw: options.raw,
      event: options.event ?? context.eventName,
    });
  }

  /**
   * The instrumentation path: one report per metric, all in one call where the transport has one.
   *
   * Never throws and never applies the error policy - the spend already happened, so failing here
   * must not fail the caller's call. Errors go to `onError`.
   */
  private send(
    context: ResolvedContext,
    metrics: Metrics,
    sendOptions: {
      dimensions: Record<string, string>;
      idempotencyKey: string;
      raw?: Record<string, unknown>;
      event?: { name: string };
    },
  ): Promise<IngestResult> {
    const { dimensions, idempotencyKey, raw, event } = sendOptions;
    const mode = context.ingestMode;

    // A broken value is one broken metric, not a broken call: the others measured fine and the
    // spend they describe already happened. Dropping only the bad one reports what is knowable.
    //
    // What counts as broken follows the mode, because the two DTOs take different numbers. A zero
    // survives into an event and is dropped from a usage report: a meter may filter on a field
    // being present, and an event that omits it on a cache miss changes shape call to call, while
    // a usage report of zero is a request that moves nothing.
    // Which metric draws the wallet, which is what decides whether a fraction is legal: the one
    // named after the currency this context checks goes to `consumeCredits`, and everything else
    // to the usage report or an event. The same split `reportMetrics` makes further down.
    const creditCurrencyId =
      context.entitlement && entitlementKind(context.entitlement) === 'credit' ? context.checkedId : undefined;

    // Whether this run is attributed to a governance entity, which is what decides whether a
    // fraction can be counted. See `wholeUnitsForGovernance`.
    const attributed = !!context.attributionKey && !!context.dimensions[context.attributionKey];

    const sendable: Metrics = {};
    let rejected: EngineError | undefined;
    for (const [featureId, rawValue] of Object.entries(metrics)) {
      const drawsWallet = featureId === creditCurrencyId;
      // The mapper's own number is what gets validated, before any rounding of ours. Rounding
      // first laundered a negative into a success: `Math.ceil(-0.5)` is `-0`, which is not `< 0`,
      // so it passed the guard that exists to catch it, was then dropped for not being `> 0`, and
      // reported as the no-op ingest that an empty turn is. A mapper returning a negative would
      // have been told it succeeded.
      //
      // The key is the feature id this spend lands on, and the mapper that produced it is the
      // application's own function. An empty one is validated by nothing downstream - the value is
      // checked, the key is not - so it would report to a feature that cannot exist, answer `ok`,
      // and move no budget: the failure that looks like success, from a typo.
      const invalid = featureId.trim() ? usageValueError(rawValue, mode, drawsWallet) : emptyMetricNameError();
      if (invalid) {
        rejected ??= invalid;
        continue;
      }
      const value = attributed && drawsWallet ? wholeUnitsForGovernance(rawValue) : rawValue;
      if (value !== rawValue) this.warnRounded(featureId, rawValue, value);
      if (value > 0 || mode === 'async') sendable[featureId] = value;
    }

    // Zero-token calls are normal (a cached refusal, an empty stream); they are not an error. They
    // are still an ingest that happened, though - counted, so a client that meters nothing is
    // distinguishable from one that never tried, and reported to `onIngest` like every result.
    if (!Object.keys(sendable).length) {
      if (rejected) return Promise.resolve(this.failedIngest(context, idempotencyKey, rejected));
      this.ingested += 1;
      const noop: IngestResult = { ok: true, reported: {}, idempotencyKey, mode, replayed: false };
      this.hook('onIngest', context, () => this.deps.hooks.onIngest?.(noop, hookContext(context)));
      return Promise.resolve(noop);
    }

    const promise = this.deps
      .engine()
      .then((engine) =>
        engine.report(context.customerId, {
          metrics: sendable,
          entitlement: context.entitlement,
          mode,
          // Flattened here rather than in the engine, so both transports send the same event and a
          // sync report pays nothing for a field it will not use.
          raw: mode === 'async' ? flattenRaw(raw) : undefined,
          dimensions,
          idempotencyKey,
          event: event ?? { name: DEFAULT_EVENT_NAME },
        }),
      )
      .then((result): IngestResult => {
        this.ingested += 1;
        // A replay is a delivery that consumed nothing - the server had already counted these
        // keys - so it is one more ingest but not one more unit of spend.
        if (!result.replayed) addMetrics(this.reported, result.reported);
        this.warnIfNothingDrains(context, result, sendable);

        const landed: IngestResult = {
          // A metric the caller's own mapper got wrong does not stop the rest from being
          // delivered - the spend is real and dropping it would understate a bill. But the turn
          // did not report everything it measured, and saying `ok` would hide that: the metrics
          // that were refused are missing from `reported`, and nothing else would ever mention
          // them. So what landed is reported as landed, and the refusal travels with it.
          ok: !rejected,
          reported: result.reported,
          idempotencyKey,
          mode: result.mode,
          replayed: result.replayed,
          creditsConsumed: result.creditsConsumed,
          ...(rejected ? { error: rejected } : {}),
        };
        // Counted and routed to the error sink exactly as a wholly failed ingest is - a mapper
        // that produced an unusable value is the application's own bug either way. `failedIngest`
        // does this for the turn that delivered nothing; this is the turn that delivered some.
        if (rejected) {
          this.ingestFailures += 1;
          this.reportError(rejected, rejected.operation, context, idempotencyKey);
        }
        this.hook('onIngest', context, () => this.deps.hooks.onIngest?.(landed, hookContext(context)));
        return landed;
      })
      .catch((err): IngestResult => this.failedIngest(context, idempotencyKey, asEngineError('ingest', err)))
      .finally(() => {
        this.pending.delete(promise);
      });

    this.pending.add(promise);
    return promise;
  }

  /**
   * A binding's own failure at measuring a call that already happened.
   *
   * A recipe reads usage off a vendor's response, and a vendor is free to change that response -
   * so reading it can throw. The call succeeded and the money is spent either way, which makes
   * this the same kind of event as a failed ingest: counted, reported, and never raised at the
   * caller, who asked the vendor for something and got it.
   */
  failedToMeasure(context: ResolvedContext, err: unknown): void {
    this.ingestFailures += 1;
    this.reportError(asEngineError('measure', err), 'measure', context);
  }

  /** Waits for in-flight ingests, so a caller knows what was actually delivered. */
  async drain(): Promise<SessionSummary> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    return this.summary();
  }

  summary(): SessionSummary {
    return {
      checks: this.checks,
      ingested: this.ingested,
      reported: { ...this.reported },
      ingestFailures: this.ingestFailures,
      lastDecision: this.decision,
    };
  }

  /** `correlationId:n` - distinct per call, for a vendor that offered no id of its own. */
  private nextKey(context: ResolvedContext): string {
    return `${context.correlationId}:${++this.step}`;
  }

  /**
   * The failure that looks like success, said once.
   *
   * A call gates on one capability and reports to another. Stigg only moves the one to the other
   * when the feature is credit-backed in the catalog - and when it is not, every call still
   * succeeds, every ingest returns `ok`, and the budget never moves. Nothing else in the system
   * can notice: the check keeps passing because nothing was ever spent.
   *
   * The two modes fail the same way and can be told about it to different degrees. A usage report
   * answers with a credit balance, so its silence is proof. An event answers with nothing at all,
   * so the most that can be said is that nothing reported names what this call checks, and whether
   * a meter closes that gap is configuration this process cannot see.
   */
  /**
   * Says that an attributed run rounded, because an overcharge the caller did not ask for must
   * not be silent - that silence is the thing this SDK was told off for in the first place.
   */
  private warnRounded(featureId: string, from: number, to: number): void {
    if (this.warnedRounded) return;
    this.warnedRounded = true;
    this.deps.logger.warn(
      `[stigg] rounded ${featureId} up from ${from} to ${to}: this run is attributed to a governance ` +
        'entity, and per-entity usage is counted in whole units. An unattributed run reports the ' +
        'fraction as measured. Denominate the currency finely enough that one unit is small, or ' +
        'drop the agent attribution to meter exactly.',
    );
  }

  private warnIfNothingDrains(context: ResolvedContext, result: EngineReportResult, sent: Metrics): void {
    if (this.warnedUnmapped) return;
    // The warning exists to say that the budget this call checks will never drain. A call that
    // named no entitlement checks no budget, so there is nothing here that can fail to drain -
    // saying it anyway would invent a gate the caller deliberately did not ask for.
    const checked = context.checkedId;
    if (!checked) return;
    const names = Object.keys(sent).join(', ');

    if (result.mode === 'async') {
      if (Object.keys(sent).includes(checked)) return;
      this.warnedUnmapped = true;
      this.deps.logger.warn(
        `[stigg] reported ${names} as events under ${context.eventName?.name ?? 'the call event'} - none of ` +
          `them names ${checked}, which is what this call checks. Whether the budget moves is now up to the ` +
          'meters configured for that event, and the event API answers with nothing that can confirm it.',
      );
      return;
    }

    if (result.creditsConsumed !== undefined) return;
    this.warnedUnmapped = true;
    this.deps.logger.warn(
      `[stigg] reported ${names} but the response carried no credit balance - ${
        names.includes(',') ? 'these features are' : 'this feature is'
      } not mapped to ${checked}, so the budget this call checks ` +
        'against will never drain. Map it in Stigg, or report to the currency directly.',
    );
  }

  private record(decision: AccessDecision, context: ResolvedContext): AccessDecision {
    this.decision = decision;
    this.hook('onDecision', context, () => this.deps.hooks.onDecision?.(decision, hookContext(context)));
    return decision;
  }

  /**
   * Hooks are instrumentation, so a throwing one must not reach the caller: it cannot turn an
   * allow into a denial, flip a delivered ingest to `ok: false`, or reject a promise the contract
   * says never rejects. The failure is reported like any other.
   */
  private hook(name: 'onDecision' | 'onIngest', context: ResolvedContext | undefined, invoke: () => unknown): void {
    safely(invoke, (err) => this.reportError(asEngineError(name, err), name, context));
  }

  /**
   * The last stop for a failure. `onError` is the application's own code and can throw too, and
   * there is nowhere left to report that to, so it falls back to the logger.
   */
  private reportError(error: EngineError, operation: string, context?: ResolvedContext, idempotencyKey?: string): void {
    safely(
      () =>
        this.deps.onError(error, {
          operation,
          runId: context?.correlationId,
          idempotencyKey,
          customerId: context?.customerId,
        }),
      (err) => this.deps.logger.warn(`[stigg] onError threw while reporting ${error.message}: ${String(err)}`),
    );
  }

  private failedIngest(context: ResolvedContext, idempotencyKey: string, error: EngineError): IngestResult {
    this.ingestFailures += 1;
    // The error knows what failed - reading a vendor's usage is not the same event as the report
    // that would have followed it, and a context that says otherwise makes the two
    // indistinguishable.
    this.reportError(error, error.operation, context, idempotencyKey);
    // `reported` is what landed, which is not always nothing: an ingest is up to two calls, and a
    // rejection on the second leaves the first one's spend at Stigg. It is what was attempted
    // minus whatever the failure took with it, so it comes off the error rather than off the
    // metrics this call set out to send.
    const landed = error.reported ?? {};
    // Guarded exactly as a successful ingest is: what landed before the failure can itself have
    // been a replay, and the server consumed nothing for it. Counting it here would make a
    // half-failed retry the one way to inflate the summary past what was actually spent.
    if (!error.replayed) addMetrics(this.reported, landed);
    const failure: IngestResult = {
      ok: false,
      reported: landed,
      idempotencyKey,
      mode: context.ingestMode,
      // What the error carried, not an assumption: `undefined` stays undefined, because the event
      // API cannot tell a first delivery from a replay and saying `false` would claim it can.
      replayed: error.replayed ?? false,
      error,
    };
    this.hook('onIngest', context, () => this.deps.hooks.onIngest?.(failure, hookContext(context)));
    return failure;
  }
}

/** Whatever went wrong, as the seam's own error. */
function asEngineError(operation: string, err: unknown): EngineError {
  if (err instanceof EngineError) return err;
  return new EngineError(operation, err instanceof Error ? err.message : String(err), { cause: err });
}
