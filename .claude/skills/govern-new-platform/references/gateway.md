# Planning a gateway binding

A gateway bills you and resells somebody else's models. It knows two things no client-side token
counter can recover — **what it actually charged** and **which model actually served** after
routing or fallback — and capturing those is most of why the binding exists.

Read `invariants.md` too. This file covers only what is specific to a gateway.

## Contents

- [First: called or operated](#first-called-or-operated)
- [The recipe](#the-recipe)
- [Registration order, and why it is not cosmetic](#registration-order-and-why-it-is-not-cosmetic)
- [Recognising the gateway](#recognising-the-gateway)
- [Cost](#cost)
- [Covering every wire it serves](#covering-every-wire-it-serves)
- [Plan template](#plan-template)

---

## First: called or operated

"Gateway" does two jobs in this domain, and they want opposite bindings. Settle this before
anything else, because the two share no code.

**A gateway you call** — OpenRouter, the Vercel AI Gateway, a hosted LiteLLM — returns its
response into your process. There is a client object, so it takes the ordinary client binding:
a recipe under `bindings/client/gateways/`, gated before the call ever leaves. This is the common
case and the rest of this file assumes it.

**A gateway you operate** — a proxy you run, fronting services that may not even be Node — is the
opposite. It is out-of-process and sees **requests, not runs**: it cannot provision, cannot check
against run-scoped state, cannot archive, and there is no client object out there to wrap. So the
lifecycle splits across the boundary — the application checks in-process, attribution travels as
`x-stigg-*` headers via `run.headers()`, and the proxy only ingests through
`stigg.ingestFromHeaders(...)`. Governance never leaves the process.

If the request is for a gateway you operate, **there is no recipe to write**. The binding already
exists in `src/bindings/proxy/`, and the work is configuration plus possibly a new
`ObservedVendor` value in `token-usage.ts`. Say so; it is a much smaller job than the requester
probably expects, and the headline is that this path cannot refuse a call — it is ingest only.

---

## The recipe

Three files under `src/bindings/client/gateways/<name>/`:

- `<name>-recipe.ts` — a factory, `<name>Recipe(options = {})`, returning `ClientRecipe<Metric>`.
  A factory rather than a constant because a gateway's denomination and base URL are the caller's
  to choose.
- `types.ts` — the options type and the response shapes, typed structurally. No vendor imports.
- `index.ts` — re-exports.

Open the file header with *why this gateway is not just an OpenAI client*. Every gateway recipe in
this package does, and it is the thing a reader needs first: `openAIRecipe` already fits these
clients by shape, so the recipe has to justify what it adds. Name the two fields and what each one
buys.

Most gateways speak the OpenAI wire, so build on the existing surfaces rather than retyping them:

```ts
import { openAIRecipe, openAISurface } from '../../providers/openai/openai-recipe';
import { GATEWAY_METRICS, TOTAL_TOKENS, pickMetrics } from '../../../shared/token-usage';
import { hostOf, matchesAnyHost, withinBaseUrl } from '../../../shared/base-url';
```

`openAIRecipe.methods` is the list of surfaces to build on and `openAISurface(path)` is the reader
for one of them — map over the first and call the second, the way `litellm-recipe.ts` does. There
is no helper that hands you a prebuilt method list.

`GATEWAY_METRICS` is the OpenAI set plus `cost`. Use it only if the gateway states a cost — see
below.

## Registration order, and why it is not cosmetic

In `src/stigg-agent-sdk.ts`, `DEFAULT_RECIPES` is matched in order, and **every gateway is an
OpenAI client by shape**. A gateway registered after `openAIRecipe` never matches: the OpenAI
recipe claims the client first, the call meters as `openai.*`, the cost and the served model are
dropped, and nothing fails. So a new gateway goes *ahead* of `openAIRecipe` — beside
`openrouterRecipe()` and `litellmRecipe()`, which are there for exactly this reason. The existing
comment on that array says so; keep it true.

Register by default when reading a richer response is not a pricing decision anyone needs to opt
into — which is the case whenever the gateway can be recognised without the customer telling you
anything. A gateway that needs a base URL only the customer knows (self-hosted) still registers,
but its matcher falls back to a guess, and the recipe should be nameable at
`wrap(client, { recipe: <name>Recipe({ baseUrl }) })`.

## Recognising the gateway

`matches` is the whole of the binding's safety. Shape cannot answer it — every OpenAI-compatible
endpoint looks alike — so the test is the base URL, and it must be the **host**, nothing weaker:

```ts
function isTheGateway(client: unknown, baseUrl?: string): boolean {
  const configured = (client as { baseURL?: unknown } | null)?.baseURL;
  if (typeof configured !== 'string') return false;
  const host = hostOf(configured);
  const expected = baseUrl ? hostOf(baseUrl) : DEFAULT_HOST;
  if (!expected) return false;
  return host === expected || host.endsWith(`.${expected}`);
}
```

A substring match is not good enough: `gateway.example.com.attacker.net` contains the host and is
somebody else's domain. A wrong match here silently changes who is billed.

For a self-hosted gateway with no canonical host, the recipe takes `baseUrl` in its options and
falls back to a narrow guess without it. Document the fallback's false positives the way the
LiteLLM recipe does — an unrelated endpoint containing the string gets claimed, and
`recipe: openAIRecipe` is how a caller settles it.

## Cost

Where the number lives decides the shape of the extractor, and each placement has a consequence
worth stating in the header rather than discovering in an invoice:

| Where | What it means | Precedent |
| --- | --- | --- |
| Response body (`usage.cost`) | Simplest. Read in `extractUsage`, scale to whole units, report as `metrics.cost`. Absent on streams if the gateway says so. | `openrouter-recipe.ts` |
| Response header | `extractUsage(result, response)` takes the `MeteredResponse` second argument. **A streamed call can never carry one** — headers go on the wire before the model has produced a token — so a stream falls back to the token path. Still check the header in the streaming branch, so the day the gateway can send one the recipe already reads it. | `litellm-recipe.ts` |
| Nowhere, or only asynchronously | Declare **no** `cost` metric. Where the gateway hands back an id for its own log record, carry that as a dimension instead, so spend can be reconciled against its records out of band. | `bedrock-recipe.ts` for the bare no-cost posture; `cloudflare-recipe.ts` for the log-id dimension |

Tokens and money are different features. Report both; price each in Stigg. The run's mapper
decides what either is worth — `weightedMetrics(<name>Recipe(), 'credits', { cost: 1 })` bills the
money and ignores the tokens.

Always attribute the model that actually served, under `options.modelDimension` (default
`'model'`), so routing drift is visible in Stigg. And set `idempotencyKey` from the gateway's own
request id — stable across *its* retries, which a local step counter cannot be.

## Covering every wire it serves

A gateway usually serves more than the OpenAI wire, and each uncovered wire is a hole with a sharp
edge. `anthropicRecipe` has no base-URL guard — it matches on shape alone, because for a direct
client there is nothing else to match on — so **an Anthropic client pointed at your gateway is
claimed by it and metered as direct Anthropic traffic**: wrong vendor on the event, no gateway
attribution at all.

So if the gateway serves the Anthropic Messages wire, map over `anthropicRecipe.methods` the way
you map over `openAIRecipe.methods`, and register the recipe ahead of `anthropicRecipe` as well as
ahead of `openAIRecipe` — `cloudflare-recipe.ts` does both, and the comment on `DEFAULT_RECIPES`
says why its position is load-bearing. The same logic applies to a native SDK of the gateway's own:
see `@openrouter/sdk`'s `chat.send` in `openrouter-recipe.ts`.

All of them stay one vendor. The wire is already in the event name.

---

## Plan template

Write the plan as concrete edits. Fill in from the research and the user's answers:

1. **`src/bindings/client/gateways/<name>/types.ts`** — `<Name>RecipeOptions` (`estimate`,
   `unitsPer<denomination>`, `modelDimension`, `baseUrl` if self-hosted) and the response shapes.
2. **`src/bindings/client/gateways/<name>/<name>-recipe.ts`** — header arguing why this is not
   `openAIRecipe`; `matches` on host; `measure()` folding cost into `metrics` and the served model
   into `dimensions`; `extractUsage` and `attachStream` per surface; `metrics` list; `vendor`;
   `totalTokensMetric`.
3. **`src/bindings/client/gateways/<name>/index.ts`** — re-exports.
4. **`src/index.ts`** — export the factory, `<Name>Metric`, `<Name>Metrics`, `<Name>RecipeOptions`,
   with the comment saying what it bills.
5. **`src/stigg-agent-sdk.ts`** — add to `DEFAULT_RECIPES` **before `openAIRecipe`** (and before
   `anthropicRecipe` if it serves that wire).
6. **`test/public-surface.test.ts`** — add the runtime export to `PUBLIC`.
7. **`test/event-names.test.ts`** — add every event name: `<name>.chat.completions.create`,
   `<name>.responses.create`, plus `<name>.messages.create` and any native-SDK path.
8. **`test/<name>-recipe.test.ts`** — cover: it matches its own host and not a lookalike domain;
   cost is scaled to whole units; the served model lands in `dimensions`; a stream reports tokens
   and (where the protocol forbids a cost) no `cost` key at all.
9. **`README.md`** — the bindings table, the event-name table, and the OpenAI-wire table listing
   base URL → recipe → events → what it reports.
10. **An example — required, not optional.** `examples/client/<name>.ts`, the
    `example-client-<name>` script in `package.json`, both README tables, and a
    `examples/shared/mock-server.ts` route serving the gateway's real wire format, plus the
    `.env.template` entries. All five are compared against each other, so four is a failing test:
    see **Every new recipe ships an example** in `invariants.md` for the checklist. Run it against
    the mock before you believe the recipe — and make the mock reproduce the awkward parts, the way
    the LiteLLM one keeps `cost` off a streamed reply because headers precede the body.

Name the open questions the plan is making assumptions about rather than burying them — the
denomination of the cost feature and the streaming cost behaviour are the two that usually bite.
