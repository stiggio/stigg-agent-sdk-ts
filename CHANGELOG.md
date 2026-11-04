# Changelog

What has landed here, newest first.

This is not a release log. `@stigg/agent-sdk-js` is versioned and released by Stigg, and the
versions below track what this repository holds rather than what npm publishes.

## Unreleased

### Added

- agentgateway, the open-source AI gateway, and the builds on it (Solo Enterprise for agentgateway,
  Gloo AI Gateway): `agentgatewayRecipe()`, over both of its wires - an OpenAI client pointed at the
  gateway reports `agentgateway.chat.completions.create` or `agentgateway.responses.create`, an
  Anthropic client `agentgateway.messages.create` - with the model that served as a dimension. The
  gateway states no price, so it reports tokens. Name it with `agentgatewayRecipe({ baseUrl })`;
  without one it is recognised only by a hostname label that is, or starts with, `agentgateway-`,
  so Solo's and Gloo's builds need the base URL.
- `stigg.wrapFetch({ baseUrl, recipe })`, for a gateway called with plain HTTP rather than an SDK:
  it hands back a `fetch` that checks and reports each request a recipe declares, matched by its
  path (`/chat/completions`, `/responses`, `/messages`), with the same event names a wrapped client
  reports. A streamed reply is reported as the caller reads it; anything else passes through.
- AUDR records: pass `audr: { client, environment }` at construction and the SDK also writes an
  [AUDR](https://openaudr.dev/spec/v1.1.0/) record for every model call it measures, to your own
  `@openaudr/audr` client. Off by default; `@openaudr/audr` is an optional peer dependency, at
  `>=0.2.0 <0.3`.
- Metering-only agents: `register()` with a `budget` that names no `limit` creates an unlimited
  assignment (cadence `P1M` unless one is passed) when the agent has none, so its usage shows in
  the tree without capping it. An existing assignment, a cap set in the dashboard included, is left
  as it is.
- Runnable examples, offline with no keys: `yarn example-client-agentgateway` (an OpenAI client),
  `yarn example-client-solo` (an Anthropic client, against Solo Enterprise), and
  `yarn example-gateway-agentgateway` (plain `fetch` through `stigg.wrapFetch`).
- Orchestrator governance for the Vercel AI SDK (`ai` 6 and 7): `stiggVercelMiddleware()`, a
  language model middleware for the AI SDK's own `wrapLanguageModel`. Each model call of
  `generateText`, `streamText` or an agent's loop is checked before it runs and reported after, as
  the agent in the middleware's `stiggContext`; a call names its customer in
  `providerOptions.stigg`, which is taken out before the provider sees the call. A stream is
  reported once, when it ends. A stream the caller stops is estimated and is not a metering
  failure; a timeout, a failed stream, or a model that states no usage - streamed or not - is
  estimated and counted as one. See `docs/vercel-ai.md`, and
  `yarn example-orchestrator-vercel-ai-handoff` for a lead, researcher and writer whose refused
  researcher falls back to a generalist.
- Orchestrator governance for LangChain and LangGraph: `StiggLangChainCallbackHandler` from the new
  `@stigg/agent-sdk-js/langchain` entry, over the framework-neutral `stigg.middleware(...)`. One
  handler per graph checks each step and reports its usage as the agent that took it, governs
  tools by name (`'*'` for the rest, `false` to exempt one, a `usage` mapper to price by use), and
  throws `AccessDeniedError` inside the refused agent so the graph decides what a refusal means.
- Orchestrator governance for Google ADK: `StiggAdkPlugin` from the new `@stigg/agent-sdk-js/adk`
  entry. One plugin on the Runner checks each agent beneath it and reports its usage as that agent,
  by its ADK name. ADK has no per-run metadata, so `stepContext` resolves the customer per step, on
  the server, and `onRefusal` decides what a refused agent does instead - `{ transferTo: '...' }`
  hands its turn to another agent.
- A budget per model: a budget can be scoped to a dimension such as the model. Register each model
  as an entity, then give the agent a budget per model; a call states its model in its own
  `stiggContext`, so one model running dry leaves the others open.
- `docs/langchain.md`, a guide to every LangChain and LangGraph configuration, and a Google ADK
  section in `docs/guide.md`.
- Runnable orchestrator examples, offline with no keys:
  - `yarn example-orchestrator-langchain` and `yarn example-orchestrator-langgraph-handoff` - a
    lead hands work to a researcher and a writer, and a refused researcher falls back to a
    generalist.
  - `yarn example-orchestrator-langgraph-model-fallback` - a budget per model, answering with a
    cheaper model once the expensive one runs dry.
  - `yarn example-orchestrator-adk-handoff` and `yarn example-orchestrator-adk-model-fallback` - the
    same two on Google ADK, the fallback through `onRefusal`.
- OpenTelemetry spans for orchestrators: a `stigg.check` and a `stigg.ingest` span per step from the
  middleware and both bindings, so Langfuse, LangSmith and the rest show Stigg in the graph's own
  trace with nothing to configure. A wrapped client emits none. `@opentelemetry/api`,
  `@langchain/core` and `@google/adk` are optional peer dependencies.
- Customers are provisioned onto a default plan the first time a call names one Stigg does not
  know yet, through `stiggContext.defaultPlanId`.
- The SDK: the run lifecycle, the client and gateway bindings, the examples, and the test suite.
- The repository itself: Yarn 4 through Corepack, ESLint and Prettier in the configuration the SDK
  is written against, a single CI job, and the checks in `tools/repo-tests`.

### Changed

- `register()` with a budget or a parent, on an account without governance, throws before it
  provisions the customer instead of after.
- For a harness driving `stigg.middleware` directly: `StepAttribution.customerId` is gone - pass
  `stiggContexts: [{ customerId }]`. `metadata.stiggCustomerId` still works, deprecated.
