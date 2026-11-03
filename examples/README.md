# Examples

What each one *demonstrates*, and how to run it, is [section 6 of the package
README](../docs/guide.md#6-run-the-examples). This file answers the question that one does not:
standing in this folder, which of these files is a thing you run?

Twenty-two are. Everything else is imported by them.

## Runnable

| File | Script |
| --- | --- |
| `client/anthropic.ts` | `example-client-anthropic` (and `example-client`) |
| `client/openai.ts` | `example-client-openai` |
| `client/gemini.ts` | `example-client-gemini` |
| `client/groq.ts` | `example-client-groq` |
| `client/mistral.ts` | `example-client-mistral` |
| `client/ollama.ts` | `example-client-ollama` — self-hosted, so a **host** rather than a key |
| `client/openrouter.ts` | `example-client-openrouter` — the OpenAI SDK pointed at the gateway |
| `client/litellm.ts` | `example-client-litellm` |
| `client/databricks.ts` | `example-client-databricks` — the OpenAI SDK pointed at a workspace `/serving-endpoints`. `AGENT_SDK_DATABRICKS_EXTERNAL=1` asserts the external-model route |
| `client/typesafe.ts` | `example-client-typesafe` — **needs a real TypeSafe key**, see below |
| `client/two-agents.ts` | `example-two-agents` — scripted, so it ends by itself |
| `orchestrator/langchain/langchain-handoff.ts` | `example-orchestrator-langchain` — a multi-agent orchestrator chat — a lead LangChain `createAgent` that delegates to a researcher (with a tool loop) and a writer held as tools — governed by one `StiggLangChainCallbackHandler`, each agent as itself; once Stigg refuses the researcher, the lead takes another pass with a generalist answering without search; with a live trace, a guard rail of five calls per tool per run, and optional Langfuse tracing beside Stigg |
| `orchestrator/langchain/langgraph-handoff.ts` | `example-orchestrator-langgraph-handoff` — agents handing work to each other: the same chat as a hand-built LangGraph `StateGraph`, one node per agent: the same `StiggLangChainCallbackHandler`, `agents` keyed by node name, and a refused researcher routed to the generalist by a graph edge |
| `orchestrator/langchain/langgraph-model-fallback.ts` | `example-orchestrator-langgraph-model-fallback` — one LangGraph agent in one node with a budget per model, each scoped to its model by a `model` dimension: it answers with an expensive Anthropic model until that model's budget runs out, then with a cheaper one in the same turn |
| `orchestrator/adk/adk-handoff.ts` | `example-orchestrator-adk-handoff` — a Google ADK chat: a coordinator hands each request to a researcher (a paid `web_search`), which hands it to a writer, governed by one `StiggAdkPlugin` on the Runner, each agent as itself; once the researcher runs dry, `onRefusal` hands its turn to a generalist answering without search, and the writer still answers |
| `orchestrator/adk/adk-model-fallback.ts` | `example-orchestrator-adk-model-fallback` — a Google ADK assistant on an expensive Gemini model, and its twin on a cheaper one, each an agent with its own budget under one `StiggAdkPlugin`; once the assistant runs dry, `onRefusal` hands each request to the twin |
| `orchestrator/vercel-ai/vercel-ai-handoff.ts` | `example-orchestrator-vercel-ai-handoff` — a Vercel AI SDK chat: a lead `ToolLoopAgent` hands each request to a researcher and a writer held as tools, each agent on its own model wrapped with `stiggVercelMiddleware`; once the researcher runs dry, the lead's tool asks a generalist answering without search |
| `gateway/openrouter.ts` | `example-gateway-openrouter` (and `example-gateway`) — the same gateway through `@openrouter/sdk` |
| `gateway/litellm.ts` | `example-gateway-litellm` |
| `gateway/bedrock.ts` | `example-gateway-bedrock` — the gateway that states no price, so it meters tokens |
| `gateway/databricks.ts` | `example-gateway-databricks` — Databricks' **own** client, `@databricks/sdk-modelservingquery`, whose whole surface is `client.query(…)`. Same recipe as the row above, different wire. `AGENT_SDK_DATABRICKS_EXTERNAL=1` runs it against the external-model recipe |
| `gateway/cloudflare.ts` | `example-gateway-cloudflare` — Cloudflare's own client, and the one example that does not stream: a streamed `ai.run` carries no usage to read |
| `shared/setup-governance.ts` | `example-setup` — also imported by every example above |

Run them as `yarn <script>`.

All of them work with no keys and no Stigg account **except `example-client-typesafe`**: the
built-in vendor mock speaks the chat wire formats, and TypeSafe's System One is not one of them.
Stigg still falls back to its own mock there, so only the vendor key is required.

The nine chat examples — `anthropic`, `openai`, `gemini`, `groq`, `mistral`, `ollama`,
`openrouter`, `litellm` and `databricks` — share one REPL and stay open until you end them, as do
the orchestrator examples, which are chats with a graph of agents rather than with a model. The
rest run a fixed script and exit: `typesafe`, which asks a whole set of typed questions in one call
rather than holding a conversation, `two-agents`, `cloudflare`, and the gateway examples. The
test suite runs three of those — the OpenRouter and LiteLLM gateways, and `two-agents` — and
every orchestrator example as well, with its input piped in.

## Imported, not runnable

```
client/core/     chat.ts          the governed REPL every vendor chat shares
                 vendor.ts        what differs per vendor, and nothing else
                 openai-stream.ts draining an OpenAI-shaped SSE stream

gateway/core/    gateway.ts       both gateway topologies, shared by the two helpers
                 vendor.ts        where a gateway writes down what it charged, and how it is called
                 proxy.ts         a real HTTP proxy on a loopback socket

orchestrator/    chat.ts          the governed chat every orchestrator example shares: setup,
core/                             registering the agents, the Stigg options, the REPL - no framework
                 scenarios.ts     the scenarios as data - handoff, model fallback: agents, budgets,
                                  the paid tool, who takes over on a refusal
                 style.ts         terminal colours, agent tags and indentation

orchestrator/    kit.ts           LangChain and LangGraph: the model, the search, the callback
langchain/                        handler that carries the Stigg options, Langfuse

orchestrator/    kit.ts           Google ADK: the model, the Runner, reading ADK events into the trace
adk/
```

Each `core/` directory holds the part that is not vendor-specific, and the files or folders
beside it hold the part that is. That split is the point rather than an accident of refactoring: governance
wiring written once is governance wiring that cannot drift between vendors.

## Scaffolding

```
shared/  load-env.ts          reads ../.env then demo.env; imported first, for its side effect
         stigg-env.ts         ../.env -> StiggEnv: which Stigg, the half a real app also has
         demo-env.ts          demo.env -> DemoEnv: the fixtures only a demo reads
         setup-governance.ts  seeds the currency or feature, entity types, demo plan, team and budgets
         mock-server.ts       the vendor mock: real Anthropic / OpenAI / Gemini / gateway wire formats
         mock-stigg-server.ts a shim over testing/mock-stigg-server.ts, shared with the tests
         demo.env.template    every AGENT_SDK_DEMO_* fixture, documented
```

`demo.env` is yours and git-ignored; copy the template if you want to change the fixtures.

With a real `STIGG_SERVER_API_KEY`, the seed writes to the environment that key belongs to: the
credit currency or feature, the `team` / agent / `model` entity types, and a free demo plan it
creates and publishes for new customers. Point the key at a sandbox environment, not production.
