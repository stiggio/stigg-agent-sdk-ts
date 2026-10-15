/**
 * Client configuration - everything that is true of one Stigg *environment*, and nothing else.
 *
 * A Stigg API key is environment-bound, so the key identifies the environment: one instance per
 * environment, like the Node server SDK. That draws the line for what belongs here. Anything that
 * varies within an environment - which customer, which agent, what it bills against, who wants to
 * watch it happen - is context for the call that needs it, not configuration for the process.
 *
 * The data half (ids, urls, numbers, enums) goes through zod so a typo fails at construction with
 * a readable message instead of as a 404 three calls later. The collaborator half (logger,
 * onError) is injected as-is - those are substitution seams, not data to validate.
 */
import { z } from 'zod';
import { CONTEXT_DEFAULTS } from './core/context';
import { consoleLogger, type Logger, noopLogger } from './logger';
// Re-exported below rather than declared here: it is the Node SDK's own configuration, and that
// client stays behind the one file that owns it (see test/module-boundaries.test.ts).
import type { CacheOptions, NodeSdkClient } from './engine/node-sdk-engine';
import type { CheckErrorAction, IngestMode } from './types';
import type { EngineError } from './errors';

/** The key sent when the target is a URL that needs none. Never reaches a real environment. */
const KEYLESS = 'offline-mock';

const dataSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  // Both default through the context's own table rather than restating it: the two used to
  // disagree, and the one written here was the one nothing read.
  checkErrorAction: z.enum(['deny', 'allow']).default(CONTEXT_DEFAULTS.checkErrorAction),
  ingest: z.enum(['sync', 'async']).default(CONTEXT_DEFAULTS.ingestMode),
  timeoutMs: z.number().int().positive().default(3_000),
});

export type { CacheOptions, NodeSdkClient };

/** Reported to `onError` alongside the failure, so a swallowed ingest is still diagnosable. */
export type ErrorContext = { operation: string; runId?: string; idempotencyKey?: string; customerId?: string };

/**
 * Everything the SDK can be told, in one object.
 *
 * All of it optional and all of it with a working default, including where to send traffic: the
 * key falls back to `STIGG_SERVER_API_KEY` and the URL to the hosted API, so the smallest working
 * program is `new StiggAgentSDK()`.
 *
 * One object rather than positional arguments so that each answer has exactly one place to go -
 * a URL given in two places needs a runtime check to refuse both, and an optional argument in
 * front of a required one forces `undefined` placeholders at the call site.
 */
export type StiggAgentSDKOptions = {
  /**
   * The server key, which names the environment. Falls back to `STIGG_SERVER_API_KEY`, the way
   * every vendor SDK does - **including when `baseUrl` is set**, since a URL says where traffic
   * goes and nothing about who is sending it.
   *
   * So a shell with that variable exported sends it to whatever `baseUrl` names, a local mock
   * included. To run keyless on such a machine, unset the variable for the process rather than
   * relying on `baseUrl` to suppress it: a deployment that genuinely needs no key is the case
   * where nothing is configured anywhere, and that is the one the fallback below serves.
   */
  apiKey?: string;
  /**
   * Where to send traffic, when it is not the hosted API. Pass it alongside `apiKey` for a
   * self-hosted deployment that still wants a key, or on its own for one that needs none.
   */
  baseUrl?: string;
  /**
   * How checks are cached. See {@link CacheOptions} - it is the Node server SDK's own cache
   * configuration, passed through, because that is where caching actually happens.
   */
  cache?: CacheOptions;
  /**
   * A Node server SDK client you already have, used instead of building one.
   *
   * Pass it when the application uses `@stigg/node-server-sdk` directly. It is the only way to
   * settle ownership: `Stigg.initialize` keeps one global instance per process and hands it back
   * when the API key matches, so without this the SDK may be handed your client, believe it built
   * it, and close it out from under you on `stigg.close()` - taking its cache and socket along.
   * A client passed here is borrowed and never closed.
   *
   * It replaces only the cached half. The governance REST client is still built from the API key,
   * because the Node SDK has no governance surface. Mutually exclusive with
   * {@link StiggAgentSDKOptions.cache}, which configures a client this SDK is no longer building.
   */
  client?: NodeSdkClient;
  /**
   * @deprecated Ignored. There is no local decision cache to put a TTL on any more - the Node
   * server SDK's entitlement cache serves these checks and keeps itself fresh, so there is no
   * window to size. Configure caching with {@link StiggAgentSDKOptions.cache}; for a hard limit
   * with no cached state at all, there is nothing to turn off on the attributed governance path.
   */
  cacheTtlMs?: number;
  /**
   * What happens to a call when the check itself fails - Stigg unreachable, a timeout, a 5xx.
   *
   * Defaults to `'allow'`: a soft limit, so an outage does not take the application down with it.
   * Pass `'deny'` to mirror governance's own fail-closed behaviour. Overridable per call through
   * `stiggContext`, and by `wrap`'s own context for every call through one client.
   */
  checkErrorAction?: CheckErrorAction;
  /**
   * Which of Stigg's ingest APIs a run reports through. Defaults to `'async'`: the event API, which
   * costs a fraction of the latency and takes a far higher rate. Overridable per run, and see
   * {@link IngestMode} for what the two trade against each other.
   */
  ingest?: IngestMode;
  timeoutMs?: number;
  /**
   * Where the SDK narrates what it did. Defaults to `'console'`, because the things it says are
   * the ones you need before anything is configured - which transport resolved, that a run is
   * gating nothing, that what was reported names no entitlement the budget converts.
   *
   * Pass `'none'` to silence it, or your own logger to route it.
   */
  logger?: Logger | 'console' | 'none';
  /**
   * Every instrumentation failure, as structure rather than as a sentence.
   *
   * The one observability hook that is environment-scoped, because it is the only one that fires
   * with no run to belong to: engine resolution, a bare `register()`, `close()`. Watching a
   * decision or an ingest is per-run and lives on `run.start(..., { hooks })`.
   *
   * It is also the only place metering failures surface at all - they are swallowed so they
   * cannot break a run - so it defaults to a warning through `logger` rather than to silence.
   * Replace it to route an `EngineError` and its {@link ErrorContext} into your own telemetry.
   */
  onError?: (error: EngineError, context: ErrorContext) => void;
};

export type ResolvedConfig = Omit<Required<z.infer<typeof dataSchema>>, 'baseUrl'> & {
  baseUrl?: string;
  cache?: CacheOptions;
  client?: NodeSdkClient;
  logger: Logger;
  onError: (error: EngineError, context: ErrorContext) => void;
};

const resolveLogger = (logger: StiggAgentSDKOptions['logger']): Logger => {
  if (logger === 'console' || logger === undefined) return consoleLogger;
  if (logger === 'none') return noopLogger;
  return logger;
};

/**
 * The key to send, which is the environment's identity.
 *
 * The environment variable is tried before the keyless fallback, and that order is the whole of
 * it. A `baseUrl` says *where* to send traffic and nothing about who is sending it, so the two
 * are independent: a self-hosted deployment names its URL in options and keeps its key in
 * `STIGG_SERVER_API_KEY`, and substituting a sentinel there would 401 with nothing in the config
 * to say why.
 *
 * {@link KEYLESS} is the last resort, not the rule: it stands in for a deployment that needs no
 * key at all - a local stand-in, or the built-in mock - and exists only because the schema below
 * demands a non-empty string. Nothing authenticates with it.
 *
 * The failure for a missing key is raised here rather than left to zod, because "set
 * STIGG_SERVER_API_KEY" is the actionable half and the schema only knows the field was too short.
 */
function resolveApiKey({ apiKey, baseUrl }: StiggAgentSDKOptions): string {
  const named = apiKey?.trim();
  if (named) return named;

  const fromEnv = process.env.STIGG_SERVER_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  // No key anywhere. A URL to send to is the one case where that is a configuration rather than
  // an omission.
  if (baseUrl) return KEYLESS;
  throw new Error(
    'No Stigg API key - pass `apiKey`, or set STIGG_SERVER_API_KEY. To run without one, pass ' +
      '`baseUrl` instead: a local stand-in, a self-hosted deployment, or the built-in mock.',
  );
}

export function resolveConfig(options: StiggAgentSDKOptions = {}): ResolvedConfig {
  const parsed = dataSchema.parse({
    apiKey: resolveApiKey(options),
    baseUrl: options.baseUrl,
    checkErrorAction: options.checkErrorAction,
    ingest: options.ingest,
    timeoutMs: options.timeoutMs,
  });

  // Refused rather than silently preferred, like the two-URL case above: `cache` configures a
  // client, and a client that was handed in is already configured. Whichever the SDK picked, the
  // other would be settings the caller believes are in force and are not.
  if (options.client && options.cache) {
    throw new Error(
      'This SDK was given both a `client` and `cache` options. The cache options configure a ' +
        'client at construction, and the one you passed is already built - so they would be ' +
        'ignored. Pass one: `client` for a client you own, or `cache` to have the SDK build one.',
    );
  }

  const logger = resolveLogger(options.logger);

  // Said rather than ignored in silence: someone who set this was sizing an overshoot window, and
  // the answer to that question is now different rather than smaller.
  if (options.cacheTtlMs !== undefined) {
    logger.warn(
      '[stigg] cacheTtlMs is ignored - this SDK no longer caches decisions. Checks are served by ' +
        "the Node server SDK's entitlement cache, which invalidates on updates and writes reported " +
        'usage back, so there is no TTL to size. Configure it with `cache` instead.',
    );
  }

  return {
    ...parsed,
    cache: options.cache,
    client: options.client,
    logger,
    // Never silent, never fatal. Replace it to route into your own telemetry.
    onError:
      options.onError ?? ((error, context) => logger.warn(`[stigg] ${context.operation} failed: ${error.message}`)),
  };
}

/** The slice of config the engine factory needs. */
export type EngineConfig = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
  cache?: CacheOptions;
  client?: NodeSdkClient;
  logger: Logger;
};
