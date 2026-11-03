/**
 * The Google ADK model-fallback example, run for real: an assistant on the expensive model, which
 * runs dry, and `onRefusal` handing its turn to a twin on the cheaper model.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { EXAMPLE_ENV } from './pinned-demo-env';

const run = promisify(execFile);
const PACKAGE_ROOT = join(__dirname, '..');

describe('the Google ADK model-fallback example', () => {
  it('answers with the assistant until its budget runs out, then hands each request to its cheaper twin', async () => {
    const pending = run('yarn', ['tsx', 'examples/orchestrator/adk/adk-model-fallback.ts'], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...EXAMPLE_ENV },
      timeout: 120_000,
    });
    // Five requests - the assistant's budget lasts three, at a price that grows with the conversation.
    pending.child.stdin?.end('What is metering?\nWhy per agent?\nAnd per model?\nFourth?\nFifth?\n');
    const { stdout } = await pending;

    // Two agents, each its own entity with its own budget, under one parent of their own.
    assert.match(stdout, /agent-adk-model-fallback limit=64 - parent of:/);
    assert.match(stdout, /agent-adk-assistant limit=4 \s*\|\s+agent-adk-assistant_lite limit=50/);
    // The assistant answers itself while it has credits - its function calling is off, so it never
    // hands off on its own.
    assert.equal(stdout.match(/\[assistant\] says/g)?.length, 3);
    assert.match(stdout, /\[assistant\]\s+stigg ingest credits=[2-9]/);
    // Then refused - and `onRefusal` hands the turn to the twin, on every later request.
    assert.equal(
      stdout.match(/\[assistant\]\s+REFUSED - BudgetExceeded by agent-adk-assistant, hands off to assistant_lite/g)
        ?.length,
      2,
    );
    assert.equal(stdout.match(/\[assistant_lite\] says/g)?.length, 2);
    assert.match(stdout, /\[assistant_lite\]\s+stigg check allowed remaining=50/);
    // Its own budget is charged: a credit a call, so its second check sees one fewer.
    assert.match(stdout, /\[assistant_lite\]\s+stigg check allowed remaining=49/);
    assert.match(stdout, /\[assistant_lite\]\s+stigg ingest credits=\d+ ok=true/, 'reported as itself');
    // Every request is answered.
    assert.equal(stdout.match(/assistant>/g)?.length, 5);
    assert.doesNotMatch(stdout, /refused by/);
  });
});
