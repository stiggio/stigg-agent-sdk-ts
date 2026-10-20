/**
 * `../.env` - the half of the environment a real application also has.
 *
 * Which Stigg to talk to, and nothing else. One key and one URL, pointed at whichever environment
 * you mean: the key is environment-bound, so the two always move together and there is no
 * separate profile name to keep in sync with them.
 *
 * Everything the examples read that an application would *not* read from an env file - the
 * tenant, the agent, what to gate on - is in `demo-env.ts` instead. The examples keep both in
 * scope under their own names, `env` and `demoEnv`, so a reader can tell at the call site which
 * half a value came from.
 */
const DEFAULT_BASE_URL = 'https://api.stigg.io';

export type StiggEnv = {
  /**
   * The key to talk to Stigg with, and **unset whenever the examples are offline** - including
   * when one was configured and AGENT_SDK_OFFLINE overrode it.
   *
   * So `offline === !apiKey`, always. That invariant is the point: a caller asking "is there a
   * key" and one asking "are we offline" cannot answer differently, which is the only way an
   * example can announce the mock and then talk to production.
   */
  apiKey?: string;
  /** Always set, so what is about to be hit is never implicit. */
  baseUrl: string;
  /** Run against the in-process mock: no key, or AGENT_SDK_OFFLINE set. */
  offline: boolean;
};

const isTruthy = (value: string | undefined) => ['1', 'true', 'yes'].includes((value ?? '').toLowerCase());

/** A variable that is set to nothing, or to spaces, is not set. */
export const text = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export function resolveStiggEnv(): StiggEnv {
  // `STIGG_SERVER_API_KEY` is the name the SDK itself reads and the one every Stigg SDK shares.
  // `STIGG_API_KEY` is still honoured so an existing `.env` keeps working - the two named
  // different things for a while, and filling in the template then leaving the constructor empty
  // used to throw.
  const configuredKey = text(process.env.STIGG_SERVER_API_KEY) ?? text(process.env.STIGG_API_KEY);
  // AGENT_SDK_OFFLINE forces the mock even when a key is present - a key can be valid while the
  // account has no credits, which would otherwise make the examples unrunnable.
  const offline = !configuredKey || isTruthy(process.env.AGENT_SDK_OFFLINE);

  return {
    offline,
    // Dropped when offline, so a configured key cannot be picked up by a caller that only checked
    // whether one exists. See the field's own note.
    apiKey: offline ? undefined : configuredKey,
    baseUrl: process.env.STIGG_BASE_URL || DEFAULT_BASE_URL,
  };
}

/**
 * Fails early with an actionable message rather than a 401 three calls later.
 *
 * Reaching this at all means a caller wanted a live key while the examples are offline, so the
 * message names both ways that happens.
 */
export function requireKey(env: StiggEnv): string {
  if (env.apiKey) return env.apiKey;
  throw new Error(
    'No STIGG_SERVER_API_KEY to run against - set it to a server key for the environment in ' +
      'STIGG_BASE_URL, and clear AGENT_SDK_OFFLINE, which forces the built-in mock even when a ' +
      'key is configured.',
  );
}
