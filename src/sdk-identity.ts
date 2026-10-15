/**
 * How a Stigg deployment can tell this SDK's traffic apart from everything else's.
 *
 * There is no analytics pipeline here and this is not one: nothing is emitted, nothing is batched,
 * nothing fires on a schedule. Adoption is read off the requests the SDK was already making, which
 * is the same answer the Node server SDK and the sidecar give - identity rides along on headers,
 * so there is no second network path to fail, no payload to review for what it collects, and
 * nothing to disable.
 *
 * Without this, an agent-sdk install is invisible: its GraphQL half reports as a plain
 * `node-server-sdk` client, and its REST half carries no Stigg identity at all.
 */

/**
 * This package's own version, read from its manifest rather than restated here - a constant would
 * have to be remembered on every release, and the one release where it is not is the release the
 * numbers quietly stop meaning anything.
 *
 * `dist/sdk-identity.js` and `src/sdk-identity.ts` both sit one directory under the package root,
 * so the same relative path works built and from source.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const AGENT_SDK_VERSION: string = require('../package.json').version;

/**
 * Deliberately not `SourceType.AgentSdk`: that enum lives in Stigg's GraphQL schema, the API
 * groups on it, and there is no member for this SDK. Adding one is a server change that has to
 * land first, so the client name is what carries the distinction in the meantime - exactly the
 * trade the sidecar made when it started naming itself.
 */
export const AGENT_SDK_CLIENT_NAME = 'agent-sdk-js';

/**
 * The REST client's equivalent, since it has no client-awareness convention of its own.
 *
 * Named into the `X-SDK-` family the GraphQL transport already sends, so both halves of one
 * agent-sdk process are recognizable the same way. Nothing on the server branches on these; they
 * arrive as trace tags, which is all identity needs to be.
 */
export const AGENT_SDK_REST_HEADERS: Record<string, string> = {
  'X-SDK-CLIENT-NAME': AGENT_SDK_CLIENT_NAME,
  'X-SDK-CLIENT-VERSION': AGENT_SDK_VERSION,
};
