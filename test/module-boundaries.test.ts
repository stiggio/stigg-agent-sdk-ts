/**
 * Which files may reach outside the package, and for what.
 *
 * The README draws this map - "node-sdk-engine.ts, the only file importing @stigg/node-server-sdk",
 * "rest-governance-engine.ts, the only file importing @stigg/typescript", and the engine seam's
 * `decision.ts` marked pure - and until now it was only a drawing. It is load-bearing: the two
 * engines are swappable because neither leaks its client past its own file, and `remedyFor` keeps
 * hand-typed copies of a server enum precisely because `decision.ts` may not import the enum.
 * (`denial-reasons.test.ts` is what checks those copies, which a test may do and `src/` may not.)
 *
 * A violation of any of this typechecks, passes every other test, and is invisible in review -
 * so it is asserted here instead.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SRC = join(__dirname, '..', 'src');

/** Every package `src/` is allowed to name, and the one file allowed to name it. */
const ALLOWED: Record<string, string> = {
  '@stigg/node-server-sdk': 'engine/node-sdk-engine.ts',
  '@stigg/typescript': 'engine/rest-governance-engine.ts',
  zod: 'config.ts',
  'node:crypto': 'stigg-agent-sdk.ts',
  // Spans for every check and ingest. The API is a no-op until an application registers a provider.
  '@opentelemetry/api': 'core/telemetry.ts',
  // The one framework binding that needs its framework loaded, reached only through the
  // `@stigg/agent-sdk-js/langchain` entry - see the entry-point test below.
  '@langchain/core/callbacks/base': 'bindings/orchestrator/langchain/callback-handler.ts',
};

const sources = (dir = ''): string[] =>
  readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
  );

/** Module specifiers that are not relative paths - i.e. everything resolved from node_modules. */
const externalImports = (file: string): string[] =>
  [...readFileSync(join(SRC, file), 'utf8').matchAll(/from '([^.'][^']*)'/g)].map((m) => m[1]);

describe('what src/ is allowed to import', () => {
  it('names no package outside the allowed list', () => {
    const found = sources().flatMap((file) => externalImports(file).map((pkg) => `${file} -> ${pkg}`));
    const unexpected = found.filter(
      (entry) => !Object.entries(ALLOWED).some(([pkg, owner]) => entry === `${owner} -> ${pkg}`),
    );
    assert.deepEqual(
      unexpected,
      [],
      'a new external import in src/ either belongs on the allowed list or belongs in a binding',
    );
  });

  it('keeps each vendor client behind the single file that owns it', () => {
    for (const [pkg, owner] of Object.entries(ALLOWED)) {
      const importers = sources().filter((file) => externalImports(file).includes(pkg));
      assert.deepEqual(importers, [owner], `${pkg} must be imported by ${owner} and nothing else`);
    }
  });

  /**
   * The seam that turns an engine result into a decision. It is the one place a denial reason is
   * interpreted, and it stays readable as pure logic only while it depends on nothing.
   */
  it('keeps the decision seam pure', () => {
    assert.deepEqual(externalImports('engine/decision.ts'), []);
  });

  /**
   * What `import '@stigg/agent-sdk-js'` loads at runtime: every module reachable from the main entry
   * through a value import. A type-only import is erased, so it does not count.
   */
  const runtimeGraph = (entry: string): Set<string> => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(join(SRC, file), 'utf8');
      for (const [statement, specifier] of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from '(\.[^']*)'/g)) {
        if (/^\s*(?:import|export)\s+type\s/.test(statement)) continue;
        const target = join(dirname(file), specifier!);
        visit(existsSync(join(SRC, `${target}.ts`)) ? `${target}.ts` : join(target, 'index.ts'));
      }
    };
    visit(entry);
    return seen;
  };

  it('keeps LangChain out of the main entry, so only `/langchain` loads it', () => {
    const loaded = runtimeGraph('index.ts');
    assert.ok(loaded.has('stigg-agent-sdk.ts'), 'the walk reaches the SDK, or it proves nothing');
    assert.ok(
      !loaded.has('bindings/orchestrator/langchain/callback-handler.ts'),
      'the main entry must not load the LangChain binding at runtime',
    );
    assert.ok(runtimeGraph('integrations/langchain.ts').has('bindings/orchestrator/langchain/callback-handler.ts'));
  });
});
