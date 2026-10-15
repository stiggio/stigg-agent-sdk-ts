# Examples

What each one *demonstrates*, and how to run it, is [section 6 of the package
README](../README.md#6-run-the-examples). This file answers the question that one does not:
standing in this folder, which of these files is a thing you run?

Seventeen are. Everything else is imported by them.

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
| `gateway/openrouter.ts` | `example-gateway-openrouter` (and `example-gateway`) — the same gateway through `@openrouter/sdk` |
| `gateway/litellm.ts` | `example-gateway-litellm` |
| `gateway/bedrock.ts` | `example-gateway-bedrock` — the gateway that states no price, so it meters tokens |
| `gateway/databricks.ts` | `example-gateway-databricks` — Databricks' **own** client, `@databricks/sdk-modelservingquery`, whose whole surface is `client.query(…)`. Same recipe as the row above, different wire. `AGENT_SDK_DATABRICKS_EXTERNAL=1` runs it against the external-model recipe |
| `gateway/cloudflare.ts` | `example-gateway-cloudflare` — Cloudflare's own client, and the one example that does not stream: a streamed `ai.run` carries no usage to read |
| `shared/setup-governance.ts` | `example-setup` — also imported by every example above |

Run them as `yarn workspace @stigg/agent-sdk-js run <script>`.

All of them work with no keys and no Stigg account **except `example-client-typesafe`**: the
built-in vendor mock speaks the chat wire formats, and TypeSafe's System One is not one of them.
Stigg still falls back to its own mock there, so only the vendor key is required.

The nine chat examples — `anthropic`, `openai`, `gemini`, `groq`, `mistral`, `ollama`,
`openrouter`, `litellm` and `databricks` — share one REPL and stay open until you end them. The
rest run a fixed script and exit: `typesafe`, which asks a whole set of typed questions in one call
rather than holding a conversation, `two-agents`, `cloudflare`, and the gateway examples. The
test suite runs three of those — the OpenRouter and LiteLLM gateways, and `two-agents`.

## Imported, not runnable

```
client/core/     chat.ts          the governed REPL every vendor chat shares
                 vendor.ts        what differs per vendor, and nothing else
                 openai-stream.ts draining an OpenAI-shaped SSE stream

gateway/core/    gateway.ts       both gateway topologies, shared by the two helpers
                 vendor.ts        where a gateway writes down what it charged, and how it is called
                 proxy.ts         a real HTTP proxy on a loopback socket
```

Each `core/` directory holds the part that is not vendor-specific, and the files beside it hold
the part that is. That split is the point rather than an accident of refactoring: governance
wiring written once is governance wiring that cannot drift between vendors.

## Scaffolding

```
shared/  load-env.ts          reads ../.env then demo.env; imported first, for its side effect
         stigg-env.ts         ../.env -> StiggEnv: which Stigg, the half a real app also has
         demo-env.ts          demo.env -> DemoEnv: the fixtures only a demo reads
         setup-governance.ts  seeds the customer, pool, entity types, team and budgets
         mock-server.ts       the vendor mock: real Anthropic / OpenAI / Gemini / gateway wire formats
         mock-stigg-server.ts a shim over testing/mock-stigg-server.ts, shared with the tests
         demo.env.template    every AGENT_SDK_DEMO_* fixture, documented
```

`demo.env` is yours and git-ignored; copy the template if you want to change the fixtures.
