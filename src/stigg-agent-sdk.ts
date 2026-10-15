/**
 * The SDK's entry point, and the run lifecycle it exposes:
 *
 *   register -> check -> execute -> ingest -> (deregister)
 *
 * `register` is one call because it is one idea - "this agent is about to do something" - but it
 * is two operations underneath, and they have very different costs. Giving the agent an identity
 * is a write, so it happens once per agent and is remembered; opening the run is not a write at
 * all, so it happens every time and is what warms the budget. Calling `register` in a loop is
 * therefore safe: the write does not repeat.
 *
 * This file is the composition root - the one place that knows both the core and the bindings.
 * Nothing under `core/` or `engine/` imports a binding, and no binding imports another.
 */
import { randomUUID } from 'node:crypto';
import { resolveConfig, type ResolvedConfig, type StiggAgentSDKOptions } from './config';
import { createGovernanceEngine } from './engine/create-engine';
import {
  describeResolution,
  type EngineResolution,
  type EntityPlacement,
  type GovernanceEngine,
} from './engine/engine';
import { asEngineError, EngineError, GovernanceNotEnabledError, isAccessDenied } from './errors';
import { parseGovernanceHeaders } from './headers';
import type { ParsedGovernanceHeaders } from './headers';
import { flattenRaw } from './core/dimensions';
import { anthropicRecipe } from './bindings/client/providers/anthropic/anthropic-recipe';
import { geminiChatRecipe, geminiRecipe } from './bindings/client/providers/gemini/gemini-recipe';
import { litellmRecipe } from './bindings/client/gateways/litellm/litellm-recipe';
import { databricksRecipe } from './bindings/client/gateways/databricks/databricks-recipe';
import { cloudflareRecipe } from './bindings/client/gateways/cloudflare/cloudflare-recipe';
import { groqRecipe } from './bindings/client/providers/groq/groq-recipe';
import { mistralRecipe } from './bindings/client/providers/mistral/mistral-recipe';
import { ollamaRecipe } from './bindings/client/providers/ollama/ollama-recipe';
import { bedrockRecipe } from './bindings/client/gateways/bedrock/bedrock-recipe';
import { openAIRecipe } from './bindings/client/providers/openai/openai-recipe';
import { openrouterRecipe } from './bindings/client/gateways/openrouter/openrouter-recipe';
import { typesafeRecipe } from './bindings/client/providers/typesafe/typesafe-recipe';
import { createClientRegistry } from './bindings/client/core/registry';
import type { ClientRegistry } from './bindings/client/core/types';
import { wrapClient } from './bindings/client/core/wrap-client';
import { observedMeasurement } from './bindings/shared/token-usage';
import { isEnforced, noCustomer, overrideContext, resolveContext } from './core/context';
import type { ContextDefaults } from './core/context';
import type { ResolvedContext, StiggContext } from './core/context';
import { GovernanceSession } from './core/session';
import type { SessionSummary } from './core/session';
import type { SessionHooks } from './core/session';
import { safely } from './core/hooks';
import type {
  Metrics,
  ClientGovernance,
  ClientOptions,
  DeregisterInput,
  AccessDecision,
  WrappedClient,
  PathsOf,
  IngestContext,
  IngestResult,
  RegisterInput,
} from './types';
import type { GovernanceHeaders } from './headers';
import {
  entitlementError,
  entitlementId,
  entitlementKind,
  usageValueError,
  vendorMetrics,
  wholeUnitsForGovernance,
} from './types';

/**
 * Recipes are data - method paths and usage extractors - so wiring them here costs nothing at
 * runtime and pulls in no vendor package. An orchestration adapter is different: it needs its
 * framework loaded, so it stays an explicit subpath import.
 */
/**
 * Order matters: the gateways are matched before the plain OpenAI adapter, because every one of
 * them *is* an OpenAI client by shape and only the base URL says which. The bare adapter would
 * otherwise claim them and lose what only a gateway knows - the model that actually served after
 * routing, and the gateway's own request id.
 *
 * Matching them costs nothing in units: they report what the gateway stated and leave what it is
 * worth to the run's mapper, like every other vendor. Billing the `cost` they add rather than the
 * tokens is that mapper's business, and stays the caller's to decide.
 */
export const DEFAULT_RECIPES = [
  // First, and that position is load-bearing. Cloudflare AI Gateway forwards the upstream body
  // untouched, so an `Anthropic` client pointed at it is an Anthropic client by shape and only the
  // hostname says otherwise - and `anthropicRecipe` has no base-URL guard, so asked first it would
  // claim that client and meter gateway traffic as direct Anthropic traffic. The same argument puts
  // it ahead of `openAIRecipe` for its OpenAI-shaped routes and for Workers AI's compatible one.
  cloudflareRecipe(),
  anthropicRecipe,
  openrouterRecipe(),
  litellmRecipe(),
  // The Databricks workspace route, matched on host *and* serving path - the host families alone
  // are every Databricks API there is, most of which are not inference. Only the hosted recipe is
  // here: `databricksExternalRecipe` covers the same wire reaching an endpoint billed by somebody
  // else, which no matcher can tell apart, so it is named at `wrap` rather than guessed at.
  databricksRecipe(),
  // Ahead of `openAIRecipe`, like the gateways above and for the same reason: shape cannot tell a
  // Groq client from any other OpenAI-compatible one, so the hostname decides, and the recipe that
  // reads the hostname has to be asked first or the generic one claims the client.
  groqRecipe,
  // Matched on its own client's configuration, so it sits with the gateways rather than ahead of
  // or behind them: an AWS command bus is nothing any other guard here can mistake for its own.
  bedrockRecipe(),
  openAIRecipe,
  // Matched on `chat.complete`, which no OpenAI-compatible client has - so position is not load
  // bearing here, unlike the gateways above.
  mistralRecipe,
  // Ahead of `typesafeRecipe` on purpose. That recipe's whole guard is a single method name,
  // `systemOne`, and an Ollama client carries a `systemone` whose request and response are the
  // same shape - casing is the entire margin between them. `find` returns the first match, so the
  // three-signal guard gets to answer first rather than relying on that margin holding.
  ollamaRecipe,
  typesafeRecipe,
  // Gemini's two surfaces are matched separately - a client and one of its chats are different
  // objects with no method in common, so neither guard can see the other's traffic.
  geminiRecipe,
  geminiChatRecipe,
];

/**
 * What a run's events are called when nothing names them.
 *
 * A client binding overrides this with the vendor call it wrapped - `anthropic.messages.create` -
 * which is the name a Stigg meter should filter on. This is only the floor, for a run opened with
 * no recipe behind it at all.
 */
const DEFAULT_EVENT_NAME = 'agent.usage';

/**
 * Which metric a gateway's report draws the wallet with when the caller names no entitlement.
 *
 * A routing default, not a gate - which is why the run paths have none and this one does. A run
 * that names no entitlement is asking not to be gated, and substituting one there would gate it;
 * `ingestFromHeaders` never checks anything, so nothing here can be made to look enforced. All this
 * decides is whether a metric literally called `credits` draws the credit wallet or is reported as
 * a feature by that name - and dropping it would silently re-route exactly those reports at the
 * next deploy, on the one path with no check to notice and an `'async'` mode that answers nothing.
 */
const DEFAULT_WALLET = { currencyId: 'credits' } as const;

/**
 * How long a failed engine probe is remembered before the next call builds a new one.
 *
 * Long enough that an outage is probed on a timer rather than once per request, short enough that
 * a transient failure costs seconds instead of a restart. See {@link StiggAgentSDK.ensureStarted}
 * for why remembering it at all is the point.
 */
const RETRY_START_AFTER_MS = 2_000;

/** The key shorthand and the options object, folded into the one object the config takes. */
function toOptions(
  first?: string | StiggAgentSDKOptions,
  second?: Omit<StiggAgentSDKOptions, 'apiKey'>,
): StiggAgentSDKOptions {
  return typeof first === 'string' ? { ...second, apiKey: first } : { ...first, ...second };
}

/** The assignment `register` is being asked to write, if it is being asked to write one. */
function toPlacement(input: RegisterInput): EntityPlacement | undefined {
  if (!input.budget) return undefined;

  const { entitlement, cadence, parentId } = input.budget;
  // A placement writes an assignment against the entitlement, so an empty one persists a budget
  // attached to nothing rather than merely routing badly.
  const invalid = entitlementError(entitlement);
  if (invalid) throw invalid;

  // `'on-create'` seeds and leaves an admin's change alone; `'always'`, the default, writes every
  // time. One field, so the two cannot both be given.
  const onCreate = input.budget.apply === 'on-create';
  // The type says a seed carries a number, and a JS caller is not bound by it. Seeding `undefined`
  // sends a cadence and no cap, so the agent is created with the budget it asked for missing -
  // enforcement then falls through to whatever ancestor has one, silently. Refused instead.
  if (onCreate && typeof input.budget.limit !== 'number') {
    throw new Error(
      `Agent ${input.agentId} asked to seed a budget with no limit to seed. ` +
        "`budget.apply: 'on-create'` writes a cap the first time and never again, so there is " +
        'nothing to write without `budget.limit`.',
    );
  }
  return {
    parentId,
    entitlement,
    cadence,
    usageLimit: onCreate ? undefined : input.budget.limit,
    usageLimitOnCreate: onCreate ? (input.budget.limit ?? undefined) : undefined,
  };
}

export class StiggAgentSDK {
  readonly config: ResolvedConfig;

  private readonly clients: ClientRegistry;
  /** Every session this SDK handed out, so `flush()` can drain all of them at once. */
  private readonly sessions = new Set<GovernanceSession>();
  /** The session the no-client paths share. Built on first use. */
  private loose?: GovernanceSession;
  /**
   * `customer:agent` -> what was last said about that agent, so a repeat of the same description
   * is not written again per run. The value is a fingerprint of the describable attributes, not
   * an id: the id is in the key.
   */
  private readonly registered = new Map<string, string>();
  /**
   * Bare registrations still on the wire, so the burst of runs that opens a process writes once
   * rather than once each. Only the memoized path is shared - see `register`.
   */
  private readonly registering = new Map<string, Promise<void>>();
  private started?: Promise<{ engine: GovernanceEngine; resolution: EngineResolution }>;
  /**
   * When the attempt currently in `started` rejected, or undefined while it is pending or has
   * resolved. What makes a failed probe expire rather than persist - see `ensureStarted`.
   */
  private startFailedAt?: number;
  private engineState?: { engine: GovernanceEngine; resolution: EngineResolution };

  /**
   * Synchronous - nothing here touches the network. The engine is built on the first call that
   * needs it, so there is no awaited setup step to forget; `await init()` forces it early.
   *
   * Where this SDK sends its traffic comes first, because it is the only thing that cannot be
   * inferred: a server key, a `{ baseUrl }` target that needs none, or nothing at all to read
   * `STIGG_SERVER_API_KEY`. A key that belongs to somewhere other than
   * the hosted API names that URL second - the two together are one idea, so neither is buried
   * among the tuning knobs that follow.
   *
   * Construct one per environment and share it - the engine's cache and its connection pool are
   * per instance, so a second one for the same environment is wasted rather than wrong.
   */
  constructor(options?: StiggAgentSDKOptions);
  /** The shorthand, for a server key with nothing else to say about where it points. */
  constructor(apiKey: string, options?: Omit<StiggAgentSDKOptions, 'apiKey'>);
  constructor(first?: string | StiggAgentSDKOptions, second?: Omit<StiggAgentSDKOptions, 'apiKey'>) {
    this.config = resolveConfig(toOptions(first, second));
    this.clients = createClientRegistry(DEFAULT_RECIPES);
  }

  /** Releases what this SDK's engine holds open. */
  async close(): Promise<void> {
    // A startup still in flight hands back an engine after this returns, and with the client
    // already out of the registry there is nothing left holding its cache and its sockets. So
    // wait for it: a close that reports success while a poller is still running is not one.
    const started = await this.started?.catch(() => undefined);
    await (started ?? this.engineState)?.engine.close?.();
  }

  /**
   * Forces the engine to resolve now and reports which client serves what. Optional - every
   * async call below does it anyway - but useful when you want the answer before the first run.
   */
  async init(): Promise<EngineResolution> {
    return (await this.ensureStarted()).resolution;
  }

  /** Undefined until the engine has resolved. `init()` returns it directly. */
  get resolution(): EngineResolution | undefined {
    return this.engineState?.resolution;
  }

  /** Available after the engine has resolved; the bindings that need it only run after that. */
  get engine(): GovernanceEngine {
    if (!this.engineState) throw new Error('The Stigg engine is not ready yet - await init() or any async call first.');
    return this.engineState.engine;
  }

  /**
   * Gives the agent an identity, a budget, and a place in the tree, and returns the agent id to
   * open a run against.
   *
   * The id is the one you passed: nothing about the run depends on this call having happened, so
   * returning it is a convenience rather than a handle. Skip `register` entirely and the agent
   * has no entity - the run still works, and checks and usage apply to the customer instead.
   *
   * Idempotent, and remembered per process: an upsert is cheap, but it is still a write, so
   * calling this on a hot path does not repeat it. A call carrying a budget or a parent always
   * writes, because that is a deliberate change rather than a formality.
   *
   * `run.start(runOptions, agentOptions)` calls this for you with the run's own scope, which is
   * the usual way in; reach for it directly to provision an agent no run is about to use.
   */
  async register(input: RegisterInput): Promise<string> {
    const { customerId, agentId } = input;
    // An id reaches the entity payload and the memo key alike, and an empty one is a public
    // identifier for nothing - provisioned, unfindable, and billed against by name. The type is
    // checked rather than assumed: `.trim()` on the number a JS caller passed throws a bare
    // TypeError from inside the SDK, which reads as a bug in it rather than in the call.
    if (typeof agentId !== 'string' || !agentId.trim()) {
      throw new Error('register needs an agentId - an empty one provisions an entity nobody can name.');
    }
    const placement = toPlacement(input);
    const key = `${customerId}:${agentId}`;
    // Memoized on the description, not just the pair: a second call describing the agent
    // differently is asking for that description to be written, and skipping it leaves the
    // account holding a name the application has already stopped using. The agent's identity is
    // `key`; this is only what is being said about it.
    //
    // Metadata is compared by its entries, sorted: `JSON.stringify` follows insertion order, so
    // the same pairs built by a spread or an `Object.fromEntries` would fingerprint differently
    // and re-upsert every run - which is the one case this memo exists to prevent.
    const metadata = describableMetadata(agentId, input.metadata);
    const describedAs = JSON.stringify([
      input.entityTypeId,
      input.displayName ?? null,
      metadata ? Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b)) : null,
    ]);
    if (!placement && this.registered.get(key) === describedAs) return agentId;

    // Everything above is a property of the arguments, so it is answered before the engine is
    // built: `run()` already validates in this order, and a malformed call that reports itself as
    // a probe timeout sends the reader looking at the network for a typo they can see.
    await this.ensureStarted();
    if (!this.engine.capabilities.provisioning) {
      // Only a call that asked for something governance-only is an error. A budget or a parent
      // cannot be honoured, and carrying on would leave an agent that looks governed with a
      // budget that was never written - so that fails. A bare registration asked for neither.
      if (placement) {
        throw new GovernanceNotEnabledError(
          `Cannot give agent ${agentId} a budget or a parent: governance is not enabled for this ` +
            'account, so there is nowhere to write the assignment. Contact Stigg to enable it, or ' +
            'register without them - checks and usage reporting work at the customer level.',
        );
      }
      this.config.logger.warn(
        `[stigg] governance is not enabled: agent ${agentId} has no entity, so checks and usage ` +
          'apply to the customer rather than to the agent.',
      );
      return agentId;
    }

    const write = async (): Promise<void> => {
      await this.engine.upsertEntity(
        customerId,
        {
          id: agentId,
          entityTypeId: input.entityTypeId,
          displayName: input.displayName,
          metadata,
        },
        placement,
      );
      this.registered.set(key, describedAs);
      this.config.logger.info(`[stigg] agent ${agentId} registered under customer ${customerId}`);
    };

    // Only the bare registration is shared. A call carrying a budget or a parent is a deliberate
    // change that always writes, and two of those are two different instructions - collapsing
    // them into one would silently drop whichever lost the race.
    if (placement) {
      await write();
      return agentId;
    }

    // The memo above cannot help until the first write lands, which is exactly when a process
    // opening its runs in parallel asks. Cleared on settle either way, so a failure is retryable
    // and the callers sharing it all hear about it.
    //
    // Keyed on the description as well as the agent, for the same reason the settled memo is: two
    // concurrent calls describing one agent differently are two different instructions, and
    // sharing a promise between them would return success to the second having written only the
    // first's `displayName`, metadata and entity type.
    const shared = `${key}:${describedAs}`;
    const inFlight = this.registering.get(shared) ?? write().finally(() => this.registering.delete(shared));
    this.registering.set(shared, inFlight);
    await inFlight;
    return agentId;
  }

  /**
   * Removes the agent's entity. Optional, mirrors `register`, and never relied on: it may never
   * fire - a crash, an abandoned stream, an interrupt that is never resumed - which is why warm
   * state has a TTL rather than waiting to be released.
   */
  async deregister(input: DeregisterInput): Promise<void> {
    await this.ensureStarted();
    const { customerId, agentId } = input;
    if (!this.engine.capabilities.provisioning) {
      throw new GovernanceNotEnabledError(
        `Cannot deregister agent ${agentId}: governance is not enabled for this account.`,
      );
    }
    await this.engine.archiveEntity(customerId, agentId);
    this.registered.delete(`${customerId}:${agentId}`);
  }

  /**
   * Governs a vendor client and hands back a copy whose calls are checked and metered.
   *
   * The whole lifecycle, in one step. `stiggContext` here is the default for every call through
   * this client; any single call overrides it by putting its own `stiggContext` in the vendor's
   * parameters. The client you passed is never mutated, so it keeps working ungoverned.
   *
   * The vendor is recognised from the client's own shape and base URL rather than named; pass
   * `recipe` only for a vendor the built-ins cannot identify.
   *
   * Warms the entitlement cache before returning when the context names both a customer and an
   * entitlement, so the calls that follow read local state. Nothing is cached in this package -
   * see {@link GovernanceSession.warmUp} for which cache that is and when there is one at all.
   */
  wrap<T extends object, O extends ClientOptions>(
    client: T,
    options: O = {} as O,
  ): WrappedClient<T, O['stiggContext'], PathsOf<O['recipe'], T>> {
    // Started, not awaited. Resolving the engine is a probe over the network, and this is a setup
    // call that reads as instant - so the work begins here and the first call that needs an
    // engine waits on it. `init()` is there for anyone who wants that settled up front.
    //
    // The rejection has to be caught here, though, and that is not tidiness: nobody is holding
    // this promise, so a failed probe became an unhandled rejection - which Node treats as fatal
    // by default. A Stigg outage would have taken the application down at `wrap()`, before a
    // single call was made, which is the exact opposite of what a soft limit promises. Reported
    // through the application's own error channel instead; the first call that needs an engine
    // awaits the same promise and surfaces it again somewhere the caller can see it.
    void this.ensureStarted().catch((err: unknown) => this.reportStartupFailure(err));

    const recipe = options.recipe ?? this.clients.find(client);
    if (!recipe) {
      // Silently returning an unwrapped client would mean one that quietly meters nothing.
      throw new Error(
        `No client recipe matches this client. Known vendors: ${this.clients.vendors().join(', ') || 'none'}. ` +
          'Pass `recipe` to name an adapter for it.',
      );
    }

    const session = this.newSession(options.hooks);
    // Resolved and validated once, here, so a call that overrides nothing has nothing to do. A
    // client wrapped with no customer is legal - its calls each name their own, and the types say
    // so - so that one case resolves per call instead.
    const context = resolveContext(options.stiggContext ?? {}, randomUUID(), {
      requireCustomer: false,
      defaults: this.contextDefaults,
    });

    // Said once, at the boundary that owns the decision. A client that gates nothing looks exactly
    // like one that gates, right up to the call that should have been refused and was not - so
    // this is the only place the difference exists before it costs money. Only for a client that
    // is otherwise fully configured: one whose calls each name their own customer may well name
    // an entitlement too, and warning there would cry wolf on every wrap.
    if (context.customerId && !isEnforced(context)) {
      this.config.logger.warn(
        '[stigg] this client named no entitlement, so nothing is checked and no call can be ' +
          "refused - it meters only. Pass `entitlement: { currencyId: 'credits' }` in " +
          '`stiggContext`, at the wrap or on a call, to gate it.',
      );
    }

    const governed = wrapClient(client, recipe, session, context);
    this.attachGovernance(governed, session, context);
    // Not awaited: warming is an optimization, and it logs rather than throws.
    if (context.customerId) void session.warmUp(context);
    return governed as WrappedClient<T, O['stiggContext'], PathsOf<O['recipe'], T>>;
  }

  /**
   * Hangs the governance handle off the wrapped client. Refuses to overwrite a `stigg` the vendor
   * already has: silently replacing one of its own properties would be a worse surprise.
   */
  private attachGovernance(client: object, session: GovernanceSession, base: ResolvedContext): void {
    if ((client as { stigg?: unknown }).stigg !== undefined) {
      throw new Error(
        'This client already has a `stigg` property, so the governance handle has nowhere to go. ' +
          'Governance would be invisible on it, so this is refused rather than overwritten.',
      );
    }
    const resolve = (override?: StiggContext): ResolvedContext => {
      const merged = override ? overrideContext(base, override) : base;
      if (!merged.customerId) throw noCustomer();
      return merged;
    };

    const governance: ClientGovernance = {
      flush: () => session.drain(),
      close: async () => {
        await session.drain();
        this.sessions.delete(session);
      },
      summary: () => session.summary(),
      get lastDecision() {
        return session.lastDecision;
      },
      headers: (override) => session.headers(resolve(override)),
      check: (override, requestedUsage) => session.check(resolve(override), requestedUsage),
      report: (metrics, override) => session.ingestMetrics(resolve(override), metrics),
    };
    Object.defineProperty(client, 'stigg', { value: governance, enumerable: false });
  }

  /**
   * The gate, with no client to wrap - what a framework binding reaches for, and what the gateway
   * example checks with before it proxies.
   */
  async check(context: StiggContext, requestedUsage = 1): Promise<AccessDecision> {
    await this.ensureStarted();
    return this.standalone().check(
      resolveContext(context, randomUUID(), { defaults: this.contextDefaults }),
      requestedUsage,
    );
  }

  /** The meter, with no client to wrap. Metrics already in Stigg's own vocabulary. */
  async report(context: StiggContext, metrics: Metrics): Promise<IngestResult> {
    await this.ensureStarted();
    return this.standalone().ingestMetrics(
      resolveContext(context, randomUUID(), { defaults: this.contextDefaults }),
      metrics,
    );
  }

  /** The `x-stigg-*` attribution for work continuing in another process, with no client involved. */
  governanceHeaders(context: StiggContext): GovernanceHeaders {
    return this.standalone().headers(resolveContext(context, randomUUID(), { defaults: this.contextDefaults }));
  }

  /**
   * The policy a context falls back to when neither the call nor `wrap` named one.
   *
   * Both fields are always set - the config schema defaults them - so this is the one place a
   * constructor option becomes the behaviour of a call. Before it existed the options were parsed,
   * stored, and never read: every context fell through to the context module's own defaults, and a
   * client constructed with `checkErrorAction: 'deny'` failed open on every call it gated.
   */
  private get contextDefaults(): ContextDefaults {
    return { checkErrorAction: this.config.checkErrorAction, ingestMode: this.config.ingest };
  }

  private newSession(hooks?: SessionHooks): GovernanceSession {
    const session = new GovernanceSession({
      engine: () => this.ensureStarted().then((state) => state.engine),
      logger: this.config.logger,
      onError: this.config.onError,
      hooks: hooks ?? {},
    });
    this.sessions.add(session);
    return session;
  }

  /** The session the no-client paths share, built on first use so an unused SDK builds none. */
  private standalone(): GovernanceSession {
    this.loose ??= this.newSession();
    return this.loose;
  }

  /**
   * Returns the decision when `err` is a governance refusal, so a catch block is one line and the
   * caller needs no import to tell a denial from a real failure.
   */
  denial(err: unknown): AccessDecision | undefined {
    return isAccessDenied(err);
  }

  /**
   * The gateway side of the split lifecycle: ingest usage a proxy observed, attributed from the
   * headers the application sent with the request. Ingest only - a gateway sees requests, not
   * runs, so there is nothing here to check against.
   */
  async ingestFromHeaders(
    headers: Record<string, string | string[] | undefined>,
    input: IngestContext & {
      usage: unknown;
      idempotencyKey: string;
      /** This report's outcome, including a failed one. The gateway's stand-in for a run hook. */
      onIngest?: (result: IngestResult) => void;
    },
  ): Promise<IngestResult> {
    const { idempotencyKey } = input;
    const mode = input.ingest ?? this.config.ingest;
    // Filled in once the headers are read, and reported with every failure after that. Declared
    // out here rather than parsed earlier because the checks below are ordered deliberately - an
    // empty idempotency key is the first thing rejected - so a failure that happens before the
    // headers are read truthfully carries no attribution, because at that point there is none.
    let attribution: ParsedGovernanceHeaders | undefined;
    // The hook is the application's own code and a gateway has no run to fall back on, so it is
    // run the way `RunHandle` runs its own: a throw from it is reported, never returned.
    const notify = (result: IngestResult) =>
      safely(
        () => input.onIngest?.(result),
        (err) => this.reportIngestFailure(asIngestError(err), idempotencyKey, attribution),
      );
    const failed = (error: EngineError): IngestResult => {
      this.reportIngestFailure(error, idempotencyKey, attribution);
      const result: IngestResult = {
        ok: false,
        // What the error carried, not an assumption of nothing. An ingest is up to two calls -
        // the features, then the wallet - so a rejection on the second leaves the first one's
        // spend at Stigg. `asEngineError` preserves that; hardcoding `{}` here threw it away, and
        // a gateway reading this result would retry work that was already billed.
        reported: error.reported ?? {},
        idempotencyKey,
        mode,
        replayed: error.replayed ?? false,
        error,
      };
      notify(result);
      return result;
    };

    // Everything is inside the failure path, the mapper and the engine's own resolution included.
    // This call is documented to answer rather than throw, and "the usage mapper threw" is not a
    // different kind of event from "the report did" to whoever is holding the request.
    try {
      if (!idempotencyKey) {
        // The gateway's request id is what deduplicates its retries. An empty one is not a key,
        // and read as absent it bills every retry again.
        throw new EngineError('ingest', 'idempotencyKey must not be empty - use the gateway request id');
      }
      await this.ensureStarted();
      // The proxy observed someone else's response, so the vendor has to be named rather than
      // guessed: raw names read off the wrong shape would report to the wrong features entirely.
      const measurement = observedMeasurement(input.usage, input.vendor);
      const metrics = (input.metrics ?? vendorMetrics)(measurement);

      attribution = parseGovernanceHeaders(headers);
      if (!attribution) {
        throw new EngineError('ingest', 'request carries no governance headers - nothing to attribute usage to');
      }

      // The same split `reportMetrics` makes: a metric named after the currency this ingest
      // draws on goes to the wallet, which takes fractions, and everything else to the usage
      // report, which does not.
      const entitlement = input.entitlement ?? DEFAULT_WALLET;
      const creditCurrencyId = entitlementKind(entitlement) === 'credit' ? entitlementId(entitlement) : undefined;

      // Whether this proxied call names an agent, read from the header the sending side sets
      // rather than guessed from the dimensions. The map arrives flat, so `{ region: 'eu' }`
      // looks exactly like an attribution key from here - and rounding on that would overcharge a
      // wallet draw with no entity behind it. See `wholeUnitsForGovernance`.
      const attributed = !!attribution.attributionKey;

      const sendable: Metrics = {};
      for (const [featureId, rawValue] of Object.entries(metrics)) {
        const drawsWallet = featureId === creditCurrencyId;
        const value = attributed && drawsWallet ? wholeUnitsForGovernance(rawValue) : rawValue;
        // A gateway maps someone else's usage object with someone else's mapper, so it is the
        // path most likely to produce a value that is not a measurement at all.
        const invalid = usageValueError(value, mode, drawsWallet);
        if (invalid) throw invalid;
        if (value > 0 || mode === 'async') sendable[featureId] = value;
      }

      // Zero-token turns are normal (a cached refusal, an empty stream); they are not an error,
      // and they are still an ingest an observer asked to be told about.
      if (!Object.keys(sendable).length) {
        const noop: IngestResult = { ok: true, reported: {}, idempotencyKey, mode, replayed: false };
        notify(noop);
        return noop;
      }

      const reported = await this.engine.report(attribution.customerId, {
        metrics: sendable,
        entitlement,
        mode,
        // What the proxy observed, as the proxy received it. There is no recipe out here, so the
        // block is whatever `observedMeasurement` could make of the usage object it was handed.
        raw: mode === 'async' ? flattenRaw(measurement.raw) : undefined,
        dimensions: attribution.dimensions,
        idempotencyKey,
        // No wrapped call to take a name from out of process, so the caller names it - or the
        // vendor it declared does, which is the closest thing to the call that actually happened.
        event: input.event ?? { name: input.vendor ? `${input.vendor}.proxied` : DEFAULT_EVENT_NAME },
      });
      // Delivered. The hook runs on the settled result, so instrumentation cannot turn a report
      // that landed into one that reads as failed.
      const result: IngestResult = {
        ok: true,
        reported: reported.reported,
        idempotencyKey,
        mode: reported.mode,
        replayed: reported.replayed,
        creditsConsumed: reported.creditsConsumed,
      };
      notify(result);
      return result;
    } catch (err) {
      return failed(asIngestError(err));
    }
  }

  /**
   * A probe that failed with nobody waiting on it.
   *
   * `wrap()` returns before the engine resolves, so this is the one path where a startup failure
   * has no caller to reject towards. Swallowing it silently would leave a client that looks
   * governed and cannot check; letting it reject unobserved ends the process.
   */
  private reportStartupFailure(err: unknown): void {
    const error = asEngineError('start', err);
    safely(
      () => this.config.onError(error, { operation: 'start' }),
      (reportErr) =>
        this.config.logger.warn(`[stigg] onError threw while reporting ${error.message}: ${String(reportErr)}`),
    );
  }

  /** `onError` is the application's too, and there is nowhere left to report its failure to. */
  private reportIngestFailure(
    error: EngineError,
    idempotencyKey?: string,
    attribution?: ParsedGovernanceHeaders,
  ): void {
    safely(
      () =>
        this.config.onError(error, {
          operation: 'ingest',
          idempotencyKey,
          // The request said which run and which customer it was for. An ingest that fails out
          // here is the one case where nobody is holding a `RunHandle` to ask, so dropping them
          // leaves the failure attached to a request id and nothing else.
          runId: attribution?.runId,
          customerId: attribution?.customerId,
        }),
      (err) => this.config.logger.warn(`[stigg] onError threw while reporting ${error.message}: ${String(err)}`),
    );
  }

  /**
   * Drains every wrapped client's in-flight ingests. Explicit because an exit hook does not fire
   * in a request-scoped or serverless runtime.
   *
   * A single client drains on its own with `client.stigg.flush()`; this is the process-wide one,
   * for a shutdown that does not know which clients exist.
   */
  async flush(options: { close?: boolean } = {}): Promise<SessionSummary[]> {
    const summaries = await Promise.all([...this.sessions].map((session) => session.drain()));
    if (options.close) await this.close();
    return summaries;
  }

  /**
   * Builds the engine once, on first need. Concurrent callers share the same attempt.
   *
   * A *failed* attempt is shared too, but only for {@link RETRY_START_AFTER_MS}. A rejected
   * promise is still a promise, so memoizing one unconditionally outlives the failure that caused
   * it: under the default `checkErrorAction: 'allow'` the process stops enforcing any budget at
   * all, and under `'deny'` it refuses every call - neither saying anything a log would show.
   *
   * Holding the failure briefly rather than discarding it on sight is the other half: callers
   * inside the window get the same rejection immediately and their own `checkErrorAction` decides
   * the outcome, so an outage is re-probed on a timer instead of once per request.
   */
  private ensureStarted(): Promise<{ engine: GovernanceEngine; resolution: EngineResolution }> {
    if (this.startFailedAt !== undefined && Date.now() - this.startFailedAt >= RETRY_START_AFTER_MS) {
      this.started = undefined;
      this.startFailedAt = undefined;
    }

    if (!this.started) {
      const attempt = createGovernanceEngine({
        apiKey: this.config.apiKey,
        baseUrl: this.config.baseUrl,
        timeoutMs: this.config.timeoutMs,
        cache: this.config.cache,
        client: this.config.client,
        logger: this.config.logger,
      }).then((state) => {
        this.engineState = state;
        this.config.logger.info(`[stigg] ${describeResolution(state.resolution)}`);
        return state;
      });
      this.started = attempt;

      // Checked against the attempt that failed, not just set: a late rejection from an attempt
      // already replaced would otherwise expire the newer one that succeeded.
      attempt.catch(() => {
        if (this.started === attempt) this.startFailedAt = Date.now();
      });
    }

    // `wrap` starts this and does not await it, so between a failing probe and the first call
    // there is a rejected promise nobody is holding - which Node treats as an unhandled rejection
    // and ends the process over. Marked handled here; it changes nothing for an awaiter, because
    // attaching a handler does not consume the rejection. Same reason `wrap-client` does it to
    // the promise behind a gated call.
    this.started.catch(() => undefined);
    return this.started;
  }
}

/** Whatever went wrong on the way to a report, as the seam's own error. */
function asIngestError(err: unknown): EngineError {
  return err instanceof EngineError ? err : new EngineError('ingest', String(err), { cause: err });
}

/**
 * The metadata an entity is described by, refused rather than carried when it is not that.
 *
 * Two readers need it to be a flat record of strings and neither says so when it is not: the memo
 * fingerprints it with `JSON.stringify`, which throws a bare `TypeError` on anything cyclic, and
 * the upsert sends it on to Stigg, which rejects the write one network hop later. A value the
 * caller can see in their own argument is worth more than either.
 */
function describableMetadata(agentId: string, metadata: unknown): Record<string, string> | undefined {
  if (metadata === undefined || metadata === null) return undefined;
  const entries = typeof metadata === 'object' && !Array.isArray(metadata) ? Object.entries(metadata) : undefined;
  const offender = entries?.find(([, value]) => typeof value !== 'string');
  if (!entries || offender) {
    throw new Error(
      `Agent ${agentId} was given metadata that is not a record of strings` +
        `${offender ? ` - \`${offender[0]}\` is a ${typeof offender[1]}` : ''}. ` +
        'Stigg stores entity metadata as strings; convert the values before passing them.',
    );
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
