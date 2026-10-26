/**
 * `@stigg/agent-sdk-js/langchain` - Stigg governance for LangChain and LangGraph.
 *
 * Its own entry point because it imports `@langchain/core`, which the package's main entry never
 * does: an application that does not run LangChain never loads it. `@langchain/core` is an optional
 * peer dependency, so this uses the copy the application already has - the one whose callback
 * manager will be calling the handler.
 *
 *   import { StiggAgentSDK } from "@stigg/agent-sdk-js";
 *   import { StiggLangChainCallbackHandler, AccessDeniedError } from "@stigg/agent-sdk-js/langchain";
 */
export {
  StiggLangChainCallbackHandler,
  CUSTOMER_METADATA_KEY,
} from '../bindings/orchestrator/langchain/callback-handler';
export type { StiggLangChainCallbackOptions } from '../bindings/orchestrator/langchain/callback-handler';
// What a refusal is, re-exported so a catch block needs one import: `e instanceof AccessDeniedError`.
export { AccessDeniedError, isAccessDenied } from '../errors';
