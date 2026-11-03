/**
 * The two-agent example, run for real.
 *
 * It is the only example that is non-interactive and finishes on its own, and it covers the one
 * path nothing else does end to end: a sibling denied by its own cap while the other keeps going,
 * and then an ancestor denying the survivor. `decision.test.ts` has both shapes as literals and
 * the mock-backed tests use a single agent with no parent, so until now the chain walk was only
 * ever exercised in pieces.
 *
 * Running the example rather than reimplementing it is deliberate: an example that stops working
 * is a broken example whether or not a test reimplements what it used to do.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { EXAMPLE_ENV } from './pinned-demo-env';

const run = promisify(execFile);
const PACKAGE_ROOT = join(__dirname, '..');

describe('the two-agent example', () => {
  it('denies one sibling by its own cap, then the survivor by the team', async () => {
    const { stdout } = await run('yarn', ['tsx', 'examples/client/two-agents.ts'], {
      cwd: PACKAGE_ROOT,
      // Forced, so the test never depends on whatever keys happen to be in the developer's .env.
      env: { ...process.env, ...EXAMPLE_ENV },
      timeout: 120_000,
    });

    assert.match(stdout, /agent-drafter\s+DENIED\s+by agent-drafter/, 'the drafter is stopped by its own cap');
    assert.match(stdout, /agent-reviewer\s+DENIED\s+by team-/, 'the reviewer is stopped by the team above it');
    assert.match(stdout, /sibling budgets are independent/, 'and the run says so, because it happened');

    // The order is the whole point: isolation first, the shared bound second.
    assert.ok(
      stdout.indexOf('agent-drafter          DENIED') < stdout.indexOf('agent-reviewer         DENIED'),
      'the drafter must run out before the team does, or neither lesson lands',
    );
  });
});
