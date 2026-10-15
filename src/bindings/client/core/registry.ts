/**
 * Which recipe fits a given client.
 *
 * Recipes are matched by the shape of the client rather than by a name the caller has to supply,
 * so `wrap()` takes one argument and adding a provider is a registry entry - core never learns
 * about a vendor. An unmatched client fails loudly and names what is supported, because a silent
 * no-op here would mean a client that quietly meters nothing.
 */
import type { ClientRecipe, ClientRegistry } from './types';

export function createClientRegistry(recipes: ClientRecipe[] = []): ClientRegistry {
  const entries = [...recipes];
  return {
    register: (recipe) => {
      entries.push(recipe);
    },
    find: (client) => entries.find((recipe) => recipe.matches?.(client) ?? false),
    vendors: () => entries.map((recipe) => recipe.vendor),
  };
}

/** True when every segment of the path exists on the client and the last one is callable. */
// `readonly`, because the paths a caller has to hand are a recipe's own - and `MethodRecipe.path`
// is readonly so a literal tuple survives assignment. Taking a mutable array made the exported
// guard unusable with the exported type.
export function hasMethod(client: unknown, path: readonly string[]): boolean {
  const target = path.reduce<any>((node, key) => (node == null ? node : node[key]), client);
  return typeof target === 'function';
}
