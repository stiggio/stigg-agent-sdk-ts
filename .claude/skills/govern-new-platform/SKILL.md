---
name: govern-new-platform
description: Classify a new LLM platform as a provider or a gateway, confirm it with the user, then plan the binding. Use this whenever someone asks the agent SDK to support, govern, meter, gate or add a new AI platform, vendor, model host, inference API or gateway - "add support for Bedrock", "can we govern Groq", "meter Fireworks calls", "support the Cerebras API", "add LiteLLM-style routing for X", "we need OpenRouter but for Y". Use it even when the request names no category and sounds like ordinary work ("wire up Together AI"), because the category is exactly what the requester has not decided and getting it wrong bills the wrong party. Also use it when someone asks where a platform belongs, whether something is a provider or a gateway, or whether a new recipe is needed at all.
---

# Governing a new platform

Adding a platform to this SDK is two decisions and then some typing. The typing is mechanical;
the two decisions are not, and both are irreversible in practice once a meter is configured
against the event names you choose.

**Decision one: provider or gateway.** This is what the skill exists for — but read the
positioning section in Phase 1 before you argue for either. The category is the requester's call
and follows how the platform is sold, not how it is built. What the research has to get right is
the *binding*: name the wrong vendor and real traffic meters under somebody else's name; miss the
one number a token counter cannot recover and it is gone.

**Decision two: does anything need building at all.** A large part of the ecosystem is reached by
pointing the OpenAI client at a base URL, and `wrap()` already governs that. Finding this out
costs one question and saves a recipe nobody needed.

Work in three phases, in order. Do not skip to planning: the user asked for a classification they
can approve, and an unapproved plan is a plan built on a guess.

---

## Phase 1 — Research before asking

Read before you ask. A question you could have answered from the platform's own docs spends the
user's attention on something you could have found, and the answers you get back are better when
they are corrections to a concrete claim rather than open-ended.

Establish these, in this order — each one is cheap and the first two often settle it:

1. **Who invoices the customer for a call?** The platform itself, or an upstream it resells?
2. **Does the platform run its own models, or route to other people's?** Read its model list: a
   namespaced id like `anthropic/claude-sonnet-5` is a reseller's catalogue; `claude-sonnet-5` is
   the maker's.
3. **What does a completed response carry?** Specifically: a `cost` or credit figure, and the name
   of the model that *actually* served after any routing or fallback.
4. **What does the application hold in its hands?** The platform's own SDK package, an `OpenAI`
   client pointed at a base URL, an `Anthropic` client pointed at one, a Vercel AI SDK model — or
   several of these at once.
5. **How could code recognise it?** A fixed public hostname, a base URL only the customer knows
   (self-hosted), a distinctive client shape, or `model.provider`.

If the repo is reachable, read `README.md`'s "Bindings, by solution" section and
`src/bindings/client/gateways/openrouter/openrouter-recipe.ts` — the file headers in this package
argue their own design, and they are the fastest way to calibrate what counts as a gateway here.

### Provider or gateway is a positioning question, not a technical one

**Read this before the table.** The mistake this prevents is reasoning from a platform's
internals to its category, and it is easy to make because the evidence below looks like it
settles the question. It does not.

Provider and gateway describe **where a customer expects to find the platform** — how it markets
itself and how the people configuring meters think of it. They do not describe its wire format,
its billing path, or the shape of its client. Two platforms can be technically identical and
belong in different directories, and that is not an inconsistency to resolve.

The live example in this tree: **Groq is a provider and Cloudflare is a gateway**, and the
evidence below says the same thing about both — each bills you directly, each runs open-weight
models it did not make, neither has an upstream maker in the billing path. They are split because
Groq sells itself as somewhere to run a model and Cloudflare sells itself as something to put in
front of other people's models. Do not "fix" that by making them match.

So what the evidence below is actually for: deciding **how to build the binding** — what `matches`
can key on, which counters exist, whether a cost is recoverable. It is not a classifier. When the
research points one way and the requester says the other, **the requester is right by definition**
— they own the positioning — so record the decision and move on rather than re-arguing it from the
internals.

### What the evidence means

| What you found | What it usually means |
| --- | --- |
| Bills you, serves models it made | Usually **Provider** — `bindings/client/providers/` |
| Bills you, resells upstream models, states which one served | Usually **Gateway** — `bindings/client/gateways/` |
| Bills nothing, normalizes many vendors behind one interface | Neither — it is a **wire**, and belongs as methods on the recipes that already exist (see `src/bindings/client/wires/`). Say so and stop; this is not a new binding. |
| Already governed, just reached a different way | A **surface** on the existing recipe, not a new vendor. `@openrouter/sdk` was this. |
| OpenAI-compatible, publishes no cost, nothing to attribute | Possibly **nothing to build**. See below. |

One thing the evidence *does* settle outright, because it is about metering rather than
positioning: **the vendor is whoever bills**. Not whose model answered, not whose SDK is imported,
not whose logo is on the dashboard. A call through `@ai-sdk/anthropic` is Anthropic traffic
because Anthropic invoices it. A call through OpenRouter to a Claude model is OpenRouter traffic
for the same reason. That decides which **vendor name** an event carries; the rows above only
suggest which **directory** the recipe lives in, and the requester decides that.

### Check whether anything needs building

Before proposing a recipe, confirm it earns its place. If the platform speaks the OpenAI wire
format, publishes no cost, and does no routing worth attributing, `openAIRecipe` already governs
it today — the customer points the OpenAI client at the base URL and wraps it. Groq, Together,
Fireworks, DeepSeek, xAI, Perplexity, vLLM and Ollama are all in this position.

What a new recipe buys over that is precisely: a vendor name of its own on the event (so meters
and per-provider budgets can tell it apart), and access to whatever the response carries that a
four-counter projection drops. If neither applies, say so plainly and offer the two-line
alternative — a `dimensions: { provider: 'groq' }` on the context separates the traffic without
any code in this package:

```ts
stigg.wrap(new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey }), {
  stiggContext: { customerId, dimensions: { provider: 'groq' } },
});
```

This is a real outcome, not a cop-out. Report it with the same confidence as a classification.

---

## Phase 2 — Confirm with the user

Put the classification to the user with `AskUserQuestion`. The point is not to be polite about it
— it is that two of these facts cannot be read off any document, and a wrong guess at either one
produces a binding that looks governed and is not:

- **Which client the application actually holds.** Shape is what `matches` keys on, so a recipe
  built for a client nobody uses gates nothing. The user knows their own code.
- **How the platform should be recognised.** A self-hosted deployment has no fixed hostname, so
  the matcher needs a base URL only the customer can supply. Guessing a hostname that is wrong
  silently changes who gets billed.

Ask as one round, not a series. Lead with your classification and the evidence behind it, as a
claim to confirm or correct, rather than an open question — you did the research, so stand behind
it:

> **Gateway.** Its model ids are namespaced by upstream (`anthropic/claude-opus-5`), the response
> names the model that actually served, and `usage.cost` states what it charged in credits. That
> last field is the thing `openAIRecipe` would drop.

Then ask only what the research left genuinely open. Typical set, trimmed to what you still need:

1. Classification — confirm, or correct (always ask this one; it is the approval gate)
2. Which client object(s) the application holds
3. How it should be recognised — fixed host, supplied base URL, shape, `model.provider`
4. Where the cost figure lives — response body, a header, or nowhere / only asynchronously
5. Whether to register it by default or require the user to name it at `wrap(client, { recipe })`

**Do not plan until the user has answered the classification question.** If their answer
contradicts your research — they call it a provider and you found a reseller's catalogue — take
their answer. The category is positioning and they own it, so a disagreement there is not a
finding; record it and move on.

Push back exactly once, and only when their answer makes the binding **unbuildable** rather than
merely differently-filed: when it needs a discriminator that does not exist at `matches` time,
when it would publish an event name that can never fire, or when it would meter two payers under
one name. Say which of those it is, offer the ways it could work, and build whichever they pick.

---

## Phase 3 — Plan the implementation

Read the reference file for the confirmed category and write the plan from it:

- **Provider** → `references/provider.md`
- **Gateway** → `references/gateway.md`

Both files cover the same ground — the recipe, the registration, the contract tests that will fail
if a list is missed, the docs and examples — but the shapes and the traps differ enough that
following the wrong one produces a plausible plan that does not work.

Read `references/invariants.md` as well, always. It holds the rules both categories share: the
ones this package enforces with tests, and the ones it enforces only with file headers and
reviewer memory. Several of them exist because the obvious implementation was shipped first and
was wrong.

The plan should name actual files and the actual lists to edit, not stages. This package guards
itself with contract tests that compare lists against each other — `public-surface`,
`event-names`, `metrics-contract`, `examples-contract`, `docs-contract`, `module-boundaries` — so
"update the tests" is not a plan step; naming which list in which file is.

Present the plan and let the user approve it before writing code. If plan mode is available, exit
plan mode with it.
