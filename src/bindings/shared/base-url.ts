/**
 * Reading a client's `baseURL`, which is the only thing that says which vendor is on the far end.
 *
 * Shape cannot answer that question: every OpenAI-compatible endpoint has the same methods, so
 * `matches` falls back to the URL, and a wrong answer there does not throw - it silently meters
 * one vendor's traffic under another vendor's name and bills the wrong party. That is what makes
 * these few lines the most consequential ones in a binding, and why they live in one place rather
 * than being written out per recipe.
 *
 * The subdomain rule below is the part worth getting exactly right, and the part a hand-written
 * copy tends to get wrong. Five recipes match on a host - Groq, OpenRouter, LiteLLM, Databricks
 * and Cloudflare - and two of them need a *set* of host suffixes rather than one, with Databricks
 * needing the path as well, because its host families cover every Databricks API and most of them
 * are not inference.
 *
 * This is deliberately not in `token-usage.ts`. That file is the vocabulary of what a response
 * counts, and a hostname is not a counter.
 */

/** The hostname, lowercased, or '' when the URL is not one this can reason about. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** The path, lowercased and without trailing slashes, or '' when the URL will not parse. */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * Whether a URL is served by `expected` or a subdomain of it.
 *
 * The dot is the whole point. A substring test lets `api.vendor.com.attacker.net` through, and an
 * `endsWith` without it lets `notvendor.com` match `vendor.com` - both are somebody else's domain,
 * and claiming either attributes their traffic to this vendor.
 */
export function matchesHost(url: string, expected: string): boolean {
  const host = hostOf(url);
  const want = expected.toLowerCase();
  if (!host || !want) return false;
  return host === want || host.endsWith(`.${want}`);
}

/**
 * The same test against several hosts, for a platform that serves one product from more than one
 * domain - Databricks has a hostname per cloud, and none of them is more canonical than the rest.
 */
export function matchesAnyHost(url: string, expected: readonly string[]): boolean {
  return expected.some((host) => matchesHost(url, host));
}

/**
 * Whether `candidate` is the configured endpoint, or something underneath it.
 *
 * A prefix match on the raw string lets `.../v1` claim `.../v10`, which is a different deployment
 * with a different price list. Compare the origin, then the path one whole segment at a time.
 */
export function withinBaseUrl(configured: string, candidate: string): boolean {
  try {
    const want = new URL(configured);
    const got = new URL(candidate);
    if (want.origin !== got.origin) return false;
    const base = want.pathname.replace(/\/+$/, '');
    const path = got.pathname.replace(/\/+$/, '');
    return path === base || path.startsWith(`${base}/`);
  } catch {
    return false;
  }
}

/** A client's configured base URL, when it has one this can read. */
export function baseUrlOf(client: unknown): string | undefined {
  const configured = (client as { baseURL?: unknown } | null)?.baseURL;
  return typeof configured === 'string' ? configured : undefined;
}
