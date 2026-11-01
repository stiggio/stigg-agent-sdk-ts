/**
 * `@stigg/agent-sdk-js/adk` - Stigg governance for Google ADK.
 *
 * Its own entry point because it imports `@google/adk`, which the package's main entry never does:
 * an application that does not run ADK never loads it. `@google/adk` is an optional peer
 * dependency, so this uses the copy the application already has - the one whose Runner will be
 * calling the plugin.
 *
 *   import { StiggAgentSDK } from "@stigg/agent-sdk-js";
 *   import { StiggAdkPlugin } from "@stigg/agent-sdk-js/adk";
 */
export { StiggAdkPlugin, DENIED_ERROR_CODE } from '../bindings/orchestrator/adk/plugin';
export type { AdkRefusal, AdkRefusalAnswer, AdkStep, StiggAdkPluginOptions } from '../bindings/orchestrator/adk/plugin';
// What a refusal is, for an application that catches one itself - in its own callback, say.
export { AccessDeniedError, isAccessDenied } from '../errors';
