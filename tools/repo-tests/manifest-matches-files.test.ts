/**
 * The manifest describes the files, and is held to it.
 *
 * `.sync-manifest.json` says what each rewritten field becomes here. Nothing made that
 * true: the manifest could claim `scripts.lint` is one thing while `package.json` says another, and
 * the tooling reading the manifest would faithfully reproduce the claim rather than the fact.
 *
 * So every concrete field is resolved against the real file. Pointers written as `<prose>` are
 * regions a person maintains, not values a machine can check, and are skipped by name.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT, readJson } from './shared';

type Field = { pointer: string; openSource?: unknown };
type Transform = { fields?: Field[]; openSourceOnly?: string[]; internalOnly?: string[] };
type Manifest = {
  pairs: { openSource: { path: string }; transform: { path: string; rules: string }[] }[];
  transforms: Record<string, Transform>;
};

const manifest = readJson<Manifest>('.sync-manifest.json');
const pair = manifest.pairs[0]!;
const dir = pair.openSource.path === '.' ? '' : pair.openSource.path;
const at = (file: string) => (dir ? `${dir}/${file}` : file);

/** The SDK source only exists once copied in; before that, the manifest describes a future. */
const synced = existsSync(join(ROOT, at('src')));

/** tsconfig.json is JSONC - the comments are load-bearing documentation, so strip rather than ban them. */
function readLoose(file: string): Record<string, unknown> {
  const raw = readFileSync(join(ROOT, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(raw) as Record<string, unknown>;
}

function resolve(root: unknown, pointer: string): unknown {
  return pointer.split('.').reduce<unknown>((node, key) => {
    if (node === null || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[key];
  }, root);
}

const CHECKABLE: Record<string, () => Record<string, unknown>> = {
  'package.json': () => readJson<Record<string, unknown>>(at('package.json')),
  'tsconfig.json': () => readLoose(at('tsconfig.json')),
};

describe('the manifest matches the files', () => {
  for (const entry of pair.transform) {
    const rules = manifest.transforms[entry.rules];
    if (!rules) continue;

    // Keys that only exist on one side can be checked whatever the state of the mirror.
    if (entry.path === 'package.json') {
      it('should carry every key the manifest calls open-source-only', () => {
        const pkg = CHECKABLE['package.json']!();
        const missing = (rules.openSourceOnly ?? []).filter((p) => resolve(pkg, p) === undefined);
        assert.deepEqual(missing, [], 'the manifest promises these and package.json does not have them');
      });

      it('should carry none of the keys the manifest calls internal-only', () => {
        const pkg = CHECKABLE['package.json']!();
        const present = (rules.internalOnly ?? []).filter((p) => resolve(pkg, p) !== undefined);
        assert.deepEqual(present, [], 'these belong to the monorepo and must not cross');
      });
    }

    const read = CHECKABLE[entry.path];
    if (!read) continue;

    for (const field of rules.fields ?? []) {
      if (field.pointer.startsWith('<')) continue; // a prose region, not a value
      it(`should match the manifest: ${entry.path} ${field.pointer}`, (t) => {
        if (!synced) return t.skip('the mirrored source arrives in the first sync');
        const actual = resolve(read(), field.pointer);
        assert.deepEqual(
          actual,
          field.openSource ?? undefined,
          `.sync-manifest.json says ${entry.path} ${field.pointer} is ${JSON.stringify(field.openSource)}`,
        );
      });
    }
  }
});
