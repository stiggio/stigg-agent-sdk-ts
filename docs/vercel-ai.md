# Governing a Vercel AI SDK app

`stiggVercelMiddleware()` is a language model middleware: hand it to the AI SDK's own
`wrapLanguageModel`, and every call the [Vercel AI SDK](https://ai-sdk.dev) makes on that model is
checked before it runs and metered after (`ai` 7 and `ai` 6): `generateText`, `streamText`, and each
step of an agent's loop. It runs on the same core as the LangChain and ADK bindings, and imports
nothing from `ai` - a middleware is a plain object.

No Vercel account is involved unless you call models through Vercel's AI Gateway: the AI SDK is a
library, and the model provider bills you.

## One model call

```ts
import { StiggAgentSDK, stiggVercelMiddleware } from '@stigg/agent-sdk-js';
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, wrapLanguageModel } from 'ai';

const stigg = new StiggAgentSDK();

const model = wrapLanguageModel({
  model: anthropic('claude-opus-5'),
  middleware: stiggVercelMiddleware({ stigg, stiggContext: { entitlement: { currencyId: 'credits' } } }),
});

await generateText({
  model,
  prompt,
  providerOptions: { stigg: { customerId: user.customerId } }, // this call's stiggContext
});
```

A call's own `stiggContext` rides `providerOptions.stigg`, the AI SDK's per-call field for provider
settings. It is laid over the middleware's own `stiggContext`. It is taken out of the call before the provider sees it, so it is never sent - not
even through the AI Gateway, which posts a call's options whole.

It cannot carry `idempotencyKey`: the AI SDK passes one call's `providerOptions` to every step and
retry, so they would all share it. Each step is keyed by its model's response id instead.

A call with no customer - neither on the middleware nor on the call - is refused before the model is
called, with an error that says so.

## A multi-agent app

The AI SDK names no agents: a sub-agent is a `generate()` call inside a tool. So each agent gets a
model of its own, wrapped as that agent:

```ts
const credits = { currencyId: 'credits' };
const governed = (agentId: string) =>
  wrapLanguageModel({
    model: anthropic('claude-opus-5'),
    middleware: stiggVercelMiddleware({
      stigg,
      stiggContext: { attributionKey: 'agentId', agentId, entitlement: credits },
    }),
  });

// Who a request is for: each agent's call option, and the delegating tool's context.
const Request = z.object({ customerId: z.string() });

const researcher = new ToolLoopAgent({
  model: governed('agent-researcher'),
  tools: { web_search },
  callOptionsSchema: Request,
  prepareCall: ({ options, ...call }) => ({
    ...call,
    providerOptions: { ...call.providerOptions, stigg: { customerId: options.customerId } },
  }),
});

const lead = new ToolLoopAgent({
  model: governed('agent-lead'),
  tools: {
    research: tool({
      inputSchema: z.object({ brief: z.string() }),
      contextSchema: Request,
      execute: async ({ brief }, { context }) => {
        try {
          return (await researcher.generate({ prompt: brief, options: context })).text;
        } catch (err) {
          // The error's message names the refused entity and why. Thrown, the AI SDK would hand
          // that text to the lead's model - so say something neutral instead.
          if (stigg.denial(err)) return 'The researcher is not available right now.';
          throw err;
        }
      },
    }),
  },
  callOptionsSchema: Request,
  prepareCall: ({ options, ...call }) => ({
    ...call,
    providerOptions: { ...call.providerOptions, stigg: { customerId: options.customerId } },
    toolsContext: { research: options },
  }),
});

// Per request: the customer, from your authenticated user - never from the request body.
await lead.generate({ prompt, options: { customerId: user.customerId } });
```

`callOptionsSchema` and `prepareCall` are the AI SDK's typed way to give an agent per-call data
(v7): `prepareCall` puts the customer where this agent's model calls read it, and in the context of
the tools that run sub-agents.

**One governed model per agent.** The agent is the one named in that model's middleware: share one
model between two agents and everything is reported for the first.

## Paid tools

A model call is governed whenever the middleware is there. A tool is governed only when the
middleware's `tools` names it, because most tools cost the customer nothing. A model middleware
never sees a tool run, so pass your tools through the same middleware's `tools()`: it wraps each
one's `execute`, so the tool is checked before it runs and reported after it succeeds.

```ts
const stiggMiddleware = stiggVercelMiddleware({
  stigg,
  stiggContext: { agentId: 'agent-researcher', entitlement: credits },
  tools: {
    // Check, then one unit per call.
    send_email: { currencyId: 'credits' },
    // Check, then report what the call used: here, a credit per search result.
    web_search: { entitlement: { currencyId: 'credits' }, usage: ({ output }) => ({ credits: output.results.length }) },
    // Every tool not named here...
    '*': { currencyId: 'credits' },
    // ...except a sub-agent held as a tool, whose own model calls are already reported.
    writer: false,
  },
});

const researcher = new ToolLoopAgent({
  model: wrapLanguageModel({ model: anthropic(MODEL), middleware: stiggMiddleware }),
  tools: stiggMiddleware.tools({ send_email, web_search, writer }),
});
```

The entries are the LangChain binding's - see [Tools](langchain.md#tools) for what each one checks
and reports - except that a `usage` mapper gets the tool's `output` exactly as `execute` returned it.
On top of those:

- **Who pays.** A tool call is checked and reported as the model step that asked for it: the same
  agent, and the customer that step named in `providerOptions.stigg`. Nothing new to pass.
- **Order.** A tool is checked once the step that asked for it has been reported, so a tool that
  shares the model's budget sees what the model spent.
- **One middleware.** Call `tools()` on the middleware of the model that calls those tools: the
  tool call is found by its id, which only that middleware saw.
- **Approved tools.** With `needsApproval`, the AI SDK runs an approved tool at the start of the
  next call, before any model step - so there is no step to take the customer from, nor when the
  approval reaches another server instance. Name it in the tool's own context instead:
  `toolsContext: { send_email: { stigg: { customerId } } }` on `ai` 7, `experimental_context: { stigg:
{ customerId } }` on `ai` 6. A tool with a `contextSchema` gets only what the schema declares, so add
  `stigg` to it. With neither, the tool is governed by the middleware's own
  `stiggContext` - its default customer, or refused with no customer at all - and the SDK warns
  once per tool.
- **Parallel calls.** The tools one step asks for run at once, so they are all checked before any of
  them reports: together they can spend a little past the budget, as in LangChain.
- **Streaming tools.** An `execute` written as `async function*` streams its results through, and is
  reported by its last one. A plain function that returns an async iterable is run to its end and
  answered by its last value, without the results in between.
- **Events.** A tool is reported as `tool.<name>` - put a meter on it.

## What a refusal does

A refused model call throws `AccessDeniedError`. A refused tool does not run.

| Refused                                              | What happens                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A model call of the agent you called `generate()` on | `generate()` rejects with it. `stigg.denial(err)` reads the decision.                                                                                                                                                                                                                                                                                     |
| A sub-agent run inside a tool                        | Left uncaught, the AI SDK hands the error's **message** to the calling model as the tool's result, and the agent goes on. That message names the refused entity and the reason - Stigg ids your model, and so your user, should not see. Catch it in your tool's `execute` and return something neutral, as above; the example asks a generalist instead. |
| A model call inside `streamText` or `agent.stream()` | The stream does not reject: the error reaches `onError` and the stream ends. Read it there.                                                                                                                                                                                                                                                               |
| A paid tool                                          | The tool does not run. It fails with `<tool> is not available: <reason>.`, which the AI SDK hands to the model as the tool's result, and the agent goes on. The message names neither the refused entity nor what is left. `stigg.denial(error)` reads the decision from the `tool-error` part.                                                           |

## Streaming

A streamed call is metered once, when the stream ends, from the usage the provider states on its
last part. A stream **stopped early** with an `abortSignal` - a user pressing stop - is reported by
an estimate of the output it produced (about 4 characters a token), marked `estimated`: its input
tokens are not known. A stop is normal, so it is not counted as a metering failure - unless the
model had answered but produced no output yet, when there is nothing to estimate. A stop before the
model answered at all reports nothing. A stop that lands after the model finished but before your
code read its last part is estimated too, so it can come in a little under what the provider counted.

A **timeout** - the AI SDK's `timeout`, or an `AbortSignal.timeout()` of your own - aborts the same
signal, and is counted as a metering failure, as is a stream that fails partway.

**Pass the request's `abortSignal` to `streamText()`.** A stream your code simply stops reading -
a `break` out of `for await` - with no `abortSignal` is not reported at all.

A model that states **no usage** at all - an OpenAI-compatible server without `include_usage`, say -
is estimated the same way, streamed or not, and counted as a metering failure (`onError`,
`summary().ingestFailures`): the meter is running on a guess.

An attempt that failed before producing anything - one the AI SDK retries - reports nothing.

## What is reported

Two events: `vercel-ai.generate` for a model call and `vercel-ai.stream` for a streamed one - put a
meter on both, or a meter on one misses the other's usage. Each carries the AI SDK's usage, under
this SDK's snake_case names for its fields: `input_tokens` (`inputTokens.total`), `output_tokens`,
`total_tokens`, and `cache_read_tokens` / `cache_write_tokens` when the provider states them. They
overlap the way
OpenAI's do - `input_tokens` already includes the cached input - so a meter that prices a cache read
lower prices `cache_read_tokens` at its own rate and takes it out of the input. The normalized `usage`
a mapper reads is disjoint: `usage.input` is the uncached input only.

## With other middleware

`wrapLanguageModel` takes a list, and the first runs outermost. Put Stigg's last, next to the model -
logging, caching, guardrails go before it:

```ts
wrapLanguageModel({ model, middleware: [guardrails, cache, stiggVercelMiddleware({ stigg, stiggContext })] });
```

A cached answer that never reaches the model is then neither checked nor reported, and a request the
guardrails block costs nothing.

A `prepareStep` that returns `providerOptions` is merged into the call's (`ai` 7), so `stigg` stays.
Leave `stigg` out of what it returns: set it there and every step gets a new `stigg` object, so a
step is no longer checked after the last streamed step's report lands - it can spend a little past
the budget.
A `prepareStep` that returns a different `model` runs that step on it: wrap that one too, or the step
is not governed.

## Not covered yet

- **Tools the provider runs.** A provider tool (`type: 'provider'`, such as Anthropic's web search)
  runs at the provider, not through `execute`, so it cannot be checked.
- **Client-side tools.** A tool with no `execute` runs in your client, not here, so it is not
  governed.
- **Sub-agents in tools.** The AI SDK keeps no run tree, so a sub-agent run inside a tool does not
  inherit the customer: pass `providerOptions.stigg` to it yourself, as above.
- **Vercel Workflow.** A durable step serializes the model and rebuilds it from its provider, which
  drops the middleware: that step runs ungoverned.

## Try it

```sh
yarn example-orchestrator-vercel-ai-handoff
```

It runs with no API keys against built-in mocks of Anthropic and Stigg. The researcher's budget lasts
three requests; on the fourth, the lead's tool asks a generalist instead.
