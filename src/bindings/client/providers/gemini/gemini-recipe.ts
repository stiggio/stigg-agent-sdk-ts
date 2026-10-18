/**
 * The Gemini recipe - `@google/genai`, the GA SDK that replaced `@google/generative-ai`.
 *
 * Two recipes, because the two call styles share no code path. `new GoogleGenAI()` builds its
 * chat module as `new Chats(this.models, ...)` and each `Chat` keeps that reference privately, so
 * a chat created from a wrapped client still calls the original, unpatched `models.generateContent`.
 * Gating `models.*` alone would leave every conversation ungoverned while the client looked
 * governed, so a chat is wrapped in its own right:
 *
 *     const chat = stigg.wrap(ai.chats.create({ model }));
 *
 * Nothing meters twice: the chat reaches the unwrapped module by construction.
 *
 * Generation only. `models.embedContent`, `generateImages`, `generateVideos`, `countTokens`,
 * `batches.*`, `caches.*` and `live.*` are billable and **not** gated here - each counts in a unit
 * these metrics do not describe. Meter one by naming your own recipe at `wrap(client, { recipe })`.
 */
import { GEMINI_METRICS, addMetrics, addTokenUsage, fromGeminiUsage, pickMetrics } from '../../../shared/token-usage';
import { meterStream } from '../../../shared/meter-stream';
import { emptyTokenUsage, type Measurement, type Metrics, type TokenUsage } from '../../../../types';
import { estimateUnits } from '../../../shared/estimate';
import { hasMethod } from '../../core/registry';
import type { ClientRecipe, MetricsFor, MetricsOf } from '../../core/types';

/**
 * Both views of a completed response: what Gemini called the counters, which is what gets
 * reported, and the normalized ones a mapper of your own would write against.
 *
 * Returns undefined for a streamed call - `generateContentStream` resolves to an async generator
 * with no `usageMetadata` on it - which is what hands the result to `attachStream` below.
 */
/**
 * How many model calls one `generateContent` made.
 *
 * With a callable tool the SDK drives the tool loop itself - up to `maximumRemoteCalls`, 10 by
 * default - and returns only the last response. Each round that called a tool leaves its reply in
 * `automaticFunctionCallingHistory`, which is `Content` and carries no token counts: the rounds
 * can be counted, not priced.
 */
function afcRounds(result: any): number {
  const history = result?.automaticFunctionCallingHistory;
  if (!Array.isArray(history)) return 1;
  const toolReplies = history.filter(
    (content: any) => Array.isArray(content?.parts) && content.parts.some((part: any) => part?.functionResponse),
  ).length;
  return toolReplies + 1;
}

/**
 * What a call whose earlier rounds were never reported can honestly say about itself.
 *
 * `generateContent` reassigns `response` each iteration and returns the last, so the earlier
 * rounds are gone before it returns and no arithmetic here recovers them. Measured: two rounds
 * billed at 126 and 171, of which the response carries 171. The streamed surface has no such gap.
 */
const partialAfcReason = (rounds: number, measured: number): string =>
  `Gemini ran ${rounds} model calls for one generateContent (automatic function calling), and the ` +
  `response carries usage for the last one only - ${measured} tokens, out of a total this SDK ` +
  `cannot see. The earlier rounds were billed by the vendor and are not in the response, so they ` +
  `are not in this measurement. To meter every round: stream the call, or set ` +
  `\`automaticFunctionCalling: { disable: true }\` and drive the tool loop yourself, which makes ` +
  `each round a call this SDK gates and meters on its own.`;

const extractUsage = (result: any): Measurement | undefined =>
  result?.usageMetadata
    ? {
        metrics: pickMetrics(result.usageMetadata, GEMINI_METRICS),
        usage: fromGeminiUsage(result.usageMetadata),
        // The vendor's own id, so one turn reported twice is one turn. The fallback is a step
        // counter off the run, which is stable only within a process.
        ...(typeof result.responseId === 'string' ? { idempotencyKey: result.responseId } : {}),
        ...afcShortfall(result),
        // The block as it arrived, for an event to state in full - including `totalTokenCount`
        // and the per-modality breakdowns this recipe does not name, which a meter can then read
        // without waiting for an SDK release.
        raw: result.usageMetadata,
      }
    : undefined;

/** The rounds this call made and what went unmeasured, for the calls where any did. */
function afcShortfall(result: any): Pick<Measurement, 'dimensions' | 'incomplete'> {
  const rounds = afcRounds(result);
  if (rounds < 2) return {};
  return {
    dimensions: { gemini_afc_rounds: String(rounds) },
    incomplete: partialAfcReason(rounds, n(result?.usageMetadata?.totalTokenCount)),
  };
}

const n = (value: unknown): number => (typeof value === 'number' ? value : 0);

/**
 * Meters a streamed call: the last block of each round, summed across rounds.
 *
 * **Within a round** `usageMetadata` repeats on every chunk as a running total, so the last block
 * is the whole round and summing the chunks bills it many times over. **Across rounds** automatic
 * function calling yields several rounds through one generator, each counting from zero, so
 * keeping only the last block bills one round of several. Measured: 305 charged, 175 from the last
 * block alone, 556 from summing every chunk.
 *
 * The boundary is `responseId`, shared by a round's chunks and changed by the next, and it is
 * trusted on its own. Measured rather than assumed: `promptTokenCount` changing is **not** a
 * boundary - it moves within a round too (92 -> 131 on the wire) - and neither is a counter
 * *failing* to drop, since a round that ended on a function call is easily smaller than the first
 * chunk of the one after it. Where no id is reported, a counter running backwards stands in,
 * being the only evidence left that a round restarted.
 */
const attachStream = (stream: any, ingest: (measurement: Measurement) => void): void => {
  /** Rounds already finished, which never change again. */
  let banked = emptyTokenUsage();
  let bankedMetrics: Metrics = {};
  /** The round being read, replaced by each block it reports because they are running totals. */
  let round: TokenUsage | undefined;
  let roundMetrics: Metrics = {};
  /** What the round being read calls itself, which is what makes the boundary exact. */
  let roundId: string | undefined;
  /** Undefined until a chunk states one. A counter nobody has reported cannot have gone down. */
  let candidates: number | undefined;
  let thoughts: number | undefined;
  /**
   * The block as it arrived, for an event to state in full - kept only while the stream turns
   * out to be a single round. Copied rather than referenced, because it is held until the stream
   * ends and the chunk it came from is the consumer's: a reference would let the dimensions
   * reported disagree with the metrics computed beside them. (`extractUsage` needs no copy -
   * there the block is flattened in the same tick it is read.)
   */
  let raw: Record<string, unknown> | undefined;
  let lastId: string | undefined;
  let rounds = 0;

  meterStream(
    stream,
    (chunk) => {
      const reported = chunk?.usageMetadata;
      if (!reported) return;
      const id = typeof chunk.responseId === 'string' ? chunk.responseId : undefined;
      const nextCandidates =
        typeof reported.candidatesTokenCount === 'number' ? reported.candidatesTokenCount : undefined;
      const nextThoughts = typeof reported.thoughtsTokenCount === 'number' ? reported.thoughtsTokenCount : undefined;
      // Both values must be present for a decrease to mean anything: an absent counter read as
      // zero looks like a restart, and banks a round that never ended.
      const dropped = (next?: number, previous?: number) =>
        next !== undefined && previous !== undefined && next < previous;

      // The id decides, on its own, wherever one is reported: a `responseId` identifies one
      // response, and one response is one round. Requiring a counter to drop as well looked
      // safer and was not - it misses a boundary whenever the new round's first usage chunk
      // already carries more output than the whole of the previous round, which is the normal
      // shape when a round ends on a function call. Measured: 223 billed as 147.
      //
      // The counters are the fallback for a stream that names nothing, where a counter running
      // backwards is the only evidence a round restarted.
      const restarted = dropped(nextCandidates, candidates) || dropped(nextThoughts, thoughts);
      const endsRound = id !== undefined && roundId !== undefined ? id !== roundId : restarted;
      // A round ended: bank what it finally reported before the new one starts from zero.
      let ended = false;
      if (round !== undefined && endsRound) {
        ended = true;
        banked = addTokenUsage(banked, round);
        bankedMetrics = addMetrics(bankedMetrics, roundMetrics);
        rounds += 1;
      }

      round = fromGeminiUsage(reported);
      roundMetrics = pickMetrics(reported, GEMINI_METRICS);
      raw = { ...reported };
      roundId = id;
      // The last round's id names the call: one measurement goes out, and this is the id that is
      // still the same if the stream is read again.
      if (id !== undefined) lastId = id;
      // Within a round an omitted counter keeps its last value; across one the baselines are
      // replaced, absence included. Carrying the old round's figure made the next chunk stating
      // that counter look like a further restart, banking a round mid-round.
      if (ended) {
        candidates = nextCandidates;
        thoughts = nextThoughts;
      } else {
        if (nextCandidates !== undefined) candidates = nextCandidates;
        if (nextThoughts !== undefined) thoughts = nextThoughts;
      }
    },
    () => {
      const usage = round ? addTokenUsage(banked, round) : banked;
      const metrics = round ? addMetrics(bankedMetrics, roundMetrics) : bankedMetrics;
      // One round, one block, and `raw` describes the whole measurement. Several rounds and no
      // block does: each states only its own round, so passing the last would hand a meter
      // dimensions that disagree with the metrics beside them. Reported instead is how many
      // rounds there were, which is the thing a reader would otherwise have no way to see.
      const single = rounds === 0 && raw;
      ingest({
        metrics,
        usage,
        ...(single ? { raw } : {}),
        ...(lastId ? { idempotencyKey: lastId } : {}),
        ...(rounds ? { dimensions: { gemini_afc_rounds: String(rounds + 1) } } : {}),
      });
    },
  );
};

/** The one-shot surface: `ai.models.generateContent` and its streaming twin. */
export const geminiRecipe = {
  vendor: 'gemini',
  metrics: GEMINI_METRICS,
  // Gemini's own name for it, which is the one its invoice shows.
  totalTokensMetric: 'totalTokenCount',
  // Either is enough on its own, the way the OpenAI recipe treats its two surfaces. Both methods
  // sit on the same module today, so requiring both would pass anyway - and would start refusing
  // clients the day the vendor splits them, which is a guard failing for a reason nobody intended.
  matches: (client) =>
    hasMethod(client, ['models', 'generateContent']) || hasMethod(client, ['models', 'generateContentStream']),
  // `as const` on each path, which is what `PathsOf` reads: a recipe named explicitly at
  // `wrap(client, { recipe })` then overlays the per-call context on exactly the methods it
  // gates, rather than falling back to the shipped vendors' list. It matters most for the chat
  // recipe below - see there - and both are written the same way so neither drifts.
  methods: [
    { path: ['models', 'generateContent'] as const, extractUsage, attachStream },
    { path: ['models', 'generateContentStream'] as const, extractUsage, attachStream },
  ],
} satisfies ClientRecipe<(typeof GEMINI_METRICS)[number]>;

/**
 * The conversational surface: one `Chat`, as `ai.chats.create(...)` hands it back.
 *
 * Matched on all three of its own methods rather than on `sendMessage` alone - that name is far
 * too common for a duck-typed registry to claim on sight, and a wrong match here would wrap
 * somebody else's object and meter its calls as Gemini traffic.
 */
export const geminiChatRecipe = {
  vendor: 'gemini',
  metrics: GEMINI_METRICS,
  // Gemini's own name for it, which is the one its invoice shows.
  totalTokensMetric: 'totalTokenCount',
  matches: (client) =>
    hasMethod(client, ['sendMessage']) && hasMethod(client, ['sendMessageStream']) && hasMethod(client, ['getHistory']),
  // Literal paths, so naming this recipe explicitly types the context onto these two methods
  // whatever the client looks like. Without it the overlay fell back to `ChatOf<T>`, which keys
  // off `getHistory` - right for detection, wrong here: an explicit recipe never consults
  // `matches`, so `wrapClient` patches and strips the context on a two-method client the types
  // were refusing it on.
  methods: [
    // Named for where the call comes from rather than for the object it was reached through: a
    // bare `gemini.sendMessage` says nothing about which API it is, and the event name is what
    // somebody has to recognise when configuring a meter to filter on it.
    { path: ['sendMessage'] as const, event: 'gemini.chats.sendMessage', extractUsage, attachStream },
    { path: ['sendMessageStream'] as const, event: 'gemini.chats.sendMessageStream', extractUsage, attachStream },
  ],
} satisfies ClientRecipe<(typeof GEMINI_METRICS)[number]>;

/**
 * A pre-call estimate based on the requested output ceiling, which Gemini nests under `config`.
 *
 * Opt-in, on the same terms as the Anthropic one: the default asks for a single unit, because an
 * estimate that overshoots denies calls the budget could have afforded, and the ingest that
 * follows corrects the balance anyway.
 */
export const estimateFromMaxOutputTokens = (tokensPerUnit = 1) =>
  estimateUnits((params: any) => params?.config?.maxOutputTokens ?? 0, tokensPerUnit);

/** One of the metric names Gemini reports. */
export type GeminiMetric = MetricsOf<typeof geminiRecipe>;

/** What a mapper reads off a Gemini call: those names, each possibly absent. */
export type GeminiMetrics = MetricsFor<typeof geminiRecipe>;
