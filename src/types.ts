/**
 * The vocabulary shared by the core, the engines and every binding, and the argument list of
 * every call on the public surface.
 *
 * Terms follow Stigg governance rather than the draft design notes: provision/archive (not
 * register/de-register), ingest (not report), assignment (not budget), dimensions (not tags).
 *
 * The imports below are all `import type`, so they are erased at compile time: this file pulls in
 * no module at runtime and stays the leaf everything else can depend on.
 */
import { EngineError } from './errors';
import type { StiggContext } from './core/context';
import type { SessionSummary, SessionHooks } from './core/session';
import type { GovernanceHeaders } from './headers';
import type { ClientRecipe } from './bindings/client/core/types';
import type { ObservedVendor } from './bindings/shared/token-usage';
import type { EventIngest } from './engine/engine';

/**
 * What a budget is measured against. Exactly one of the two - the same mutual exclusion the
 * Stigg check endpoint enforces, expressed so the compiler catches it instead of the API.
 */
export type Entitlement = { currencyId: string; featureId?: never } | { featureId: string; currencyId?: never };

/**
 * Which of Stigg's two ingest APIs a run reports through.
 *
 * `'sync'` is `usage.report`/`reportUsageBulk`: a fixed DTO of `featureId` and a whole-number
 * `value` per metric, aggregated the moment it lands, so the next check sees it. It costs more
 * latency and has the lower rate limit.
 *
 * `'async'` is `events.report`/`reportEvent`: the call is reported as one event and Stigg's own
 * meters turn it into usage, seconds later. Low latency, a far higher rate limit, and nothing
 * meters at all until a **raw-events meter** is configured for the event name on Stigg's side.
 */
export type IngestMode = 'sync' | 'async';

/** The id to send as `featureId`/`currencyId`, whichever kind the entitlement is. */
export const entitlementId = (entitlement: Entitlement): string => entitlement.currencyId ?? entitlement.featureId;

/** 'credit' targets read the customer's credit pool; 'feature' targets need an entitling subscription. */
export const entitlementKind = (entitlement: Entitlement): 'credit' | 'feature' =>
  entitlement.currencyId ? 'credit' : 'feature';

/**
 * The entitlement as every Stigg endpoint takes it: one of two mutually exclusive id fields,
 * ready to spread.
 *
 * ```ts
 * await client.v1Beta.customers.entitlements.check(customerId, { ...entitlementRef(entitlement), requestedUsage });
 * ```
 *
 * Narrowing on the property rather than through {@link entitlementKind} is the point: a function
 * call cannot narrow a union, so every hand-written version of this needed a `!` on each branch -
 * an assertion that the union already guarantees and that would survive the union changing.
 */
export const entitlementRef = (entitlement: Entitlement): { currencyId: string } | { featureId: string } =>
  entitlement.currencyId !== undefined ? { currencyId: entitlement.currencyId } : { featureId: entitlement.featureId };

/**
 * Why an entitlement cannot be billed against, if one was named at all.
 *
 * Naming none is legal: it is how a caller asks for metering without enforcement, so undefined is
 * not an error here. The one place an entitlement is genuinely required is an assignment, which is
 * written over `(entity x entitlement)` - and `register` refuses that case itself, because only it
 * knows the agent to name in the message.
 *
 * What stays refused is an entitlement that is named and names nothing. The union permits
 * `{ currencyId: '' }`, and an empty currency is falsy - so it classifies as a feature and every
 * branch downstream then asks for a `featureId` that is not there. An empty id is a typo rather
 * than an intention, and letting it through meters a run against nothing while it still looks
 * enforced.
 */
export function entitlementError(entitlement: Entitlement | undefined): Error | undefined {
  if (!entitlement) return undefined;
  if (entitlementId(entitlement)?.trim()) return undefined;
  return new Error('a run needs a non-empty currencyId or featureId - an empty one bills against nothing.');
}

/**
 * A provider-neutral token measurement. Every client/orchestrator binding normalizes into this
 * before anything touches Stigg, so the mapper below is written once for all of them.
 */
export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /**
   * What the vendor says the call cost in total, when it says anything.
   *
   * Apart from the four above, and deliberately so: those are disjoint and add up to the call,
   * while this one *overlaps all of them*. It is here because a mapper that wants one number
   * should be able to use the vendor's own rather than re-adding the parts and hoping the
   * arithmetic matches - the two can differ, and when they do the vendor's is the one that gets
   * invoiced.
   *
   * Read from the response where the vendor publishes a total, and summed from the four where it
   * publishes none and they are disjoint. Undefined where neither is true, which is the honest
   * answer rather than a guess: see `COMPUTED_TOTALS`.
   */
  total?: number;
};

export const emptyTokenUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });

/**
 * What one completed call reports: feature id -> whole-number value. One report each.
 *
 * A record rather than a list of `{featureId, value}` pairs, so the same feature cannot appear
 * twice - two reports of one feature in one call would collide on idempotency keys and silently
 * lose one of them.
 */
export type Metrics = Record<string, number>;

/**
 * Turns what a binding observed into the metrics to report.
 *
 * Defaults to the vendor's own: whatever names and values came back on the response. Supply your
 * own to report something else - see `unitsPerTokens` for the one-number case, and each client
 * recipe for what that vendor meters by default.
 */
export type MetricsMapper = (measurement: Measurement) => Metrics;

/**
 * What one completed call is worth, as the binding that observed it saw it.
 *
 * Two views of one call, and both are useful. `metrics` is what the vendor said, in the vendor's
 * own words - reported as-is, so what lands in Stigg reconciles against what the vendor bills.
 * `usage` is the same call flattened into four comparable counters, which is what a mapper writes
 * against when it wants one number or one vocabulary across vendors.
 */
export type Measurement = {
  /** The vendor's own field names and values, verbatim. What gets reported by default. */
  metrics?: Metrics;
  /** The same call, normalized and non-overlapping. Context for writing your own mapper. */
  usage?: TokenUsage;
  /**
   * The vendor's usage object as it arrived, before any counter was picked out of it.
   *
   * Carried only so an event can state what the vendor said in full - it rides the event's
   * dimensions under a `raw.` prefix, flattened to scalars, and a meter can then aggregate a
   * counter this SDK does not know about yet. Never reported as a metric: a feature id has to be
   * something the customer's catalog knows, and a vendor's changelog must not be able to invent
   * one. The usage block only - never a response body, so no prompt or completion text leaves
   * the process.
   */
  raw?: Record<string, unknown>;
  /** Per-call attribution, merged over the run's own dimensions. e.g. the model that served. */
  dimensions?: Record<string, string>;
  /**
   * Set when a counter here is this SDK's estimate rather than something the vendor stated.
   *
   * Only one thing sets it today: a stream the consumer abandoned. Anthropic states the output
   * count on the event that ends the stream, so a reply stopped halfway never states one - and
   * reporting nothing for text the customer read, and the vendor billed, is a hole rather than a
   * conservative answer.
   *
   * Carried on the measurement rather than folded into a dimension so it reaches the run's
   * `usageMapper`, which is what makes it a decision rather than a surprise: a mapper that would
   * rather bill nothing than bill an estimate can branch on this and return `{}`.
   */
  estimated?: true;
  /** The vendor's own request id, when it has one that is stable across its retries. */
  idempotencyKey?: string;
  /**
   * Why this measurement does not cover everything the vendor billed, when it does not.
   *
   * For the case where usage exists that the response never carried - not a disagreement between
   * two numbers the vendor gave, which is data the caller can judge for themselves, but work
   * that was charged for and never reported. What is here is still ingested: a short measurement
   * beats none. The reason is then raised through the same channel a failed read uses, so
   * `onError` fires and `summary().ingestFailures` counts it, rather than the shortfall being
   * something a reader of the docs was supposed to have known about.
   */
  incomplete?: string;
};

/** What a run reports when nobody says otherwise: exactly what the vendor stated. */
export const vendorMetrics: MetricsMapper = (measurement) => measurement.metrics ?? {};

/** A binding may report either shape; `TokenUsage` is the common case and stays terse. */
export const toMeasurement = (value: TokenUsage | Measurement): Measurement =>
  'input' in value ? { usage: value } : value;

/**
 * The amount to report when this run is attributed to a governance entity.
 *
 * Governance counts in whole units and cannot be made to count otherwise from here: its ingest
 * schema is `z.number().int()`, and the counter behind it is a Redis `HINCRBY`, which takes an
 * integer delta. A fractional amount is rejected at that boundary - the wallet still moves, the
 * per-entity counter does not, and nothing in the response says so. An agent's budget silently
 * stops advancing while its spend carries on.
 *
 * So an attributed run rounds up, and only an attributed run: a run that names no entity reports
 * what its mapper produced, because the wallet takes fractions and nothing downstream of it
 * counts in whole units.
 *
 * Rounding *up* rather than to nearest, because a call that happened must cost something: at any
 * sane denomination most calls are worth less than one unit, and rounding to nearest would bill
 * nothing for nearly all of them.
 *
 * TODO: delete this, and the call sites that use it, once governance counts fractional usage.
 * The platform fix is to scale internally - store micro-units and accept fractions at the API
 * boundary - which keeps `HINCRBY` working and is the only way an agent budget can be
 * denominated finely enough to price a call worth a tenth of a cent. Until then this is a
 * deliberate overcharge on small calls, which is why it is announced rather than silent.
 */
export const wholeUnitsForGovernance = (value: number): number => Math.ceil(value);

/**
 * Why a measured value cannot be reported, if it cannot.
 *
 * Zero is not an error - a cached refusal or an empty stream is a normal turn - but a mapper
 * dividing by an unset config returns NaN or Infinity, and reading those as "nothing was used"
 * meters the run at zero while every call still reports success. Those are refused everywhere.
 *
 * A fraction is refused on one path only, and the rule is the endpoint's rather than this SDK's:
 *
 * - **The wallet** takes them. `credits.consumption.consume` and its async twin accept a
 *   fractional `amount`, and balances are fractional too - which they have to be, or a currency
 *   could never be denominated finely enough to price a call worth a tenth of a cent.
 * - **An event** takes them. The number rides as a dimension and a meter sums what it finds,
 *   which is the only way a gateway's `cost` reports honestly.
 * - **The usage report** does not: `POST /api/v1/usage` answers
 *   `400 Expected integer, received float`. That is the one case refused here, where the caller
 *   can still see which metric it was - metering failures are swallowed into `onError`, so a 400
 *   three frames down is a silent gap rather than an error anyone reads.
 *
 * Shared, because every path that reports usage has to answer this the same way.
 */
export function usageValueError(
  value: number,
  mode: IngestMode = 'sync',
  // Whether this metric draws the credit wallet rather than reporting a feature. The wallet takes
  // fractions in both modes, so what the ingest mode decides does not apply to it.
  drawsWallet = false,
): EngineError | undefined {
  if (!Number.isFinite(value) || value < 0) {
    return new EngineError('ingest', `usage value must be a finite non-negative number, got ${value}`);
  }
  if (mode === 'async' || drawsWallet || Number.isInteger(value)) return undefined;
  return new EngineError(
    'ingest',
    `usage value must be a whole number to report against a feature, got ${value}. The usage ` +
      'report takes integers; a credit currency takes fractions, and so does an event under ' +
      "`ingest: 'async'`.",
  );
}

/**
 * One metric, summed from every token class and divided by the unit size.
 *
 * The mapper for an application that prices tokens itself. Named for what it produces - units
 * under an id - rather than for credits, because it does not deduct any: it reports a number, and
 * that number draws the wallet only when the id happens to name a credit currency. Which it is
 * decides the whole ingest path, so a mapper that claimed to know was the wrong place to look.
 *
 * **Prefer reporting the raw counters and converting in Stigg.** A consumption mapping on the plan
 * does the same arithmetic where a pricing change does not need a deploy, and it is the only place
 * that can weight cache reads cheaper. Reach for this when the application deliberately prices
 * itself.
 *
 * The division is reported as it comes out. A credit currency takes fractions, so a call worth
 * four fifths of a unit costs four fifths of one - rounding it up here would be this SDK's
 * arithmetic on someone else's price. A **feature** is the exception: `POST /api/v1/usage` takes
 * integers, so pick a `tokensPerUnit` that divides, or round in your own mapper.
 *
 * @param id The Stigg feature id or credit currency id to report under.
 * @param tokensPerUnit How many tokens make one unit.
 */
export const unitsPerTokens =
  (id: string, tokensPerUnit = 1): MetricsMapper =>
  ({ usage }) =>
    usage ? { [id]: (usage.input + usage.output + usage.cacheRead + usage.cacheCreate) / tokensPerUnit } : {};

/** What the caller should do about a denial. A refusal is a commercial event, not an error. */
export type Remedy = 'top-up' | 'raise-budget' | 'subscribe' | 'retry';

/**
 * Which client answered, or - for 'cache', 'policy' and 'unenforced' - that nothing was asked.
 *
 * `'unenforced'` is the one that could not have been asked: the run named no entitlement, so there
 * is no budget to consult and every decision it hands back is an allow.
 */
export type DecisionSource = 'rest' | 'node-sdk' | 'cache' | 'policy' | 'unenforced';

/**
 * The structured refusal. Returned, never thrown, everywhere the caller has a return path:
 * the denial path is a revenue surface (top-up, upgrade), so it must be inspectable.
 */
export type AccessDecision = {
  hasAccess: boolean;
  /** Which entity blocked - a governance node, or the customer when governance is not in play. */
  deniedBy?: string;
  /**
   * Why it was refused. Stigg's `accessDeniedReason` verbatim, except where `locallyDerived` says
   * the SDK reached the verdict itself. `InsufficientCredits` and `BudgetExceeded` differ.
   */
  reason?: string;
  remedy?: Remedy;
  /** Tightest remaining budget across the pool and the chain. Undefined when nothing is bounded. */
  remaining?: number;
  usageLimit?: number | null;
  currentUsage?: number;
  source: DecisionSource;
  checkedAt: number;
  /** True when the engine served this from its own fallback rather than live state. */
  isFallback?: boolean;
  /**
   * True when the SDK decided this rather than Stigg. A credit check reads the balance and
   * compares it against the requested amount here, because the credit read takes no requested
   * usage to adjudicate - so the balance is Stigg's, and the refusal is the SDK's.
   *
   * Distinct from `isFallback`: that one says the state was stale, this one says the state was
   * live and the arithmetic was ours. Both can be true, and `strictCheck: false` on the engine's
   * capabilities is the same admission at the level above.
   */
  locallyDerived?: boolean;
  /** One line for a log: every field that matters, already formatted. */
  summary: string;
  /** What to tell the user. A refusal is a commercial event, so it carries its own remedy. */
  message: string;
};

/**
 * The outcome of one ingest - which is now one report per metric, so the result is per metric too.
 * Never a rejection: metering must not break the caller's run.
 */
export type IngestResult = {
  /** True only when every metric landed. One failure among four is not a success. */
  ok: boolean;
  /** What was reported, by feature id. Empty when the call measured nothing at all. */
  reported: Metrics;
  /**
   * The key the report deduped on. Under `'sync'` each metric is keyed
   * `${idempotencyKey}:${featureId}`, so they dedupe independently; under `'async'` the whole
   * turn is one event under this key alone.
   */
  idempotencyKey: string;
  /** Which API this went through, because the two answer with different amounts of truth. */
  mode: IngestMode;
  /**
   * Stigg reported nothing consumed for every metric: these keys were already ingested.
   * **Undefined under `'async'`** - the event API answers with an empty body, so a replay is
   * something Stigg does and the SDK cannot observe. Saying `false` would be a claim, not a fact.
   */
  replayed?: boolean;
  /**
   * Credits this report actually drew, when Stigg said so. Absent when the features reported are
   * not credit-backed - which is also when the run's budget will never drain - and always absent
   * under `'async'`, which returns no balance at all.
   */
  creditsConsumed?: number;
  error?: unknown;
};

/**
 * What a check resolves to when the engine could not answer it. A policy, not a notification:
 * hooks are told what happened and cannot change it, while this decides the outcome. Ingest has
 * no equivalent - a failed ingest never affects a run, it only reaches `hooks.onError`.
 */
export type CheckErrorAction = 'deny' | 'allow';

// ---------------------------------------------------------------------------------------------
// The client surface.
//
// `wrap(client, clientOptions)` is the only step. What governs a call - {@link StiggContext} -
// is given there as the default for every call through that client, and again inside any single
// call's params to override it. There is no run to open, so there is nothing to keep in sync
// between a setup step and a call site.
// ---------------------------------------------------------------------------------------------

/** What binding a vendor client needs: how to recognise it, what to watch, and what governs it. */
export type ClientOptions = {
  /**
   * Use this adapter instead of matching the client by its shape and base URL. The built-in ones
   * cover Anthropic, OpenAI, OpenRouter and LiteLLM; reach for this when a vendor none of them
   * identifies needs one of its own.
   */
  recipe?: ClientRecipe;
  /** Everything this client reports back while it works. See {@link SessionHooks}. */
  hooks?: SessionHooks;
  /** The default context for every call through this client. Any call may override it. */
  stiggContext?: StiggContext;
};

/**
 * `register` - giving an agent an identity, a budget, and a place in the tree.
 *
 * A write, which is why it is its own call rather than something a gated call carries: a limit is
 * not a field on the entity, so this is two idempotent upserts underneath - the entity, then an
 * assignment over `(entity x entitlement)`. That is also why `parentId` belongs here and not on
 * the entity: the hierarchy is per-entitlement.
 *
 * Optional throughout. Skip it and the agent has no entity - calls still work, and checks and
 * usage apply to the customer instead.
 */
export type AgentOptions = {
  /** The durable agent. This is the entity budgets attach to. */
  agentId: string;
  /**
   * The governance entity type to create the agent as. Required, and not defaulted: a guessed
   * type pairs the agent with an attribution key nothing resolves, and the spend then lands on
   * the customer looking exactly like a call that was never governed.
   */
  entityTypeId: string;
  displayName?: string;
  metadata?: Record<string, string>;
  /**
   * What this agent may spend, and where it sits in the tree. Omit it and `register` writes an
   * identity and nothing else.
   *
   * Grouped rather than flat because these five are one write underneath - an assignment over
   * `(entity x entitlement)` - while the fields above are the entity. See {@link AgentBudget}.
   */
  budget?: AgentBudget;
};

/**
 * What an agent may spend, as the one write it actually is.
 *
 * Grouped because these are one write underneath - an assignment over `(entity x entitlement)` -
 * while the fields beside them describe the entity. The grouping is what makes two illegal
 * combinations unrepresentable: `apply` is one field, so there is no way to ask for both budget
 * modes, and `entitlement` is required, so there is no way to write a limit against nothing.
 *
 * `parentId` lives here rather than on the entity because the hierarchy is **per-entitlement**:
 * an agent can sit under one parent for one budget and elsewhere for another.
 */
export type AgentBudget = {
  /**
   * Which entitlement the budget is written against - a credit currency or a metered feature.
   *
   * Required, because an assignment is written over `(entity x entitlement)`: a limit with
   * nothing to write it against has nowhere to land.
   */
  entitlement: Entitlement;
  /** ISO-8601 single-unit reset window, e.g. 'P1M'. Governance requires it when creating a budget. */
  cadence?: string;
  /** Places the agent under a parent entity. Tri-state: omit to leave it, null to make it a root. */
  parentId?: string | null;
} & (
  | {
      /** The limit, written on every call. `null` clears whatever is assigned. */
      limit?: number | null;
      /** Writes the limit every time. The default. */
      apply?: 'always';
    }
  | {
      /** The limit to seed with. Not nullable: there is nothing to clear on an agent being created. */
      limit: number;
      /**
       * Writes the limit only when this agent has no assignment yet.
       *
       * Reach for it when an admin may change the budget out of band - `'always'` would overwrite
       * their change on every process start.
       */
      apply: 'on-create';
    }
);

export type AgentScope = {
  /** The tenant. Every governance call is scoped to one customer. */
  customerId: string;
};

/** `register` - the standalone call, which has no run to take the scope from. */
export type RegisterInput = AgentOptions & AgentScope;

/** `deregister` - archiving the entity. No entitlement: an entity is not archived per-entitlement. */
export type DeregisterInput = Pick<AgentScope, 'customerId'> & Pick<AgentOptions, 'agentId'>;

/**
 * Every property path the shipped recipes gate, written as the overlay walks it.
 *
 * Paths, not leaf names. The extra field has to appear in the vendor's own parameter type or an
 * object literal carrying it is an excess-property error - but matching on the last segment alone
 * also typed `stiggContext` onto every *other* method that happened to share the name. `create` is
 * the common one: `openai.files.create` and `openai.batches.create` are not gated by any recipe,
 * so a caller who passed a context there type-checked, was never checked, and handed the vendor an
 * unknown field it would forward rather than strip - the exact harm the narrow list existed to
 * prevent.
 *
 * `messages.stream` is here without being in any recipe's `methods`: it reaches the wire through
 * the gated `messages.create`, so a context given to it does arrive.
 */
export type GatedPath =
  | ['messages', 'create']
  | ['messages', 'stream']
  | ['chat', 'completions', 'create']
  | ['responses', 'create']
  | ['systemOne']
  | ['models', 'generateContent']
  | ['models', 'generateContentStream']
  // Mistral's eight. Two segments each, and the first segment is a namespace rather than the
  // method, so none of these claims a bare verb the way a one-segment path would.
  | ['chat', 'complete']
  | ['chat', 'stream']
  | ['chat', 'parse']
  | ['chat', 'parseStream']
  | ['fim', 'complete']
  | ['fim', 'stream']
  | ['agents', 'complete']
  | ['agents', 'stream'];

/**
 * Gemini's conversational surface, which is wrapped as an object in its own right: a `Chat` holds
 * the models module privately, so wrapping the client never reaches these. The paths are one
 * segment long because the `Chat` *is* the client there.
 *
 * Kept OUT of {@link GatedPath} and reached only through {@link ChatOf}, because one segment is
 * the whole path here and `sendMessage` is far too common a verb to claim globally. In the
 * fallback list it typed `stiggContext` onto any client that happened to have one - a Slack
 * client, a queue client - and on a client that some *other* recipe matched, that was the silent
 * case the narrow list exists to prevent: `wrap` succeeded, the method was never gated, and the
 * context object was forwarded to the vendor as an unknown field.
 */
export type ChatGatedPath = ['sendMessage'] | ['sendMessageStream'];

/**
 * Ollama's two, kept out of {@link GatedPath} for exactly the reason `sendMessage` is.
 *
 * The client is flat - `chat` and `generate` are methods on it, with no namespace to make them
 * distinctive - and those are among the most common verbs a client object can have. In the
 * fallback list they would type `stiggContext` onto any object with a `chat(...)` method at all,
 * on clients no recipe matches, which is the silent case that list exists to prevent: `wrap`
 * succeeds, the method is never gated, and the context object is forwarded to the vendor as an
 * unknown field. Reached only through {@link ChatOf}, keyed on all three markers
 * `ollamaRecipe.matches` requires.
 */
export type OllamaGatedPath = ['chat'] | ['generate'];

/**
 * Databricks' first-party client, whose whole surface is `query`. Out of {@link GatedPath} for the
 * same reason as the two above, and more urgently: `query` is not merely a common method name, it
 * is the one every database client in the ecosystem already owns. In the fallback list it would
 * type `stiggContext` onto a `pg`, `mysql2`, Snowflake or BigQuery client - objects no recipe
 * matches - and that context would be forwarded to the driver as an unknown field.
 */
export type DatabricksGatedPath = ['query'];

/**
 * The paths to overlay when no recipe was named, given what the client actually looks like.
 *
 * `getHistory` is the discriminator, and it is exactly what `geminiChatRecipe.matches` requires -
 * so the types promise a context on precisely the methods the runtime will gate, rather than on
 * every object with a method of that name.
 */
/**
 * The shapes the registry matches *before* it ever reaches the chat recipe.
 *
 * `geminiChatRecipe` is last in the shipped list, so any of these wins - which means a client
 * carrying one of them has its chat methods left unpatched however chat-shaped it also looks.
 */
type GatedVendorShape =
  | { messages: { create: unknown } }
  | { chat: { completions: { create: unknown } } }
  | { responses: { create: unknown } }
  | { models: { generateContent: unknown } }
  | { models: { generateContentStream: unknown } }
  | { chat: { complete: unknown } }
  | { systemOne: unknown };

/**
 * Which paths to overlay when no recipe was named, given what the client looks like.
 *
 * `getHistory` is the discriminator, and it is what `geminiChatRecipe.matches` requires - so the
 * types promise a context on the methods the runtime will gate rather than on every object with
 * a method of that name.
 *
 * It is not enough on its own, though. A client carrying *both* a gated vendor's shape and a
 * chat's is matched as that vendor, leaving `sendMessage` unpatched - and an overlay keyed on
 * `getHistory` alone still invited a context onto it, which is never checked and is handed to
 * the vendor as an unknown field. So anything the registry would claim first is excluded here,
 * mirroring that precedence.
 */
export type ChatOf<T> = T extends GatedVendorShape
  ? GatedPath
  : // Ollama, recognised by the same three markers its recipe requires rather than by `chat`
    // alone. Ahead of the chat arm only to mirror the registry's own order; the two shapes share
    // no marker, so neither can claim the other's client.
    T extends OllamaShape
    ? GatedPath | OllamaGatedPath
    : T extends DatabricksQueryShape
      ? GatedPath | DatabricksGatedPath
      : T extends { getHistory: (...args: any[]) => any }
        ? GatedPath | ChatGatedPath
        : GatedPath;

/**
 * What `databricksRecipe.matches` looks for, as near as a type can get - and the gap is the point.
 *
 * The runtime guard is `query` **plus** a `userAgent` naming the Databricks SDK. That second
 * marker cannot be written here: `userAgent` is declared `private` in the client's `.d.ts`, and a
 * `private` member makes a class non-assignable to any structural type naming it. So unlike
 * {@link OllamaShape}, which mirrors its matcher exactly, this keys on the one thing the client
 * does publish - the shape of what `query` resolves to.
 *
 * That still discriminates, which was checked rather than assumed: `QueryEndpointResponse` has no
 * required property, so a target of all-optional fields would normally be a weak type that
 * anything satisfies - but a `pg` or Snowflake result shares *none* of these names, and TypeScript's
 * weak-type rule rejects exactly that case. `created?: bigint` is the field doing most of the work;
 * nothing else in the ecosystem returns a bigint timestamp beside a `servedModelName`.
 *
 * The residual gap is a `query` typed as `Promise<any>`, which matches everything by construction.
 * That costs a context offered on a method the runtime will decline to gate - the type is wider
 * than the matcher, never narrower, so nothing is gated that was not typed.
 */
type DatabricksQueryShape = {
  query: (...args: any[]) => Promise<{
    servedModelName?: string | undefined;
    predictions?: unknown;
    created?: bigint | undefined;
  }>;
};

/** What `ollamaRecipe.matches` looks for, as a type. Kept in step with it by hand. */
type OllamaShape = {
  chat: (...args: any[]) => any;
  generate: (...args: any[]) => any;
  ps: (...args: any[]) => any;
};

/**
 * The paths still live after stepping through `K`, or `never` when that key leads nowhere gated.
 *
 * This is what bounds the walk: recursion follows the paths themselves, so there is no depth
 * budget to keep in step with the deepest vendor surface, and no mapping of branches - a client's
 * whole `files` or `batches` subtree - that could never hold a gated method.
 */
type Below<Paths extends readonly string[], K> = Paths extends readonly [infer Head, ...infer Rest]
  ? Head extends K
    ? Rest extends readonly string[]
      ? Rest
      : never
    : never
  : never;

/** One signature, with the context threaded into whatever parameter object it already takes. */
type GatedSignature<P, R extends unknown[], Ret, Ctx> = P extends object
  ? (params: P & { stiggContext?: Ctx }, ...rest: R) => Ret
  : (params: P, ...rest: R) => Ret;

/**
 * A gated method, overloads and all.
 *
 * The arms are tried widest first because a single `infer` arm would silently collapse an
 * overloaded method to its **last** signature - and `chat.completions.create` is overloaded
 * precisely on `stream`, so collapsing it would hand a streaming caller the non-streaming return
 * type. Three arms covers every vendor method the recipes gate; a fourth overload would fall
 * through to the last arm and keep working, minus the earlier signatures.
 */
type GatedMethod<F, Ctx> = F extends {
  (params: infer P1, ...rest: infer R1): infer T1;
  (params: infer P2, ...rest: infer R2): infer T2;
  (params: infer P3, ...rest: infer R3): infer T3;
}
  ? GatedSignature<P1, R1, T1, Ctx> & GatedSignature<P2, R2, T2, Ctx> & GatedSignature<P3, R3, T3, Ctx>
  : F extends {
        (params: infer P1, ...rest: infer R1): infer T1;
        (params: infer P2, ...rest: infer R2): infer T2;
      }
    ? GatedSignature<P1, R1, T1, Ctx> & GatedSignature<P2, R2, T2, Ctx>
    : F extends (params: infer P, ...rest: infer R) => infer Ret
      ? GatedSignature<P, R, Ret, Ctx>
      : F;

/**
 * The client's own surface, with every gated method taught to accept a `stiggContext`.
 *
 * Rebuilt structurally, which on its own would lose the vendor's class identity - so
 * {@link WrappedClient} intersects it back with `T` rather than replacing it. The overlay comes
 * first in that intersection on purpose: an intersection of two call signatures is an overload
 * set resolved in order, and the vendor's own signature would reject `stiggContext` as an excess
 * property if it were tried first.
 */
export type GatedSurface<T, Ctx, Paths extends readonly string[] = GatedPath> = {
  [K in keyof T]: [Below<Paths, K>] extends [never]
    ? T[K]
    : // The path ends here, so this key is the gated method itself.
      [] extends Below<Paths, K>
      ? GatedMethod<T[K], Ctx>
      : // It continues, so walk on with only what is still reachable beneath this key.
        GatedSurface<T[K], Ctx, Below<Paths, K>>;
};

/**
 * Which paths a wrapped client accepts a context on: the recipe's own, or the shipped ones.
 *
 * `wrap` infers the options object it was handed, so a recipe passed inline keeps whatever types
 * it was written with - and a recipe that declares its paths as literals (`path: [...] as const`)
 * gets the overlay on exactly the methods it gates, rather than on the shipped vendors' paths.
 *
 * Anything else falls back to {@link GatedPath}: no recipe at all, which is the detection case, and
 * a recipe whose paths widened to `string[]`, where there is nothing to narrow to and guessing
 * would be worse than the default. So this only ever adds precision; it cannot take it away.
 */
export type PathsOf<R, T = unknown> = R extends { methods: readonly { path: infer P }[] }
  ? P extends readonly [string, ...string[]]
    ? P
    : ChatOf<T>
  : ChatOf<T>;

/**
 * What a call still owes, given what `wrap` was already told.
 *
 * `customerId` is the one field that has to come from somewhere, so a client wrapped without one
 * types it as required on every call and a client wrapped with one types it as optional. The
 * runtime checks it either way, for callers the types never reached.
 */
export type CallContext<Wrapped> = Wrapped extends { customerId: string }
  ? StiggContext
  : StiggContext & { customerId: string };

/**
 * A vendor client bound to this environment. Every call its recipe covers is checked before it
 * leaves and metered after, against the context `wrap` was given and whatever the call overrides.
 */
export type WrappedClient<T, Wrapped = StiggContext, Paths extends readonly string[] = GatedPath> = GatedSurface<
  T,
  CallContext<Wrapped>,
  Paths
> &
  T & {
    /** What this client did, and what is still in flight. */
    readonly stigg: ClientGovernance;
  };

/** The governance handle hung off a wrapped client. */
export type ClientGovernance = {
  /** Waits for in-flight ingests, then reports what this client did. */
  flush(): Promise<SessionSummary>;
  /** Drains, then releases what this client holds. */
  close(): Promise<void>;
  /** What this client has done so far, without waiting. */
  summary(): SessionSummary;
  /** The last decision this client made, or undefined if it has made none. */
  readonly lastDecision?: AccessDecision;
  /** The `x-stigg-*` attribution for work continuing in another process. */
  headers(override?: StiggContext): GovernanceHeaders;
  /** The gate, for a call this client does not wrap. */
  check(override?: StiggContext, requestedUsage?: number): Promise<AccessDecision>;
  /** The meter, for usage this client did not observe. */
  report(metrics: Metrics, override?: StiggContext): Promise<IngestResult>;
};

/** What an out-of-process ingest needs, since it has no run to carry it. */
export type IngestContext = {
  /** What the run this usage belongs to checks against. Defaults to the `credits` currency. */
  entitlement?: Entitlement;
  /**
   * What to report. Defaults to the vendor's own names, read off the usage object the proxy
   * observed - the same default a wrapped client gets.
   */
  metrics?: MetricsMapper;
  /**
   * Which shape the observed usage is. Named rather than sniffed: Anthropic and the Responses API
   * both count `input_tokens`, and a wrong guess would report to another customer's meter.
   * Omitted, only the normalized counters are available - so supply a `metrics` mapper too.
   */
  vendor?: ObservedVendor;
  /** Which of Stigg's ingest APIs to report through. Defaults to the client's setting. */
  ingest?: IngestMode;
  /**
   * What the event is called in `'async'` mode. There is no wrapped call out here to name it
   * after, so a proxy either says, or is reported under the vendor it declared.
   *
   * Singular, and named to match `IngestOptions.event`: one report is one event, whatever the
   * turn measured.
   */
  event?: EventIngest;
};
