import type { ClientRecipe } from '../client/core/types';
import type { StiggContext } from '../../core/context';
import type { SessionHooks } from '../../core/session';
import type { ClientContext, ClientGovernance } from '../../types';

/** Whatever `fetch` the application already uses. Defaults to the global one. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** `fetch`'s own second argument, plus the per-call context a wrapped client reads off its params. */
export type GovernedRequestInit = RequestInit & {
  /** Overrides the context `wrapFetch` was given, for this request only. Never sent on the wire. */
  stiggContext?: StiggContext;
};

export type FetchOptions = {
  /**
   * The endpoint whose calls are governed - the gateway's base URL. A request outside it, or to a
   * path no recipe method answers, goes through untouched: this is a `fetch`, and an application
   * reaches more than its gateway with one.
   */
  baseUrl: string;
  /**
   * What the responses mean. Required, unlike at `wrap`: there is no client object to recognise a
   * vendor by, and guessing from a URL is exactly the decision that bills the wrong party. Any
   * recipe over the OpenAI or Anthropic wire works - `agentgatewayRecipe()`, `litellmRecipe()`,
   * `openAIRecipe` - because the request path says which of its methods a call is.
   */
  recipe: ClientRecipe;
  /** The `fetch` to govern. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Everything this fetch reports back while it works. See {@link SessionHooks}. */
  hooks?: SessionHooks;
  /** The default context for every governed request. Any request may override it. */
  stiggContext?: ClientContext;
};

/**
 * A `fetch` bound to this environment: a request to a governed route is checked before it leaves
 * and metered from its response, exactly as the same call through a wrapped SDK client would be.
 */
export type GovernedFetch = ((input: string | URL | Request, init?: GovernedRequestInit) => Promise<Response>) & {
  /** What this fetch did, and what is still in flight. The same handle a wrapped client carries. */
  readonly stigg: ClientGovernance;
};
