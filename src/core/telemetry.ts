/**
 * OpenTelemetry spans for what an orchestrator's governance did: one `stigg.check` per check, one
 * `stigg.ingest` per report - from `stigg.middleware` and the bindings over it, not from `wrap`.
 *
 * This is how an observability vendor sees Stigg beside an agent graph's own steps, with nothing
 * to configure: Langfuse, LangSmith and the rest already register an OpenTelemetry provider for
 * the graph, and these spans land in the same trace. With no provider they cost nothing, and
 * `@opentelemetry/api` is an optional peer, loaded on the first span - an application without it
 * gets no spans and no error.
 *
 * A refusal is a span with status `ERROR` and an `AccessDeniedError` exception event. That is the
 * one place a refusal is always visible to another tool: inside an orchestrator, the refused step
 * itself never reaches the other callbacks' error hooks, so their own span for it stays open.
 *
 * Spans attach to whatever span is active where the check or the report happens - an
 * application's span around a request or an agent turn - so they land in that trace.
 *
 * Attribute names are `stigg.*` for what only Stigg knows, and the OpenTelemetry GenAI semantic
 * conventions for what is common to every agent framework: `gen_ai.agent.name`, `gen_ai.tool.name`.
 */
import type * as OpenTelemetry from '@opentelemetry/api';
import type { Attributes } from '@opentelemetry/api';
import { AGENT_SDK_VERSION } from '../sdk-identity';
import type { AccessDecision, IngestResult } from '../types';
import type { ResolvedContext } from './context';

/** The instrumentation scope every Stigg span is reported under - what a span filter matches on. */
export const TRACER_NAME = '@stigg/agent-sdk-js';

let api: typeof OpenTelemetry | null | undefined;

/** The application's copy of the API, loaded once - or `null` when it has none installed. */
function openTelemetry(): typeof OpenTelemetry | null {
  if (api === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      api = require('@opentelemetry/api') as typeof OpenTelemetry;
    } catch {
      api = null;
    }
  }
  return api;
}

/** Asked for per span, so a provider registered after this package was loaded is still found. */
const tracer = (otel: typeof OpenTelemetry) => otel.trace.getTracer(TRACER_NAME, AGENT_SDK_VERSION);

/** Who the call was for: the attribution, as the check and the report both carry it. */
function attribution(context: ResolvedContext): Attributes {
  const attributes: Attributes = {
    'stigg.customer.id': context.customerId,
    'stigg.correlation_id': context.correlationId,
  };
  if (context.agent !== undefined) attributes['gen_ai.agent.name'] = context.agent;
  if (context.tool !== undefined) attributes['gen_ai.tool.name'] = context.tool;
  if (context.attributionKey && context.dimensions[context.attributionKey] !== undefined) {
    attributes['stigg.agent.id'] = context.dimensions[context.attributionKey];
  }
  for (const [key, value] of Object.entries(context.dimensions)) attributes[`stigg.dimension.${key}`] = value;
  if (context.eventName) attributes['stigg.event.name'] = context.eventName.name;
  return attributes;
}

/** One check, from when it was asked to when it was answered. */
export function traceCheck(context: ResolvedContext, decision: AccessDecision, startedAt: number): void {
  const otel = openTelemetry();
  if (!otel) return;
  const attributes: Attributes = {
    ...attribution(context),
    'stigg.decision.has_access': decision.hasAccess,
    'stigg.decision.source': decision.source,
  };
  if (context.checkedId) attributes['stigg.entitlement.id'] = context.checkedId;
  if (decision.reason) attributes['stigg.decision.reason'] = decision.reason;
  if (decision.deniedBy) attributes['stigg.decision.denied_by'] = decision.deniedBy;
  if (decision.remaining !== undefined) attributes['stigg.decision.remaining'] = decision.remaining;
  if (decision.remedy) attributes['stigg.decision.remedy'] = decision.remedy;
  if (decision.isFallback) attributes['stigg.decision.is_fallback'] = true;

  const span = tracer(otel).startSpan('stigg.check', { startTime: startedAt, attributes });
  if (!decision.hasAccess) {
    span.recordException({ name: 'AccessDeniedError', message: decision.message });
    span.setStatus({ code: otel.SpanStatusCode.ERROR, message: decision.summary });
  }
  span.end();
}

/** One report, whether it landed, failed, or had nothing to send. */
export function traceIngest(context: ResolvedContext, result: IngestResult, startedAt: number): void {
  const otel = openTelemetry();
  if (!otel) return;
  const attributes: Attributes = {
    ...attribution(context),
    'stigg.ingest.ok': result.ok,
    'stigg.ingest.mode': result.mode,
    'stigg.ingest.idempotency_key': result.idempotencyKey,
  };
  for (const [metric, value] of Object.entries(result.reported)) attributes[`stigg.metric.${metric}`] = value;
  if (result.creditsConsumed !== undefined) attributes['stigg.ingest.credits_consumed'] = result.creditsConsumed;
  if (result.replayed !== undefined) attributes['stigg.ingest.replayed'] = result.replayed;

  const span = tracer(otel).startSpan('stigg.ingest', { startTime: startedAt, attributes });
  if (!result.ok) {
    const message = result.error instanceof Error ? result.error.message : String(result.error ?? 'ingest failed');
    span.recordException({ name: 'EngineError', message });
    span.setStatus({ code: otel.SpanStatusCode.ERROR, message });
  }
  span.end();
}
