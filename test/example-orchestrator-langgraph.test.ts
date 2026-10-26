/**
 * The LangGraph orchestrator example, run for real: the same flow as the LangChain one, built as a
 * hand-built `StateGraph`, with the same Stigg integration - so the same outcomes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { EXAMPLE_ENV } from './pinned-demo-env';

const run = promisify(execFile);
const PACKAGE_ROOT = join(__dirname, '..');

describe('the LangGraph orchestrator example', () => {
  it('governs each node as its agent, and routes around a refused researcher', async () => {
    const pending = run('yarn', ['tsx', 'examples/orchestrator/langgraph.ts'], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...EXAMPLE_ENV },
      timeout: 120_000,
    });
    // Four turns - the researcher's budget lasts three - then end-of-input.
    pending.child.stdin?.end('What is worth metering?\nAnd why per agent?\nWhat about tools?\nAnd the lead?\n');
    const { stdout } = await pending;

    // Each node is checked and billed as the agent of that name.
    for (const agent of ['lead', 'researcher', 'writer']) {
      assert.match(stdout, new RegExp(`\\[${agent}\\]\\s+stigg check allowed`), `${agent} is checked`);
      assert.match(stdout, new RegExp(`\\[${agent}\\]\\s+stigg ingest credits=1 ok=true`), `${agent} is billed`);
    }
    assert.equal(stdout.match(/\[writer\] done/g)?.length, 4, 'the writer answers every turn');
    // The paid search runs in the `tools` node, and is still refused as the researcher.
    assert.match(stdout, /\[researcher\]\s+REFUSED web_search - BudgetExceeded by agent-researcher/);
    // The graph routes the refused researcher to the generalist, and the turn still ends.
    assert.match(stdout, /another pass - researcher refused \(BudgetExceeded by agent-researcher\)/);
    const pass = stdout.indexOf('another pass');
    assert.ok(stdout.indexOf('[generalist] done', pass) > pass, 'the generalist answers in its place');
    assert.match(stdout, /\[generalist\]\s+stigg ingest credits=1 ok=true/);
    assert.ok(stdout.lastIndexOf('[writer] done') > pass, 'and the writer still writes the answer');
  });
});
