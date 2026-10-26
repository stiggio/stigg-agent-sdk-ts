/**
 * `stigg.middleware(...)`, the framework-neutral core every orchestrator binding drives - here
 * driven directly, the way a harness of your own would. The LangChain handler's own contract is
 * in `langchain-callbacks.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IngestResult, MiddlewareTools } from '../src';
import { noopLogger } from '../src/logger';
import { newStigg } from './stigg-harness';

const CUSTOMER = 'customer-acme';
const credits = { currencyId: 'credits' } as const;
const lead = { agent: 'lead', customerId: CUSTOMER };

/**
 * A graph with one listed agent, `lead`, governed as `agent-1` and gating on credits, with every
 * check, report and metering failure captured.
 */
async function graph(options: { tools?: MiddlewareTools; leadTools?: MiddlewareTools; agentBudget?: number } = {}) {
  const errors: unknown[] = [];
  const { stigg } = await newStigg({ agentBudget: options.agentBudget ?? 100, onError: (err) => errors.push(err) });
  const ingests: IngestResult[] = [];
  const checked: (string | undefined)[] = [];
  const middleware = stigg.middleware({
    stiggContext: { attributionKey: 'agentId', entitlement: credits, ingestMode: 'sync' },
    tools: options.tools,
    agents: { lead: { stiggContext: { agentId: 'agent-1' }, tools: options.leadTools } },
    hooks: {
      onIngest: (result) => ingests.push(result),
      onDecision: (_decision, context) => checked.push(context.tool ?? 'model'),
    },
  });
  let runs = 0;
  /** One tool call, start to end. */
  const tool = async (
    name: string | undefined,
    output: unknown = 'ok',
    step: { callId?: string; kind?: string } = {},
  ) => {
    const runId = `t${(runs += 1)}`;
    await middleware.startTool(runId, { name, input: {}, ...step }, lead);
    await middleware.endTool(runId, output);
  };
  const flushed = async () => {
    await stigg.flush();
    return { ingests, checked, errors };
  };
  return { middleware, tool, flushed };
}

describe('stigg.middleware, driven by a harness of its own', () => {
  it('refuses an idempotencyKey on a default context, where every step would share it', async () => {
    const { stigg } = await newStigg();
    assert.throws(() => stigg.middleware({ stiggContext: { idempotencyKey: 'k' } as never }), /idempotencyKey/);
    assert.throws(
      () => stigg.middleware({ agents: { planner: { stiggContext: { idempotencyKey: 'k' } as never } } }),
      /agents\.planner\.stiggContext cannot set `idempotencyKey`/,
    );
  });

  it('checks and bills a step with no framework at all', async () => {
    const { middleware } = await graph();

    await middleware.startModel('step-1', lead, 'my-harness.model');
    await middleware.endModel('step-1', { metrics: { credits: 1 } });
    const summary = await middleware.stigg.flush();

    assert.equal(summary.checks, 1);
    assert.equal(summary.ingested, 1);
  });

  it('bills nothing for a step that failed - a model call or a tool that did not deliver', async () => {
    const { middleware, flushed } = await graph({ tools: { web_search: credits } });

    await middleware.startModel('m1', lead, 'my-harness.model');
    middleware.abandon('m1');
    await middleware.endModel('m1', { metrics: { credits: 1 } });
    await middleware.startTool('t1', { name: 'web_search' }, lead);
    middleware.abandon('t1');
    await middleware.endTool('t1', 'late');

    const { ingests, checked } = await flushed();
    assert.deepEqual(checked, ['model', 'web_search'], 'both were checked before they ran');
    assert.equal(ingests.length, 0);
  });

  it('reports a model reply with no usage as a metering failure, without failing the step', async () => {
    const { middleware, flushed } = await graph();

    await middleware.startModel('m1', lead, 'my-harness.model');
    await middleware.endModel('m1', undefined);

    const { ingests, errors } = await flushed();
    assert.equal(ingests.length, 0);
    assert.match(String(errors[0]), /without usage/);
  });

  it('never throws into the run when Stigg rejects a report', async () => {
    const { middleware, flushed } = await graph();

    await middleware.startModel('m1', lead, 'my-harness.model');
    // A negative value is refused before it is sent: the run goes on, and the result says so.
    await middleware.endModel('m1', { metrics: { credits: -1 } });

    const { ingests } = await flushed();
    assert.equal(ingests[0]?.ok, false);
  });
});

describe('the tool calls a model issued', () => {
  it('names a tool that starts with only its call id, and bills it to the agent that called it', async () => {
    const { middleware, flushed } = await graph({ leadTools: { web_search: credits } });

    await middleware.startModel('m1', lead, 'my-harness.model');
    await middleware.endModel('m1', { metrics: { credits: 1 } }, [{ id: 'call_1', name: 'web_search' }]);
    // A tools node of its own, attributed to no agent - as LangGraph's `ToolNode` is.
    await middleware.startTool('t1', { callId: 'call_1' }, { agent: 'tools', customerId: CUSTOMER });
    await middleware.endTool('t1', 'found');

    const { checked, ingests } = await flushed();
    assert.deepEqual(checked, ['model', 'web_search']);
    assert.equal(ingests.length, 2);
  });

  it('checks a call that runs again - a retry, a resumed graph - and bills it under the same key', async () => {
    const { middleware, flushed } = await graph({ leadTools: { web_search: credits } });

    await middleware.startModel('m1', lead, 'my-harness.model');
    await middleware.endModel('m1', { metrics: { credits: 1 } }, [{ id: 'call_1', name: 'web_search' }]);
    await middleware.startTool('t1', { callId: 'call_1' }, lead);
    middleware.abandon('t1');
    await middleware.startTool('t2', { callId: 'call_1' }, lead);
    await middleware.endTool('t2', 'found');

    const { checked, ingests } = await flushed();
    assert.deepEqual(checked, ['model', 'web_search', 'web_search']);
    assert.deepEqual(
      ingests.slice(1).map((r) => r.idempotencyKey),
      ['call_1:credits'],
    );
  });

  it('bills a call replayed after it succeeded to the same agent, under the same key', async () => {
    const { middleware, flushed } = await graph({ leadTools: { web_search: credits } });
    const toolsNode = { agent: 'tools', customerId: CUSTOMER };

    await middleware.startModel('m1', lead, 'my-harness.model');
    await middleware.endModel('m1', { metrics: { credits: 1 } }, [{ id: 'call_1', name: 'web_search' }]);
    await middleware.startTool('t1', { callId: 'call_1' }, toolsNode);
    await middleware.endTool('t1', 'found');
    // The tools node runs again - a retry of a sibling call, a resumed graph - and replays this one.
    await middleware.startTool('t2', { callId: 'call_1' }, toolsNode);
    await middleware.endTool('t2', 'found');

    const { checked, ingests } = await flushed();
    assert.deepEqual(checked, ['model', 'web_search', 'web_search'], 'both checked as the lead');
    assert.deepEqual(
      ingests.slice(1).map((r) => r.idempotencyKey),
      ['call_1:credits', 'call_1:credits'],
    );
  });

  it('remembers only so many calls that never ran, dropping the oldest first', async () => {
    const { middleware, flushed } = await graph({ leadTools: { web_search: credits } });

    // A thousand and one issued calls whose tools never start - a guard rail, a cancelled run.
    const issued = Array.from({ length: 1_001 }, (_, n) => ({ id: `call_${n}`, name: 'web_search' }));
    await middleware.endModel('m1', undefined, issued);
    await middleware.startTool('t-oldest', { callId: 'call_0' }, lead);
    await middleware.startTool('t-newest', { callId: 'call_1000' }, lead);

    const { checked } = await flushed();
    assert.deepEqual(checked, ['web_search'], 'the oldest was evicted; the newest is still known');
  });

  it('never matches a nameless tool by its kind against an entry written for a name', async () => {
    const { tool, flushed } = await graph({ tools: { TavilySearch: credits, '*': false } });

    await tool(undefined, 'found', { kind: 'TavilySearch' });

    const { checked } = await flushed();
    assert.deepEqual(checked, [], "only '*' covers a tool known by its class, and here it is off");
  });

  it("governs a tool no model called and that has no name by its kind, under '*'", async () => {
    const { tool, flushed } = await graph({ tools: { '*': credits } });

    // A packaged tool a node invokes directly: no name, no call id, only its class.
    await tool(undefined, 'found', { kind: 'TavilySearch' });

    const { checked, ingests } = await flushed();
    assert.deepEqual(checked, ['TavilySearch']);
    assert.equal(ingests.length, 1);
  });
});

describe('the steps in flight', () => {
  it('says so when a step is dropped to make room, rather than leave it unreported in silence', async () => {
    const { middleware, flushed } = await graph();

    // Ten thousand and one model calls started and never ended: the oldest makes room.
    for (let n = 0; n <= 10_000; n += 1) await middleware.startModel(`m${n}`, lead, 'my-harness.model');
    await middleware.endModel('m0', { metrics: { credits: 1 } });

    const { ingests, errors } = await flushed();
    assert.equal(ingests.length, 0, 'the dropped step bills nothing on its late end');
    assert.match(String(errors[0]), /a step was still in flight.*dropped unreported/);
  });
});

describe('a tool that starts with no name', () => {
  it('is warned about once per kind when it ends without a name - possibly a free tool, so not an error', async () => {
    const warnings: string[] = [];
    const errors: unknown[] = [];
    const { stigg } = await newStigg({
      logger: { ...noopLogger, warn: (message: string) => warnings.push(message) },
      onError: (err) => errors.push(err),
    });
    const middleware = stigg.middleware({
      stiggContext: { entitlement: credits, ingestMode: 'sync' },
      tools: { web_search: credits },
    });

    // A calculator called directly, three times: no name, no tool call, nothing to price it by.
    for (const runId of ['t1', 't2', 't3']) {
      await middleware.startTool(runId, { kind: 'Calculator', input: {} }, lead);
      await middleware.endTool(runId, 4);
    }
    await stigg.flush();

    assert.deepEqual(errors, [], 'not a metering failure on every call');
    assert.equal(warnings.filter((w) => w.includes('(Calculator) ran with no name')).length, 1);
  });

  it('is refused before it runs when the run names no customer, as a named tool is', async () => {
    const { middleware } = await graph({ tools: { web_search: credits } });

    await assert.rejects(middleware.startTool('t1', { input: {} }, { agent: 'lead' }), /No customerId/);
  });

  it('is let through untouched when nothing is governed - a config of only exemptions', async () => {
    const { middleware, flushed } = await graph({ tools: { '*': false } });

    // No customer, and no entry that governs anything: nothing to hold it for, so nothing to refuse.
    await middleware.startTool('t1', { input: {} }, { agent: 'lead' });
    await middleware.endTool('t1', 'found', 'web_search');

    const { checked, ingests } = await flushed();
    assert.deepEqual(checked, []);
    assert.equal(ingests.length, 0);
  });

  it('says so when it is dropped to make room, rather than go unreported in silence', async () => {
    const { middleware, flushed } = await graph({ tools: { web_search: credits } });

    // Ten thousand and one unnamed tools started and never ended: the oldest makes room.
    for (let n = 0; n <= 10_000; n += 1) await middleware.startTool(`t${n}`, { input: {} }, lead);
    await middleware.endTool('t0', 'found', 'web_search');

    const { ingests, errors } = await flushed();
    assert.equal(ingests.length, 0, 'the dropped tool reports nothing on its late end');
    assert.match(String(errors[0]), /a tool with no name was still in flight/);
  });
});

describe('tools: which are governed, and what each one reports', () => {
  it("governs every tool not named under '*', and leaves one marked false alone", async () => {
    const { tool, flushed } = await graph({ tools: { '*': credits, researcher: false } });

    await tool('calculator');
    await tool('researcher');

    const { checked, ingests } = await flushed();
    assert.deepEqual(checked, ['calculator'], 'the sub-agent held as a tool is billed by its own model calls');
    assert.deepEqual(
      ingests.map((r) => r.reported),
      [{ credits: 1 }],
    );
  });

  it("reports what a tool's usage makes of the call", async () => {
    const { tool, flushed } = await graph({
      tools: {
        web_search: { entitlement: credits, usage: ({ output }) => ({ credits: (output as unknown[]).length }) },
      },
    });

    await tool('web_search', [1, 2, 3]);

    const { checked, ingests } = await flushed();
    assert.deepEqual(checked, ['web_search']);
    assert.deepEqual(ingests[0]!.reported, { credits: 3 });
  });

  it("meters a tool with only a usage, and never checks it against the agent's entitlement", async () => {
    const { tool, flushed } = await graph({ tools: { sql_query: { usage: () => ({ credits: 2 }) } } });

    await tool('sql_query');

    const { checked, ingests } = await flushed();
    assert.deepEqual(checked, []);
    assert.deepEqual(ingests[0]!.reported, { credits: 2 });
  });

  it("lets an agent opt out of the catch-all with '*': false - but not out of a tool the shared config names", async () => {
    const { tool, flushed } = await graph({
      tools: { '*': credits, send_email: credits },
      leadTools: { '*': false, web_search: credits },
    });

    await tool('calculator');
    await tool('web_search');
    await tool('send_email');

    const { checked } = await flushed();
    assert.deepEqual(checked, ['web_search', 'send_email']);
  });

  it('counts a usage that throws, or returns no metrics, as a metering failure, and keeps the run going', async () => {
    const { tool, flushed } = await graph({
      tools: {
        web_search: {
          entitlement: credits,
          usage: () => {
            throw new Error('no results field');
          },
        },
        sql_query: { usage: () => undefined as never },
      },
    });

    await tool('web_search');
    await tool('sql_query');

    const { ingests, errors } = await flushed();
    assert.equal(ingests.length, 0);
    assert.match(String(errors[0]), /no results field/);
    assert.match(String(errors[1]), /returned undefined, not metrics/);
  });

  it("never mistakes Object.prototype's names for configured tools", async () => {
    const wildcard = await graph({ tools: { '*': credits } });
    // Under the catch-all, as any other unnamed tool - not as `Object.prototype.constructor`.
    await wildcard.tool('constructor');
    assert.deepEqual((await wildcard.flushed()).checked, ['constructor']);

    const named = await graph({ tools: { web_search: credits } });
    await named.tool('toString');
    const { checked, ingests } = await named.flushed();
    assert.deepEqual(checked, [], 'not named, no catch-all: ungoverned');
    assert.equal(ingests.length, 0);
  });

  it('refuses at construction an entry that would do nothing, or that mixes the two forms', async () => {
    const { stigg } = await newStigg();
    assert.throws(() => stigg.middleware({ tools: { web_search: {} as never } }), /neither an entitlement/);
    assert.throws(
      () => stigg.middleware({ tools: { web_search: { usage: 1 } as never } }),
      /web_search\.usage must be a function/,
    );
    assert.throws(
      () => stigg.middleware({ agents: { lead: { tools: { '*': { usage: 'x' } as never } } } }),
      /agents\.lead\.tools\.'\*'\.usage/,
    );
    // The shorthand with a usage beside it: the usage would never run.
    assert.throws(
      () => stigg.middleware({ tools: { web_search: { currencyId: 'credits', usage: () => ({}) } as never } }),
      /mixes an entitlement's own fields/,
    );
  });
});
