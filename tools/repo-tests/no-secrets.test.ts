/**
 * Nothing that authenticates anything may be tracked.
 *
 * The real protection is upstream - `.env` and `examples/demo.env` are gitignored on both sides, so
 * a sync that copies tracked files only cannot carry one. This is the guard for the day someone
 * commits a credential anyway, or adds a template that ships a populated key.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';

import { ROOT, trackedFiles } from './shared';

const SKIPPED = /^(\.yarn\/|yarn\.lock$)|\.(png|jpg|jpeg|gif|svg|ico|pdf|woff2?)$/;

const SECRETS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/ },
  { name: 'OpenAI-style secret key', pattern: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', pattern: /\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

/**
 * A template may ship defaults - a model name, a base URL, `AGENT_SDK_DEMO_ATTRIBUTION_KEY=agentId`
 * - but never a populated credential. So a credential-shaped name must be empty or hold something
 * short and readable; anything long or opaque is the shape of a real key.
 */
const CREDENTIAL_ASSIGNMENT = /^\s*(?:export\s+)?([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*(.*)$/;
const HARMLESS_VALUE = /^[A-Za-z][A-Za-z0-9._-]{0,14}$/;

const files = trackedFiles().filter((file) => !SKIPPED.test(file));

describe('no secrets in the index', () => {
  it('should track files to scan', () => {
    assert.ok(files.length > 0);
  });

  it('should not track an environment file that is not a template', () => {
    const envFiles = files.filter((file) => {
      const name = basename(file);
      return (name === '.env' || name.endsWith('.env')) && !/\.(template|example)$/.test(name);
    });
    assert.deepEqual(envFiles, [], 'environment files belong in .gitignore; commit a .template instead');
  });

  for (const file of files) {
    it(`should carry no credential: ${file}`, () => {
      const content = readFileSync(join(ROOT, file), 'utf8');

      for (const { name, pattern } of SECRETS) {
        assert.equal(pattern.test(content), false, `${file} looks like it contains a ${name}`);
      }

      if (!/\.(template|example)$/.test(file) && !file.includes('.env')) return;

      for (const line of content.split('\n')) {
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
