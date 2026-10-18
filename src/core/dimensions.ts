/**
 * The vendor's usage object, reduced to something an event can carry.
 *
 * Stigg dimensions are a flat map of scalars, so a nested object has to be flattened or dropped -
 * there is no third option, and stringifying a subtree would put something no meter can aggregate
 * into a field a meter is meant to read.
 *
 * Everything here is a limit rather than a translation, because the input is not ours: a vendor
 * adds fields whenever it likes, and this runs on every metered call. Depth, count and type are
 * all capped so a response that grows a large nested block cannot grow the event with it.
 */

/** Prefix for everything read off the vendor's object, so it can never shadow a metric. */
export const RAW_PREFIX = 'raw.';

const MAX_DEPTH = 2;
const MAX_KEYS = 32;

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

/**
 * The vendor's own usage block as event dimensions, `raw.`-prefixed and flattened with dotted keys.
 *
 * Fractions are kept: an event states what the vendor said and a meter is free to sum decimals,
 * which is the one place a gateway's `cost` can be reported honestly. `null`, `undefined`, arrays
 * and anything past the depth cap are dropped rather than coerced - a zero that was never reported
 * is worse than a counter that is absent.
 */
export function flattenRaw(raw: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  if (!raw) return {};
  const flat: Record<string, string | number | boolean> = {};
  const walk = (node: Record<string, unknown>, path: string, depth: number): void => {
    for (const [key, value] of Object.entries(node)) {
      if (Object.keys(flat).length >= MAX_KEYS) return;
      const name = path ? `${path}.${key}` : key;
      if (isScalar(value)) flat[`${RAW_PREFIX}${name}`] = value;
      else if (depth < MAX_DEPTH && value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, name, depth + 1);
      }
    }
  };
  walk(raw, '', 0);
  return flat;
}
