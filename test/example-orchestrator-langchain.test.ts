/**
 * The governed multi-agent orchestrator chat, run for real - the same reasoning as the two-agent test: an
 * example that stops working is a broken example whether or not a test reimplements it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { EXAMPLE_ENV } from './pinned-demo-env';

const run = promisify(execFile);
const PACKAGE_ROOT = join(__dirname, '..');

describe('the multi-agent orchestrator example', () => {
  it('governs each agent on its own, and keeps going when one is refused', async () => {
    const pending = run('yarn', ['tsx', 'examples/orchestrator/langchain.ts'], {
      cwd: PACKAGE_ROOT,
      // Forced, so the test never depends on whatever keys happen to be in the developer's .env.
      env: { ...process.env, ...EXAMPLE_ENV },
      timeout: 120_000,
    });
    // Four turns - the researcher's budget lasts three - then end-of-input, which ends the chat
    // the way Ctrl-D does.
    pending.child.stdin?.end('What is worth metering?\nAnd why per agent?\nWhat about tools?\nAnd the lead?\n');
    const { stdout } = await pending;

    // Turn 1 runs every agent: the researcher's tool loop, the writer, the lead's delegations.
    assert.equal(
      stdout.match(/\[writer\] done - model calls=1\s+tokens=\d+/g)?.length,
      4,
      'the writer runs every turn',
    );
    assert.equal(
      stdout.match(/\[lead\] done - model calls=3\s+tokens=\d+/g)?.length,
      4,
      'the lead finishes every turn',
    );
    // Each agent is checked and billed by its own handler.
    for (const agent of ['lead', 'researcher', 'writer']) {
      assert.match(stdout, new RegExp(`\\[${agent}\\]\\s+stigg check allowed`), `${agent} is checked`);
      assert.match(stdout, new RegExp(`\\[${agent}\\]\\s+stigg ingest credits=1 ok=true`), `${agent} is billed`);
    }
    // The graph is one parent agent in Stigg, registered first, with every agent beneath it.
    assert.match(stdout, /agent agent-orchestrator registered/);
    assert.ok(
      stdout.indexOf('agent agent-orchestrator registered') < stdout.indexOf('agent agent-lead registered'),
      'the parent exists before a child is placed under it',
    );
    assert.match(stdout, /agent-orchestrator limit=160 - parent of:/);
    // Turn 4: the researcher runs dry mid-loop and is refused - its search, then itself - and the
    // lead takes another pass with the generalist rather than the run failing.
    assert.match(stdout, /\[researcher\]\s+REFUSED web_search - BudgetExceeded by agent-researcher/);
    assert.match(stdout, /\[lead\]\s+another pass - researcher refused \(BudgetExceeded by agent-researcher\)/);
    const pass = stdout.indexOf('another pass');
    assert.ok(stdout.indexOf('[generalist] done', pass) > pass, 'the generalist answers in its place');
    assert.match(stdout, /\[generalist\]\s+stigg ingest credits=1 ok=true/, 'billed as itself');
    assert.ok(stdout.lastIndexOf('[writer] done') > pass, 'and the lead goes on to the writer');
  });

  /** One offline turn of the example, with the demo fixtures overridden. */
  const oneTurn = async (env: Record<string, string>) => {
    const pending = run('yarn', ['tsx', 'examples/orchestrator/langchain.ts'], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...EXAMPLE_ENV, ...env },
      timeout: 120_000,
    });
    pending.child.stdin?.end('What is worth metering?\n');
    return (await pending).stdout;
  };

  it('meters every agent with nothing checked when no entitlement is named', async () => {
    const stdout = await oneTurn({ AGENT_SDK_DEMO_CURRENCY_ID: '' });

    assert.match(stdout, /metering mode: no entitlement/);
    assert.doesNotMatch(stdout, /stigg check/, 'metering mode checks nothing');
    for (const agent of ['lead', 'researcher', 'writer']) {
      assert.match(stdout, new RegExp(`\\[${agent}\\]\\s+stigg ingest input_tokens=\\d+`), `${agent} is still metered`);
    }
  });

  it('runs at the customer level when there is no agent type to attribute under', async () => {
    const stdout = await oneTurn({ AGENT_SDK_DEMO_ENTITY_TYPE_ID: '', AGENT_SDK_DEMO_ATTRIBUTION_KEY: '' });

    assert.match(stdout, /every check is against customer customer-acme/);
    assert.doesNotMatch(stdout, /registered under customer/, 'no agent is provisioned');
    assert.match(stdout, /\[lead\]\s+stigg check allowed/);
    assert.doesNotMatch(stdout, /REFUSED/, "the customer's pool is large enough that nothing runs dry");
  });
});
