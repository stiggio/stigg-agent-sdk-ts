/**
 * AUDR (Agent Usage Detail Record) emission: one record per model call this SDK measured.
 *
 * AUDR is an open receipt for AI usage - one JSON object per metered operation - that other
 * systems ingest: Chargebee, Lago, an OTel collector. This module writes those receipts for the
 * calls the SDK already gates, as the harness that ran them. It is off unless `audr` is passed at
 * construction, and it is a second, independent output: what this SDK reports to Stigg is still
 * reported directly, so pointing an AUDR client at a Stigg sink would count every call twice.
 *
 * Written against `@openaudr/audr`'s types, never its code. The host owns the client - its sink
 * holds the credentials, the batching and the retries - so all this needs from it is `record()`.
 * The package is an optional peer, pinned in `package.json` to the versions these records were
 * checked against; its types are used only where they are erased from this package's `.d.ts`, so
 * an application that leaves AUDR off never needs it installed. test/audr.test.ts checks the rest
 * against it: every record against its `validate()`, and this module's types against its own.
 *
 * After the fact by design. A record says what a call consumed once it is over; it cannot refuse
 * one. Enforcement stays where it is, in the check before the call.
 *
 * @see https://openaudr.dev/spec/v1.1.0/
 */
import type { AudrRecord as SpecRecord, Environment, SPEC_VERSION } from '@openaudr/audr' with {
  'resolution-mode': 'import',
};
import { AGENT_SDK_VERSION } from '../sdk-identity';
import type { Measurement, TokenUsage } from '../types';
import type { ResolvedContext } from './context';

/** The spec version these records are written to. */
export const AUDR_SPEC_VERSION = '1.1.0' satisfies typeof SPEC_VERSION;

/** How this SDK signs its records: the harness, under its own package name. */
export const AUDR_EMITTER = {
  component: 'harness',
  name: '@stigg/agent-sdk-js',
  version: AGENT_SDK_VERSION,
} as const;

/** AUDR's environments. A sink ignores a record that names none, so one is required here. */
export const AUDR_ENVIRONMENTS = [
  'production',
  'staging',
  'development',
  'test',
  'evaluation',
] as const satisfies readonly Environment[];
export type AudrEnvironment = (typeof AUDR_ENVIRONMENTS)[number];

/**
 * One AUDR record, as this SDK writes it - a subset of the spec's, structurally compatible with
 * `@openaudr/audr`'s `AudrRecord`, so the host's `Client` takes it as is.
 */
export type AudrRecord = {
  spec_version: string;
  record_id: string;
  emitter: { component: 'harness'; name: string; version: string };
  resource: { type: 'model'; operation: 'generation'; modality: 'text'; provider: string; name: string };
  run: { run_id: string; span_id: string; parent_span_id?: string; name?: string };
  attribution: {
    environment: AudrEnvironment;
    account_id: string;
    feature_id?: string;
    labels?: Record<string, string>;
  };
  usage: {
    llm: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
      requests: number;
    };
  };
  timing: { event_time: string; duration_ms?: number };
};

/** What this SDK needs of an `@openaudr/audr` `Client`: somewhere to hand a record. */
export type AudrClientLike = {
  /** Validates and queues the record. The real one returns at once and never throws. */
  record(record: AudrRecord): unknown;
};

export type AudrOptions = {
  /**
   * The host's own AUDR client - `new Client(sink)` from `@openaudr/audr`. Its sink decides where
   * records go; this SDK never creates, flushes or shuts it down.
   */
  client: AudrClientLike;
  /** Which environment the records are for. Every record carries the customer, as `account_id`. */
  environment: AudrEnvironment;
};

/**
 * What a binding knows about one call that the measurement does not: who served it, which model,
 * where it sits in a run tree, and when it started. Never sent to Stigg.
 */
export type AudrTrace = {
  /** The vendor that was called - the recipe's own name for it. */
  provider?: string;
  /** The model the vendor says served, falling back to the one the request named. */
  model?: string;
  /**
   * The run this call belongs to, when a framework's run tree says. Otherwise the correlation id
   * when the caller stated one, and the call alone when it did not.
   */
  runId?: string;
  /** This call's own span. Generated when the binding has none. */
  spanId?: string;
  /** The span this call ran under, when a framework's run tree says. */
  parentSpanId?: string;
  /** `Date.now()` when the call started, for `timing.duration_ms`. */
  startedAt?: number;
};

/** Emits one record per measured model call. Built once per SDK, shared by every session. */
export type AudrEmitter = {
  /** Returns what the client's `record()` did, so a client whose record() is async is still caught. */
  emit(context: ResolvedContext, measurement: Measurement): unknown;
};

/**
 * Refused at construction rather than at the first call: a client that cannot take a record, or an
 * environment a sink will ignore, would otherwise drop every record without a word.
 */
export function createAudrEmitter(options: AudrOptions, warn: (message: string) => void): AudrEmitter {
  if (typeof options?.client?.record !== 'function') {
    throw new Error(
      "`audr.client` has no record() method. Pass the application's own AUDR client - " +
        '`new Client(sink)` from `@openaudr/audr`.',
    );
  }
  if (!AUDR_ENVIRONMENTS.includes(options.environment)) {
    throw new Error(
      `\`audr.environment\` is '${String(options.environment)}' - it must be one of ` +
        `${AUDR_ENVIRONMENTS.join(', ')}. A sink ignores a record that names none.`,
    );
  }
  const { client, environment } = options;
  let warnedShort = false;

  return {
    emit(context, measurement) {
      // An estimate is this SDK's number, not the vendor's, and an incomplete measurement fills
      // what the vendor left out with zeros - AUDR has no way to say either. A downstream system
      // counts what a record states, so it must be only what the provider stated.
      if (measurement.estimated || measurement.incomplete) {
        if (!warnedShort) {
          warnedShort = true;
          warn(
            '[stigg] an estimated or incomplete measurement was not emitted as an AUDR record: AUDR carries only ' +
              'stated usage.',
          );
        }
        return undefined;
      }
      const record = toRecord(context, measurement, environment);
      return record ? client.record(record) : undefined;
    },
  };
}

/** The record for one call, or nothing when there is no token usage to state. */
export function toRecord(
  context: ResolvedContext,
  measurement: Measurement,
  environment: AudrEnvironment,
  now = Date.now(),
): AudrRecord | undefined {
  const llm = llmUsage(measurement.usage);
  if (!llm) return undefined;
  const trace = context.audr ?? {};
  const labels = labelsOf({ ...context.dimensions, ...measurement.dimensions });
  const spanId = trace.spanId || crypto.randomUUID();
  const record = {
    spec_version: AUDR_SPEC_VERSION,
    record_id: uuidv7(now),
    emitter: { ...AUDR_EMITTER },
    resource: {
      type: 'model',
      operation: 'generation',
      // Required for a model. `text` is the adapters' own default: no recipe here reads a call's
      // modality, and a vision or audio call is still metered by the tokens it states.
      modality: 'text',
      provider: providerSlug(trace.provider),
      name: trace.model || 'unknown',
    },
    run: {
      // A generated correlation id is the wrap's, not a run's: one client wrapped at module scope
      // would make every call it ever makes, for every customer, a single run.
      run_id: runIdOf(trace.runId ?? (context.correlationStated ? context.correlationId : spanId)),
      span_id: spanId,
      ...(trace.parentSpanId ? { parent_span_id: trace.parentSpanId } : {}),
      ...(context.agent ? { name: context.agent } : {}),
    },
    attribution: {
      environment,
      account_id: context.customerId,
      ...(context.checkedId ? { feature_id: context.checkedId } : {}),
      ...(labels ? { labels } : {}),
    },
    usage: { llm },
    timing: {
      event_time: new Date(now).toISOString(),
      ...(trace.startedAt !== undefined && now >= trace.startedAt ? { duration_ms: now - trace.startedAt } : {}),
    },
  } satisfies AudrRecord;
  return record satisfies SpecRecord;
}

/**
 * The four counters, already in AUDR's terms: `TokenUsage` is disjoint, so `input` excludes cache
 * reads and writes as AUDR's `input_tokens` does. Reasoning stays inside `output` - AUDR subtracts
 * it only when it is reported apart, and this SDK does not report it apart.
 */
function llmUsage(usage: TokenUsage | undefined): AudrRecord['usage']['llm'] | undefined {
  if (!usage) return undefined;
  const counters = {
    input_tokens: count(usage.input),
    output_tokens: count(usage.output),
    cache_read_tokens: count(usage.cacheRead),
    cache_write_tokens: count(usage.cacheCreate),
  };
  const stated = Object.fromEntries(Object.entries(counters).filter(([, value]) => value !== undefined));
  return { ...stated, requests: 1 };
}

/** A counter AUDR can carry: a whole, non-negative number. Anything else is left unstated. */
function count(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** AUDR's provider slug: lowercase, each run of other characters a `-`. */
function providerSlug(name: string | undefined): string {
  const slug = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unknown';
}

/** AUDR bounds a run id to 8-64 characters; one outside that is padded or cut rather than lost. */
function runIdOf(id: string): string {
  if (id.length > 64) return id.slice(0, 64);
  return id.length < 8 ? id.padEnd(8, '_') : id;
}

/**
 * The call's dimensions, as labels: AUDR's metadata that is not usage, which is what they are to
 * anyone but Stigg. Keys and values AUDR would reject are dropped, not the record.
 */
function labelsOf(dimensions: Record<string, string>): Record<string, string> | undefined {
  const labels = Object.entries(dimensions).filter(
    ([key, value]) => /^[a-zA-Z0-9_.-]{1,64}$/.test(key) && typeof value === 'string' && value.length <= 256,
  );
  return labels.length ? Object.fromEntries(labels) : undefined;
}

/** A UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then random bits. AUDR's `record_id`. */
export function uuidv7(now = Date.now()): string {
  // The global Web Crypto, not `node:crypto`: that import belongs to one file (see
  // test/module-boundaries.test.ts), and Node 22 has this one built in.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
