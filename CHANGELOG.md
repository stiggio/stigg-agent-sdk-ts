# Changelog

What has landed here, newest first.

This is not a release log. `@stigg/agent-sdk-js` is versioned and released by Stigg, and the
versions below track what this repository holds rather than what npm publishes.

## Unreleased

### Added

- Orchestrator governance for LangChain and LangGraph: `StiggLangChainCallbackHandler` from the new
  `@stigg/agent-sdk-js/langchain` entry, over the framework-neutral `stigg.middleware(...)`. One
  handler per graph checks and bills each step as the agent that took it, governs tools by name
  (`'*'` for the rest, `false` to exempt one, a `usage` mapper to price by use), and throws
  `AccessDeniedError` inside the refused agent so the graph decides what a refusal means.
- `docs/langchain.md`, a guide to every LangChain and LangGraph configuration, and two runnable
  examples of the same governed chat: `yarn example-orchestrator-langchain` and
  `yarn example-orchestrator-langgraph`.
- OpenTelemetry spans for orchestrators: a `stigg.check` and a `stigg.ingest` span per step from the
  middleware and the LangChain handler, so Langfuse, LangSmith and the rest show Stigg in the
  graph's own trace with nothing to configure. A wrapped client emits none.
  `@opentelemetry/api` and `@langchain/core` are optional peer dependencies.
- Customers are provisioned onto a default plan the first time a call names one Stigg does not
  know yet, through `stiggContext.defaultPlanId`.
- The SDK: the run lifecycle, the client and gateway bindings, the examples, and the test suite.
- The repository itself: Yarn 4 through Corepack, ESLint and Prettier in the configuration the SDK
  is written against, a single CI job, and the checks in `tools/repo-tests`.
