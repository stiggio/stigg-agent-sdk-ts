# `@stigg/agent-sdk-js` — agent governance for the agent stack (TypeScript)

A thin SDK that gates and meters agent runs against [Stigg](https://stigg.io), plus runnable
examples for the two layers it binds to: a client you wrap, and a gateway you call or operate.
The examples are not part of the published package - they live beside the source in this
repository, and the paths below are relative to its root.

```bash
npm install @stigg/agent-sdk-js      # or: yarn add @stigg/agent-sdk-js
```

Requires Node 22 or later. Ships CommonJS with type declarations, and a `./internal` subpath for
the engine seam.

Everything here runs **with no API keys and no Stigg account**: a built-in mock stands in for
both the LLM vendors and the Stigg API.

## What the SDK does

One core lifecycle, several bindings, one swappable engine.

```
construct  →  register?  →  wrap  →  [ check? → execute → ingest ]  →  deregister?
    |            |           |
 per env,    optional:     the boundary you declare; the client goes through
 one SDK     a write       Stigg, and check and ingest happen inside it
             about the
             agent
```

**There is no run to open.** What governs a call — who it is for, what gates it, what it reports —
is a `stiggContext`, given once at `wrap` as the default for that client and again inside any
single call's own parameters to override it. One wrapped client therefore serves every customer
and every agent, which is what a multi-tenant server actually needs.

**No subscription required.** A customer's credit balance can be checked and drawn with no
subscription in place at all, so the shortest path from nothing to a working integration is a
credit currency and a `customerId` — no plan, no entitlement wiring, no catalog modelling first.
Model the pricing once the metering is real.

`check` happens when the context names an `entitlement`. Omit it and the call meters only: the
request still goes out, and it is still billed.

`register` and `deregister` are optional. `register` hands back the agent id it was given — a
convenience for the next line, not a handle the rest depends on. Skip them and the agent has no
entity — calls still work, and checks and usage apply to the customer. That is deliberate:
**wrapping a client must never depend on governance being available**, and a governance-only
request (a budget, a parent) is the only thing that fails without it.

- **The agent is the entity; attribution is a dimension.** An entity upsert is idempotent and
  cheap, but it is still a write — which is why provisioning is `register()` and never something a
  gated call carries. Naming an `agentId` in a context attributes to that agent; it does not
  create it.
- **A denial is a returned decision, not an exception** — it names which entity blocked and what
  to do about it. Refusing is a commercial event (a top-up, an upgrade), not an incident. That is
  `client.stigg.check()`. A **wrapped** call has nowhere to return one — the vendor's signature
  owns the return type — so there it is raised as `AccessDeniedError`, and `stigg.denial(err)`
  turns it back into the decision. A context that named no `entitlement` never gets there: it has
  nothing to check against, so every call goes out and `check()` hands back an allow whose
  `source` is `'unenforced'`.
- **Metering never breaks the call.** Ingest failures are swallowed into the `onError` hook;
  enforcement failures are never swallowed. They are deliberately separate code paths.

```ts
import { StiggAgentSDK } from '@stigg/agent-sdk-js';

// One per environment, and everything it takes is one object with a working default. The key can
// be left out entirely to read STIGG_SERVER_API_KEY, or replaced by a `baseUrl` that needs none -
// a local stand-in, or a self-hosted Stigg:
//   new StiggAgentSDK({ apiKey, baseUrl: 'https://stigg.internal', ingest: 'sync' })
// A bare key is the shorthand for the common case.
const stigg = new StiggAgentSDK(apiKey);

// Provisioning the agent: a write, so it is its own call. A *bare* registration is remembered per
// process and skipped the second time; this one carries a parent and a budget, and a call that
// changes placement always writes - two differing instructions cannot be collapsed into one.
await stigg.register({
  customerId: 'customer-acme',
  agentId: 'agent-support-bot',
  // The entity: what the agent IS. `register` is the one call that creates it, so it is the one
  // call that needs the type.
  entityTypeId: 'agent',
  // The assignment: what it may SPEND, and where it sits. One object, because it is one write -
  // over (entity x entitlement), which is why the entitlement is required inside it.
  budget: {
    entitlement: { currencyId: 'credits' },
    parentId: 'team-eng',
    limit: 5,
    apply: 'on-create',
    cadence: 'P1M',
  },
});

// Governs the client and hands back a COPY whose calls are checked and metered. The client you
// passed keeps working ungoverned.
//
// Wrapped with no customer, this client serves every tenant the process handles, and each call
// names the one it is for. The types enforce that: `customerId` is **required** on every call
// through a client wrapped this way.
const govClient = stigg.wrap(new Anthropic(), {
  stiggContext: {
    // Naming an entitlement is the enforcement switch. Omit it and the calls meter without
    // gating - every call still goes out, and nothing is ever refused.
    entitlement: { currencyId: 'credits' },
    // What the calls are attributed to. The attribution key is required with it - a guessed one
    // resolves no entity, and the spend would land on the customer looking exactly like a call
    // that was never governed. The parent needs no key: governance walks the chain up from here.
    agentId: 'agent-support-bot',
    attributionKey: 'agentId',
    // Optional extra attribution, sent verbatim on every check and ingest.
    // dimensions: { tenantId: 'acme-eu' },
  },
});

// The call site is otherwise untouched; the context rides in the vendor's own parameter object
// and is lifted back out before the vendor sees it.
await govClient.messages.create({
  model,
  max_tokens: 1024,
  messages,
  stiggContext: { customerId: 'customer-acme' },
});

await govClient.messages.create({
  model,
  max_tokens: 1024,
  messages,
  stiggContext: { customerId: 'customer-globex' },
});

// Drains what is still in flight and reports what this client did.
await govClient.stigg.flush();
```

**Nothing in the setup path touches the network.** The constructor is synchronous and so is
`wrap` — resolving the engine is a probe that decides which transport serves which operation, and
both start that work rather than waiting on it. The first call that needs an engine awaits the
same probe; every call after it finds one already resolved. So there is no awaited setup step to
forget, and no call that silently runs ungoverned because setup had not finished.

The latency moves rather than disappearing: whoever makes the first call pays for the probe. If
you would rather pay at boot — and have a bad key fail there instead of inside a request —
`await stigg.init()` forces it early and hands back the resolution.

Construct one per environment and share it. A second one for the same environment is wasted
rather than wrong — and only partly a second client: `Stigg.initialize` keeps one global Node SDK
instance per process and hands it back when the API key matches, so the entitlement cache and its
socket are shared while the governance REST client is not. See
[what the cache promises](#what-the-cache-promises) for what that means for `close()`.

**A customer given at `wrap` is a default, not a scope.** One wrapped client can serve every
tenant, so naming a customer there means every call that does not override it bills *that* one —
correctly, silently, and forever if the client outlives the request. It is the right shape for a
single-tenant process and the wrong one for a server, which is why the example above leaves it
out and the types then require it per call.

```ts
// Single-tenant process: a default is fine, and calls need no context at all.
const client = stigg.wrap(new Anthropic(), {
  stiggContext: { customerId: 'customer-acme', entitlement: { currencyId: 'credits' } },
});
await client.messages.create({ model, max_tokens: 1024, messages });
```

`wrap()` also starts warming the entitlement cache when the context names both a customer and an
entitlement, so the calls that follow read local state. That is an optimization and it is not
awaited: a failure there is logged, never thrown, and the first check falls back to asking the
server.

**`wrap` returns a copy.** The object you built is never mutated and keeps working ungoverned,
which is what makes the governed one safe to hand around. Wrapping an already-governed client
throws rather than stacking a second gate on it — there is nothing a second wrap could mean now
that the context travels with each call.

`stigg.check(context)` and `stigg.report(context, metrics)` are the same two operations with no
client to wrap, which is how a framework binding and the gateway reach them.

`wrap()` recognises the vendor from the client's own shape — there is nothing there the SDK
cannot see for itself — and throws, naming the vendors it knows, rather than handing back a
client that quietly meters nothing. Pass `recipe` to name an adapter for a vendor it cannot
identify.

**Gemini chats are wrapped in their own right.** `new GoogleGenAI()` builds its chat module over
the `models` module it holds — `new Chats(this.models, …)` — and every `Chat` keeps that
reference privately, so a chat created from a wrapped client still calls the original, unpatched
module. Wrapping the client governs `models.generateContent` and `models.generateContentStream`;
wrap the chat to govern a conversation:

```ts
const ai = new GoogleGenAI({ apiKey });
const models = stigg.wrap(ai, { stiggContext });     // one-shot calls
const chat = stigg.wrap(ai.chats.create({ model }), { stiggContext }); // a conversation
```

Nothing is metered twice by doing both, because the chat never reaches the patched module.

**Automatic function calling is metered in full only when you stream.** Hand Gemini a callable
tool and its SDK drives the tool loop for you — up to ten model calls for one
`generateContent` — and returns only the last response. Streamed, every round's chunks reach
this SDK and are summed; measured on the wire, 122 + 170 = 292 of 292. Not streamed, the earlier
rounds are discarded inside the vendor's SDK before it returns, so there is nothing left to read:
a two-round call billed at 315 reports 181. That turn is still metered for what it can see, is
tagged `gemini_afc_rounds`, and **raises** through `onError` with the shortfall named — it is
counted in `summary().ingestFailures` rather than left for you to notice. To meter every round,
stream the call, or set `automaticFunctionCalling: { disable: true }` and drive the loop
yourself, which makes each round a call this SDK gates and meters on its own.

Decisions describe themselves, so printing one takes no import: `decision.summary` is the log
line, `decision.message` is what to tell the user. `stigg.denial(err)` turns a caught error back
into a decision, or `undefined` when it was a real failure.

### What a call checks, and what it reports

They are different things, and keeping them apart is what lets Stigg do the pricing instead of
your application.

`entitlement` is what a call **checks** — a credit currency or a metered feature. Reporting goes
somewhere else entirely: to `usageMapper`, one report per metric, named and valued as the vendor
stated them. Stigg converts a credit-backed feature into the currency on its own side, which is
what the API was built for and why `usage.report` answers with a credit balance.

```
[governance] ingest input_tokens=12 cache_read_input_tokens=3 output_tokens=46 ... credits=0.94
```

`entitlement` is also **the enforcement switch**. Name one and every call through the wrapped
client is checked before it leaves. Leave it out and nothing is checked at all: no budget is
pre-fetched, no call can be refused, and the calls meter exactly as gated ones do. There is no
separate flag, because a context with nothing to check against cannot be enforced and a flag would
only be a second place for the two to disagree — so the client says which it is, once, at `wrap`:

```
[stigg] this client named no entitlement, so nothing is checked and no call can be refused - it
meters only. Pass `entitlement: { currencyId: 'credits' }` in `stiggContext`, at the wrap or on a
call, to gate it.
```

The default is the vendor's own vocabulary, so **each recipe is where you read what that vendor
meters** — `anthropicRecipe.metrics` is the list, typed as literals rather than as `string`.

#### The events this SDK reports, and the meters to put behind them

Reporting defaults to Stigg's event API (see the ingest table further down), and an event is
matched by **name**. A wrapped client names each call after the call — the name someone reading
that vendor's API would have guessed — so these are what your meters filter on:

| Binding                   | Event name                                                          | Fields a meter can aggregate                                                              |
| ------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Anthropic                 | `anthropic.messages.create`                                         | `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `total_tokens` |
| OpenAI (chat)             | `openai.chat.completions.create`                                    | `prompt_tokens`, `completion_tokens`, `cached_tokens`, `total_tokens`                     |
| OpenAI (responses)        | `openai.responses.create`                                           | `input_tokens`, `output_tokens`, `cached_tokens`, `total_tokens`                          |
| Groq                      | `groq.chat.completions.create`                                      | the OpenAI chat set — one surface, because Groq serves no Responses endpoint              |
| OpenRouter                | `openrouter.chat.completions.create`, `openrouter.responses.create` | the OpenAI set, plus `cost`                                                               |
| OpenRouter — its own SDK  | `openrouter.chat.send`, `openrouter.responses.send`                 | the same set — `@openrouter/sdk` camelCases its counters and the recipe reads them back under the wire's names, so one meter covers either client |
| LiteLLM                   | `litellm.chat.completions.create`, `litellm.responses.create`       | the OpenAI set, plus `cost`                                                               |
| Mistral                   | `mistral.chat.complete`, `mistral.chat.stream`, `mistral.chat.parse`, `mistral.chat.parseStream`, `mistral.fim.complete`, `mistral.fim.stream`, `mistral.agents.complete`, `mistral.agents.stream` | `prompt_tokens`, `completion_tokens`, `total_tokens` — the **wire's** names, not the camelCase its SDK renames them to |
| Ollama                    | `ollama.chat`, `ollama.generate`                                    | `prompt_eval_count`, `eval_count`, `total_tokens` — self-hosted, so these measure tokens you served yourself rather than tokens anyone billed you for |
| Bedrock                   | `bedrock.send`                                                      | `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheWriteInputTokens`, `totalTokens` — and no `cost`, because Bedrock states none |
| Databricks                | `databricks.chat.completions.create`, `databricks.responses.create`, `databricks.query` | `prompt_tokens`, `completion_tokens`, `total_tokens`, `reasoning_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` — and no `cost`, because Databricks states none on any response. `databricks.query` is the first-party client and reports the first three only; it camelCases the wire and is renamed back, so both clients report one vocabulary |
| Databricks — external models | `databricks-external.chat.completions.create`, `databricks-external.responses.create`, `databricks-external.query` | the same six. A separate vendor name because a different party is invoiced, and it is **opt-in**: the two routes are indistinguishable from the client, so naming it asserts something the SDK cannot check |
| Cloudflare                | `cloudflare.chat.completions.create`, `cloudflare.responses.create`, `cloudflare.messages.create`, `cloudflare.ai.run` | the OpenAI set plus `cache_read_input_tokens`, `cache_creation_input_tokens` — the union across every wire it serves, and a call reports only the names its own route sent. No `cost` and no neuron count: neither Workers AI nor AI Gateway states a price on any response, so `cf_aig_log_id` rides as a dimension instead. A gateway **cache hit meters nothing**, because nobody was billed for it |
| TypeSafe                  | `typesafe.systemOne`                                                | `input_tokens`, `output_tokens`, `total_tokens`                                           |
| Gemini                    | `gemini.models.generateContent`, `gemini.models.generateContentStream` | `promptTokenCount`, `candidatesTokenCount`, `cachedContentTokenCount`, `thoughtsTokenCount`, `toolUsePromptTokenCount`, `totalTokenCount` |
| Gemini — a chat           | `gemini.chats.sendMessage`, `gemini.chats.sendMessageStream`        | the same five                                                                             |
| A gateway, out of process | `<vendor>.proxied`                                                  | whatever the proxy declared its vendor to be                                              |

Every metric rides the event under its own name, so **one event feeds as many features as you
configure meters for** — that is why a turn costs one request however many counters it reported.
The vendor's own usage block rides along too, under a `raw.` prefix and flattened to scalars, so a
meter can read a counter this SDK does not name yet: `raw.cache_creation_input_tokens`, or a
gateway's `raw.cost` before it was scaled into whole units. Your run's `dimensions` — `agentId`
and anything else you set — are on the same event, and win any key the vendor also used.

A meter to put behind one of them, in Stigg's own terms:

```jsonc
{
  "aggregation": { "function": "SUM", "field": "output_tokens" },
  "filters": [
    { "conditions": [{ "field": "eventName", "operation": "EQUALS", "value": "anthropic.messages.create" }] },
  ],
}
```

> **An event reported against a name with no meter behind it returns 200 and meters nothing.** The
> event API answers with an acknowledgement, not a balance, so nothing downstream can notice on its
> own — configure the meter first, or run with `ingest: 'sync'`, which does answer.

> **None of this applies to a metric named after a credit currency.** That draws the wallet
> directly and needs no event name and no meter — see [the three ingest paths](#the-engine-sdk-first-rest-to-complete)
> below. If you are using `unitsPerTokens(currencyId, …)`, that is the path you are on, and the
> table above is about the other one.

#### Pricing them yourself

`weightedMetrics` turns a price-per-metric table into the mapper:

```ts
import { anthropicRecipe, weightedMetrics } from '@stigg/agent-sdk-js';

const govClient = stigg.wrap(new Anthropic(), {
  stiggContext: {
    customerId,
    entitlement: { currencyId: 'data_credit' },
    // A whole credit per input token, half a credit per output token, cache reads free.
    usageMapper: weightedMetrics(anthropicRecipe, 'data_credit', {
      input_tokens: 1,
      output_tokens: 0.5,
    }),
  },
});
```

The table is keyed to that recipe's own names, so a typo does not compile. Naming a metric is
optional — an unpriced one is free, and a table that prices nothing meters nothing.

A weight is the price of **one unit** of that metric, so the example above is half a credit per
output token. Pass `{ per: 1000 }` when the numbers read better per thousand.

It also handles the two things a hand-written mapper has to get right: a turn that measured
nothing reports nothing rather than a zero, and a counter the response omitted is absent rather
than zero. For one number without weights, `unitsPerTokens(id, n)` is the short form.

Neither rounds. A credit currency takes a fractional amount, so a turn worth a fifth of a unit
costs a fifth of one — rounding it up would be this SDK's arithmetic on your price. **A feature is
the exception**: `POST /api/v1/usage` answers `400 Expected integer, received float`, so when the
target is a feature rather than a currency, pick a unit size that divides or round in your own
mapper.

> **An attributed run is the other exception, and the SDK rounds it up for you.** Per-entity usage
> is counted in whole units — governance validates its ingest as an integer and increments a Redis
> counter with `HINCRBY` — so a fractional amount is rejected there *while the wallet still moves*.
> The agent's budget would stop advancing with nothing in the response to say so.
>
> So a run naming an `agentId` rounds its wallet draw up, and logs that it did. A run with no
> entity attribution reports the fraction as measured. Denominate the currency finely enough that
> one unit is small, and the overcharge is noise; this goes away when governance counts fractions.


#### Writing the mapper yourself

A calculation a weights table cannot express is an ordinary function, and each binding exports the
type of what it receives — `AnthropicMetrics` for Anthropic, and `OpenAIMetrics`,
`OpenRouterMetrics`, `LiteLLMMetrics`, `GeminiMetrics` and `TypeSafeMetrics` for the rest:

```ts
import type { AnthropicMetrics, Metrics } from '@stigg/agent-sdk-js';

const dataCredits = ({ metrics = {} }: { metrics?: AnthropicMetrics }): Metrics => {
  const billable = (metrics.output_tokens ?? 0) * 5 + (metrics.input_tokens ?? 0);
  return billable > 0 ? { data_credit: Math.ceil(billable / 100) } : {};
};
```

Every counter is optional, because a vendor reports cache reads only when there were some. Use
`AnthropicMetric` for one name rather than the table, and `MetricsOf<typeof someRecipe>` /
`MetricsFor<typeof someRecipe>` for a recipe you built yourself.

#### The overlap you have to know about

Vendors disagree about whether cached tokens are already counted inside the input total, and the
metrics are reported **verbatim** — because a number published under a vendor's own field name
has to match that vendor's own dashboard.

Every vendor also reports a **total**, which by definition overlaps everything beneath it. Where
the vendor publishes one it is reported verbatim — `total_tokens`, or `totalTokenCount` for
Gemini. Anthropic and TypeSafe publish none, so theirs is summed from counters that are disjoint,
which is the only case where the SDK adds anything up. **Price the total or the breakdown, never
both.**

| Vendor           | Input-ish key   | Includes cached tokens?                                  |
| ---------------- | --------------- | -------------------------------------------------------- |
| Anthropic        | `input_tokens`  | **No** — cache keys are separate; the four sum correctly |
| OpenAI Chat      | `prompt_tokens` | **Yes**, includes `cached_tokens`                        |
| OpenAI Responses | `input_tokens`  | **Yes**, includes `cached_tokens`                        |
| LangChain        | `input_tokens`  | **Yes**, includes both cache keys                        |
| Gemini           | `promptTokenCount` | **Yes**, includes `cachedContentTokenCount`           |
| Databricks       | `prompt_tokens` | **Unverified** — Databricks documents neither direction. It spells the pair with Anthropic's names (`cache_read_input_tokens`), whose counters sit beside the input count, so this SDK does not subtract them. Its stated `total_tokens` is read rather than computed, so the total is right either way — price the total, or verify against your own endpoint before pricing the breakdown |

Gemini overlaps in both directions at once, so it is worth stating separately: pricing
`promptTokenCount` **and** `cachedContentTokenCount` double-bills the cached tokens, while
`thoughtsTokenCount` and `toolUsePromptTokenCount` sit *outside* the two headline counters —
leave them out of a table and a reasoning model's thinking tokens, usually the expensive half of
the answer, are billed at nothing. The four add back up to the vendor's own `totalTokenCount`,
which is the arithmetic to check a table against.

So if you price `prompt_tokens` **and** `cached_tokens` for OpenAI traffic, you bill the cached
ones twice. Price one or the other, or use `normalizedMetrics` — four disjoint counters under
SDK-owned names, comparable across every vendor:

```ts
import { normalizedMetrics } from '@stigg/agent-sdk-js';
stigg.wrap(client, { stiggContext: { customerId, usageMapper: normalizedMetrics } });
```

OpenAI also has no raw name for cache creation, so its default set is three keys and a
`cache_creation_input_tokens` feature stays at zero for OpenAI traffic.

#### The failure that looks like success

A feature only drains a credit budget when your catalog maps it to that currency. Until it does,
every call succeeds, every ingest returns `ok`, and the budget never moves — so the call gates on a
number nothing spends. Stigg answers those reports with no credit balance, so the first one says
so:

```
[stigg] reported input_tokens but the response carried no credit balance - this feature is not
mapped to credits, so the budget this run checks against will never drain. Map it in Stigg, or
report to the currency directly.
```

### Bindings, by solution

Organised by where the customer's business logic sits, not by vendor. Each has a generic core;
vendor directories are thin recipes over it.

The word "gateway" below does two jobs, so the directories do not: one you **call** is an ordinary
client and lives in `bindings/client/gateways/`, beside `bindings/client/providers/` because both
are recipes over the same wrapper. One you **operate** is the opposite binding and lives in
`bindings/proxy/`.

| Binding                                          | Reached as                                           | Mechanism                                                                                | Can refuse?                                |
| ------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------ |
| Client                                           | `stigg.wrap(client, { stiggContext })`               | gates the recipe's methods on a copy, vendor matched by shape                            | Yes — when the context names an entitlement |
| Client — a gateway you **call**                  | `wrap(client, { recipe: openrouterRecipe() })`       | same wrapper; the recipe bills `usage.cost` and attributes `response.model`              | Yes, same as any client                    |
| Client — a gateway whose cost is in a **header** | `wrap(client, { recipe: litellmRecipe() })`          | same wrapper; the recipe bills `x-litellm-response-cost` and attributes `response.model` | Yes, same as any client                    |
| Client — a gateway that states **no** price      | `wrap(client, { recipe: databricksRecipe() })`       | same wrapper; no `cost` metric at all, and the model that answered is attributed instead | Yes, same as any client                    |
| Gateway you **operate** (`bindings/proxy`)       | `client.stigg.headers()` → `stigg.ingestFromHeaders(...)` | attribution travels as `x-stigg-*` headers; `vendor` names the shape it observed         | **No — ingest only**                       |

A client run that names no `entitlement` lands in the same column as the gateway — metering
without a gate — except that it is in-process, and naming one turns it back on.

#### Providers that speak the OpenAI wire format

A large part of the ecosystem exposes an OpenAI-compatible API rather than one of its own:
OpenRouter, LiteLLM, Groq, Together, Fireworks, DeepSeek, xAI and Perplexity, plus self-hosted
servers like vLLM and Ollama. There is no separate client to install for any of them. You point
the OpenAI client at their base URL, and `wrap` matches on the **shape of the client**, not on who
is at the other end of it:

```ts
// Groq, Together, Ollama, vLLM - anything OpenAI-compatible
const client = stigg.wrap(
  new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY }),
  { stiggContext: { customerId, entitlement: { currencyId: 'credits' } } },
);
```

So `OpenAI` in that line names the **wire format**, not the vendor being billed. What differs is
which recipe matches, and that decides what you can meter:

| Pointed at                           | Recipe matched     | Events it emits                   | Reports                           |
| ------------------------------------ | ------------------ | --------------------------------- | --------------------------------- |
| `https://openrouter.ai/api/v1`       | `openrouterRecipe` | `openrouter.*` (see below)        | tokens, `cost`, model that served |
| the LiteLLM proxy URL you configured | `litellmRecipe`    | `litellm.*`                       | tokens, `cost`, model that served |
| `https://api.groq.com/openai/v1`     | `groqRecipe`       | `groq.*`                          | tokens only                       |
| a Databricks workspace `/serving-endpoints`  | `databricksRecipe` | `databricks.*`                    | tokens, model that answered       |
| `https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1` | `cloudflareRecipe` | `cloudflare.*`                    | tokens only                       |
| `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/<provider>` | `cloudflareRecipe` | `cloudflare.*`                    | tokens, model that served, log id |
| anything else OpenAI-compatible      | `openAIRecipe`     | `openai.*`                        | tokens only                       |

Each of those covers **both OpenAI surfaces**, and a surface is its own event: Chat Completions
reports `<vendor>.chat.completions.create` and the Responses API reports
`<vendor>.responses.create`. A meter filtering on one sees nothing from the other, so configure the
one your code actually calls - or both. The full list is in the event table earlier in this file.

OpenRouter and Groq are recognised by their **hostname** and LiteLLM by the base URL you hand its
recipe. For the two gateways that is what earns them a `cost` the token counters cannot recover;
for Groq, which publishes no cost, it earns a vendor name of its own. Everything else is OpenAI as
far as this SDK can tell, because that is all the client reveals.

> **One exception to that last row.** Given no base URL of its own, the LiteLLM recipe falls back to
> looking for `litellm` anywhere in the client's URL - a self-hosted proxy has no canonical hostname
> to compare against, the way OpenRouter's own hostname does. So an unrelated OpenAI-compatible
> endpoint that happens to contain the string, like `https://api.acme.com/litellm-compat/v1`, is
> claimed by it and reports under `litellm.*`. Pass `recipe: openAIRecipe` to settle it explicitly.

**The consequence worth planning for:** every provider in that last row reports under `openai.*`.
A raw-events meter cannot tell Together from Fireworks from OpenAI itself, and neither can a
per-provider budget. If you need them separated, give the call a dimension of your own —

```ts
stiggContext: { customerId, dimensions: { provider: 'groq' } }
```

— and filter the meter on it, or pass a recipe with its own `vendor` name, which changes the event
name to match.

> **Groq has its own recipe, and its own vendor name.** Groq is reached either through its own
> `groq-sdk`, which defaults to `https://api.groq.com`, or through an `OpenAI` client pointed at
> `https://api.groq.com/openai/v1`. Same hostname, so `groqRecipe` claims **both** and both report
> `groq.chat.completions.create`. One surface only: Groq serves no Responses endpoint, so there is
> no Groq event for that API and there never will be.
>
> On both routes its streamed chunks carry no top-level `usage` — the counters ride `x_groq.usage`
> on the final chunk — and that read is shared with `openAIRecipe` rather than copied, so a Groq
> deployment on some *other* base URL (`GROQ_BASE_URL` pointed at a proxy or a regional endpoint)
> is still metered correctly even though the hostname guard declines it. It reports `openai.*` in
> that case; name `recipe: groqRecipe` at `wrap` to attribute it to Groq explicitly.
>
> Note the same field means something else on a **buffered** response — `x_groq.usage` is hardware
> cache statistics (`dram_cached_tokens`, `sram_cached_tokens`) there, not tokens — so only the
> streamed reader consults it, and only when it names a token counter.
>
> Groq also reports a per-model `usage_breakdown` for its compound systems, where one request runs
> several models. That is **not** metered: a measurement carries one set of metrics and one
> `dimensions` object, so there is nowhere to put two models' counts without attributing both to
> one of them. The request's own `usage` total is reported, which is the honest number.
>
> ⚠️ **Migration.** Groq traffic used to report under `openai.chat.completions.create`, because
> shape was all that matched it. It now reports `groq.chat.completions.create`. **A Stigg
> raw-events meter configured against the `openai.*` name for Groq traffic will stop matching** —
> add `groq.chat.completions.create` to that meter, or pass `recipe: openAIRecipe` at `wrap` to
> keep the old name. Traffic to OpenAI itself is unaffected.

> **Mistral, both ways round.** Mistral ships its own client, and `mistralRecipe` governs it —
> `chat.complete`/`chat.stream`/`chat.parse`/`chat.parseStream`, `fim.*` and `agents.*`, eight
> surfaces over one usage block, reported as `mistral.*`. Point an `OpenAI` client at
> `https://api.mistral.ai/v1` instead and you get the row above: `openAIRecipe` matches it and it
> reports `openai.*`. Both report the same counter **names** — `prompt_tokens` and the rest — because
> the vendor SDK's camelCase is a rename of that same wire, and one account should not read as two
> vocabularies. Mistral is matched by **shape**, not hostname: it serves from `api.mistral.ai`,
> `api.eu.mistral.ai` and `api.us.mistral.ai`, and a per-request `serverURL` can override all three.
>
> Two Mistral call styles are **not** governed, and both are quiet about it. Every method also
> exists as a standalone function taking the client as an argument — `chatComplete(client, …)` from
> `@mistralai/mistralai/funcs/` — which never goes through the patched method, so such a call is
> neither gated nor metered. And a streamed response read through `getReader()` rather than
> `for await` bypasses the meter, because the stream is your object and cannot be swapped for a
> metered copy. Call the methods, and iterate the stream.

> **OpenRouter, both ways round.** OpenRouter's own `@openrouter/sdk` package is a different shape
> — its methods are `chat.send` and `responses.send`, and its counters come back camelCased — but
> `openrouterRecipe` declares those surfaces too, so `wrap` governs that client as well as an
> `OpenAI` one pointed at `https://openrouter.ai/api/v1`. Four event names rather than two
> (`openrouter.chat.send` beside `openrouter.chat.completions.create`), because a meter filtering
> on one must not catch the other. Both report the **wire's** counter names: the SDK's camelCase is
> a rename of the same block, and one account should not read as two vocabularies.

> **Databricks, as two recipes over one wire.** Databricks model serving is OpenAI-compatible, so
> an `OpenAI` client pointed at `https://<workspace>/serving-endpoints` is all the application
> holds. Two things make it worth a recipe rather than the `openAIRecipe` row above.
>
> The first is that **the request does not say what model is being used.** On the classic route the
> `model` argument is a serving *endpoint* name the customer chose — `prod-chat` is legal, and it
> may front DBRX, a Llama that Databricks hosts, or somebody's OpenAI account. The response's
> `model` field is what recovers that, and `databricksRecipe` puts it on the ingest as a dimension.
> Metered as `openai.*` the whole workspace is one undifferentiated stream.
>
> The second is **who gets invoiced**, and this one is a decision you have to make rather than one
> the SDK can make for you. Foundation Model API traffic (`databricks-claude-*`, `databricks-llama-*`,
> DBRX) is billed to your Databricks account in DBUs. An endpoint configured as an *external model*
> carries your own OpenAI or Anthropic key, and that provider invoices your account with them —
> Databricks only estimates the figure, into `system.ai_gateway.external_model_spend`, and says it
> is not liable for the difference. Same host, same path, same request, same response: **nothing on
> the client side distinguishes them.** So the split is an assertion, not a detection —
>
> ```ts
> stigg.wrap(client, { recipe: databricksExternalRecipe() });
> ```
>
> — and `databricksExternalRecipe` is deliberately not registered by default, because an assertion
> nobody made is not a default. Assert wrongly and nothing throws: DBU traffic lands on the meter
> you keep for upstream spend, or vice versa. If one workspace serves both kinds, wrap one client
> per kind.
>
> **Neither recipe reports a `cost`**, on either route — Databricks states no price on any
> response, in the body or in a header. Reconcile spend against its system tables out of band.
>
> Recognised by workspace host **and** serving path: the three public families
> (`cloud.databricks.com`, `azuredatabricks.net`, `gcp.databricks.com`) crossed with
> `/serving-endpoints` or `/ai-gateway/mlflow/v1`. The host alone is every Databricks API there is,
> most of which are not inference. A PrivateLink or custom-DNS workspace matches neither half —
> give the recipe its base URL: `databricksRecipe({ baseUrl })`.
>
> **Both clients, one recipe.** `@databricks/sdk-modelservingquery` is Databricks' own JS client,
> and its whole surface is one method — `client.query({ name, messages })`, reported as
> `databricks.query`. It is a second *surface* rather than a second vendor, because one Databricks
> account is billed whichever client the application imported; splitting it would split one bill
> across two meters. It is recognised automatically, so `wrap(client)` governs it with no recipe
> named.
>
> Three things are worth knowing before you choose it. It **camelCases the wire** — its generated
> parser turns `prompt_tokens` into `promptTokens` — so this SDK renames the counters back, and
> both clients report `prompt_tokens` for the same workspace. It reports **three counters, not
> six**: its usage type has no cache pair and no `reasoning_tokens`, which are absent rather than
> zero. And it **cannot stream**, and its request carries no `tools`, `response_format` or
> `stream_options` — so for real work the OpenAI-compatible route above is still the richer one,
> and it is what the Databricks docs show.
>
> One method serves chat, completions, embeddings and custom-model predictions, so the event name
> cannot say which ran. The response's own `object` field rides as a `response_object` dimension
> so a meter can tell them apart.

> **Cloudflare Workers AI is a provider, not a gateway.** Cloudflare runs these models on its own
> GPUs and invoices them to your Cloudflare account, which is the test this package applies. The
> `@cf/<author>/<model>` ids look like a reseller's catalogue and are not one — `<author>` is who
> *made* the weights, not who bills for running them, and `@cf/openai/gpt-oss-120b` is OpenAI's
> open-weights release at Cloudflare's own per-token rate rather than OpenAI API pricing. (`@hf/…`
> ids are Workers AI too, and about an eighth of the catalogue, so anything keying on the `@cf/`
> prefix alone is wrong.)
>
> Two clients reach it and both report under `cloudflare`, because one account is billed
> whichever is held: an `OpenAI` client pointed at
> `https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`, and the `cloudflare` package's own
> client, whose method is `ai.run(model, inputs)`. Two event names, so a meter can tell the wires
> apart.
>
> **It publishes no cost and no neuron count.** Cloudflare bills Workers AI in Neurons and puts a
> neuron figure on no response at all — not the binding's, not either REST route's — so converting
> tokens to Neurons needs Cloudflare's per-model rate table, which this SDK does not hold and will
> not guess at. Tokens are what the response states and tokens are what it reports.
>
> ⚠️ **A streamed `ai.run` is gated but not metered.** Asked for a stream, that method hands back
> the raw SSE byte stream rather than parsed chunks, so there is no object with a `usage` block to
> read — and the recipe attaches no reader rather than one that would find nothing and report a
> zero. The call is still checked before it leaves; the measurement afterwards is what is missing.
> Stream through the OpenAI-compatible route instead, where usage arrives on the final chunk, or
> call `ai.run` buffered.
>
> `ai.run` also carries **no model dimension**, because the model is that method's first argument
> and an extractor only ever sees the result. Nothing is lost that matters — Workers AI does not
> route, so what was asked for is what ran — but a meter that wants it can have it from
> `stiggContext: { dimensions: { model: '@cf/meta/llama-3.1-8b-instruct' } }`.
>
> One wrinkle about that hostname: `…/ai/v1` also serves **third-party** models (a bare
> `author/model` id like `openai/gpt-4.1`) routed through AI Gateway and paid out of Cloudflare
> credits under Unified Billing. Those land on this recipe, which is defensible rather than a
> mistake — Cloudflare is the payer either way — and the model is on the response, so a meter that
> wants them apart can split on it. AI Gateway proper lives on `gateway.ai.cloudflare.com` and has
> its own recipe.

Client recipes are data — method paths and usage extractors — so the factory wires the built-in
ones with no vendor package loaded. Nothing in `src/index.ts` pulls a vendor package in at
runtime, which is what keeps one import enough for every example.

"Gateway" covers two deployments that want opposite bindings, and the split is worth naming.

**A gateway you call** — OpenRouter as a service — returns its response into your process, and
that response carries two things no token counter can recover: the credits it actually charged
(`usage.cost`) and which model actually served after fallback routing (`response.model`). That is
an ordinary client, so it takes the ordinary client binding: `openrouterRecipe()` reads both, and
the call is gated before it ever leaves. It **is** registered by default and matched by base URL
ahead of `openAIRecipe`, because reading a richer response is not a decision anyone needs to opt
into — out of the box it reports the same token metrics the plain OpenAI recipe would, and adds
`cost`, the model that served and the gateway's own request id.

Tokens and money are different features, so both are reported and you price each in Stigg. When a
response carries no cost, the key is simply absent rather than substituted with something else.
`unitsPerCredit` (micro-credits by default) is the denomination of the `cost` feature.

**A gateway you call whose price is in a header** — LiteLLM Proxy — is the same binding with one
wrinkle worth knowing before you budget on it. LiteLLM prices every call itself, but writes the
number into `x-litellm-response-cost` rather than into the body, so `litellmRecipe()` reads the
response and not just the payload. Headers go on the wire before the model has produced a token,
so a **streamed** call cannot carry a cost at all — tokens survive a stream fine, a price does
not. So a non-streaming call reports its tokens **and** a `cost`, while a streamed one reports
the tokens alone — the same features either way, one of them simply missing where the protocol
cannot carry it.
That is the protocol rather than a limit of the binding, and the gateway example prints both
numbers side by side so the difference is not a surprise in an invoice.

**A gateway you operate** — a proxy fronting services that may not even be Node — is the one that
is not a binding in the full sense, and deliberately so: it is out-of-process and sees
**requests, not runs**. It cannot provision, cannot check against run-scoped state, and cannot
archive, and there is no client object out there to wrap. So the lifecycle splits across the
boundary — the application checks in-process, attribution travels as headers,
and the proxy only ingests. Governance never leaves the process.

A recipe reports a `Measurement`, not just token counts: `metrics` carries the vendor's own field
names and is what gets reported (a gateway puts its real spend in `metrics.cost` there, where a
token mapper would only lose it), `raw` rides an event's dimensions under a `raw.` prefix,
`dimensions` are merged over the context's own, and `idempotencyKey` lets the vendor's own request
id — stable across _its_ retries, which a local step counter cannot be — replace the default
`correlationId:step`. Returning
a bare `TokenUsage` still works and stays the common case.

### The engine: SDK first, REST to complete

Two clients, composed per operation, and the SDK tells you which one it picked:

```text
[governance] mode=governance check=rest report=node-sdk provisioning=rest (governance enabled)
```

| Operation           | Client                                | Why                                                                      |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| `check`             | `@stigg/typescript` (REST, `v1-beta`) | only the REST surface takes `dimensions` and returns governance `chains` |
| `ingest`            | `@stigg/node-server-sdk`              | it has the in-memory cache, and usage reporting is the hot path          |
| provision / archive | `@stigg/typescript` (REST, `v1-beta`) | entities and assignments exist only on the governance surface            |

**Ingest has three paths, not two.** `ingest` picks between the first two — but **the name of the
metric decides first**, and that is the rule to read before the table:

> **If a metric is named after the credit currency the context checks, it draws the wallet
> directly, in both modes.** No event, no usage report, and no meter involved — `ingest` then only
> decides whether the call waits for the balance to come back.

That is the path `unitsPerTokens(currencyId, …)` puts you on, and it is why switching `async` and
`sync` can look like it changes nothing: both deduct credits, neither needs a metered feature, and
the only visible difference is whether `IngestResult.creditsConsumed` is filled in. Metrics named
after a **feature** take one of the other two columns.

|                        | A metric named after the currency       | `ingest: 'async'` — the default     | `ingest: 'sync'`                                     |
| ---------------------- | --------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| Call                   | `consumeCredits` / `consumeCreditsAsync` | `events.report` / `reportEvent`     | `usage.report` / `reportUsageBulk`                   |
| Latency and rate limit | follows the mode                        | low latency, much higher limit      | higher latency, lower limit                          |
| The next check         | includes it under `'sync'`; lags under `'async'` | lags while Stigg aggregates         | already includes the spend                           |
| What you send          | a currency id and an amount             | the call, as one event              | a `featureId` and a whole-number `value`, per metric |
| Meter type             | **none — the wallet is drawn directly** | **Raw events**, configured in Stigg | calculated / incremental                             |
| What comes back        | a balance under `'sync'`, nothing under `'async'` | an acknowledgement        | a credit balance                                     |

Async sends **one event for the whole turn**, every metric on its own dimension, because one event
feeds any number of meters — fanning out per metric buys nothing and costs a request each. Sync
sends one report per metric, batched into a single bulk call.

There is no event path from a raw event to a currency, which is why the first column exists at all:
a usage report takes only a `featureId`, so a currency has to be drawn rather than metered.

> **`'async'` does not settle the wallet before the next check.** `consumeCreditsAsync` is
> reconciled into the balance on Stigg's side, and nothing invalidates the entitlement cache in the
> meantime — so a check made immediately after a draw can still see the balance from before it, and
> approve a call the wallet could not afford. `'sync'` is what closes that window.

**The match is exact.** A metric draws the wallet only when its name *equals* the currency the
context checks. `unitsPerTokens('data_credit', …)` against `entitlement: { currencyId: 'credits' }`
is a feature report named `data_credit`, not a draw on `credits` — so it needs a meter like any
other feature, and silently meters nothing until one exists.

**A check asks for one unit by default, so the last call can overshoot.** The budget is allowed
below zero, and `'async'` adds a reconciliation window on top — calls made while Stigg is still
turning events into usage all see the same balance. Worst case is therefore one call's cost, plus
whatever lands in that window.

Narrow it per call with the recipe's own estimator, which asks for what the call could cost
instead of for one unit:

```ts
import { anthropicRecipe, estimateFromMaxTokens } from '@stigg/agent-sdk-js';

stigg.wrap(new Anthropic(), {
  stiggContext: { customerId, entitlement: { currencyId: 'credits' } },
  // `estimate` reads the call's own parameters - here `max_tokens` - and asks for that many
  // units instead of one. The ingest that follows still corrects the balance.
  recipe: {
    ...anthropicRecipe,
    methods: anthropicRecipe.methods.map((method) => ({ ...method, estimate: estimateFromMaxTokens(1_000) })),
  },
});
```

It is opt-in on purpose: an estimate that overshoots denies calls the budget could have afforded,
and the ingest that follows corrects the balance anyway. For a hard cap, pair it with
`ingest: 'sync'` — `'async'` trades exactness for throughput, so it is not what a hard cap is for.

**Which to reach for.** Credits when the unit is money-like, shared across features, pre-purchased
or topped up — one balance, many consumers. A metered feature when the limit is per-capability,
belongs to a plan entitlement, or resets on a billing cadence. Both when a plan grants a feature
allowance and a credit pool covers the overage; name the feature in `usageMapper` and let Stigg's
consumption mapping convert it, rather than pricing it in code.

**Governance is optional.** Not every account has it. When it is missing the factory falls back
to customer-level enforcement on the Node SDK alone — every example still runs, denials just name
the customer instead of an agent:

```text
[governance] mode=customer-level check=node-sdk report=node-sdk provisioning=unavailable
             (403 GovernanceNotEnabled - customer-level fallback)
```

Nothing declares this. The client asks the account once at init and acts on the answer, so there
is no second source of truth to disagree with the first. Without governance, checks and usage
reporting still work at the customer level — and `register()` follows that split. A bare
registration warns and hands the id back: it asked for an identity, and a call needs none. A call
carrying a **budget or a parent** throws, because there is nowhere to write the assignment, and a
run that looked governed with a budget that was never written is the failure worth refusing.

### What the cache promises

**This package has no cache.** Checks are served by the Node server SDK's entitlement cache, which
is a far better one than a TTL over decisions could be:

- it writes the server's own measurement response back into cached usage, so a report that moved
  the budget is visible to the very next check;
- it invalidates on realtime updates, so a plan change or a cancelled subscription lands without
  waiting out a window;
- it applies usage-period resets at read time, rather than serving a number that expired;
- it falls back to configured entitlements when Stigg is unreachable;
- and it can be backed by **Redis**, so sibling processes share one view instead of each holding
  their own.

All of that is configured through `cache`, which is the Node SDK's own configuration passed
straight through — `redis`, `memoryCacheMaxSizeBytes`, `entitlementsFallback`,
`creditEntitlementsFallback`, `realtimeUpdatesEnabled`, `enableEdge`, `offline`:

```ts
const stigg = new StiggAgentSDK(apiKey, {
  cache: { redis: { host: 'redis', port: 6379, environmentPrefix: 'prod', ttl: -1 } },
});
```

`wrap()` primes it for the customer in the context, loading their whole entitlement state rather
than one decision — so a later check against a different entitlement is warm too, and each check
is evaluated against the amount it actually asks for.

#### If your application already has a Stigg client

Pass it, and the SDK uses it instead of building one:

```ts
const stigg = new StiggAgentSDK(apiKey, { client: appStiggClient });
```

This is about **ownership**, not deduplication. `Stigg.initialize` already keeps one global
instance per process and hands it back when the API key matches — so without `client` you may
well be handed the application's own, and nothing observable can tell that apart from a client
the SDK just built: the instance exposes neither its configuration nor its identity. Since
`close()` nulls that global and tears the runtime down, `stigg.close()` would then take the
application's cache and socket with it.

A client passed here is **borrowed and never closed**; one the SDK builds is owned and closed. It
replaces only the cached half — the governance REST client is still built from the API key,
because the Node SDK has no governance surface — and it is mutually exclusive with `cache`, which
configures a client the SDK is no longer building.

An earlier design cached decisions here for a `cacheTtlMs` (default 5s). It duplicated the
machinery above and degraded it: a cached allow outlived the report that spent the budget, could
not hear an invalidation, and did not carry the requested amount in its key — so an allow fetched
for one unit authorized a call asking for ten thousand. `cacheTtlMs` is now **ignored**, and
warns when set.

**The one path that caches nothing is an attributed governance check** — a check carrying
dimensions, which is how per-agent budgets are enforced. It resolves an entity, which only the
governance API can do, so it is a live call every time. That is why
`RestGovernanceEngine.capabilities.strictCheck` is `true`: there is no window in which two
processes can each approve the same budget. It costs a round trip per call, which is the right
trade in front of a multi-second model call and the wrong one to optimize away with a stale allow.

None of it applies to a context that names no `entitlement`: it warms nothing and checks nothing,
because it never asks.

#### How this SDK identifies itself

**There is no telemetry.** Nothing is emitted on a schedule, nothing is batched in the background,
and there is no second network path that could fail or leak. The SDK names itself on the requests
it was already making, and that is all:

| Half | What it sends |
| --- | --- |
| Cached reads and ingest (GraphQL) | `apollographql-client-name: agent-sdk-js`, `apollographql-client-version: <this package's version>` |
| Governance (REST) | `X-SDK-CLIENT-NAME: agent-sdk-js`, `X-SDK-CLIENT-VERSION: <this package's version>` |

No customer data, no prompts, no model output — the package name and its version, next to the
process identity (`X-SDK-INSTANCE-ID` and friends) the Node SDK already sends.

Two things it deliberately does **not** do. It does not send a distinct `source`: that header is a
server-side enum with no member for this SDK, the API groups on it, so a new member is a server
change that has to land first — the client name carries the distinction until then. And it does not
rename a client you passed in through `client`, which keeps whatever name your application gave it;
`Stigg.initialize` may also hand back a client your application built first, in which case the same
applies. Both cases are correct — the name belongs to whoever owns the client.

## 0. Try it with no setup at all

```bash
yarn example-client-anthropic    # or -openai, -gemini, -openrouter, -litellm
yarn example-gateway             # or example-gateway-litellm
```

The full list, with what each one demonstrates, is in [section 6](#6-run-the-examples).

The vendor mock speaks the real wire formats, so the vendor SDK parses a genuine response and
every field the examples read (`usage`, `model`, `cost`, tool calls) is populated. The Stigg mock
implements real entities, budgets and hierarchy, so a demo genuinely hits a denial and can name
which entity caused it. Only the prose and the storage are fake.

To force the mocks even when keys **are** present — useful when a key is valid but the account
has no credits — set `AGENT_SDK_OFFLINE=1` in `.env`.

## 1. Prerequisites

- **Node 22** — the version in the repo's `.nvmrc`. Check with `node --version`.
- **Yarn 4** via Corepack:

  ```bash
  corepack enable
  ```

## 2. Get an Anthropic API key (optional)

Used by the client examples. Skip this to stay on the offline mock.

1. Go to **<https://console.anthropic.com>** and sign up or sign in.
2. Open **Billing** and add a payment method or buy credits. A brand-new org has no balance,
   and requests fail with `400 credit balance is too low` until you do.
3. Open **Settings → API Keys** and click **Create Key**. Give it a name.
4. **Copy the key immediately** — it is shown only once. It starts with `sk-ant-`.
5. Put it in `.env` as `AGENT_SDK_ANTHROPIC_API_KEY` (step 5 below).

The examples default to the `claude-opus-5` model. Override with `AGENT_SDK_ANTHROPIC_MODEL` in `.env`.

## 3. Gateway access (optional)

Used by the gateway examples. Skip this entirely to stay on the offline mock, which speaks both
wire formats — including LiteLLM's header-borne cost, and its absence on a stream.

### OpenRouter

1. Go to **<https://openrouter.ai>** and sign in with Google, GitHub, or email.
2. Open **Settings → Credits** and add credits (a few dollars is plenty for these examples).
3. Go to **<https://openrouter.ai/keys>** and click **Create Key**.
4. Optionally set a **credit limit** on the key — a hard cap on what this key can ever spend.
   Recommended while experimenting.
5. Copy the key (starts with `sk-or-`) and put it in `.env` as `AGENT_SDK_OPENROUTER_API_KEY`.

The example asks for `AGENT_SDK_OPENROUTER_MODEL` and falls back through
`AGENT_SDK_OPENROUTER_FALLBACK_MODELS`.
Both are model slugs — browse or verify them at **<https://openrouter.ai/models>**.

### LiteLLM

There is no signup: a LiteLLM proxy is something you host, so this is a URL rather than an account.

1. Start one — `pip install 'litellm[proxy]'`, then `litellm --model gpt-4o --port 4000`. It needs
   the upstream key for whatever it fronts (`OPENAI_API_KEY`, and so on) in its own environment.
2. Put its URL in `.env` as `AGENT_SDK_LITELLM_BASE_URL`. The default is `http://localhost:4000` —
   note a **local Stigg** uses port 4000 too, so move one of them if you run both.
3. Put a virtual key in `AGENT_SDK_LITELLM_API_KEY` if the proxy requires one (`--master_key`, or
   a key minted through `/key/generate`). Leave it blank and the examples use the offline mock.

`AGENT_SDK_LITELLM_MODEL` is a **model group** from the proxy's own config, not a provider slug.
A group is free to resolve to a different deployment, and that difference is the routing drift
the examples flag.

## 4. Point at a Stigg environment (optional)

One key and one URL, pointed at whichever environment you mean. The key is environment-bound, so
it and the URL always move together — there is no separate profile name to keep in sync with them.

| Environment | `STIGG_BASE_URL`                                                |
| ----------- | --------------------------------------------------------------- |
| production  | `https://api.stigg.io` (the default when the variable is blank) |
| staging     | `https://api-staging.stigg.io`                                  |
| local       | `http://localhost:4000`                                         |

Get a server key for that environment from **app.stigg.io → Integrations → API keys** and put it
in `STIGG_API_KEY`.

**Leave `STIGG_API_KEY` blank and everything still runs** against a built-in Stigg mock, with no
account at all — the same rule the vendor keys follow. `AGENT_SDK_OFFLINE=1` forces the mocks even
when keys are present, which is what you want when a key is valid but the account has no credits.

Two things adjust themselves to the URL, so you do not configure them twice:

- The mock answers both transports — REST and `/graphql` — so the engine resolves exactly as it
  does against a real account: governance checks and provisioning over REST, ingest and
  unattributed checks over the Node SDK. The line the SDK prints at startup says which it picked.
- Against `localhost` the Node SDK's edge cache and realtime socket are switched off, because a
  local API serves neither and the SDK maps a localhost base to edge port 3060.

### Seed the environment

```bash
yarn example-setup                    # 5-credit agent budget
yarn example-setup --agent-limit 6    # raise it
yarn example-setup --no-governance    # seed without entities
yarn example-setup --archive          # clean up, bottom-up
```

`--no-governance` describes this invocation only: it skips the entity and budget steps, so the
account is seeded without a tree. It is not a mode the examples inherit — offline, each one starts
its own mock, and that mock has governance enabled. To see customer-level enforcement end to end,
use an account that genuinely has no governance.

Idempotent per step, and safe to re-run — but not safe to run twice **at once**: the credit grant
reads the balance and then grants, with nothing between the two, so two concurrent invocations can
both decide the pool is short and both fund it. Run it once at a time. Steps are gated by what the
account actually has:

| Step                       | Needs governance? | What it does                                                                     |
| -------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| 1. customer                | no                | creates it if missing                                                            |
| 2. credit pool             | no                | grants credits when the balance is below `--pool-min`, guarded by a balance read |
| 3. entity types + entities | **yes**           | `team` (attribution key `teamId`) and `agent` (`agentId`)                        |
| 4. assignments             | **yes**           | One agent per example, each = 5 per `P1M`, all parented to `team-research`       |

Each example registers **its own agent** — `agent-support-bot-anthropic`, `-openai`, `-gemini`, `-openrouter`,
`-litellm`, and the base `agent-support-bot` for the gateway examples. Budgets attach to the agent, so
sharing one would mean running the OpenAI example spends what the Anthropic example had left. The
shared parent team keeps the ancestor rule demonstrable, and its budget is sized so one agent
exhausting itself does not block the others:

```text
team-research (team) usage=0/30
  agent-support-bot            usage=0/5
  agent-support-bot-anthropic  usage=0/5
  agent-support-bot-openai     usage=0/5
  agent-support-bot-openrouter usage=0/5
  agent-support-bot-litellm    usage=0/5
```

**The client examples provision their own agent** — the seed prepares the account (entity types,
the parent team, a funded pool). That is the more realistic split: an admin sets up the account, an
application provisions its own agents at runtime. `register()` carries it:

One caveat about the cap, because the two halves can overlap. `apply: 'on-create'` is exactly that
— on create — so if the seed has already written an assignment for that agent, the application's
cap is **not** applied and the seeded one stands. That is the point of the option (an admin who
raises a budget out of band should not have it stamped back on every process start), but it does
mean `--agent-limit` on the seed wins over the number below. Leave `apply` at its default
(`'always'`) if the application is meant to own it.

```ts
await stigg.register({
  customerId: 'customer-acme',
  agentId: 'agent-support-bot-anthropic',
  entityTypeId: 'agent',
  budget: {
    // A budget is written over (entity x entitlement), so the entitlement is required here: a
    // cap has nowhere to land without one.
    entitlement: { currencyId: 'credits' },
    parentId: 'team-research',
    limit: 5,
    cadence: 'P1M',
  },
});
```

A cap is **not** a field on the entity. An entity is just a node — id, type, display name,
metadata — and a limit is an _assignment_ over `(entity × capability)`. So that one call is two
idempotent upserts underneath: `PUT …/entities` then `PUT …/assignments`. It is also why
`parentId` rides the assignment rather than the entity — and sits inside `budget` for the same
reason: the hierarchy is per-capability, so one agent can sit under different parents for
different currencies.

`budget.limit` is tri-state — a number caps it, `null` tracks without blocking (the observe-only
rollout), and omitting it leaves whatever is already assigned untouched. Governance requires both
it and `cadence` when it creates a budget, which is why both are passed above.

The pool is deliberately much larger than the agent budget, so a demo denial comes from the
agent's own cap (`BudgetExceeded`) rather than an empty wallet (`InsufficientCredits`). Those are
different products — an upsell versus an escalation to whoever set the budget — and the SDK keeps
them distinct all the way to the message the user sees.

## 5. Configure and install

Two files, deliberately separate. Both are git-ignored, and each has a committed `.template`
beside it to copy from.

**`.env`** (from `.env.template`) — credentials and SDK configuration. Everything in it is either a
secret or a real setting you would also make in your own application.

**`examples/demo.env`** (from `examples/demo.env.template`) — the demo's fixtures: the tenant, the
team, the agent. Nothing in it is configuration — a real application knows its tenant from the
request it is serving, never from an env file.

Neither file is required **against the mocks**: every fixture default is compiled into the
examples, so with no files and no keys at all they still run end to end. Those defaults are
mock-only. Once `STIGG_API_KEY` is set the examples stop inventing ids for an environment they
can actually write to — `AGENT_SDK_DEMO_CUSTOMER_ID` becomes required, and the rest degrade to a
smaller demo (see the fixtures table below).

`.env` is loaded first and is never overwritten, so setting one of the `AGENT_SDK_DEMO_*` names
there (or exporting it in your shell) overrides the fixture without editing `demo.env`.

### `.env` — credentials and endpoints

| Variable                               | Default                                  | Purpose                                                                                                                              |
| -------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENT_SDK_ANTHROPIC_API_KEY`          | — (falls back to `ANTHROPIC_API_KEY`)    | Layers 1 and 3                                                                                                                       |
| `AGENT_SDK_ANTHROPIC_MODEL`            | `claude-opus-5`                          | Claude model for layers 1 and 3                                                                                                      |
| `AGENT_SDK_OPENAI_API_KEY`             | — (falls back to `OPENAI_API_KEY`)       | The OpenAI client example                                                                                                            |
| `AGENT_SDK_OPENAI_MODEL`               | `gpt-5`                                  | Model for the OpenAI client example                                                                                                  |
| `AGENT_SDK_GROQ_API_KEY`               | — (falls back to `GROQ_API_KEY`)         | The Groq client example. Blank ⇒ the offline mock                                                                                     |
| `AGENT_SDK_GROQ_MODEL`                 | `llama-3.3-70b-versatile`                | Model for the Groq client example                                                                                                    |
| `AGENT_SDK_MISTRAL_API_KEY`            | — (falls back to `MISTRAL_API_KEY`)      | The Mistral client example. Blank ⇒ the offline mock                                                                                  |
| `AGENT_SDK_MISTRAL_MODEL`              | `mistral-small-latest`                   | Model for the Mistral client example                                                                                                 |
| `AGENT_SDK_OLLAMA_HOST`                | — (falls back to `OLLAMA_HOST`)          | Ollama is self-hosted, so a **host** stands in for the key: blank ⇒ the offline mock, set ⇒ that server (default `http://127.0.0.1:11434`) |
| `AGENT_SDK_OLLAMA_MODEL`               | `llama3.3`                               | Model for the Ollama client example — must be pulled on that server first                                                            |
| `AGENT_SDK_OPENROUTER_API_KEY`         | — (falls back to `OPENROUTER_API_KEY`)   | Layer 2                                                                                                                              |
| `AGENT_SDK_GEMINI_API_KEY`             | —                                        | Falls back to `GEMINI_API_KEY` / `GOOGLE_API_KEY`. Absent, the Gemini example runs on the built-in mock                               |
| `AGENT_SDK_GEMINI_MODEL`               | `gemini-3.8-flash`                       | Model for the Gemini client example                                                                                                  |
| `AGENT_SDK_OPENROUTER_MODEL`           | `anthropic/claude-opus-5`                | Primary model requested from the gateway                                                                                             |
| `AGENT_SDK_OPENROUTER_FALLBACK_MODELS` | `anthropic/claude-sonnet-5,openai/gpt-5` | Comma-separated fallbacks tried in order                                                                                             |
| `AGENT_SDK_BEDROCK_REGION`             | `us-east-1` (falls back to `AWS_REGION`) | Region the Bedrock model is called in. There is no Bedrock key variable: AWS authenticates through its own credential chain, and the example asks that chain rather than looking for one |
| `AGENT_SDK_BEDROCK_MODEL`              | `anthropic.claude-sonnet-4-5-20250929-v1:0` | Bedrock model id. Names one model exactly — Bedrock does not route, so there is no fallback list                                   |
| `AGENT_SDK_LITELLM_API_KEY`            | — (falls back to `LITELLM_API_KEY`)      | Layer 2. Blank ⇒ the offline mock                                                                                                    |
| `AGENT_SDK_CLOUDFLARE_API_KEY`         | none                                     | Cloudflare API token with Workers AI read access (falls back to `CLOUDFLARE_API_TOKEN`)                                              |
| `AGENT_SDK_CLOUDFLARE_ACCOUNT_ID`      | none                                     | Required by every `ai.run` call — it is part of the URL path, not the body                                                           |
| `AGENT_SDK_CLOUDFLARE_MODEL`            | `@cf/meta/llama-3.1-8b-instruct`         | A Workers AI model id. `@hf/…` ids are Workers AI too, so a matcher keyed on `@cf/` alone misses about an eighth of the catalogue    |
| `AGENT_SDK_DATABRICKS_API_KEY`         | — (falls back to `DATABRICKS_TOKEN`)     | A workspace token — a PAT, or an OAuth M2M token. Blank ⇒ the offline mock. Read by both Databricks examples |
| `AGENT_SDK_DATABRICKS_BASE_URL`        | none                                     | Your workspace — customer-specific, so there is no default that could be right. `/serving-endpoints` is appended if you leave it off, and a PrivateLink workspace works because the recipe is handed this URL rather than recognising the host |
| `AGENT_SDK_DATABRICKS_MODEL`           | `databricks-claude-sonnet-4-6`           | A serving **endpoint** name, not a model id — which is why the served model has to be read off the response. Read by both Databricks examples |
| `AGENT_SDK_DATABRICKS_EXTERNAL`        | unset                                    | `1` asserts the endpoint carries your own upstream key, so that provider invoices it rather than Databricks. An assertion the SDK cannot check — it switches both Databricks examples to `databricks-external.*` |
| `AGENT_SDK_LITELLM_BASE_URL`           | `http://localhost:4000`                  | Your own proxy — self-hosted, so there is no public default                                                                          |
| `AGENT_SDK_LITELLM_MODEL`              | `gpt-5`                                  | A model **group** from the proxy's config, not a provider slug                                                                       |
| `STIGG_API_KEY`                        | —                                        | **Server** key (`server-…`). A publishable `client-…` key fails every call with `IdentityForbidden`. Blank ⇒ the built-in Stigg mock |
| `STIGG_BASE_URL`                       | `https://api.stigg.io`                   | Which environment that key belongs to                                                                                                |

### What the examples gate and meter against — in `examples/demo.env`

These moved out of `.env`, because they fail the test that separates the two files: **if you would
change it to play with an example, it is a fixture.** A real application decides every one of them
in code — what it bills against is part of its pricing, not of its deployment.

The SDK's own settings are arguments rather than variables, which is why none of them appear here:
`new StiggAgentSDK({ apiKey, baseUrl, cache, client, timeoutMs, logger, onError })` for the
environment, and `wrap(client, { stiggContext })` — overridable inside any call's own parameters —
for what a call is governed by.

| Variable                         | Default                 | Purpose                                                                            |
| -------------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `AGENT_SDK_DEMO_CURRENCY_ID`     | `credits` *(mock only)* | `stiggContext.entitlement` — credit currency to budget against. The default is the examples' own and applies only offline; the SDK has none. Naming neither this nor a feature is legal and means the calls **meter without gating** — `entitlement` is itself the enforcement switch. `two-agents` and the gateway examples refuse to run that way, since a budget draining is their whole subject |
| `AGENT_SDK_DEMO_FEATURE_ID`      | —                       | `stiggContext.entitlement` — metered feature instead; exclusive with the above      |
| `AGENT_SDK_DEMO_EVENT_NAME`      | —                       | `stiggContext.eventName` — overrides the name derived from the vendor call          |

### `examples/demo.env` — demo fixtures

Scaffolding, not configuration. Your own application supplies all of this from its own context.

Each fixture has **three** states, because "no `demo.env` at all" and "I want no agent" are
different things and an absent variable cannot mean both:

| The variable is…      | Against the mock              | With a real `STIGG_API_KEY`                     |
| --------------------- | ----------------------------- | ----------------------------------------------- |
| **absent**            | the default below             | unset — the demo degrades, or says what it needs |
| **set**               | that value                    | that value                                      |
| **present but blank** | unset, deliberately           | unset, deliberately                             |

The defaults are mock-only on purpose: against an environment you can write to, a guessed
`customer-acme` is either someone else's tenant or one nobody asked for.

| Variable                              | Default *(mock only)* | Unset ⇒                                                               |
| ------------------------------------- | --------------------- | --------------------------------------------------------------------- |
| `AGENT_SDK_DEMO_CUSTOMER_ID`          | `customer-acme`       | **Error.** Every governance call is scoped to a tenant, and the examples will not invent one |
| `AGENT_SDK_DEMO_TEAM_ID`              | `team-research`       | The agents are **roots** — no ancestor budget binds them. `two-agents` needs one and says so |
| `AGENT_SDK_DEMO_AGENT_ID`             | `agent-support-bot`   | **No agent at all**: checks and usage land on the customer's own pool. Blank it to see that path against the mock. Each client example appends its vendor (`…-anthropic`) |
| `AGENT_SDK_DEMO_ENTITY_TYPE_ID` | `agent` *(mock only)* | `register`'s own `entityTypeId` — the entity type agents are provisioned as |
| `AGENT_SDK_DEMO_ATTRIBUTION_KEY` | `agentId` *(mock only)* | `stiggContext.attributionKey` — the key that type identifies its agents under. **Both or neither**: the SDK defaults neither half, because a guessed key resolves no entity and the spend lands on the customer looking exactly like an ungoverned call |
| `AGENT_SDK_OFFLINE`                   | empty                 | Set to `1` to force the mocks even when keys are present              |
| `AGENT_SDK_DEMO_MOCK_GOVERNANCE_FAIL` | empty                 | Mock only: make the runtime check return `503`                        |

Install dependencies from the **repo root**:

```bash
corepack enable
yarn install
```

## 6. Run the examples

All commands work from anywhere in the repo, and all of them run with no keys at all — except
`example-client-typesafe`, whose vendor the built-in mock does not speak. That one still needs no
Stigg account.

| Command                     | Runs                                                                  | What it shows                                                                                               |
| --------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `example-client-anthropic`  | [`client/anthropic.ts`](./examples/client/anthropic.ts)               | A governed chat. One `wrap()` gates and meters every turn                       |
| `example-client-openai`     | [`client/openai.ts`](./examples/client/openai.ts)                     | The same script, a different vendor — governance is not vendor-specific work                                |
| `example-client-gemini`     | [`client/gemini.ts`](./examples/client/gemini.ts)                     | The same script again, on a vendor that counts in its own names and streams running totals                  |
| `example-client-groq`       | [`client/groq.ts`](./examples/client/groq.ts)                         | Groq through the `openai` client: matched by hostname, so it reports `groq.*`, and its streamed counters come off `x_groq`  |
| `example-client-mistral`    | [`client/mistral.ts`](./examples/client/mistral.ts)                   | A vendor whose SDK camelCases the wire — `chat.stream` is its own method, and the metered names are the wire's              |
| `example-client-ollama`     | [`client/ollama.ts`](./examples/client/ollama.ts)                     | A self-hosted engine that bills nobody: a flat client, counters flat on the response, and capacity rather than spend        |
| `example-client-openrouter` | [`client/openrouter.ts`](./examples/client/openrouter.ts)             | `openrouterRecipe()` billing the credits actually charged instead of a token count                          |
| `example-client-litellm`    | [`client/litellm.ts`](./examples/client/litellm.ts)                   | The same script against a self-hosted proxy. Streams, so it meters tokens — see the gateway example for why |
| `example-client-databricks` | [`client/databricks.ts`](./examples/client/databricks.ts)             | An `OpenAI` client pointed at a workspace `/serving-endpoints`. The request names an **endpoint**, not a model, so the served model on the way back is the thing to watch. `AGENT_SDK_DATABRICKS_EXTERNAL=1` asserts the external-model route |
| `example-client-typesafe`   | [`client/typesafe.ts`](./examples/client/typesafe.ts)                 | A non-chat client: typed questions, batched or one per call. **Needs a real TypeSafe key**                  |
| `example-two-agents`        | [`client/two-agents.ts`](./examples/client/two-agents.ts)             | Two agents, one team: a sibling denied by its own cap, then the survivor denied by the team above it        |
| `example-gateway-openrouter`| [`gateway/openrouter.ts`](./examples/gateway/openrouter.ts)           | The two gateway topologies: calling one gates, operating one only ingests. `example-gateway` runs this one  |
| `example-gateway-litellm`   | [`gateway/litellm.ts`](./examples/gateway/litellm.ts)                 | The same two topologies when the cost is in a header: real spend, then tokens, from one request             |
| `example-gateway-bedrock`   | [`gateway/bedrock.ts`](./examples/gateway/bedrock.ts)                 | A gateway that states no price: tokens are all there is to meter, and nothing proxies it                    |
| `example-gateway-databricks` | [`gateway/databricks.ts`](./examples/gateway/databricks.ts)          | Databricks' **own** client, `@databricks/sdk-modelservingquery` — one method, `client.query(…)`, governed by the same recipe as the row above and reported as `databricks.query`. Shows the camelCase counters renamed back to the wire's, and a budget draining until it refuses |
| `example-gateway-cloudflare` | [`gateway/cloudflare.ts`](./examples/gateway/cloudflare.ts)           | Cloudflare's own client (`ai.run`). The one example that does not stream — a streamed `ai.run` hands back raw SSE bytes, so there is no usage block to meter |
| `example-setup`             | [`shared/setup-governance.ts`](./examples/shared/setup-governance.ts) | Seeds a customer, a pool and per-entity budgets. Idempotent                                                 |

`example-client` is an alias for the Anthropic one. Prefix any of them with `AGENT_SDK_OFFLINE=1`
to force the mocks even when keys are present.

### Layer 1 — client abstraction (interactive chat)

An interactive, multi-turn chat, governed end to end, against any of five vendors. Type `exit`,
`quit`, an empty line, or press **Ctrl-D** / **Ctrl-C** to end it.

```bash
yarn example-client-anthropic     # also: example-client
yarn example-client-openai
yarn example-client-gemini
yarn example-client-openrouter
yarn example-client-litellm
```

All five run [the same script](./examples/client/core/chat.ts) — same governance wiring, same
output, not one line of it vendor-specific. What differs is a helper per vendor
([anthropic](./examples/client/anthropic.ts), [openai](./examples/client/openai.ts),
[gemini](./examples/client/gemini.ts), [openrouter](./examples/client/openrouter.ts),
[litellm](./examples/client/litellm.ts)) holding the four things that genuinely differ:
which key to read, how to build the client, how to stream a turn, and where usage sits on the
response. That is the same split the SDK makes internally, for the same reason.

All five report the names their own vendor used, which is why the ingest lines differ between
them: Anthropic states `input_tokens`/`output_tokens`, OpenAI states `prompt_tokens`/
`completion_tokens`, and Gemini states `promptTokenCount`/`candidatesTokenCount` — plus a
`thoughtsTokenCount` that is billed as output and counted beside the candidates rather than
inside them. Run `example-gateway-litellm` to watch a gateway add `cost` beside them.

```text
[governance] stigg=in-process mock customer=customer-acme currency=credits
[stigg] mode=governance check=rest (node-sdk when unattributed) report=node-sdk provisioning=rest (governance enabled)
[stigg] agent agent-support-bot-anthropic registered under customer customer-acme

you> what is metering?
[governance] check hasAccess=true remaining=5 source=rest
assistant> Metering is the practice of recording how much of a service ...
  [usage:turn 1] input=12 output=46 cache_read=3 cache_creation=0
[governance] ingest input_tokens=12 cache_read_input_tokens=3 output_tokens=46 key=9d63...:1 ok=true credits=0.94

...

you> one more
[governance] check hasAccess=false remaining=0.5742 deniedBy=agent-support-bot-anthropic reason=BudgetExceeded remedy=raise-budget source=rest
  Budget exhausted for agent-support-bot-anthropic. Ask whoever set this budget to raise it, or wait for the next reset.
  Raise the budget in another shell, then just keep typing - the next message re-checks:
    yarn example-setup --agent-limit 6
```

The chat stays open after a denial. Run the suggested command in another shell and keep typing:
because denials are never cached, the next message goes through. That is the whole point of
making a refusal a commercial event rather than an error.

Every check reads `source=rest`, and `remaining` falls as the ingests land. This is an attributed
check — the agent travels as a dimension, so it resolves an entity and only the governance API can
answer it. Nothing is served from a decision cache, which is why the denial arrives on the first
call that actually exceeds the budget rather than one window later.

### Layer 2 — gateways, in both directions

The same prompt through OpenRouter three times: wrapped with `openrouterRecipe()` (non-streaming,
then streaming), then once more down the header path, so the two topologies sit side by side.

```bash
yarn example-gateway
```

```text
--- wrapped, non-streaming ---
requested model : anthropic/claude-opus-5
served model    : anthropic/claude-sonnet-5  <- routing drift
cost (credits)  : 0.00108
prompt tokens   : 21 (cached: 7)
completion tok. : 39 (reasoning: 4)
[governance] hasAccess=true remaining=25000 source=rest
[governance] ingest prompt_tokens=21 completion_tokens=39 cached_tokens=7 cost=1080 key=gen-mock... ok=true

--- header path, non-streaming ---
...
[governance] proxy ingest prompt_tokens=21 completion_tokens=39 cached_tokens=7 key=gen-mock... ok=true
(ingest-only: no check on this path, and tokens not cost - the mapper cannot see usage.cost)
```

The contrast is the whole point. Both report the same three token counters; only the wrapped call
also reports **`cost=1080`** — 0.00108 credits in micro-credits, what the gateway really charged —
attributed to the model that actually served. The header path carries a usage report rather than a
price, so the one feature that says what the call cost in money is simply missing from it. Same
request, same seams; the difference is a feature, not a denomination.

If the primary model is down, rate-limited, or refuses, OpenRouter serves a fallback slug instead
and `served model` differs — flagged as `<- routing drift`, which silently changes COGS. The
recipe puts that slug on the ingest as a `model` dimension, so the drift is visible in Stigg and
not just in the log.

The `cost` feature is denominated by the recipe: `openrouterRecipe()` reports micro-credits by
default, because OpenRouter charges fractional credits and Stigg ingests whole units. Set
`unitsPerCredit` to match however the Stigg feature is defined. When a response carries no cost at
all — BYOK, and a few upstreams — the `cost` key is simply absent; the token metrics were never
conditional on it.

#### When the price is in a header

LiteLLM makes the same comparison and splits the wrapped call in two, because for this gateway
_how_ you called it decides whether the price is knowable at all:

```bash
yarn example-gateway-litellm
```

```text
--- wrapped, non-streaming ---
requested group : gpt-5
served model    : gpt-5-2025-08-07  <- routing drift
cost (USD)      : 0.001005
[governance] ingest prompt_tokens=21 completion_tokens=36 cached_tokens=7 cost=1005 key=chatcmpl-... ok=true

--- wrapped, streaming ---
cost (USD)      : (not reported - the header precedes the body)
[governance] ingest prompt_tokens=21 completion_tokens=36 cached_tokens=7 key=chatcmpl-... ok=true

--- header path, non-streaming ---
[governance] proxy ingest prompt_tokens=21 completion_tokens=36 cached_tokens=7 key=chatcmpl-... ok=true
(ingest-only: no check on this path, and tokens not cost - what crosses the boundary is a usage
report, so the price the proxy computed has nowhere to go)
```

Same proxy, same recipe, same prompt. The tokens are identical in all three; what differs is
whether `cost` is there at all. The proxy knew the price every time — it computed it — but a
header is flushed before generation starts, so the streamed call has nothing to read
([BerriAI/litellm#12689](https://github.com/BerriAI/litellm/issues/12689)), and the ingest-only
boundary carries a usage report rather than a price. Gating is unaffected throughout: both wrapped
legs are refused before the request leaves, whatever they end up reporting.

So if you budget in spend against LiteLLM, price the `cost` feature and know that streamed turns
will not contribute to it — the token features still will. `litellmRecipe()` reports micro-dollars
by default; set `unitsPerDollar` to match however the Stigg feature is defined.

### Seeing the fail-closed path

The governance check is fail-closed server-side: it returns `503` rather than silently allowing.

```bash
AGENT_SDK_OFFLINE=1 AGENT_SDK_DEMO_MOCK_GOVERNANCE_FAIL=1 \
  yarn example-client-anthropic
# [stigg] check failed: check: 503 governance cache unavailable
# [governance] check hasAccess=false reason=EngineError remedy=retry source=policy

# The explicit opt-in - refuse the call when the check itself could not be made. An SDK option,
# not an env var, and overridable per call through `stiggContext`:
#   new StiggAgentSDK({ apiKey, baseUrl, checkErrorAction: 'deny' })
```

`allow` is the default: a soft limit, so an unreachable Stigg does not take the application down
with it. `deny` mirrors the server's own fail-closed behaviour and is a decision worth making
deliberately — "never break the customer's run" and "never spend past a budget" are not the same
promise, and only you know which one this call is for.

## 7. Typecheck, lint and test

```bash
yarn build   # typecheck, then emit dist/ - what gets published
yarn lint
yarn test    # node:test via tsx; no network, literal fakes
```

`build` is two passes over two configs, and the split is the point. `tsconfig.json` is the
typechecker's view: it covers `src`, `examples`, `test` and `testing`, and emits nothing.
`tsconfig.build.json` compiles the two entry points - `src/index.ts` and `src/internal.ts` - and
whatever they import, so only `src/` reaches `dist/`. It clears `dist/` first, because a module
that was renamed or deleted would otherwise sit there and ship.

Either pass resolves `@stigg/node-server-sdk` and `@stigg/typescript` from `node_modules`, as
published packages like any other - there is no workspace indirection here.

## 8. Troubleshooting

| Symptom                                     | Cause and fix                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403 GovernanceNotEnabled`                  | The account has no governance. Checks and usage still work; `register()` throws, because there is nowhere to create the agent entity. Contact Stigg to enable it.                                                                                                                                                                                    |
| `No STIGG_API_KEY`                          | Set it to a server key for the environment in `STIGG_BASE_URL`, or leave it blank to run on the built-in mock.                                                                                                                                                                                                                                       |
| `503` and every turn denied                 | The governance cache is unavailable and `checkErrorAction` is `deny`. The default is `allow`, so this is a policy that was asked for; drop it to keep running through the outage, or relax a single call with `stiggContext: { checkErrorAction: 'allow' }`. |
| `usage value must be a whole number to report against a feature` | `POST /api/v1/usage` takes integers. Report against a **credit currency** instead, which takes fractions, or raise the unit size in your `usageMapper` so the division comes out whole.                                                                                                                                                 |
| `... is backed by a raw-events meter`       | A `sync` run reported to a feature only a meter can fill. Report that run with `ingest: 'async'` (the default), or point it at a feature whose value your application computes.                                                                                                                                                                      |
| Ingest reports `ok=true` but usage stays 0  | Under `async` an acknowledgement is all the event API returns. Check a raw-events meter filters on the event name (see the event table above); against a **local** Stigg, also that the `ingest-usage-stream-processor` and `calculate-usage-stream-processor` lambdas are running. `ingest: 'sync'` answers with a balance and will say so instead. |
| Still denied right after a top-up           | Budgets reset per cadence window, so a spent agent stays spent. Re-run `example-setup --agent-limit N` with a higher limit, or use a new `AGENT_SDK_DEMO_AGENT_ID`.                                                                                                                                                                                  |
| Denial names the customer, not the agent    | Customer-level mode (no governance), or the context named no `agentId` and carried no attribution dimensions of its own.                                                                                                                                                                                                                             |
| Denial names an agent you did not pass      | A `dimensions` key resolves an entity that already exists in the account. The agent belongs in `stiggContext.agentId`; `dimensions` gates on whatever it names, registered here or not.                                                                                                                                                              |
| `401` / `authentication_error`              | The key is present but wrong. Clear it from `.env` to fall back to the offline mock, or fix it.                                                                                                                                                                                                                                                      |
| `400 credit balance is too low` (Anthropic) | Add credits under Billing, or set `AGENT_SDK_OFFLINE=1` to run on the mock.                                                                                                                                                                                                                                                                          |
| `402` / insufficient credits (OpenRouter)   | Add credits under Settings → Credits, or set `AGENT_SDK_OFFLINE=1` to run on the mock.                                                                                                                                                                                                                                                               |
| `400` naming a model (OpenRouter)           | A slug in `AGENT_SDK_OPENROUTER_MODEL` / `AGENT_SDK_OPENROUTER_FALLBACK_MODELS` does not exist. Check <https://openrouter.ai/models>.                                                                                                                                                                                                                |
| `ECONNREFUSED` on port 4000 (LiteLLM)       | No proxy is running there. Start one (`litellm --model gpt-4o --port 4000`), fix `AGENT_SDK_LITELLM_BASE_URL`, or clear `AGENT_SDK_LITELLM_API_KEY` to fall back to the mock.                                                                                                                                                                        |
| `400` / unknown model group (LiteLLM)       | `AGENT_SDK_LITELLM_MODEL` must name a group from the proxy's own config, not a provider slug. List them with `curl $AGENT_SDK_LITELLM_BASE_URL/v1/models`.                                                                                                                                                                                           |
| LiteLLM turns bill `units=1`, not spend     | Expected on a streamed call: `x-litellm-response-cost` is flushed before the body, so there is no cost to read. Call non-streaming to bill real spend.                                                                                                                                                                                               |
| `Cannot find module`                        | Run `yarn install` from the repo root, not from this directory.                                                                                                                                                                                                                                                                                      |
| Chat prints nothing and exits               | Input is not a TTY (piped input hits end-of-file). Try `printf 'hi\nexit\n' \| yarn example-client-anthropic`.                                                                                                                                                                                                     |
| A CLI hangs after the last line             | The Node SDK keeps a background cache alive. Call `gov.flush({ close: true })`, as the examples do.                                                                                                                                                                                                                                                  |

## 9. Layout

```
src/
  index.ts                                            the whole public surface, one import
  stigg-agent-sdk.ts                                 the composition root: the one file that knows both sides
  types.ts                                            the vocabulary, and every call's argument list
  config.ts errors.ts logger.ts                       validated per-environment config, flat errors, structural logger
  decision-text.ts headers.ts                         how a decision reads; the cross-process attribution convention
  engine/     engine.ts decision.ts                   the four-operation seam; chains -> decision (pure)
              node-sdk-engine.ts                      the only file importing @stigg/node-server-sdk
              rest-governance-engine.ts               the only file importing @stigg/typescript
              composite-engine.ts create-engine.ts    routing per operation, and who picked what
  core/       run-handle.ts                           the handle every binding consumes
  bindings/   client/core/                           the recipe contract, the registry, the wrapper
              client/providers/ client/gateways/     a model provider, or a gateway you call
              proxy/                                 a gateway you operate: headers in, ingest only
              shared/                                usage shapes and metric tables both halves read

testing/      mock-stigg-server.ts                    the Stigg stand-in the examples and the tests share

examples/
  shared/     demo-env, the two mocks, setup-governance    scaffolding every example uses
  client/     core/{chat,vendor} + anthropic|openai|gemini|openrouter|litellm|typesafe   a helper per vendor
              two-agents                                   two siblings, one team budget between them
  gateway/    core/{gateway,vendor,proxy} + openrouter|litellm  calling one; operating one on a real socket
```

The examples mirror the bindings directory deliberately — a generic core plus a thin per-vendor
file is the shape the problem has, at both layers.

Core never imports a binding or a concrete engine, and no binding imports another — only
`stigg-agent-sdk.ts` knows both, which is what lets `wrap()` live on the SDK object
without core learning a vendor's name. Adding a provider is a recipe file; adding an engine is a
leaf file plus a branch in the factory.

## Contributing

The SDK is developed and released by Stigg. Issues and pull requests are welcome -
[`CONTRIBUTING.md`](CONTRIBUTING.md) covers running it locally and the conventions worth knowing.

Report vulnerabilities privately, as described in [`SECURITY.md`](SECURITY.md).

MIT © Stigg Inc. See [LICENSE](LICENSE).
