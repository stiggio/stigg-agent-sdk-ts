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

const docs = [
  'README.md',
  join('docs', 'guide.md'),
  join('docs', 'instances.md'),
  join('examples', 'README.md'),
].filter((doc) => existsSync(join(ROOT, doc)));

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
  // The file that held it. A doc naming `core/run-handle.ts` passed this list for months, because
  // the list spelled the type and the layout section spelled the filename.
  'run-handle',
];

/**
 * Spellings this package deliberately stopped using.
 *
 * Unlike {@link RETIRED}, which names APIs that no longer exist, this one still resolves to
 * something real - `STIGG_API_KEY` still has a value in somebody's shell - so nothing breaks when
 * it comes back and no other test has any reason to notice. It was renamed so every Stigg SDK
 * reads the key under one name; this list is what keeps the old one out.
 */
const FORBIDDEN: { text: string; why: string; except?: string[] }[] = [
  {
    text: 'STIGG_API_KEY',
    why: 'the key is read from STIGG_SERVER_API_KEY, the name every Stigg SDK shares',
    // The one place it belongs: the fallback that keeps an existing `.env` working has to name it.
    except: [join('examples', 'shared', 'stigg-env.ts')],
  },
];

/** Walked rather than listed, so a new example is covered without anyone remembering to add it. */
const exampleFiles = exampleSources();

/** Everything written for a reader: the documents above, plus what ships beside the examples. */
const readable = [...docs, '.env.template', join('examples', 'demo.env.template'), ...exampleFiles];

function exampleSources(dir = 'examples'): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? exampleSources(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

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

describe('the docs say nothing a reader outside Stigg cannot use', () => {
  // A count over everything proves nothing here: the fixed documents alone clear any threshold
  // worth setting, so the walk over `examples/` could return nothing and this would still pass.
  // The discovered half is the half that can silently vanish, so it is the half that is asserted.
  it('should find documents to check, so this test is not vacuous', () => {
    assert.ok(exampleFiles.length > 0, 'no example sources found - the walk over examples/ stopped seeing the tree');
    assert.ok(docs.length > 0, 'the document list emptied out');
  });

  for (const { text, why, except = [] } of FORBIDDEN) {
    it(`no document reintroduces ${text}`, () => {
      const pattern = new RegExp(`(^|[^\\w-])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`);
      const offenders = readable
        .filter((file) => !except.includes(file))
        .filter((file) => pattern.test(readFileSync(join(ROOT, file), 'utf8')));

      assert.deepEqual(offenders, [], `${text} is back - ${why}`);
    });
  }
});
