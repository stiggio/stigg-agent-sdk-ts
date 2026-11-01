/**
 * The Google ADK example, run for real: a coordinator handing each request down to a researcher
 * and a writer, against the offline Gemini mock, with one `StiggAdkPlugin` on the Runner.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { EXAMPLE_ENV } from './pinned-demo-env';

const run = promisify(execFile);
const PACKAGE_ROOT = join(__dirname, '..');

describe('the Google ADK handoff example', () => {
  it('governs each ADK agent as itself, and hands a refused researcher to the generalist', async () => {
    const pending = run('yarn', ['tsx', 'examples/orchestrator/adk-handoff.ts'], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...EXAMPLE_ENV },
      timeout: 120_000,
    });
    // Five requests - the researcher's budget lasts three - then end-of-input.
    pending.child.stdin?.end(
      'What is worth metering?\nAnd why per agent?\nWhat about tools?\nAnd the lead?\nOne more?\n',
    );
    const { stdout } = await pending;

    // Each agent is checked and reported as itself, and the chain runs end to end.
    for (const agent of ['coordinator', 'researcher', 'writer']) {
      assert.match(stdout, new RegExp(`\\[${agent}\\]\\s+stigg check allowed`), `${agent} is checked`);
      assert.match(stdout, new RegExp(`\\[${agent}\\]\\s+stigg ingest credits=\\d+ ok=true`), `${agent} is reported`);
    }
    assert.equal(
      stdout.match(/\[coordinator\]\s+hands off to researcher/g)?.length,
      5,
      'every request starts at the top',
    );
    assert.equal(stdout.match(/\[researcher\]\s+calls web_search/g)?.length, 4);
    assert.equal(stdout.match(/\[writer\] says/g)?.length, 5, 'the writer answers every request');

    // The fourth request: the search is refused as a tool result, then the researcher's own call -
    // which `onRefusal` answers by handing the turn to the generalist, there and on the fifth.
    assert.match(stdout, /\[researcher\]\s+REFUSED web_search - BudgetExceeded by agent-adk-researcher/);
    assert.equal(
      stdout.match(/\[researcher\]\s+REFUSED - BudgetExceeded by agent-adk-researcher, hands off to generalist/g)
        ?.length,
      2,
    );
    assert.equal(stdout.match(/\[generalist\]\s+hands off to writer/g)?.length, 2, 'and the generalist to the writer');
    assert.match(stdout, /\[generalist\]\s+stigg ingest credits=\d+ ok=true/, 'reported as itself');
    // The coordinator's own budget is untouched by the researcher's.
    assert.doesNotMatch(stdout, /\[coordinator\]\s+stigg check REFUSED/);
    assert.match(stdout, /Conversation ended/);
  });
});
