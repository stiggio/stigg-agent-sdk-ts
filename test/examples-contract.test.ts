/**
 * The examples, package.json and the docs, agreeing about which examples exist.
 *
 * Three lists describing one folder, and they had already drifted: `example-client-typesafe` and
 * `example-gateway-openrouter` were scripts that appeared in no document, so the largest client
 * example - 282 lines of it - was invisible to anyone reading the README. Examples are never run
 * in CI and no test referenced them, so nothing was ever going to say so.
 *
 * Same guard as `metrics-contract` and `public-surface`: the lists are compared to each other
 * rather than reviewed by eye, because two lists describing one thing drift.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

const scripts: Record<string, string> = JSON.parse(read('package.json')).scripts;
const exampleScripts = Object.entries(scripts).filter(([name]) => name.startsWith('example'));

/** `tsx examples/client/anthropic.ts` -> `examples/client/anthropic.ts`. */
const targetOf = (command: string): string => command.replace(/^tsx\s+/, '').split(/\s+/)[0];

describe('the example scripts', () => {
  it('has some, or this whole file is passing on an empty set', () => {
    assert.ok(exampleScripts.length >= 8, `expected the example scripts, found ${exampleScripts.length}`);
  });

  it('points every script at a file that exists', () => {
    const missing = exampleScripts
      .map(([name, command]) => ({ name, target: targetOf(command) }))
      .filter(({ target }) => !existsSync(join(ROOT, target)));
    assert.deepEqual(missing, [], 'a script naming a file that was moved or deleted');
  });

  it('names every runnable example in the examples README', () => {
    const readme = read('examples/README.md');
    const unlisted = exampleScripts
      .map(([, command]) => targetOf(command).replace(/^examples\//, ''))
      .filter((target, index, all) => all.indexOf(target) === index)
      .filter((target) => !readme.includes(target));
    assert.deepEqual(unlisted, [], 'a runnable example the folder README does not mention');
  });

  it('names every script in the package README, so the table stays complete', () => {
    const readme = read('docs/guide.md');
    // Aliases are listed beside the script they alias rather than on their own row.
    const aliases = new Set(['example-client', 'example-gateway']);
    const undocumented = exampleScripts
      .map(([name]) => name)
      .filter((name) => !aliases.has(name) && !readme.includes(name));
    assert.deepEqual(undocumented, [], 'a script the package README never mentions');
  });
});
