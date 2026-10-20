/**
 * Every command a reader is told to run exists, and addresses this repository.
 *
 * The documentation arrives written for a workspace, where each command reads
 * `yarn workspace <package> run <script>`; here it is rewritten to `yarn <script>`. A line the
 * rewrite misses still reads as perfectly good instructions and describes a layout this repository
 * does not have - and a command naming a script that was renamed fails the moment someone follows
 * it. Both are checked, across the README, the examples, and the extension guide.
 *
 * It has already earned its place: it caught a Run line pointing at a script that exists nowhere.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT, readJson, trackedFiles } from './shared';

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

const scripts = Object.keys(readJson<{ scripts?: Record<string, string> }>('package.json').scripts ?? {});

/** Everything that tells a reader what to type. */
const documents = trackedFiles('README.md', 'docs', 'examples', '.claude').filter((file) =>
  /\.(md|ts)$|\.template$/.test(file),
);

const sources = documents.map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }));

/** `yarn <name>` anywhere - a table cell, a fenced block, a header comment. */
const invoked = sources.flatMap(({ file, text }) =>
  [...text.matchAll(/\byarn\s+([a-z][\w:-]*)/g)]
    .map((match) => ({ file, name: match[1] as string }))
    .filter(({ name }) => !BUILTINS.has(name)),
);

describe('documented commands', () => {
  it('should find commands to check, so this test is not vacuous', () => {
    assert.ok(invoked.length > 0, 'the documentation stopped telling anyone how to run anything');
  });

  it('should address this repository, not a workspace it is not part of', () => {
    const stale = sources.filter(({ text }) => /yarn\s+workspace\s+@stigg\//.test(text)).map(({ file }) => file);
    assert.deepEqual(stale, [], 'these kept the workspace form - the rewrite missed them');
  });

  for (const name of [...new Set(invoked.map((entry) => entry.name))]) {
    it(`should be a real script: yarn ${name}`, () => {
      const where = invoked.find((entry) => entry.name === name)?.file;
      assert.ok(
        scripts.includes(name),
        `${where} says \`yarn ${name}\`, which package.json does not define - available: ${scripts.join(', ')}`,
      );
    });
  }
});
