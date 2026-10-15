/**
 * Provider usage objects -> the SDK's neutral `TokenUsage`.
 *
 * The inputs are typed structurally rather than against each vendor's SDK, so this handful of
 * readers covers a direct client, a gateway response and an orchestrator callback - and adding a
 * provider whose response happens to match costs nothing. Hence the shape-named reader below:
 * `fromFlatTokenUsage` is read by every vendor that counts that way, not by one of them.
 */
import { emptyTokenUsage, type Measurement, type Metrics, type MetricsMapper, type TokenUsage } from '../../types';
import type {
  BedrockLikeUsage,
  FlatTokenUsage,
  GeminiLikeUsage,
  LangChainLikeUsage,
  MistralLikeUsage,
  DatabricksLikeUsage,
  DatabricksQueryLikeUsage,
  OllamaLikeUsage,
  OpenAILikeUsage,
  ResponsesLikeUsage,
} from './types';

const n = (value: number | null | undefined): number => (typeof value === 'number' && value > 0 ? value : 0);

export function fromFlatTokenUsage(usage: FlatTokenUsage | null | undefined): TokenUsage {
  if (!usage) return emptyTokenUsage();
  const counted = {
    input: n(usage.input_tokens),
    output: n(usage.output_tokens),
    cacheRead: n(usage.cache_read_input_tokens),
    cacheCreate: n(usage.cache_creation_input_tokens),
  };
  // No vendor on this shape publishes a total, and these four are disjoint - cache reads and
  // writes sit beside the input count rather than inside it - so their sum is the whole call.
  return { ...counted, ...withTotal(counted.input + counted.output + counted.cacheRead + counted.cacheCreate) };
}

/** `{ total }` when there is one to state, and nothing at all when there is not. */
const withTotal = (total: number): { total?: number } => (total > 0 ? { total } : {});

export function fromOpenAIUsage(usage: OpenAILikeUsage | null | undefined): TokenUsage {
  if (!usage) return emptyTokenUsage();
  const cacheRead = n(usage.prompt_tokens_details?.cached_tokens);
  return {
    // OpenAI states its own, and a stated total beats one reassembled from the parts.
    ...withTotal(n(usage.total_tokens)),
    // OpenAI counts cached prompt tokens inside prompt_tokens, so subtract to avoid double-count.
    input: Math.max(0, n(usage.prompt_tokens) - cacheRead),
    output: n(usage.completion_tokens),
    cacheRead,
    cacheCreate: n(usage.prompt_tokens_details?.cache_write_tokens),
  };
}

/**
 * OpenAI's Responses API, which counts the same tokens under different names - `input_tokens`
 * rather than `prompt_tokens`, and the cache detail one level along. Reading it with the Chat
 * Completions extractor finds none of them and meters the call at zero.
 */
export function fromResponsesUsage(usage: ResponsesLikeUsage | null | undefined): TokenUsage {
  if (!usage) return emptyTokenUsage();
  const cacheRead = n(usage.input_tokens_details?.cached_tokens);
  return {
    ...withTotal(n(usage.total_tokens)),
    // As with chat completions, cached tokens are counted inside the input total.
    input: Math.max(0, n(usage.input_tokens) - cacheRead),
    output: n(usage.output_tokens),
    cacheRead,
    // OpenAI's own Responses API reports no cache writes, so this is 0 for it either way. A
    // gateway mirroring the surface may report them - OpenRouter does - and reading the field
    // costs nothing where it is absent, where the alternative was dropping a counter the customer
    // was charged for.
    cacheCreate: n(usage.input_tokens_details?.cache_write_tokens),
  };
}

/**
 * Bedrock's Converse usage, whose four counters are disjoint.
 *
 * Nothing is subtracted, unlike the OpenAI and Gemini readers: AWS states that `inputTokens`
 * already excludes whatever was read from or written to the cache, so taking the cache back out
 * would charge the call for less than it used.
 *
 * The total is read, not recomputed, like every other vendor that publishes one - but it is worth
 * knowing what it covers. AWS documents `totalTokens` as the input and output of the call, and
 * documents `inputTokens` as cache-exclusive, so on a cached call the stated total can be smaller
 * than the four counters add up to. Both are reported: price the breakdown if the cache matters to
 * you, the total if it does not, and see the README's overlap table before pricing both.
 */
export function fromBedrockUsage(usage: BedrockLikeUsage | null | undefined): TokenUsage {
  if (!usage) return emptyTokenUsage();
  const counted = {
    input: n(usage.inputTokens),
    output: n(usage.outputTokens),
    cacheRead: n(usage.cacheReadInputTokens),
    cacheCreate: n(usage.cacheWriteInputTokens),
  };
  const stated = n(usage.totalTokens);
  return {
    ...counted,
    // The vendor's figure when it gave one; otherwise the sum, which is sound precisely because
    // these four do not overlap.
    ...withTotal(stated || counted.input + counted.output + counted.cacheRead + counted.cacheCreate),
  };
}

export function fromLangChainUsage(usage: LangChainLikeUsage | null | undefined): TokenUsage {
  if (!usage) return emptyTokenUsage();
  const cacheRead = n(usage.input_token_details?.cache_read);
  const cacheCreate = n(usage.input_token_details?.cache_creation);
  return {
    input: Math.max(0, n(usage.input_tokens) - cacheRead - cacheCreate),
    output: n(usage.output_tokens),
    cacheRead,
    cacheCreate,
  };
}

/**
 * Gemini's `usageMetadata`, whose two overlaps run in opposite directions - see `GeminiLikeUsage`
 * for the vendor's own wording on each.
 *
 * The arithmetic is checked by the one invariant the vendor publishes: the four counters below
 * add back up to `totalTokenCount`, which is why neither overlap may be read the other way.
 */
export function fromGeminiUsage(usage: GeminiLikeUsage | null | undefined): TokenUsage {
  if (!usage) return emptyTokenUsage();
  const cacheRead = n(usage.cachedContentTokenCount);
  return {
    // Gemini's own, under its own name. Never recomputed from the counters below: they overlap,
    // and the vendor's figure is the one its invoice will show.
    ...withTotal(n(usage.totalTokenCount)),
    // Cached content is counted inside the prompt total, so subtract it rather than bill it
    // twice. Tool-use prompt tokens are not inside it - `totalTokenCount` adds them alongside -
    // so they are input this would otherwise drop entirely.
    input: Math.max(0, n(usage.promptTokenCount) - cacheRead) + n(usage.toolUsePromptTokenCount),
    // Thinking tokens are billed as output and counted beside the candidates, not within them.
    output: n(usage.candidatesTokenCount) + n(usage.thoughtsTokenCount),
    cacheRead,
    // Nothing to read: an explicit cache is written by `caches.create`, a separate call whose own
    // response carries the token count for it. A generation reports only what it read.
    cacheCreate: 0,
  };
}

/**
 * Mistral's `UsageInfo` - the OpenAI three, camelCased by a generated SDK.
 *
 * Counts the same way OpenAI's chat usage does, so the arithmetic is the same: the vendor states
 * its own total and it is read rather than recomputed. There is no cache counter to subtract -
 * `UsageInfo` carries none, so unlike `fromOpenAIUsage` nothing is nested inside the prompt count.
 */
export function fromMistralUsage(usage: MistralLikeUsage | null | undefined): TokenUsage {
  if (!usage) return emptyTokenUsage();
  return {
    ...withTotal(n(usage.totalTokens)),
    input: n(usage.promptTokens),
    output: n(usage.completionTokens),
    cacheRead: 0,
    cacheCreate: 0,
  };
}

/**
 * Ollama's two counters, read off the response root rather than out of a `usage` block.
 *
 * Disjoint - the prompt evaluation and the generation are separate work - so their sum is the
 * whole call and computing a total from them is the vendor's own arithmetic rather than ours.
 * Ollama publishes no total of its own, which is why there is one to compute.
 */
export function fromOllamaUsage(usage: OllamaLikeUsage | null | undefined): TokenUsage {
  if (!usage) return emptyTokenUsage();
  const counted = { input: n(usage.prompt_eval_count), output: n(usage.eval_count), cacheRead: 0, cacheCreate: 0 };
  return { ...counted, ...withTotal(counted.input + counted.output) };
}

/**
 * Any of the three shapes above, recognised by its own fields. Vendors disagree on names but not
 * enough to be ambiguous, so the caller can pass whatever the response carried.
 */
export function normalizeUsage(usage: unknown): TokenUsage {
  if (!usage || typeof usage !== 'object') return emptyTokenUsage();
  const raw = usage as FlatTokenUsage &
    OpenAILikeUsage &
    LangChainLikeUsage &
    GeminiLikeUsage &
    MistralLikeUsage &
    OllamaLikeUsage &
    Partial<TokenUsage>;
  // Already normalized - a caller doing its own accounting. Recognised by any of the four, not
  // only the cache pair: an application that counts input and output and has no cache to report
  // used to fall past this to the flat vendor reader, which looks for `input_tokens` and finds
  // none - so `{ input: 600, output: 400 }` normalized to zeroes and metered the turn as nothing.
  //
  // Rebuilt from all four either way: a partial object leaves the rest undefined, and
  // `undefined + number` is NaN, which the mapper would pass on as a measurement of nothing.
  if (
    typeof raw.cacheRead === 'number' ||
    typeof raw.cacheCreate === 'number' ||
    typeof raw.input === 'number' ||
    typeof raw.output === 'number'
  ) {
    return { input: n(raw.input), output: n(raw.output), cacheRead: n(raw.cacheRead), cacheCreate: n(raw.cacheCreate) };
  }
  if ('prompt_tokens' in raw || 'completion_tokens' in raw) return fromOpenAIUsage(raw);
  // Mistral's camelCase, claimed before the flat reader below. Nothing else spells its counters
  // this way, so one numeric field identifies it - and without this the object falls through to
  // `fromFlatTokenUsage`, which looks for `input_tokens`, finds none, and meters the turn at zero.
  if (typeof raw.promptTokens === 'number' || typeof raw.completionTokens === 'number') {
    return fromMistralUsage(raw);
  }
  // Any one of Gemini's counters identifies it - they share no name with the shapes above, and
  // one is all a caller may send. Read off the component list so the two cannot drift, and keyed
  // on a *numeric* value: `in` is true for a key whose value is `undefined`, which a payload
  // built by spreading optional fields carries, and that read someone else's counts as zero.
  if (GEMINI_COMPONENT_METRICS.some((key) => typeof raw[key] === 'number')) return fromGeminiUsage(raw);
  // Ollama's two, read the same way and for the same reason as Gemini's. The recipe never arrives
  // here - it calls `fromOllamaUsage` on the response root directly - but this function is public
  // and the examples print what it returns, so without this branch an Ollama turn falls through to
  // `fromFlatTokenUsage`, finds no `input_tokens`, and prints zeroes beside counters that metered
  // correctly.
  if (OLLAMA_COMPONENT_METRICS.some((key) => typeof raw[key] === 'number')) return fromOllamaUsage(raw);
  if ('input_token_details' in raw) return fromLangChainUsage(raw);
  // Three shapes count `input_tokens`/`output_tokens` - the flat one, the Responses API and
  // LangChain - so the fallback reads any of them happily. Both nested shapes are claimed above
  // by the detail key they carry, because falling through to the flat reader would silently drop
  // the cache detail and overstate the input it was hiding inside.
  if ('input_tokens_details' in raw) return fromResponsesUsage(raw as ResponsesLikeUsage);
  return fromFlatTokenUsage(raw);
}

/** Nothing counted and nothing stated: an accumulator before its first round, not a round. */
const isNeutral = (usage: TokenUsage): boolean =>
  usage.total === undefined && !usage.input && !usage.output && !usage.cacheRead && !usage.cacheCreate;

export const addTokenUsage = (into: TokenUsage, add: TokenUsage): TokenUsage => {
  // Summed across the rounds of one call, but only while every round states one. A round that
  // stated none makes the call's total unstateable, and passing the other round's on as if it
  // were the whole understates the call silently - the failure this file exists to avoid. An
  // empty accumulator is not a round, so it does not count as one that said nothing.
  const total = isNeutral(into)
    ? add.total
    : isNeutral(add)
      ? into.total
      : into.total !== undefined && add.total !== undefined
        ? into.total + add.total
        : undefined;

  return {
    input: into.input + add.input,
    output: into.output + add.output,
    cacheRead: into.cacheRead + add.cacheRead,
    cacheCreate: into.cacheCreate + add.cacheCreate,
    ...(total !== undefined ? { total } : {}),
  };
};

// ---------------------------------------------------------------------------------------------
// The vendor's own names, for the reports a run sends by default.
//
// Explicit key lists, never a walk over the response. A blind walk would report `cost` (a float
// Stigg rejects) or `service_tier` (a string) - and worse, the day a vendor adds a counter the
// SDK would start reporting a feature the customer's catalog has never heard of, failing every
// call from then on. A vendor's changelog must not be able to inject feature ids into a bill.
//
// Every vendor reports a **total** as well as its breakdown, and the two deliberately overlap.
// The breakdown answers "what did this call spend it on" and the total answers "what did it
// cost"; only the customer's catalog knows which of those it bills, so both are sent and neither
// is chosen on their behalf. Pricing a total *and* a component underneath it bills those tokens
// twice - `normalizedMetrics` is the disjoint alternative for anyone who would rather not think
// about it, and the README's overlap table says which counters nest inside which.
//
// Where the vendor publishes a total it is read, never recomputed. Where it publishes none -
// Anthropic and TypeSafe - it is summed from counters that are disjoint, which is the only case
// where adding them up is the vendor's own arithmetic rather than ours. See `COMPUTED_TOTALS`.
// ---------------------------------------------------------------------------------------------

// Where a counter is read and what it ends up called are the same string for Anthropic and are
// not for OpenAI, which nests its cache detail. One list cannot be both, so the paths stay
// private to the surface that reads them and only the reported names are exported - those are
// what a mapper receives, and what Stigg meters. `metricNamesMatchPaths` holds the two in step.

/** Where to read each counter off an Anthropic response. Flat, so the paths are the names. */
const ANTHROPIC_PATHS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

/** TypeSafe reports two flat counters and nothing else, so the paths are the names again. */
const TYPESAFE_PATHS = ['input_tokens', 'output_tokens'] as const;

/**
 * The counters Gemini breaks a call down into. Flat, so the paths are the names.
 *
 * Kept apart from the reported list because these are also what *identifies* a Gemini usage
 * object to `normalizeUsage`. A total is not identifying - more than one vendor has one - so
 * recognising a payload by `totalTokenCount` would route an object that counted its tokens some
 * other way into the Gemini reader, which finds none of these and meters it at zero.
 */
const GEMINI_COMPONENT_PATHS = [
  'promptTokenCount',
  'candidatesTokenCount',
  'cachedContentTokenCount',
  'thoughtsTokenCount',
  'toolUsePromptTokenCount',
] as const;

/** Those, plus the vendor's own total. */
const GEMINI_PATHS = [...GEMINI_COMPONENT_PATHS, 'totalTokenCount'] as const;

/** Chat Completions keeps its cache detail one level down; the leaf is what gets reported. */
const OPENAI_CHAT_PATHS = [
  'prompt_tokens',
  'completion_tokens',
  'prompt_tokens_details.cached_tokens',
  'total_tokens',
] as const;

/** The Responses API counts the same tokens under different names, nested the same way. */
const OPENAI_RESPONSES_PATHS = [
  'input_tokens',
  'output_tokens',
  'input_tokens_details.cached_tokens',
  'total_tokens',
] as const;

/**
 * The name a computed total is reported under, for the vendors that publish none of their own.
 *
 * `total_tokens` rather than a name of ours, because it is what OpenAI calls the same number and
 * what a reader expects to find - but it is worth knowing which vendors state it and which get it
 * from {@link COMPUTED_TOTALS}: Anthropic and TypeSafe publish no total at all, so theirs is the
 * SDK's arithmetic over counters the vendor *did* state, not a figure off their dashboard.
 */
export const TOTAL_TOKENS = 'total_tokens';

/** Anthropic's four counters. Disjoint - cache reads and writes are not inside `input_tokens`. */
export const ANTHROPIC_COMPONENT_METRICS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

/** Those four, plus the total this SDK adds up for them. */
export const ANTHROPIC_METRICS = [...ANTHROPIC_COMPONENT_METRICS, TOTAL_TOKENS] as const;

/**
 * Gemini's five. Two of them overlap in opposite directions and both are reported verbatim, the
 * way every vendor's are, because a number published under a vendor's field name has to reconcile
 * against that vendor's own dashboard: `cachedContentTokenCount` is already *inside*
 * `promptTokenCount`, while `thoughtsTokenCount` and `toolUsePromptTokenCount` sit *outside* the
 * two headline counters. Price accordingly - or price `normalizedMetrics` instead, which is
 * disjoint by construction.
 */
export const GEMINI_METRICS = GEMINI_PATHS;

/** What identifies a Gemini usage object: its breakdown, never its total. */
export const GEMINI_COMPONENT_METRICS = GEMINI_COMPONENT_PATHS;

/**
 * Chat Completions. `prompt_tokens` **includes** `cached_tokens`, so these two overlap - reported
 * as the vendor states them, which is what reconciles against its invoice. Whoever prices
 * `prompt_tokens` must know the cached ones are already inside it.
 */
export const OPENAI_CHAT_METRICS = ['prompt_tokens', 'completion_tokens', 'cached_tokens', 'total_tokens'] as const;

/** The Responses API, which overlaps the same way under its own names. */
export const OPENAI_RESPONSES_METRICS = ['input_tokens', 'output_tokens', 'cached_tokens', 'total_tokens'] as const;

/**
 * Where Mistral's counters are **read** and what each is **reported** as - the only vocabulary
 * here where those are different strings.
 *
 * Every other vendor is reported under the key it was read from, which is why `METRIC_PATHS` is a
 * list and `metricName` just takes the last segment. Mistral's generated SDK renames the wire on
 * the way in - the API sends `prompt_tokens`, the client hands you `promptTokens` - so following
 * that convention would report a camelCase feature id that matches nothing on Mistral's own
 * dashboard, and would differ from what the same account reports through an `OpenAI` client
 * pointed at `api.mistral.ai/v1`. One account, one invoice, one vocabulary: the wire's.
 *
 * So the map runs read-key -> reported-name, and `pickRenamedMetrics` is what applies it.
 */
export const MISTRAL_METRIC_NAME_MAP = {
  promptTokens: 'prompt_tokens',
  completionTokens: 'completion_tokens',
  totalTokens: 'total_tokens',
} as const;

/**
 * Mistral's three, under the wire's own names.
 *
 * No cache counter: `UsageInfo` carries none. The cache and reasoning detail the v2 SDK models
 * lives on a different type that chat responses do not use, so declaring it here would type a
 * pricing table against a number that never arrives.
 */
export const MISTRAL_METRICS = ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const;

/**
 * TypeSafe's two. No cache counters and no cost: the API reports what it charged for and stops
 * there, which was confirmed against the wire rather than inferred from the SDK's types.
 */
export const TYPESAFE_COMPONENT_METRICS = ['input_tokens', 'output_tokens'] as const;

/** Those two, plus the total this SDK adds up for them. */
export const TYPESAFE_METRICS = [...TYPESAFE_COMPONENT_METRICS, TOTAL_TOKENS] as const;

/**
 * Ollama's two. Flat on the response root, so the paths are the names.
 *
 * No cache counter and no cost: Ollama is self-hosted, so there is no invoice behind these at all
 * - they measure the customer's own capacity rather than a vendor's charge. The durations beside
 * them on the response are nanoseconds, not tokens, and are deliberately absent from this list.
 */
export const OLLAMA_COMPONENT_METRICS = ['prompt_eval_count', 'eval_count'] as const;

/** Those two, plus the total this SDK adds up for them. */
export const OLLAMA_METRICS = [...OLLAMA_COMPONENT_METRICS, TOTAL_TOKENS] as const;

/** Both OpenAI surfaces, which is what one client can report across its two APIs. */
export const OPENAI_METRICS = [
  'prompt_tokens',
  'completion_tokens',
  'input_tokens',
  'output_tokens',
  'cached_tokens',
  'total_tokens',
] as const;

/** A gateway speaks the OpenAI shape and adds the price it charged, under its own field name. */
export const GATEWAY_METRICS = [...OPENAI_METRICS, 'cost'] as const;

/**
 * A gateway that forwards the upstream body untouched, and so reports in two vocabularies.
 *
 * Unlike LiteLLM, which normalises every upstream to the OpenAI wire, Cloudflare AI Gateway's
 * provider-native routes pass the provider's own body straight through - so `/openai` returns
 * OpenAI's counter names and `/anthropic` returns Anthropic's. One recipe serves both wires, so
 * this is the union of what its surfaces can report, which is what `metrics` is defined to be.
 *
 * No `cost`, and that is the defining fact rather than an oversight. Cloudflare states no price on
 * any response: its figure lives in the gateway's own log, is explicitly an estimate, and is zero
 * on a cache hit. So the recipe carries the log id as a dimension and lets spend be reconciled out
 * of band, exactly as the gateway reference prescribes for a price that is only available
 * asynchronously.
 */
export const CLOUDFLARE_METRICS = [
  ...OPENAI_METRICS,
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

/**
 * Bedrock's five, under its own names and with no price among them.
 *
 * Reported verbatim rather than translated into the OpenAI spelling, which is the rule everywhere
 * except where one service is reachable through two different clients - see `sdk-usage.ts` for
 * that exception. Bedrock is reached one way, so its own names are the honest ones, and a reader
 * comparing a Stigg meter against an AWS bill is comparing like with like.
 *
 * No `cost`: Bedrock states no price on the response, which is the thing that most separates it
 * from the other two gateways here. See the recipe for what that costs a run.
 */
export const BEDROCK_PATHS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'totalTokens',
] as const;

/** Those five. Flat, so the paths are the names. */
export const BEDROCK_METRICS = BEDROCK_PATHS;

/**
 * Databricks' six, under its own names - and its own names are two vendors' names at once.
 *
 * The first three are OpenAI's spelling, because the serving endpoints speak the OpenAI wire. The
 * two cache counters are *Anthropic's* spelling, flat on the usage block rather than nested under
 * `prompt_tokens_details` where an OpenAI-shaped reader would look for them, and `reasoning_tokens`
 * is Databricks' own. Reported exactly as Databricks spells them, per the rule that a number has to
 * reconcile against the vendor's own dashboard - renaming the cache pair to `cached_tokens` would
 * make one account read as two vocabularies and find nothing where it looked.
 *
 * No `cost`, and that is the fact that most shapes this binding: Databricks states no price on any
 * response, on either route. See `databricks-recipe.ts` for what that costs a run.
 */
export const DATABRICKS_PATHS = [
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'reasoning_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

/**
 * The same counters as the Responses API spells them.
 *
 * Databricks serves both OpenAI surfaces, and they do not share field names: Chat Completions
 * sends `prompt_tokens`/`completion_tokens` and Responses sends `input_tokens`/`output_tokens`.
 * Reading a Responses body with the list above finds neither, so the call would report its total
 * and nothing else - a number with no breakdown under it, which prices wrongly rather than
 * visibly. Each surface reads its own list.
 */
export const DATABRICKS_RESPONSES_PATHS = [
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'reasoning_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

/** The union across both surfaces: what a Databricks call can report, which is what `metrics` is. */
export const DATABRICKS_METRICS = [
  'prompt_tokens',
  'completion_tokens',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'reasoning_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

/**
 * Where the **first-party client's** counters are read and what each is reported as.
 *
 * The second map in this file, and it exists for precisely the reason the Mistral one does.
 * `@databricks/sdk-modelservingquery` is generated, and its zod schema parses `prompt_tokens` off
 * the wire and transforms it to `promptTokens` before the caller ever sees it - so following the
 * key it was read from would report a camelCase feature id for a call that the *same workspace*
 * reports in snake_case when the application holds an `OpenAI` client instead.
 *
 * That is not a cosmetic difference. It is one Databricks account producing two different feature
 * ids depending on which package the application happened to import, splitting one bill across two
 * meters - which is the failure `pickRenamedMetrics` was built to prevent. Three entries rather
 * than six because `ExternalModelUsageElement` carries only three; the cache pair and
 * `reasoning_tokens` have no field on it, and a counter with no field is absent rather than zero.
 */
export const DATABRICKS_QUERY_METRIC_NAME_MAP = {
  promptTokens: 'prompt_tokens',
  completionTokens: 'completion_tokens',
  totalTokens: 'total_tokens',
} as const;

/**
 * Workers AI's three, and only three.
 *
 * OpenAI's spelling, flat, with no cache detail nested underneath - so this is a narrower list
 * than `OPENAI_CHAT_METRICS` rather than a reuse of it. Declaring `cached_tokens` here would type
 * a pricing table against a counter Workers AI never sends.
 *
 * No neurons either, which is the counter a reader might expect. Cloudflare bills Workers AI in
 * Neurons, and publishes none of them on any response - binding or REST - so the conversion from
 * tokens is a price list this SDK does not hold. Tokens are what the response states and tokens
 * are what this reports.
 */
export const WORKERS_AI_PATHS = ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const;

/** Those three. Flat, so the paths are the names. */
export const WORKERS_AI_METRICS = WORKERS_AI_PATHS;

/**
 * Databricks' usage block -> the neutral digest.
 *
 * `input` is `prompt_tokens` verbatim, *not* reduced by the cache reads the way `fromOpenAIUsage`
 * reduces its own. OpenAI documents its cached tokens as counted inside `prompt_tokens`, so
 * subtracting there is undoing a documented overlap. Databricks documents no such thing, and the
 * spelling it chose for the pair is Anthropic's - whose cache counters sit *beside* the input
 * count rather than inside it. So the Anthropic convention is the better guess and the overlap is
 * left alone; the stated total is read rather than computed, which keeps the one number that gets
 * invoiced right whichever way the overlap actually runs. The README's overlap table says the
 * direction is unverified for Databricks, because it is.
 */
export function fromDatabricksUsage(usage: DatabricksLikeUsage | null | undefined): TokenUsage {
  if (!usage) return emptyTokenUsage();
  return {
    // Read, never computed: Databricks states a total, and a stated total beats a reassembled one
    // precisely because the overlap above is unknown.
    ...withTotal(n(usage.total_tokens)),
    // Both spellings, because one Databricks workspace serves both OpenAI surfaces: Chat
    // Completions sends `prompt_tokens`/`completion_tokens` and Responses sends
    // `input_tokens`/`output_tokens`. A body carries one pair or the other, never both, so the
    // fallback cannot double-count - and reading only the chat pair left `normalizedMetrics` and
    // every custom `TokenUsage` mapper seeing zeroes for a Responses call.
    input: n(usage.prompt_tokens ?? (usage as { input_tokens?: number }).input_tokens),
    output: n(usage.completion_tokens ?? (usage as { output_tokens?: number }).output_tokens),
    cacheRead: n(usage.cache_read_input_tokens),
    cacheCreate: n(usage.cache_creation_input_tokens),
  };
}

/**
 * The same block as read through the first-party client -> the neutral digest.
 *
 * Its own reader rather than a call into `fromDatabricksUsage`, because the field names genuinely
 * differ: the generated client camelCases the wire on the way in, so a snake_case reader finds
 * none of these and returns an all-zero digest without throwing. That is the shape of failure the
 * invariants call out - an extractor that meters every call at nothing and trips no test.
 *
 * No cache arithmetic to get wrong here, which is the one simplification over the wire-shaped
 * reader: `ExternalModelUsageElement` declares no cache counters at all, so there is no overlap of
 * unknown direction to leave alone. The stated total is still read rather than recomputed.
 */
export function fromDatabricksQueryUsage(usage: DatabricksQueryLikeUsage | null | undefined): TokenUsage {
  if (!usage) return emptyTokenUsage();
  return {
    ...withTotal(n(usage.totalTokens)),
    input: n(usage.promptTokens),
    output: n(usage.completionTokens),
    cacheRead: 0,
    cacheCreate: 0,
  };
}

/** The leaf a dotted path reports under - `prompt_tokens_details.cached_tokens` -> `cached_tokens`. */
export const metricName = (path: string): string => path.split('.').pop()!;

/**
 * Which counters are summed to produce a vendor's total, for the vendors that publish none.
 *
 * Only ever disjoint sets: Anthropic's four do not overlap and neither do TypeSafe's two, so the
 * sum is the whole call and nothing is counted twice. A vendor whose counters overlap - Gemini's
 * cached tokens sit inside its prompt count, OpenAI's inside theirs - is not in this table,
 * because adding those up would be arithmetic the vendor never agreed to. Those vendors state a
 * total themselves and it is read, not computed.
 */
export const COMPUTED_TOTALS: Record<string, readonly string[]> = {
  anthropic: ANTHROPIC_COMPONENT_METRICS,
  typesafe: TYPESAFE_COMPONENT_METRICS,
  ollama: OLLAMA_COMPONENT_METRICS,
};

/**
 * Adds the computed total to a metrics object, for a vendor that states none of its own.
 *
 * Absent rather than zero when nothing was counted, like every other metric here: a call that
 * measured nothing reports nothing, instead of a zero somebody has to interpret.
 */
export function withComputedTotal(metrics: Metrics, keys: readonly string[]): Metrics {
  const total = keys.reduce((sum, key) => sum + (metrics[key] ?? 0), 0);
  return total > 0 ? { ...metrics, [TOTAL_TOKENS]: total } : metrics;
}

/**
 * Whether a path list and a name list agree, for the test that keeps them from drifting.
 *
 * Two lists describing one thing is the cost of separating where a counter lives from what it is
 * called. This is what makes that cost a compile-and-test problem rather than a billing one.
 */
export const metricNamesMatchPaths = (paths: readonly string[], names: readonly string[]): boolean => {
  const fromPaths = [...new Set(paths.map(metricName))];
  return fromPaths.length === names.length && fromPaths.every((name) => names.includes(name));
};

/** The read paths, for the tests that hold them in step with the names above. */
export const METRIC_PATHS = {
  anthropic: ANTHROPIC_PATHS,
  openaiChat: OPENAI_CHAT_PATHS,
  openaiResponses: OPENAI_RESPONSES_PATHS,
  typesafe: TYPESAFE_PATHS,
  gemini: GEMINI_PATHS,
  bedrock: BEDROCK_PATHS,
  databricks: DATABRICKS_PATHS,
  databricksResponses: DATABRICKS_RESPONSES_PATHS,
  workersAi: WORKERS_AI_PATHS,
  ollama: OLLAMA_COMPONENT_METRICS,
} as const;

/**
 * Reads the named keys off a vendor's usage object, dotted paths included.
 *
 * A nested key reports under its leaf - `prompt_tokens_details.cached_tokens` becomes
 * `cached_tokens` - because the leaf is the vendor's own name for it and a feature id with a dot
 * in it reads badly everywhere. Anything absent, fractional or not a number is skipped: a metric
 * the vendor did not report is not a zero, and Stigg rejects fractions.
 */
export function pickMetrics(usage: unknown, keys: readonly string[]): Metrics {
  if (!usage || typeof usage !== 'object') return {};
  const metrics: Metrics = {};
  for (const key of keys) {
    const value = key.split('.').reduce<any>((node, part) => (node == null ? node : node[part]), usage);
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      metrics[key.split('.').pop()!] = value;
    }
  }
  return metrics;
}

/**
 * Reads each key of a read -> reported map off a usage object, reporting under the mapped name.
 *
 * The counterpart to {@link pickMetrics} for a vendor whose SDK spells its counters differently
 * from its own wire. Same guards, and for the same reasons: anything absent, fractional or not a
 * number is skipped, because a metric the vendor did not report is not a zero and Stigg rejects
 * fractions. Flat keys only - no vendor needing this nests its counters, and a dotted read here
 * would make the map ambiguous about which half of the arrow the dot belongs to.
 */
export function pickRenamedMetrics(usage: unknown, map: Record<string, string>): Metrics {
  if (!usage || typeof usage !== 'object') return {};
  const metrics: Metrics = {};
  for (const [key, name] of Object.entries(map)) {
    const value = (usage as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) metrics[name] = value;
  }
  return metrics;
}

/** Accumulates metrics across a stream, which reports its counters in more than one chunk. */
export const addMetrics = (into: Metrics, add: Metrics): Metrics => {
  const summed: Metrics = { ...into };
  for (const [key, value] of Object.entries(add)) summed[key] = (summed[key] ?? 0) + value;
  return summed;
};

/**
 * The SDK's own four counters, under SDK-owned names, from the normalized measurement.
 *
 * The opt-out from vendor names, for an application running more than one provider: these are
 * disjoint and mean the same thing whoever served the call, so one set of Stigg features covers
 * every vendor. Pass it as a run's `metrics`.
 */
export const normalizedMetrics: MetricsMapper = ({ usage }) => {
  if (!usage) return {};
  const metrics: Metrics = {};
  if (usage.input > 0) metrics.stigg_input_tokens = usage.input;
  if (usage.output > 0) metrics.stigg_output_tokens = usage.output;
  if (usage.cacheRead > 0) metrics.stigg_cache_read_tokens = usage.cacheRead;
  if (usage.cacheCreate > 0) metrics.stigg_cache_creation_tokens = usage.cacheCreate;
  return metrics;
};

/** The shapes a gateway can be told it observed, since guessing reports to the wrong features. */
/**
 * The shapes a proxy can be told it observed.
 *
 * Named for the vendor rather than for the shape, because a proxy operator knows what is behind
 * them and not what its usage object looks like - but it is the shape that is being selected,
 * which is why OpenAI appears twice. Its two APIs spell the same counters differently, and
 * `openai-responses` is that surface rather than a vendor of its own.
 */
export type ObservedVendor = 'anthropic' | 'typesafe' | 'openai' | 'openai-responses' | 'gemini';

// Read paths, not reported names: OpenAI keeps its cache detail nested, so the name alone finds
// nothing there. Anthropic and TypeSafe share the flat shape and differ only in how much of it
// they fill in, so a proxy fronting either reads the same paths - but it still has to be able to
// say which, rather than being told to pass the other vendor's name and know why.
const METRIC_KEYS: Record<ObservedVendor, readonly string[]> = {
  anthropic: METRIC_PATHS.anthropic,
  typesafe: METRIC_PATHS.typesafe,
  openai: METRIC_PATHS.openaiChat,
  'openai-responses': METRIC_PATHS.openaiResponses,
  gemini: METRIC_PATHS.gemini,
};

/**
 * Both views of a usage object a proxy observed, for the ingest path that has no recipe.
 *
 * The vendor is named rather than sniffed. `normalizeUsage` guesses from the object's own fields
 * and says itself that Anthropic and the Responses API are ambiguous - both count `input_tokens`.
 * A wrong guess would report to another meter entirely, which nothing downstream can undo - so
 * an unnamed vendor reports nothing raw and leaves the normalized counters to a mapper.
 */
export function observedMeasurement(usage: unknown, vendor?: ObservedVendor): Measurement {
  return {
    metrics: vendor ? pickMetrics(usage, METRIC_KEYS[vendor]) : {},
    usage: normalizeUsage(usage),
    // Kept whole for an event to carry, and it does not depend on naming the vendor: a dimension
    // is something a meter reads deliberately, not a feature id a wrong guess could invent.
    // An array is an object and is not this: `Object.entries` would flatten it to `raw.0`,
    // `raw.1`, ... - dimensions named after positions in a list nobody meant to send.
    raw: usage && typeof usage === 'object' && !Array.isArray(usage) ? (usage as Record<string, unknown>) : undefined,
  };
}
