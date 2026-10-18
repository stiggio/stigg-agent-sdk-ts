/**
 * The shape of an ingest, which both transports share even though none of their calls do.
 *
 * Stigg has two ingest APIs and they are not interchangeable. The usage report takes a fixed DTO -
 * a `featureId` and a whole-number `value` per metric - and aggregates on arrival, so the next
 * check sees the spend. The event report takes the call as one event and lets Stigg's own meters
 * turn it into usage seconds later, for a fraction of the latency and a far higher rate limit.
 * Which one a run wants is a product decision - immediacy against throughput - so the caller
 * chooses it and this file only carries the choice out.
 *
 * What that costs each metric:
 *
 * - **`'sync'`** sends one usage report per metric, batched into the one bulk call both clients
 *   have, because a chat turn otherwise costs four round trips.
 * - **`'async'`** sends **one event for the whole turn**, every metric on its own dimension. One
 *   event can feed any number of meters - each picks its number with `aggregation.field` - so
 *   fanning out per metric would buy nothing and cost a request each.
 *
 * A metric named after the run's own credit currency is neither: it draws the wallet directly,
 * because a usage report takes only a `featureId` and there is no event path from a raw event to
 * a currency. It follows the mode only in how it waits - `consumeCredits` under `'sync'`, which
 * answers with a balance, and `consumeCreditsAsync` under `'async'`, which does not.
 *
 * That orchestration lives here, and with it the parts of an ingest that are the same whichever
 * client makes it: the consumption payload, the per-metric idempotency key, and how a bulk ack is
 * read. Each engine still passes its own calls, so a vendor method is only ever named by the file
 * that owns that client - but the split between wallet and features, and what a turn is taken to
 * have cost, cannot come to mean one thing over REST and another over the SDK.
 */
import { EngineError, asEngineError, isMeterMismatchError } from '../errors';
import { entitlementId, entitlementKind } from '../types';
import type { IngestMode, Metrics } from '../types';
import type { EngineOpSource, EngineReportParams, EngineReportResult } from './engine';

/** What one transport can do with an ingest, as the calls it already knows how to make. */
export type ReportCalls = {
  /** Draw the wallet and wait for the balance, for a metric that names the run's currency. */
  credits: (featureId: string, value: number) => Promise<EngineReportResult>;
  /** The same draw, reconciled on Stigg's side. No balance comes back. */
  creditsAsync: (featureId: string, value: number) => Promise<EngineReportResult>;
  /** One bulk usage report, one entry per metric. */
  usage: (metrics: Metrics) => Promise<EngineReportResult>;
  /** One event for the whole turn, carrying every metric as a dimension. */
  event: (metrics: Metrics, dimensions: Record<string, string | number | boolean>) => Promise<EngineReportResult>;
};

/**
 * Keeps every metric of a turn deduping on its own - and on the same key whichever path sends it,
 * since a metric that names the run's currency is a wallet draw here and a usage entry elsewhere.
 */
const metricKey = (params: EngineReportParams, featureId: string) => `${params.idempotencyKey}:${featureId}`;

/** A draw on the wallet. `consume` and `consumeAsync` take it unchanged, on both transports. */
export const creditConsumption = (
  customerId: string,
  params: EngineReportParams,
  currencyId: string,
  amount: number,
) => ({
  customerId,
  currencyId,
  amount,
  idempotencyKey: metricKey(params, currencyId),
  dimensions: params.dimensions,
});

/** One bulk usage report, one entry per metric. REST adds its own `updateBehavior` on top. */
export const usageEntries = (customerId: string, params: EngineReportParams, metrics: Metrics) =>
  Object.entries(metrics).map(([featureId, value]) => ({
    customerId,
    featureId,
    value,
    dimensions: params.dimensions,
    idempotencyKey: metricKey(params, featureId),
  }));

/**
 * What a wallet draw amounts to, read the same way whichever client made it.
 *
 * Only the call and where the balance sits on its response differ between the transports; this is
 * everything after that. `creditsConsumed` is the metric's own value because a draw is spent at
 * par - no feature mapping, no rate - and `replayed` is `false` under `'sync'` rather than
 * unknown: the response carries the wallet's running balance but not this call's own deduction,
 * so a replayed key is indistinguishable from a fresh one. Under `'async'` nothing comes back at
 * all, so it stays undefined.
 */
export function creditResult(
  currencyId: string,
  amount: number,
  currentUsage: number | null | undefined,
  mode: IngestMode,
  source: EngineOpSource,
): EngineReportResult {
  return {
    reported: { [currencyId]: amount },
    currentUsage: currentUsage ?? undefined,
    // What Stigg confirmed drawn, not what was sent - `reported` already says that. Under
    // `'async'` the draw is reconciled later and the response carries no balance, so there is
    // nothing confirmed to state and the field stays absent, exactly as its own type promises.
    creditsConsumed: mode === 'async' ? undefined : amount,
    replayed: mode === 'async' ? undefined : false,
    mode,
    source,
  };
}

/** As much of a bulk ack as either client returns: the balance, and what each entry cost. */
export type UsageAck = {
  currentUsage?: number | null;
  credit?: { currentUsage?: number | null; consumed?: number | null } | null;
};

/** What a bulk usage report amounts to, read the same way whichever client answered. */
export function usageResult(acks: readonly UsageAck[], metrics: Metrics, source: EngineOpSource): EngineReportResult {
  const credited = acks.filter((ack) => ack.credit);
  const last = acks[acks.length - 1];
  return {
    reported: metrics,
    currentUsage: last?.credit?.currentUsage ?? last?.currentUsage ?? undefined,
    // Absent when nothing reported was credit-backed - which is what the run needs to know.
    creditsConsumed: credited.length ? credited.reduce((sum, ack) => sum + (ack.credit?.consumed ?? 0), 0) : undefined,
    // Zero consumed against a credit-backed feature means these keys were already counted.
    replayed: credited.length ? credited.every((ack) => ack.credit?.consumed === 0) : false,
    mode: 'sync',
    source,
  };
}

const merge = (into: EngineReportResult, add: EngineReportResult): EngineReportResult => ({
  ...into,
  reported: { ...into.reported, ...add.reported },
  creditsConsumed:
    into.creditsConsumed === undefined && add.creditsConsumed === undefined
      ? undefined
      : (into.creditsConsumed ?? 0) + (add.creditsConsumed ?? 0),
  currentUsage: add.currentUsage ?? into.currentUsage,
  // Only a report where *every* metric was a replay is a replay: a partial one still spent. One
  // half that cannot say - an event - makes the whole turn unable to say, rather than say `false`.
  replayed: into.replayed === undefined || add.replayed === undefined ? undefined : into.replayed && add.replayed,
});

export async function reportMetrics(params: EngineReportParams, calls: ReportCalls): Promise<EngineReportResult> {
  // No entitlement means no wallet, so every metric is a feature - which is exactly what a run that
  // gates on nothing is reporting.
  const walletId =
    params.entitlement && entitlementKind(params.entitlement) === 'credit'
      ? entitlementId(params.entitlement)
      : undefined;

  const wallet: Metrics = {};
  const features: Metrics = {};
  for (const [featureId, value] of Object.entries(params.metrics)) {
    // A zero reaches here only under `'async'`, where it is kept so an event's dimensions hold
    // the same shape on a turn that measured nothing. A wallet draw has no dimensions to hold -
    // it is a consumption, not an event - so a zero would buy the shape nothing and spend a real
    // call and this turn's idempotency key to do it, leaving a 0 in the customer's ledger.
    if (featureId === walletId) {
      if (value !== 0) wallet[featureId] = value;
    } else features[featureId] = value;
  }

  let result: EngineReportResult = { reported: {}, replayed: true, mode: params.mode, source: 'rest' };
  let reported = false;

  if (Object.keys(features).length) {
    result = merge(
      result,
      params.mode === 'async'
        ? await calls.event(features, eventDimensions(params, features))
        : await calls.usage(features).catch((err) => {
            throw isMeterMismatchError(err) ? meterMismatchError(features) : asEngineError('ingest', err);
          }),
    );
    reported = true;
  }
  for (const [featureId, value] of Object.entries(wallet)) {
    // The features above may already be at Stigg. If the wallet draw rejects now, that spend is
    // real and the error has to carry it, or the turn reads as though nothing was metered.
    result = merge(
      result,
      await (params.mode === 'async' ? calls.creditsAsync : calls.credits)(featureId, value).catch((err: unknown) => {
        throw asEngineError('ingest', err, { reported: result.reported, replayed: result.replayed });
      }),
    );
    reported = true;
  }

  // Nothing was sent, so nothing was replayed either - saying otherwise would read as a duplicate.
  return reported ? result : { ...result, replayed: false };
}

/**
 * What one event carries, and in which order.
 *
 * Three namespaces flatten into one map, so the order is the whole design. Attribution is applied
 * last and wins outright: a gateway passes vendor fields through, and a vendor field that happened
 * to be called `agentId` would otherwise re-attribute the bill to an entity that never ran. The
 * raw block sits under its own prefix beneath both, where it can be metered deliberately but
 * cannot displace anything.
 */
export function eventDimensions(
  params: EngineReportParams,
  metrics: Metrics,
): Record<string, string | number | boolean> {
  return { ...params.raw, ...metrics, ...params.dimensions };
}

/**
 * The one thing the caller has to fix themselves, so it reads the same whichever client found it.
 *
 * An in-process run derives the name from the vendor call it wrapped, so this is reachable only
 * out of process, where there is no recipe to derive it from.
 */
export function missingEventError(): EngineError {
  return new EngineError(
    'ingest',
    'async ingest reports one event per call, and the event has to be named. Set ' +
      "`stiggContext.eventName` to the name your Stigg meter filters on, or use `ingestMode: 'sync'`.",
  );
}

/**
 * A sync report to a feature only a meter can fill.
 *
 * The rejection used to be a routing signal - the engines retried it as an event and remembered.
 * That made the transport a property of the catalog, discovered one rejection at a time, and
 * silently moved a run onto an eventually-consistent path it never asked for. Now it says so.
 */
export function meterMismatchError(metrics: Metrics): EngineError {
  const names = Object.keys(metrics).join(', ');
  return new EngineError(
    'ingest',
    `${names} ${Object.keys(metrics).length > 1 ? 'are' : 'is'} backed by a raw-events meter, which the ` +
      "usage report cannot fill. Report this run with `ingest: 'async'`, or point it at a feature " +
      'whose value your application computes.',
  );
}
