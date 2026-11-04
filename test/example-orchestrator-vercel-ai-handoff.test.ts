/**
 * The Vercel AI SDK handoff example, run for real against the offline mocks: the same flow as the
 * LangChain one - each agent checked and its usage ingested as itself, a refused researcher routed around.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { EXAMPLE_ENV } from './pinned-demo-env';

const run = promisify(execFile);
const PACKAGE_ROOT = join(__dirname, '..');

describe('the Vercel AI SDK handoff example', () => {
  it('governs each agent as itself, and routes around a refused researcher', async () => {
    const pending = run('yarn', ['tsx', 'examples/orchestrator/vercel-ai/vercel-ai-handoff.ts'], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...EXAMPLE_ENV },
      timeout: 120_000,
    });
    // Four turns - the researcher's budget lasts three - then end-of-input.
    pending.child.stdin?.end('What is worth metering?\nAnd why per agent?\nWhat about tools?\nAnd the lead?\n');
    const { stdout } = await pending;

    // Each agent is checked and its usage ingested as itself - the researcher, run inside the lead's tool, too.
    for (const agent of ['lead', 'researcher', 'writer']) {
      assert.match(stdout, new RegExp(`\\[${agent}\\]\\s+stigg check allowed`), `${agent} is checked`);
      assert.match(stdout, new RegExp(`\\[${agent}\\]\\s+stigg ingest credits=1 ok=true`), `${agent} is ingested`);
    }
    assert.equal(stdout.match(/\[writer\] done/g)?.length, 4, 'the writer answers every turn');
    // Its paid search is checked too: two model calls and a search a request, then one on the fourth.
    assert.equal(stdout.match(/\[researcher\]\s+stigg check allowed/g)?.length, 10, 'the search is checked');
    // The researcher's budget runs out on the fourth request.
    assert.match(stdout, /\[researcher\]\s+stigg check REFUSED remaining=0/);
    assert.match(stdout, /another pass - researcher refused \(BudgetExceeded by agent-vercel-ai-researcher\)/);
    const pass = stdout.indexOf('another pass');
    assert.ok(stdout.indexOf('[generalist] done', pass) > pass, 'the generalist answers in its place');
    assert.match(stdout, /\[generalist\]\s+stigg ingest credits=1 ok=true/);
    assert.ok(stdout.lastIndexOf('[writer] done') > pass, 'and the writer still writes the answer');
    assert.equal(stdout.match(/assistant>/g)?.length, 4, 'every turn is answered');
  });
});
