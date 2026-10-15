/**
 * Templates do not ship credentials.
 *
 * This used to also carry a list of regexes for API-key shapes. It was removed because it did not
 * work: `/\bsk-[A-Za-z0-9]{20,}/` stops at the first `-`, so `sk-ant-api03-…`, `sk-proj-…` and
 * `sk-or-v1-…` all passed it, and Google's `AIza…` and Stigg's own keys had no pattern at all. A
 * guard that catches one of five formats is worse than none, because it reads like coverage.
 *
 * Secret detection belongs to tools that maintain the patterns for a living: GitHub secret scanning
 * with push protection on this repository, or gitleaks in CI. What stays here is the part that was
 * always this repository's own - the committed templates, which are the one place a credential
 * could be added deliberately and look normal.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT, trackedFiles } from './shared';

/**
 * A template may ship defaults - a model name, a base URL - but never a populated credential. So a
 * credential-shaped name must be empty or hold something short and readable; anything long or
 * opaque is the shape of a real key.
 */
const CREDENTIAL_ASSIGNMENT = /^\s*(?:export\s+)?([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*(.*)$/;
const HARMLESS_VALUE = /^[A-Za-z][A-Za-z0-9._-]{0,14}$/;

const envFiles = trackedFiles().filter((file) => basename(file).includes('.env'));

describe('no credentials in the index', () => {
  it('should not track an environment file that is not a template', () => {
    const live = envFiles.filter((file) => !/\.(template|example)$/.test(file));
    assert.deepEqual(live, [], 'environment files belong in .gitignore; commit a .template instead');
  });

  for (const file of envFiles) {
    it(`should leave every credential empty: ${file}`, () => {
      for (const line of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
        const match = CREDENTIAL_ASSIGNMENT.exec(line);
        if (!match) continue;
        const [, key, rawValue] = match;
        const value = (rawValue ?? '').trim().replace(/^['"]|['"]$/g, '');
        assert.ok(
          value === '' || HARMLESS_VALUE.test(value),
          `${file} sets ${key} to something that looks like a credential; a template leaves those empty`,
        );
      }
    });
  }
});
