/**
 * The README names only commands that exist.
 *
 * `README.md` is one of the three transformed files: the prose mirrors, but every
 * `yarn workspace @stigg/agent-sdk-js run <script>` on the internal side becomes `yarn <script>`
 * here. That rewrite is the one transform with nothing behind it - a missed line reads as perfectly
 * good instructions and fails the moment someone follows it.
 *
 * So the scripts the README tells a reader to run are checked against the scripts that exist.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT, readJson } from './shared';

/** Yarn's own verbs. A reader runs these too, and they are not package scripts. */
const BUILTINS = new Set([
  'add',
  'bin',
  'cache',
  'config',
  'dedupe',
  'dlx',
  'exec',
  'explain',
  'info',
  'init',
  'install',
  'link',
  'node',
  'npm',
  'pack',
  'patch',
  'plugin',
  'rebuild',
  'remove',
  'run',
  'set',
  'unlink',
  'up',
  'version',
  'why',
  'workspace',
  'workspaces',
]);

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const scripts = Object.keys(readJson<{ scripts?: Record<string, string> }>('package.json').scripts ?? {});

/** `yarn <name>` anywhere in the file - a table cell, a fenced block, a sentence. */
const invoked = [...readme.matchAll(/\byarn\s+([a-z][\w:-]*)/g)]
  .map((match) => match[1] as string)
  .filter((name) => !BUILTINS.has(name));

describe('README commands', () => {
  it('should name at least one script, so this test is not vacuous', () => {
    assert.ok(invoked.length > 0, 'the README stopped telling anyone how to run anything');
  });

  for (const name of [...new Set(invoked)]) {
    it(`should be a real script: yarn ${name}`, () => {
      assert.ok(
        scripts.includes(name),
        `README says \`yarn ${name}\`, which package.json does not define - available: ${scripts.join(', ')}`,
      );
    });
  }
});
