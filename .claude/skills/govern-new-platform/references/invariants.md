# What every binding owes, whichever category it is

Read this alongside `provider.md` or `gateway.md`. These rules are shared, and most of them exist
because the obvious implementation was shipped first and turned out to meter the wrong thing.

## Contents

- [The rules the tests enforce](#the-rules-the-tests-enforce)
- [The rules only the headers enforce](#the-rules-only-the-headers-enforce)
- [The lists that must be edited together](#the-lists-that-must-be-edited-together)
- [Verifying](#verifying)

---

## The rules the tests enforce

**No vendor package may be imported under `src/`.**
`test/module-boundaries.test.ts` holds an allowlist of four packages, each pinned to the one file
allowed to name it. A recipe is *data* — method paths, extractors, a duck-typed `matches` — which
is what lets `src/index.ts` export every binding without pulling a single vendor SDK in at
runtime. Type the response shapes structurally in the binding's own `types.ts`; never
`import type { ... } from '@vendor/sdk'`.

**Every runtime export is a compatibility promise.**
A symbol added to `src/index.ts` must be added to the `PUBLIC` list in
`test/public-surface.test.ts`. The list is the diff that makes a wider public surface something
somebody chose.

**Event names are published API.**
`test/event-names.test.ts` pins every name this package ships, and the README's event table is
read by `test/docs-contract.test.ts`. A Stigg raw-events meter filters on these strings, so
changing one breaks a customer's meter silently. The name is derived — `${vendor}.${path.join('.')}`
— so `openrouter.chat.completions.create` falls out of the recipe rather than being typed.

**Metric names must match where they are read from.**
`test/metrics-contract.test.ts` checks that a recipe's declared `metrics` list is the set its
extractors can actually produce, and that the metric type stays a union rather than widening back
to `string`. Two lists describing one thing drift; this is what makes that a test failure instead
of a billing one.

**Docs name only APIs that exist.**
`test/docs-contract.test.ts` checks the identifiers the README, `docs/guide.md` and
`examples/README.md` name against what the package exports. Documentation is the one contract with
no compiler behind it.

**Examples, scripts and docs agree.**
`test/examples-contract.test.ts` compares `examples/`, the `example-*` scripts in `package.json`,
and the docs that list them. Adding an example means all three.

**Every new recipe ships an example. Not optional.**
A recipe is the only part of a binding nobody can try. Tests prove it reads a shape; an example is
what proves the shape is the one the vendor's own client actually produces — the Mistral mock
looked right and its generated client rejected the whole stream, because `finishReason` is
required-but-nullable and a hand-written fixture had no reason to know that. Run it against the
mock before you believe either.

Five places, all compared against each other, so four of them is a failing test:

| Where | What |
| --- | --- |
| `examples/client/<name>.ts` | the example itself — model it on the closest existing one |
| `package.json` | the `example-client-<name>` script |
| `examples/README.md` | the runnable table |
| `README.md` | the example table in the run-the-examples section |
| `examples/shared/mock-server.ts` | a route serving the vendor's **real** wire format |

Plus `.env.template` and the README's env table: `AGENT_SDK_<VENDOR>_API_KEY` and
`AGENT_SDK_<VENDOR>_MODEL`, falling back to the bare vendor name. A self-hosted vendor has no key —
Ollama takes `AGENT_SDK_OLLAMA_HOST`, and its presence is what selects the real server over the
mock.

The vendor SDK goes in **`devDependencies`**, never `dependencies`: the examples import it, `src/`
must not, and that split is what keeps one import enough for every binding.

Make the mock serve what the vendor serves, including the inconvenient parts. Groq's streamed
chunks carry no top-level `usage` and Ollama omits its counters from every chunk but the last; a
mock that tidied either up would make the example pass while the binding stayed broken.

---

## The rules only the headers enforce

**One vendor per payer, however many wires reach it.**
The Vercel AI Gateway speaks OpenAI chat completions, OpenAI responses, Anthropic Messages, *and*
the AI SDK model interface — and all four are `vendor: 'vercel'`, because one account is billed
whichever is used. Which wire a call arrived on is already visible in the event name
(`vercel.chat.completions.create` against `vercel.doGenerate`), so it does not need to be a second
vendor as well. Splitting one payer into two vendors splits one customer's bill across two meters.

**Report in the platform's own field names, verbatim.**
A number published under a vendor's own field name has to reconcile against that vendor's own
dashboard. `prompt_tokens` for OpenAI-shaped vendors, `input_tokens` for Anthropic-shaped,
`promptTokenCount` for Gemini. This holds even when a generated SDK camelCases the wire:
the Mistral binding reads `promptTokens` off the client and reports `prompt_tokens`, because it is
one account, one dashboard, one invoice — so one vocabulary, and a meter keeps matching whichever
client the application holds. That rename is what `MISTRAL_PATHS` and `pickRenamedMetrics` in
`token-usage.ts` are for; every other vendor is reported under the key it was read from, which is
why `METRIC_PATHS` is a list of paths and that one is a map.

**A surface with a different shape needs a reader of its own.**
Reusing an extractor across shapes that merely look alike is the trap that meters every call at
zero: the extractor finds none of its fields, reports nothing, and no test notices because
nothing threw. If the counters are nested differently or named differently, write a second reader
and reuse the *names*, not the parser.

**Never declare a metric the platform cannot report.**
It types a pricing table against a number that never arrives. The Vercel gateway deliberately
omits `cost` from its metric list for exactly this reason — Vercel's price is reachable only
through an eventually-consistent `getGenerationInfo({ id })` that cannot sit in a synchronous
extractor, so the recipe carries the generation id as a dimension instead and lets spend be
reconciled out of band.

**An absent counter is absent, not zero.**
A platform reports cache reads only when there were some. A streamed call cannot carry a
header-borne cost, because headers go on the wire before the model has produced a token.
Substituting a zero bills a real call at nothing and looks like data.

**The default estimate is 1, and that is deliberate.**
The pre-call check asks "is there any budget left at all?". An estimate that overshoots denies
calls the budget could have afforded, and the ingest that follows corrects the balance anyway. Any
richer estimate is opt-in through the recipe's options.

**A total overlaps everything beneath it.**
`totalTokensMetric` names which metric is the total so a caller pricing metrics can avoid
double-charging. Omit it for a platform that publishes no total and whose counters overlap — there
is nothing honest to put there.

**Refuse loudly rather than meter silently.**
A recipe whose paths resolve on nothing, a denomination that cannot divide, a gate asked for a
negative amount — each produced a call that looked governed and was not. `test/recipe-guards.test.ts`
is where these refusals live.

**Scale fractional money into whole units with the float guard.**
Stigg ingests whole units, so a price in fractional currency needs a denomination small enough not
to round every call up to 1 (micro-units by default, exposed as `unitsPerCredit` / `unitsPerDollar`).
Use the existing idiom — `Math.max(1, Math.ceil(Number((cost * units).toPrecision(12))))` — because
`0.00108 * 1e6` is `1080.0000000000002` and `ceil` would bill the extra unit.

---

## The lists that must be edited together

A binding is done when every one of these names it. Omitting one either fails a contract test or,
worse, ships a binding nobody can find.

| Where | What to add |
| --- | --- |
| `src/bindings/client/<providers\|gateways>/<name>/` | `<name>-recipe.ts`, `types.ts`, `index.ts` |
| `src/index.ts` | the recipe factory, its `*Metric` / `*Metrics` types, its `*RecipeOptions` |
| `test/public-surface.test.ts` | the runtime export, in `PUBLIC` |
| `src/stigg-agent-sdk.ts` | `DEFAULT_RECIPES`, **in the right order** — see `gateway.md` |
| `test/event-names.test.ts` | every event name the recipe can emit |
| `test/metrics-contract.test.ts` | any new metric constant added to `token-usage.ts` |
| `test/<name>-recipe.test.ts` | the recipe's own tests |
| `README.md` | bindings table, event table, and the OpenAI-wire table if it speaks that wire |
| `examples/client/<name>.ts` | an example — **required**, see [the rule](#the-rules-the-tests-enforce) for all five places |
| `package.json` | the matching `example-client-<name>` script |
| `examples/shared/mock-server.ts` | a route serving the vendor's real wire format |
| `examples/README.md` | the runnable table |
| `.env.template` | `AGENT_SDK_<VENDOR>_API_KEY` / `_MODEL`, or a host for a self-hosted one |

## Verifying

```bash
yarn test        # contract tests included
yarn build       # type-checks src, test and examples first
```

Verify against the real client where you can, not only against a hand-built fixture. The
Mistral binding was checked against the SDK's own published types — `UsageInfo` really is
camelCase, and `FIMCompletionResponse` really does carry the same block as `ChatCompletionResponse`
— which is the kind of thing a fixture written from the same misreading as the recipe will happily
confirm. A generated client that *validates* what it
parses will also reject a mock missing fields the real API always sends.
