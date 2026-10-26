# LangChain and LangGraph

How to govern a LangChain or LangGraph agent graph with Stigg: check each step before it runs, and
report what it used after. It covers the configurations the binding supports, from metering a
whole graph against a customer up to a budget per agent and a price per tool. For everything else
the SDK does, see the [full guide](guide.md).

```bash
npm install @stigg/agent-sdk-js      # @langchain/core is a peer: the copy your application already has
```

## The words, first

- **An orchestrator** runs several AI agents as one program. A lead agent hands work to others (a
  researcher, a writer); each makes its own model calls and uses its own tools.
- **LangChain** builds an agent with `createAgent`: a model, its tools and its instructions.
  **LangGraph** is the engine underneath, and also lets you draw the graph yourself, as nodes that
  do work and edges that pick the next node.
- **A callback** is an object passed to a run as `callbacks: [...]`. LangChain calls it before and
  after each model call and each tool call, in every agent beneath the run - including agents
  started from inside a tool. Langfuse and LangSmith plug in the same way.
- **The middleware** is `stigg.middleware(...)`: Stigg's step-level logic, with no framework in it.
  `StiggLangChainCallbackHandler` is the callback that plugs it into LangChain and LangGraph.

## One handler per graph

```ts
import { StiggAgentSDK } from '@stigg/agent-sdk-js';
import { StiggLangChainCallbackHandler, AccessDeniedError } from '@stigg/agent-sdk-js/langchain';

const stigg = new StiggAgentSDK({ apiKey }); // once per process

const stiggHandler = new StiggLangChainCallbackHandler({
  stigg,
  stiggContext: { entitlement: { currencyId: 'credits' } },
});

await agent.invoke(input, {
  callbacks: [stiggHandler], // beside any other handler - Langfuse, LangSmith
  metadata: { stiggCustomerId: 'customer-acme' }, // the customer, on every run
});
```

The handler is built once and passed on every `invoke`. The customer changes per request, so it
rides the run's `metadata` rather than the handler; a single-tenant application can put a default
in `stiggContext: { customerId }` instead. A run with neither is refused before its first step. A
run's `stiggCustomerId` wins over the default, so it must come from your server - see
[who names the customer](#who-names-the-customer).

What happens on each step:

| Step            | Before it runs                                          | After it succeeds                                                                                                                     |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A model call    | checked against the entitlement, when one is named      | its token usage reported, through the `usageMapper` - a chat model's `usage_metadata`, or a completion model's `llmOutput.tokenUsage` |
| A governed tool | checked against the tool's entitlement, when it has one | its `usage` reported, or one unit                                                                                                     |
| Any other tool  | nothing                                                 | nothing                                                                                                                               |

A step that fails is billed nothing. A refusal is thrown as `AccessDeniedError` from inside the
step, which is the only way a callback can stop LangChain; what it means is up to the graph - see
[when Stigg refuses](#when-stigg-refuses).

## Configurations

The configurations build on each other: each adds one option to the one before.

### Metering only

```ts
new StiggLangChainCallbackHandler({ stigg, stiggContext: {} });
```

No `entitlement`, so nothing is ever checked or refused: every model call is reported, and the
graph runs as it would without Stigg. By default a call reports LangChain's own counters -
`input_tokens`, `output_tokens`, `total_tokens` - so put meters behind those names in Stigg, or
convert with a `usageMapper` (below).

### Checking the whole graph against one entitlement

```ts
new StiggLangChainCallbackHandler({
  stigg,
  stiggContext: {
    entitlement: { currencyId: 'credits' },
    usageMapper: unitsPerTokens('credits', 1_000), // a credit per thousand tokens
    ingestMode: 'sync', // so the next check sees this call's spend
  },
});
```

Every model call in the graph - the lead's, and every sub-agent's - is checked against the
customer's credits and billed to them. This is the basic use: the same check-then-report a wrapped
client does, applied to every step of the graph.

- `usageMapper` turns a call's usage into what is reported, exactly as it does for
  `stigg.wrap(client)`. `unitsPerTokens(id, n)` is the one-number case; the
  [full guide](guide.md#writing-the-mapper-yourself) covers writing your own. It reports fractions,
  which a credit currency takes; a feature under `'sync'` takes whole numbers only, so round up
  there (`Math.ceil`), or the report is rejected.
- `ingestMode: 'sync'` reports through Stigg's usage API, so the next check already sees the spend.
  The default, `'async'`, is cheaper and has a higher rate limit, but meters only behind a
  raw-events meter, seconds later - so a fast graph can run past its limit before the check catches
  up.

### Each agent as itself

```ts
// Once, at startup: an entity and a budget per agent, under one parent that caps the graph.
await stigg.register({
  customerId,
  agentId: 'agent-orchestrator',
  entityTypeId: 'agent',
  budget: { entitlement: credits, limit: 160 },
});
for (const [agent, limit] of Object.entries({ lead: 100, researcher: 10, writer: 20 })) {
  await stigg.register({
    customerId,
    agentId: `agent-${agent}`,
    entityTypeId: 'agent',
    budget: { entitlement: credits, limit, parentId: 'agent-orchestrator' },
  });
}

new StiggLangChainCallbackHandler({
  stigg,
  stiggContext: { attributionKey: 'agentId', entitlement: credits, usageMapper, ingestMode: 'sync' },
  agents: {
    lead: { stiggContext: { agentId: 'agent-lead' } },
    researcher: { stiggContext: { agentId: 'agent-researcher' } },
    writer: { stiggContext: { agentId: 'agent-writer' } },
  },
});
```

Each step is checked and billed as the agent that took it, against that agent's own budget - and,
through the parent, the graph's. One agent running dry refuses that agent's steps and nothing else.

- **Keys.** A step belongs to the nearest run above it named for an agent in `agents`: a
  `createAgent` or `createReactAgent` by its `name`, or a node of a hand-built LangGraph
  `StateGraph` by its own. That is LangChain's run tree, so a sub-agent is billed as itself even
  when the tool that runs it passes on its parent's config - and the `lc_agent_name` in a run's
  metadata, which a caller can set, never decides whose budget pays.
- **Name every sub-agent.** One with no name, or a name `agents` does not list, is billed as the
  nearest listed agent above it - usually its parent. In a hand-built graph, name a node after the
  agent it runs, a subgraph's node included: the node's name is what the tree sees.
- **A top-level agent: set `rootAgent`.** The run you `invoke` is named by whoever invokes it -
  `invoke(input, { runName })` - so on its own its name would let a caller pick whose budget pays,
  or step outside every agent's. `rootAgent: 'lead'` fixes it: the top-level run is that agent,
  whatever it is named. When metadata names a configured agent that no run above a step is named
  after, the SDK says so once.
- **One context per step, not two.** An agent's `stiggContext` is laid over the shared one, field
  by field. Each step is checked once and reported once, under the merged context - an agent that
  sets only `agentId` still uses the shared `entitlement` and `usageMapper`. Nothing is billed twice.
- **An agent left out** runs under the shared context alone - at the customer level, unless that
  context names an agent - and the SDK warns once that it was not listed.
- **`idempotencyKey` is refused** on both contexts: every step would share it, and only the first
  would be billed. Each step is keyed by its own id.

### A hand-built LangGraph

The integration is the same handler, with `agents` keyed by node name:

```ts
const graph = new StateGraph(Turn)
  .addNode('lead', lead)
  .addNode('researcher', researcher)
  .addNode('tools', new ToolNode([search]))
  .addNode('writer', writer)
  // ...edges
  .compile();

await graph.invoke(input, { callbacks: [stiggHandler], metadata: { stiggCustomerId } });
```

Inside a `createAgent`, the agent's name wins over its internal nodes; in a hand-built graph the
node is the agent. A tool that runs in a node of its own - LangGraph's `ToolNode` - is billed to
the agent whose model called it, not to the `tools` node.

## Tools

A model call is governed whenever the handler is there. A tool is governed only when `tools` names
it, because most tools - a calculator, a lookup in your own database - cost the customer nothing.

```ts
new StiggLangChainCallbackHandler({
  stigg,
  stiggContext: { entitlement: credits, usageMapper, ingestMode: 'sync' },
  tools: {
    // Check, then one unit per call.
    send_email: { currencyId: 'credits' },

    // Check, then report what the call used: here, a credit per search result.
    tavily_search: {
      entitlement: { currencyId: 'credits' },
      usage: ({ output }) => ({ credits: output.results.length }),
    },

    // Metering only: never checked, always reported.
    sql_query: { usage: ({ output }) => ({ 'rows-read': output.rowCount }) },

    // Every tool not named here...
    '*': { currencyId: 'credits' },
    // ...except a sub-agent held as a tool, whose own model calls are already billed.
    researcher: false,
  },
});
```

| Entry                    | Checked before    | Reported after       |
| ------------------------ | ----------------- | -------------------- |
| an entitlement           | yes               | one unit against it  |
| `{ entitlement, usage }` | yes               | what `usage` returns |
| `{ usage }`              | never             | what `usage` returns |
| `false`                  | no                | nothing              |
| `'*'`                    | as its value says | as its value says    |

- **`usage`** gets `{ name, input, output }`: the tool's arguments and what it returned, parsed
  back from the JSON LangChain passes them as. It returns metrics by feature id, the same shape a
  `usageMapper` does. One that throws is a metering failure, reported through `onError`; the run
  goes on.
- **Double billing.** In LangChain, a sub-agent is often a tool of its parent (`tool(() =>
researcher.invoke(...))`). Its model calls are already checked and billed as it, so under `'*'`
  mark that tool `false`. The SDK cannot tell a sub-agent from any other tool, so it does not guess.
- **Per agent.** `agents.<name>.tools` is laid over the shared `tools`, name by name: an agent can
  add a paid tool of its own, or set a shared one to `false` to be exempt from it. `'*': false`
  opts the agent out of the catch-all only - a tool the shared `tools` names is still governed
  until the agent names it `false` too.
- **Who pays.** A tool is billed to the agent whose model called it, under that agent's context.
- **A packaged tool with no name.** A class-based tool like `TavilySearch` reaches the handler
  without its name, which is then taken from the model's tool call - remembered in the process
  that issued it. A run resumed on another process has no such call: its result still carries the
  tool's name, so it is billed when it ends, but it runs unchecked, and the SDK warns once. A node
  that invokes the tool directly (`tool.invoke({ q })`) has neither a call nor a named result: it is
  not checked and cannot be priced, and the SDK warns once per kind of tool - it may be a free one. Only `'*'` covers both -
  use it to govern packaged tools.
- **Only a call that succeeded is billed**, once, keyed by the model's tool-call id. A call that
  runs again - a retry, a resumed graph - is checked again and billed under the same key.
- Every entry is validated when the handler is built: one with neither an entitlement nor a
  `usage` is refused, since it would do nothing, and so is one that mixes the short form with
  `usage` (`{ currencyId, usage }`) - write it as `{ entitlement: { currencyId }, usage }`.

## Who names the customer

`stiggCustomerId` decides whose budget a run spends and whose entitlement it is checked against,
and a run's metadata wins over the handler's default. So it must be set by your server, from the
authenticated user - never passed through from the request.

- **In your own server**, set it where you call `invoke`, from your session or auth layer.
- **On LangGraph Platform**, the client sends the run's `metadata`, so a caller could name another
  customer. Set `stiggCustomerId` server-side instead - in your
  [custom auth](https://langchain-ai.github.io/langgraph/concepts/auth/) handler, from the
  authenticated identity - and ignore or overwrite any value the client sent. The client can name
  the run too, so set `rootAgent` on the handler rather than trust the run's name.
- **With `defaultPlanId`**, every customer id a run names becomes a customer on that plan, so a
  customer id a caller can choose is a customer a caller can create. Keep the id server-side, and
  make the default plan a free one - on a paid plan, each new id would start a paid subscription.

## When Stigg refuses

The refusal is an `AccessDeniedError` thrown inside the step that was refused. Where it lands
decides what happens, and the graph owns that:

| Refused                    | What LangChain does              | What the graph can do                                |
| -------------------------- | -------------------------------- | ---------------------------------------------------- |
| a governed tool            | the tool call fails              | return the refusal to the model as the tool result   |
| a sub-agent's model call   | the sub-agent's `invoke` rejects | route around it: another agent, or a degraded answer |
| the top agent's model call | your `invoke` rejects            | show the user the remedy                             |

`stigg.denial(err)` reads the decision back from whatever LangChain wrapped it in, or returns
`undefined` for an error that was not a refusal:

```ts
// A sub-agent held as a tool, with a fallback when Stigg refuses it.
const research = tool(
  async ({ brief }) => {
    try {
      return lastText((await researcher.invoke({ messages: [brief] })).messages);
    } catch (err) {
      const decision = stigg.denial(err);
      if (!decision) throw err;
      return (
        `(Unsourced - ${decision.message})\n` + lastText((await generalist.invoke({ messages: [brief] })).messages)
      );
    }
  },
  { name: 'researcher', description: 'Research a question.', schema },
);

// The top of the graph.
try {
  await lead.invoke(input, { callbacks: [stiggHandler], metadata: { stiggCustomerId } });
} catch (err) {
  const decision = stigg.denial(err);
  if (!decision) throw err;
  console.log(decision.message); // what to tell the user: a top-up, an upgrade
}
```

In a hand-built LangGraph, the node catches the refusal, records it in the state, and a
conditional edge routes on it - `state.refused ? 'generalist' : 'writer'`.

A check that could not be made - Stigg unreachable - is not a refusal. It resolves through
`checkErrorAction`: `'allow'` by default, so an outage does not stop your agents. Reporting never
throws into the run; a failed report goes to `onError` and is counted.

## Seeing what it did

- **Hooks.** `hooks: { onDecision, onIngest }` are called for every check and report, with
  `context.agent` and `context.tool` saying whose step it was.
- **OpenTelemetry, out of the box.** Every check and report is a `stigg.check` / `stigg.ingest`
  span, with a refusal as an `ERROR` span, in the same trace as the agents' own steps. There is
  nothing to turn on: whatever OpenTelemetry provider your observability tool registered (Langfuse,
  LangSmith, Datadog) receives them. Langfuse filters by scope, so add Stigg's - see
  [Observability](guide.md#observability-an-orchestrators-checks-and-ingests-are-opentelemetry-spans).
- **Flushing.** `await stigg.flush()` before the process exits, so no report is left in flight.

## Under the handler: your own framework

`StiggLangChainCallbackHandler` is a thin layer over `stigg.middleware(options)`, which takes the
same options and knows no framework. A harness of your own can drive it directly:

```ts
const middleware = stigg.middleware({ stiggContext, tools, agents });

await middleware.startModel(stepId, { agent: 'planner', customerId }, 'my-harness.model'); // throws on refusal
await middleware.endModel(stepId, { metrics: { credits: 1 } });
await middleware.startTool(toolStepId, { name: 'web_search', input }, { agent: 'planner', customerId });
await middleware.endTool(toolStepId, output);
```

## Known limits

- **Completion models report usage once per batch.** A batch of prompts reports its whole token
  usage on its first run, and a streamed completion reports none at all - which is said as a
  metering failure rather than billed as zero.
- **No reservation.** A check does not hold budget, so parallel tool calls from one agent can each
  pass and together overshoot.
- **Rounding per call.** Each report is a whole unit per entity, so many small calls round up more
  than one large one.
- **No rollout modes.** There is no observe or warn-only mode yet: with an entitlement named, a
  refusal is thrown.

## Run it

Two examples build the same chat - a lead, a researcher with a paid search, a writer, and a
generalist as the fallback - once with `createAgent` and once as a hand-built `StateGraph`, with
the same Stigg configuration. Both run with no keys at all:

```bash
yarn example-orchestrator-langchain
yarn example-orchestrator-langgraph
```

The researcher runs out of credits in the fourth turn, and the lead takes another pass with the
generalist. The sources are in [`examples/orchestrator/`](../examples/orchestrator/).
