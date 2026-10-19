/**
 * Every tracked file is accounted for.
 *
 * `repo-contract.json` classifies each path: copied from the source, rewritten on the way in, or
 * this repository's own. A file matching none of those is one nobody decided about - it would
 * arrive, or fail to arrive, by accident. That is what this test refuses.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { ROOT, matchesAny, readJson, trackedFiles } from './shared';

type Contract = {
  version: number;
  package: { path: string };
  paths: { copied: string[]; rewritten: string[]; ours: string[]; absent: string[] };
  files: Record<string, unknown>;
  rewrites: Record<string, unknown>;
};

const contract = readJson<Contract>('repo-contract.json');

describe('tracked paths', () => {
  it('should be a contract at version 1', () => {
    assert.equal(contract.version, 1);
    assert.ok(contract.package.path.length > 0, 'a path is required; the repository root is "."');
    assert.ok(!contract.package.path.endsWith('/'), 'the path must not end with "/"');
  });

  it('should describe every rewritten path', () => {
    const undescribed = contract.paths.rewritten.filter((path) => !(path in contract.files));
    assert.deepEqual(undescribed, [], 'these are listed as rewritten but `files` says nothing about them');
  });

  it('should account for every tracked file', () => {
    const dir = contract.package.path === '.' ? '' : `${contract.package.path}/`;
    const files = trackedFiles(contract.package.path).map((file) => file.slice(dir.length));
    const known = [...contract.paths.copied, ...contract.paths.rewritten, ...contract.paths.ours];

    assert.deepEqual(
      files.filter((file) => !matchesAny(file, known)),
      [],
      'these are tracked but no rule says where they belong - add them to repo-contract.json',
    );
  });

  it('should not track anything it says is absent', () => {
    const present = trackedFiles().filter((file) => matchesAny(file, contract.paths.absent));
    assert.deepEqual(present, [], 'the contract says these do not exist here');
  });

  // Not tracking the file is half of it. The guide is written where that document exists, so its
  // layout section names it; copied here unchanged, it points a reader at a path this repository
  // has decided not to have. Nothing else notices - a sentence naming a missing file still reads
  // perfectly well.
  it('should not send a reader to a document it says is absent', () => {
    const missingDocuments = contract.paths.absent.filter((path) => path.endsWith('.md'));
    const documents = trackedFiles('README.md', 'docs', 'examples', '.claude').filter((file) => file.endsWith('.md'));

    const dangling = documents.flatMap((file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      return missingDocuments.filter((path) => text.includes(basename(path))).map((path) => `${file} -> ${path}`);
    });

    assert.deepEqual(dangling, [], 'these name a document this repository does not have');
  });
});
