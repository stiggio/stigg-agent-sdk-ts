/**
 * The docs name only APIs that exist.
 *
 * Every one of these drifted at once when the run lifecycle became a per-call context: the README
 * went on offering `run.headers()`, `run.check()` and an `engineMode` option, and `Measurement`
 * grew a `units` field it never had. Each reads as instructions, none of it compiles, and nothing
 * in the test suite or the typechecker could notice - documentation is the one contract with no
 * compiler behind it.
 *
 * So the symbols the docs name are checked against the ones the package exports. Deliberately
 * narrow: this looks for identifiers written as a member of something the SDK hands back, which is
 * where a rename does its damage, rather than trying to parse prose.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');

const sources = (dir = ''): string[] =>
  readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
  );

const code = sources()
  .map((file) => readFileSync(join(SRC, file), 'utf8'))
  .join('\n');

// `docs/instances.md` is held back from the open-source mirror for now, so the list is the
// documents that are actually here. Recorded in `repo-contract.json`.
const docs = ['README.md', join('docs', 'instances.md'), join('examples', 'README.md')].filter((doc) =>
  existsSync(join(ROOT, doc)),
);

/**
 * Names the lifecycle used to have. A rename leaves these behind in prose that still reads as
 * instructions, and the old spelling is what a reader will try first.
 */
const RETIRED = [
  'run.start(',
  'run.check(',
  'run.headers(',
  'run.ingest(',
  'RunHandle',
  'RunOptions',
  'StiggGovClient',
];

/**
 * Written like a member and owned by somebody else: a file on disk, or a vendor's own surface the
 * docs name to contrast it with ours. Listed rather than pattern-matched, so adding one is a
 * decision somebody made.
 */
const NOT_OURS = ['json', 'ts', 'md', 'models'];

describe('the docs name only APIs that exist', () => {
  for (const doc of docs) {
    it(`${doc} names no retired lifecycle API`, () => {
      const text = readFileSync(join(ROOT, doc), 'utf8');
      for (const name of RETIRED) {
        assert.ok(!text.includes(name), `${doc} still refers to \`${name}\`, which this package no longer has`);
      }
    });

    it(`${doc} names only members the source defines`, () => {
      const text = readFileSync(join(ROOT, doc), 'utf8');
      // A dotted path written as code, with or without an argument list: `` `a.b` ``,
      // `` `a.b()` ``, `` `a.b(c, { d })` `` and `` `a.b.c()` ``. The first spelling of this
      // matched only the first two, which is to say almost nothing a README actually contains -
      // every documented call with arguments walked straight past it.
      const referenced = [...text.matchAll(/`([a-z][\w]*(?:\.[a-zA-Z][\w]*)+)\s*(?:\([^`]*\))?`/g)];
      const unknown = referenced
        .flatMap((match) => {
          // Every segment after the receiver, which may be any local name a snippet invented.
          const [, ...members] = match[1]!.split('.');
          return members.filter((member) => !code.includes(member) && !NOT_OURS.includes(member)).map(() => match[0]);
        })
        .filter((whole, index, all) => all.indexOf(whole) === index);

      assert.deepEqual(unknown, [], `named in ${doc} and defined nowhere in src/`);
    });
  }
});
