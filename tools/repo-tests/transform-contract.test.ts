/**
 * What the transformed files must look like on this side.
 *
 * Each rule is the open-source half of a transform in `.sync-manifest.json`. A sync that forgot one
 * leaves a repository that cannot be installed or type-checked outside the monorepo it came from -
 * which is the one thing this repository exists to disprove.
 *
 * Every path here is resolved from the pair's `openSource.path`, never assumed. The package sits at
 * the repository root today; if it ever moves under `packages/`, that is one field in the manifest
 * and these checks follow it without being touched.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT, readJson } from './shared';

type PackageJson = {
  name?: string;
  private?: boolean;
  license?: string;
  repository?: { url?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type Manifest = {
  pairs: { id: string; openSource: { path: string } }[];
};

/** Ranges that only mean something inside the monorepo's workspace. */
const LOCAL_PROTOCOL = /^(workspace|file|link|portal):/;

const manifest = readJson<Manifest>('.sync-manifest.json');

for (const pair of manifest.pairs) {
  const dir = pair.openSource.path === '.' ? '' : pair.openSource.path;
  const at = (file: string) => (dir ? `${dir}/${file}` : file);

  describe(`transform contract: ${dir || 'the package at the repository root'}`, () => {
    const manifestPath = at('package.json');

    if (!existsSync(join(ROOT, manifestPath))) {
      it('should have a manifest once the source has arrived', () => {
        assert.ok(true, `${manifestPath} arrives with the first sync for pair "${pair.id}"`);
      });
      return;
    }

    const pkg = readJson<PackageJson>(manifestPath);

    it('should be the Stigg agent SDK, under this repository', () => {
      assert.equal(pkg.name, '@stigg/agent-sdk-js');
      assert.equal(pkg.license, 'MIT');
      assert.ok(pkg.repository?.url?.includes('stigg-agent-sdk-ts'), 'repository.url must name this repository');
    });

    // Nothing is released from here - `@stigg/agent-sdk-js` on npm is built by Stigg internally.
    // Dropping this flag would make an accidental `npm publish` from a laptop land on the registry.
    it('should stay unpublishable', () => {
      assert.equal(pkg.private, true);
    });

    it('should declare no workspace-local dependency ranges', () => {
      const ranges = Object.entries({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      }).filter(([, range]) => LOCAL_PROTOCOL.test(range));

      assert.deepEqual(ranges, [], 'these ranges only resolve inside the monorepo - see .sync-manifest.json');
    });

    it('should type-check against this repository, not the monorepo above it', () => {
      const raw = readFileSync(join(ROOT, at('tsconfig.json')), 'utf8');

      assert.ok(!raw.includes('../../../'), 'tsconfig must not reach outside this repository');
      assert.ok(
        !/"paths"\s*:/.test(raw),
        'dependencies resolve through node_modules here; a paths block is monorepo leakage',
      );
    });

    it('should keep the build config the source expects', () => {
      if (!existsSync(join(ROOT, at('src')))) return; // nothing to build until the first sync
      assert.ok(existsSync(join(ROOT, at('tsconfig.build.json'))), 'tsconfig.build.json mirrors with the source');
    });
  });
}
