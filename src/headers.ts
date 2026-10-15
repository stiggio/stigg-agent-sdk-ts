/**
 * The wire convention for splitting the run lifecycle across a process boundary.
 *
 * A gateway is out-of-process and sees requests, not runs. These headers are what lets the
 * application keep governance in-process while something downstream still ingests against the
 * right entity - so the convention belongs to the core, not to any one binding.
 */
export const GOVERNANCE_HEADERS = {
  customer: 'x-stigg-customer-id',
  dimensions: 'x-stigg-dimensions',
  run: 'x-stigg-run-id',
  /**
   * Which key in `dimensions` names the agent, when one does.
   *
   * Sent because the far end cannot work it out. Governance resolves an entity per attribution
   * key, and which keys those are is declared on the entity types in the account - so a receiver
   * holding only `{ agentId: 'a-1', region: 'eu' }` cannot tell the attribution from the
   * metadata. Guessing either way is wrong in a direction that costs money: treat every
   * dimension as attribution and an ordinary `region` rounds the draw up; treat none as
   * attribution and a real agent's budget stops counting.
   */
  attributionKey: 'x-stigg-attribution-key',
} as const;

/**
 * What `run.headers()` produces - all three, always.
 *
 * Built rather than parsed, so the type says so: an empty map or an unrelated one is not a set of
 * governance headers, and there is no point discovering that at the far end of a request. The
 * receiving side is deliberately looser, because what arrives there is whatever was sent.
 */
export type GovernanceHeaders = Record<(typeof GOVERNANCE_HEADERS)[keyof typeof GOVERNANCE_HEADERS], string>;

export type ParsedGovernanceHeaders = {
  customerId: string;
  dimensions: Record<string, string>;
  runId?: string;
  /** The key under which `dimensions` names the agent, when the sender named one. */
  attributionKey?: string;
};

/** The receiving side. Returns undefined when the request carries no attribution to act on. */
export function parseGovernanceHeaders(
  headers: Record<string, string | string[] | undefined>,
): ParsedGovernanceHeaders | undefined {
  // Node lowercases what it receives, but a map built by hand or converted from `Headers` keeps
  // whatever case the sender used, and losing attribution over it would be silent.
  // What a header is worth, whichever container it arrived in: `'c'` and `['c']` are the same
  // value under this function's own argument type, so comparing the containers would call them a
  // disagreement. A header present but blank is a header that is not set.
  const valueOf = (raw: string | string[] | undefined): string | undefined => {
    const first = Array.isArray(raw) ? raw[0] : raw;
    return first?.trim() ? first.trim() : undefined;
  };

  const lookup = new Map<string, string | undefined>();
  const ambiguous = new Set<string>();
  for (const [key, raw] of Object.entries(headers)) {
    const name = key.toLowerCase();
    const value = valueOf(raw);
    // Two spellings of one header, disagreeing. Folding case makes them the same name, and
    // letting the last one win would attribute the request to whichever the map happened to
    // iterate second - a silently wrong customer reads exactly like a right one.
    if (lookup.has(name) && lookup.get(name) !== value) ambiguous.add(name);
    lookup.set(name, value);
  }
  const read = (name: string): string | undefined => (ambiguous.has(name) ? undefined : lookup.get(name));

  const customerId = read(GOVERNANCE_HEADERS.customer);
  if (!customerId) return undefined;

  let dimensions: Record<string, string> = {};
  const raw = read(GOVERNANCE_HEADERS.dimensions);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      // `JSON.parse` succeeds on `null`, arrays and scalars, none of which are a dimensions map.
      if (isDimensions(parsed)) dimensions = parsed;
    } catch {
      // A malformed header must not cost the request; usage just loses its entity attribution.
      dimensions = {};
    }
  }

  // Only honoured when it names a dimension that is actually there: a key with nothing under it
  // attributes to no entity, and treating it as though it did would round a draw up for nothing.
  const attributionKey = read(GOVERNANCE_HEADERS.attributionKey);
  return {
    customerId,
    dimensions,
    runId: read(GOVERNANCE_HEADERS.run),
    ...(attributionKey && dimensions[attributionKey] ? { attributionKey } : {}),
  };
}

const isDimensions = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === 'string');
