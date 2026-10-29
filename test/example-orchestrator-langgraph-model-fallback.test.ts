/**
 * The LangGraph model-fallback example, run for real: a premium model priced per token as it is,
 * which runs dry, and a graph edge that answers with the cheaper model instead.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { EXAMPLE_ENV } from './pinned-demo-env';

const run = promisify(execFile);
const PACKAGE_ROOT = join(__dirname, '..');

describe('the LangGraph model-fallback example', () => {
  it('answers with the expensive model until its own budget runs out, then with the cheaper one, in the same node', async () => {
    const pending = run('yarn', ['tsx', 'examples/orchestrator/langgraph-model-fallback.ts'], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...EXAMPLE_ENV },
      timeout: 120_000,
    });
    // Five turns - Opus's budget lasts three, at a price that grows with the conversation.
    pending.child.stdin?.end('What is metering?\nWhy per agent?\nAnd per model?\nFourth?\nFifth?\n');
    const { stdout } = await pending;

    // One agent, with a budget per model - each model registered as an entity of its own.
    assert.match(stdout, /agent-assistant claude-opus-5 limit=4 claude-haiku-5-5 limit=50/);
    // Under its own parent, so it never rewrites the handoff example's cap or shares its count.
    assert.match(stdout, /agent-model-fallback limit=64 - parent of:/);
    assert.match(stdout, /claude-opus-5 registered/);
    // Opus is checked as the assistant, against its own budget, at its own price.
    assert.match(stdout, /\[assistant\]\s+stigg ingest credits=[2-9]/);
    // Then refused - and the same node answers with Haiku, whose budget is still open.
    const switched = stdout.indexOf('switching model - claude-opus-5 BudgetExceeded');
    assert.ok(switched > 0, 'the node catches the refusal of the expensive model');
    assert.ok(stdout.indexOf('waiting for claude-haiku-5-5', switched) > switched, 'and calls the cheaper one');
    // Haiku's own 50, inside the agent's whole 54 that Opus already spent 6 of.
    assert.match(stdout, /\[assistant\]\s+stigg check allowed remaining=48/);
    // Every turn tries Opus first, so both later turns switch, and every turn is answered.
    assert.equal(stdout.match(/switching model/g)?.length, 2);
    assert.equal(stdout.match(/assistant>/g)?.length, 5);
  });
});
