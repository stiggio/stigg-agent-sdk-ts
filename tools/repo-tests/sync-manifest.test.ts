/**
 * The mirror is only as good as the manifest that describes it.
 *
 * Every tracked file inside a mirrored package has to be accounted for: mirrored, transformed, or
 * explicitly open-source-only. A file that matches none of those is a file nobody decided about -
 * it would travel, or fail to travel, by accident. That is what this test refuses.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { matchesAny, readJson, trackedFiles } from './shared';

type Pair = {
  id: string;
  internal: { repo: string; path: string };
  openSource: { repo: string; path: string };
  mirror: string[];
  transform: { path: string; rules: string }[];
  openSourceOnly?: string[];
  internalOnly: string[];
};

type Manifest = {
  version: number;
  pairs: Pair[];
  repositoryOnly: string[];
  transforms: Record<string, unknown>;
};

const manifest = readJson<Manifest>('.sync-manifest.json');

describe('sync manifest', () => {
  it('should declare at least one pair, at version 1', () => {
    assert.equal(manifest.version, 1);
    assert.ok(manifest.pairs.length > 0);
  });

  for (const pair of manifest.pairs) {
    describe(pair.id, () => {
      it('should name both sides as a single prefix, without a trailing slash', () => {
        for (const side of [pair.internal, pair.openSource]) {
          assert.match(side.repo, /^[\w-]+\/[\w-]+$/);
          assert.ok(side.path.length > 0, 'a path is required; the repository root is "."');
          assert.ok(!side.path.endsWith('/'), `${side.path} must not end with "/"`);
        }
      });

      it('should name a known transform for every transformed file', () => {
        for (const entry of pair.transform) {
          assert.ok(
            entry.rules in manifest.transforms,
            `${entry.path} names transform "${entry.rules}", which .sync-manifest.json does not define`,
          );
        }
      });

      it('should account for every tracked file in the package', () => {
        // The package is the repository root, so "every file in the package" is every file there
        // is, and the repository's own paths are what the rest of the manifest accounts for.
        const atRoot = pair.openSource.path === '.';
        const prefix = atRoot ? '' : `${pair.openSource.path}/`;
        const files = trackedFiles(pair.openSource.path).map((file) => file.slice(prefix.length));

        const known = [
          ...pair.mirror,
          ...pair.transform.map((entry) => entry.path),
          ...(pair.openSourceOnly ?? []),
          ...(atRoot ? manifest.repositoryOnly : []),
        ];
        const unaccounted = files.filter((file) => !matchesAny(file, known));

        assert.deepEqual(
          unaccounted,
          [],
          `these files are tracked here but no rule says whether they mirror - add them to .sync-manifest.json`,
        );
      });
    });
  }
});
