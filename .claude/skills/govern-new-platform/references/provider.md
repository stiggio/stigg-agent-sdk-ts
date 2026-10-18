# Planning a provider binding

A provider bills you and serves models it made. There is no cost figure to recover and no routing
to attribute — what the binding has to get right instead is the **vocabulary**, the **surfaces**,
and the parts of the client that look governable and are not.

Read `invariants.md` too. This file covers only what is specific to a provider.

## Contents

- [Before anything: does it need a recipe](#before-anything-does-it-need-a-recipe)
- [The recipe](#the-recipe)
- [One client can need two recipes](#one-client-can-need-two-recipes)
- [Vocabulary](#vocabulary)
- [Surfaces, and saying no to some](#surfaces-and-saying-no-to-some)
- [Streaming](#streaming)
- [Calls the SDK makes on your behalf](#calls-the-sdk-makes-on-your-behalf)
- [Plan template](#plan-template)

---

## Before anything: does it need a recipe

If the provider is reached by pointing the `OpenAI` client at a base URL, `openAIRecipe` already
matches it by shape and governs it today. A recipe of its own buys exactly two things: a vendor
name of its own on the event, and access to whatever its response carries that the OpenAI
projection drops. If the provider publishes nothing beyond the standard counters, the honest
answer is a dimension on the context rather than a file in this package:

```ts
stiggContext: { customerId, dimensions: { provider: '<name>' } }
```

Say this out loud if it applies. It is a real outcome and it is the one the README already
recommends for Groq, Together, Fireworks, DeepSeek, xAI, Perplexity, vLLM and Ollama.

A recipe starts earning its place when the provider ships **its own SDK with its own shape**
(different method paths, different usage block), or publishes counters the OpenAI four cannot
express — Gemini's five-way split, Anthropic's disjoint cache counters.

---

## The recipe

Files under `src/bindings/client/providers/<name>/`:

- `<name>-recipe.ts` — a constant `<name>Recipe` when it takes no options, a factory when it does.
  Anthropic and OpenAI are constants; Gemini exports two recipes and an estimate helper.
- `types.ts` — response shapes, typed structurally. No vendor imports; `module-boundaries.test.ts`
  will fail on one.
- `index.ts` — re-exports.

The header is where the design is argued. Say which call styles exist, which ones this covers,
and — explicitly — which billable surfaces it does **not** cover and why. That last paragraph is
not an apology; it is what stops someone assuming a wrapped client governs everything the provider
can charge for.

`matches` is duck-typed on shape. A provider reached through its own SDK can match on shape alone,
because the shape is distinctive. Require enough signals that the recipe cannot claim somebody
else's object: the Gemini chat recipe requires all three of its markers for exactly this reason,
and `isLanguageModel` requires five.

## One client can need two recipes

This is the trap worth checking for early, because the symptom is a client that looks governed and
is not.

`new GoogleGenAI()` builds its chat module internally and each `Chat` keeps a private reference to
the *unwrapped* module. So a chat created from a wrapped client still calls the original,
unpatched `models.generateContent` — gating `models.*` alone leaves every conversation ungoverned
while the wrapper reports success. The fix was a second recipe, so the chat is wrapped in its own
right:

```ts
const chat = stigg.wrap(ai.chats.create({ model }));
```

Nothing meters twice, because the chat reaches the unwrapped module by construction.

**Check for this in any provider SDK that offers a stateful conversation, session or thread
object.** The question to ask of the client's source: does the helper object call back through the
client you wrapped, or through a reference it captured before wrapping? If it captured one, it
needs its own recipe and its own entry in `DEFAULT_RECIPES`.

## Vocabulary

Report the provider's own field names, verbatim — a number published under a vendor's field name
has to reconcile against that vendor's dashboard. Check `src/bindings/shared/token-usage.ts`
first: if the provider's block matches an existing vocabulary, reuse the constant rather than
declaring a parallel list.

| If the usage block looks like | Use |
| --- | --- |
| `prompt_tokens` / `completion_tokens` | `OPENAI_CHAT_METRICS`, `fromOpenAIUsage` |
| `input_tokens` / `output_tokens` with a Responses shape | `OPENAI_RESPONSES_METRICS`, `fromResponsesUsage` |
| Anthropic's four, cache counters disjoint from input | `ANTHROPIC_METRICS`, `fromFlatTokenUsage` |
| Gemini's nested `usageMetadata` | `GEMINI_METRICS`, `fromGeminiUsage` |
| Something genuinely new | A new constant in `token-usage.ts` — and a matching entry in `test/metrics-contract.test.ts` |

Set `totalTokensMetric` to whichever name is this provider's total, so a caller pricing metrics
can avoid double-charging the tokens underneath it. Omit it only when the provider publishes no
total and its counters overlap — there is nothing honest to put there.

Mind what each name *means*, not just how it is spelled. `input_tokens` excludes the cache
counters beside it; `prompt_tokens` includes `cached_tokens`. Reporting one under the other's name
makes the dashboard disagree with the invoice.

## Surfaces, and saying no to some

Each method the provider exposes is its own `MethodRecipe` and its own event name
(`${vendor}.${path.join('.')}`). A meter filtering on one sees nothing from the other, so list
every surface the application might call, and say in the README which names a meter should match.

Govern **generation**. Decline the rest, and say so in the header. Embeddings, image, video,
speech, transcription, token counting, batches, caches and live sessions are all billable and all
count in units these token metrics do not describe — metering them with a token recipe reports a
number that is wrong rather than missing. The escape hatch for a caller who needs one is naming
their own recipe at `wrap(client, { recipe })`, and the header should point at it.

If the provider also ships through the Vercel AI SDK, append `languageModelMethods({ metrics })`
to the recipe and match with `isLanguageModelFrom(client, '<provider>')`. Same vendor, same
meters, new wire — pass the metrics function for *this* provider's vocabulary, because the AI SDK
normalizes everything into one usage object and the recipe's job is to undo that.

## Streaming

A streamed call reports usage later, so it takes `attachStream` rather than `extractUsage`. Wrap
the iterator **in place** and call `ingest` once, at completion, so one completed response emits
exactly one measurement.

Which helper depends on what the SDK hands back:

- Async iterator (`for await`) → `meterStream`
- `ReadableStream` → `meterReadableStream`
- Both at once, as some generated SDKs do → `meterStream` patches the iterator in place, which
  covers the documented `for await`. A consumer calling `getReader()` bypasses it; the stream is
  the caller's object and cannot be swapped for a metered copy. Say so in the header rather than
  leaving it to be discovered.

A stream that fails before reporting usage should report **nothing**, not a zero — the AI SDK
surfaces failures as an `error` part, so a broken stream still ends normally and a zero would bill
a call that cost something at nothing.

## Calls the SDK makes on your behalf

Two things to look for, both of which make the metered number disagree with the invoice:

**An internal leg of another wrapped method** must not be gated twice. Mark it with
`passthrough(params, options)` — only the recipe can tell, because vendors flag these differently.

**A tool loop the SDK drives itself.** Gemini's `generateContent` runs up to `maximumRemoteCalls`
rounds and returns only the last response; the earlier rounds were billed and their counts are
gone by the time the SDK returns. Streamed, every round's usage arrives and is summed. Not
streamed, there is nothing left to read. If the provider does this, the rounds can be counted but
not priced — report what can honestly be said and state the gap in the header, as `afcRounds` does.

---

## Plan template

Write the plan as concrete edits. Fill in from the research and the user's answers:

1. **`src/bindings/client/providers/<name>/types.ts`** — the usage block and response shapes,
   structurally typed.
2. **`src/bindings/shared/token-usage.ts`** — only if the vocabulary is genuinely new: the metric
   constant, the `from<Name>Usage` parser, and the `COMPUTED_TOTALS` / `METRIC_PATHS` entries.
3. **`src/bindings/client/providers/<name>/<name>-recipe.ts`** — header naming what is covered and
   what is deliberately not; `matches`; one `MethodRecipe` per surface with `extractUsage` or
   `attachStream`; `metrics`; `vendor`; `totalTokensMetric`.
4. **A second recipe** if a stateful chat/session object captures an unwrapped reference.
5. **`src/bindings/client/providers/<name>/index.ts`** — re-exports.
6. **`src/index.ts`** — the recipe(s), `<Name>Metric`, `<Name>Metrics`, any estimate helper.
7. **`src/stigg-agent-sdk.ts`** — add to `DEFAULT_RECIPES`. Order matters less than for a gateway,
   but keep it after the gateways so a gateway client is never claimed as direct traffic.
8. **`test/public-surface.test.ts`** — the runtime exports, in `PUBLIC`.
9. **`test/event-names.test.ts`** — every event name the recipe can emit.
10. **`test/metrics-contract.test.ts`** — any new metric constant, and the typing assertions.
11. **`test/<name>-surfaces.test.ts`** — per surface: usage extracted from a real-shaped response;
    the streamed path emitting exactly one measurement at completion; a stream that fails
    reporting nothing; the chat recipe gating a chat if there is one.
12. **`README.md`** — the bindings table, the event-name table with this provider's counters, and
    prose for anything surprising (an ungoverned surface, an unpriceable tool loop).
13. **An example — required, not optional.** `examples/client/<name>.ts`, the
    `example-client-<name>` script in `package.json`, both README tables, and a
    `examples/shared/mock-server.ts` route serving the provider's real wire format, plus the
    `.env.template` entries. All five are compared against each other, so four is a failing test:
    see **Every new recipe ships an example** in `invariants.md` for the checklist. Run it against
    the mock before you believe the recipe — that is what catches a shape the vendor's own client
    rejects.

Flag the open questions rather than burying them. For a provider, the two that usually bite are
which surfaces are in scope and whether a stateful helper object needs its own recipe.
