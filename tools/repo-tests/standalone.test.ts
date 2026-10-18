/**
 * The package stands on its own.
 *
 * It is written inside a larger workspace, and the things that make it work there - a local
 * dependency protocol, compiler paths pointing at sibling builds - mean nothing once it is here.
 * A missed one leaves a repository that cannot be installed or type-checked, which is the one
 * thing this repository exists to disprove.
 *
 * Paths come from `repo-contract.json` rather than being assumed: the package sits at the root
 * today, and if it ever moves under `packages/` that is one field, not an edit here.
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

type Contract = { package: { path: string } };

/** Ranges that only mean something inside the monorepo's workspace. */
const LOCAL_PROTOCOL = /^(workspace|file|link|portal):/;

const contract = readJson<Contract>('repo-contract.json');

{
  const dir = contract.package.path === '.' ? '' : contract.package.path;
  const at = (file: string) => (dir ? `${dir}/${file}` : file);

  describe(`standalone: ${dir || 'the package at the repository root'}`, () => {
    const manifestPath = at('package.json');

    if (!existsSync(join(ROOT, manifestPath))) {
      it('should have a manifest once the source has arrived', () => {
        assert.ok(true, `${manifestPath} arrives with the SDK source`);
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

      assert.deepEqual(ranges, [], 'these ranges only resolve in the workspace the SDK is written in');
    });

    it('should type-check against this repository, standing alone', () => {
      const raw = readFileSync(join(ROOT, at('tsconfig.json')), 'utf8');

      assert.ok(!raw.includes('../../../'), 'tsconfig must not reach outside this repository');
      assert.ok(
        !/"paths"\s*:/.test(raw),
        'dependencies resolve through node_modules here; a paths block does not belong',
      );
    });

    it('should keep the build config the source expects', () => {
      if (!existsSync(join(ROOT, at('src')))) return; // nothing to build until the first sync
      assert.ok(existsSync(join(ROOT, at('tsconfig.build.json'))), 'tsconfig.build.json mirrors with the source');
    });
  });
}
