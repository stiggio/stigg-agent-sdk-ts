/**
 * The gateway examples, run for real.
 *
 * Both topologies in one script, and the second one is the reason this test exists: the proxy is
 * a real HTTP server on a loopback socket, so the attribution has to survive being serialised and
 * parsed back out of `req.headers`. That is the part the examples used to only describe - the old
 * version handed the same object to `ingestFromHeaders` in-process, which proved nothing about
 * the wire.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { EXAMPLE_ENV } from './pinned-demo-env';

const run = promisify(execFile);
const PACKAGE_ROOT = join(__dirname, '..');

const runExample = async (file: string): Promise<string> => {
  const { stdout } = await run('yarn', ['tsx', file], {
    cwd: PACKAGE_ROOT,
    // Forced, so the test never depends on whichever keys are in the developer's .env.
    env: { ...process.env, ...EXAMPLE_ENV },
    timeout: 120_000,
  });
  return stdout;
};

for (const [label, file] of [
  ['openrouter', 'examples/gateway/openrouter.ts'],
  ['litellm', 'examples/gateway/litellm.ts'],
] as const) {
  describe(`the ${label} gateway example`, () => {
    it('gates the call it makes and bills what the gateway charged', async () => {
      const stdout = await runExample(file);
      assert.match(stdout, /wrapped, non-streaming/);
      // Cost, not tokens: the run's mapper prices the `cost` the gateway stated.
      assert.match(stdout, /\[governance\] ingest \w+=\d+ /, 'the wrapped call bills a real number');
      assert.match(stdout, /hasAccess=true remaining=\d+/, 'and the budget it spends is readable');
    });

    it('carries the attribution across a real socket to a proxy that cannot check', async () => {
      const stdout = await runExample(file);
      assert.match(stdout, /header path, over a real socket \(http:\/\/127\.0\.0\.1:\d+\)/);
      // The run id and customer come back off `req.headers`, not off an object this process held.
      assert.match(
        stdout,
        /\[proxy\] ingested .*ok=true for run=[0-9a-f-]{36} customer=\S+/,
        'the proxy attributed the request from headers that crossed the wire',
      );
      assert.doesNotMatch(stdout, /\[proxy\].*hasAccess=/, 'nothing on that path gates');
    });
  });
}
