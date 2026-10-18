/**
 * The contract describes the files, and is held to it.
 *
 * `repo-contract.json` says what each rewritten file must contain. Nothing made that true: the
 * contract could claim `scripts.lint` is one thing while `package.json` says another, and whatever
 * reads the contract would reproduce the claim rather than the fact.
 *
 * So every concrete value is resolved against the real file. Prose descriptions of a rewrite are
 * for people, not machines, and are skipped.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT, readJson } from './shared';

type FileSpec = { values?: Record<string, unknown>; present?: string[]; absent?: string[] };
type Contract = { package: { path: string }; files: Record<string, FileSpec> };

const contract = readJson<Contract>('repo-contract.json');
const dir = contract.package.path === '.' ? '' : contract.package.path;
const at = (file: string) => (dir ? `${dir}/${file}` : file);

/** The SDK source only exists once copied in; before that, the contract describes a future. */
const populated = existsSync(join(ROOT, at('src')));

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

const READERS: Record<string, () => Record<string, unknown>> = {
  'package.json': () => readJson<Record<string, unknown>>(at('package.json')),
  'tsconfig.json': () => readLoose(at('tsconfig.json')),
};

describe('the contract matches the files', () => {
  for (const [file, spec] of Object.entries(contract.files)) {
    const read = READERS[file];
    if (!read) continue;

    describe(file, () => {
      // Key presence holds whatever state the repository is in.
      if (spec.present) {
        it('should carry every key the contract requires', () => {
          const missing = spec.present!.filter((pointer) => resolve(read(), pointer) === undefined);
          assert.deepEqual(missing, [], 'the contract promises these and the file does not have them');
        });
      }

      if (spec.absent) {
        it('should carry none of the keys the contract excludes', () => {
          const found = spec.absent!.filter((pointer) => resolve(read(), pointer) !== undefined);
          assert.deepEqual(found, [], 'these only mean something where the SDK is written, and do not belong here');
        });
      }

      for (const [pointer, expected] of Object.entries(spec.values ?? {})) {
        it(`should match the contract: ${pointer}`, (t) => {
          if (!populated) return t.skip('the SDK source is not here yet');
          assert.deepEqual(
            resolve(read(), pointer),
            expected ?? undefined,
            `repo-contract.json says ${file} ${pointer} is ${JSON.stringify(expected)}`,
          );
        });
      }
    });
  }
});
