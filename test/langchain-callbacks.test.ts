/**
 * The LangChain binding: `StiggLangChainCallbackHandler`, over a graph's `stigg.middleware(...)`.
 *
 * Most cases drive the hooks directly, with the arguments LangChain passes, so they pin the
 * handler's contract rather than a framework version. The last block runs a real `createAgent`
 * against the offline Anthropic mock, because the part that cannot be faked is what LangChain does
 * with a handler's throw - and that is the whole reason the handler throws at all.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { ChatAnthropic } from '@langchain/anthropic';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { ToolMessage } from '@langchain/core/messages';
import { createAgent, tool } from 'langchain';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode, createReactAgent, toolsCondition } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import {
  unitsPerTokens,
  type AccessDecision,
  type HookContext,
  type IngestResult,
  type ToolCallMeasurement,
} from '../src';
import { AccessDeniedError, StiggLangChainCallbackHandler, isAccessDenied } from '../src/integrations/langchain';
import { noopLogger } from '../src/logger';
import { newStigg } from './stigg-harness';
import { seedBudget } from '../testing/mock-stigg-server';
import { startMockServer } from '../examples/shared/mock-server';

const CUSTOMER = 'customer-acme';
const credits = { currencyId: 'credits' } as const;

/** The run of the `lead` agent - what a step is attributed by: the configured agent above it. */
const LEAD_RUN = 'lead-run';

/** What LangChain hands `handleChatModelStart`, up to the metadata: the parent run and the metadata are read. */
const modelStart = (
  runId: string,
  metadata: Record<string, unknown>,
  // `null` for a step with no agent run above it: `undefined` would take the default.
  parentRunId: string | null = LEAD_RUN,
): Parameters<StiggLangChainCallbackHandler['handleChatModelStart']> => [
  {},
  [[]],
  runId,
  parentRunId ?? undefined,
  {},
  [],
  metadata,
];

/** Opens a run named `name`, as LangChain reports an agent's run: parent fourth, name eighth. */
const openRun = (handler: StiggLangChainCallbackHandler, runId: string, name: string, parentRunId?: string) =>
  (handler.handleChainStart as (...args: unknown[]) => void)({}, {}, runId, parentRunId, [], {}, 'chain', name);

/** What LangChain hands `handleLLMEnd` for one chat generation. */
const llmResult = (id: string, input = 900, output = 100) => ({
  generations: [
    [{ message: { id, usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output } } }],
  ],
});

/**
 * A graph with one listed agent, `lead`, governed as `agent-1` and gating on credits - the shared
 * context once, the agent's own over it - with every decision, ingest and warning captured.
 */
async function governed(options: { agentBudget?: number; checkErrorAction?: 'allow' | 'deny' } = {}) {
  const warnings: string[] = [];
  const { stigg, mock } = await newStigg({
    agentBudget: options.agentBudget ?? 100,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (m: string) => warnings.push(m),
      error: () => undefined,
    },
    ...(options.checkErrorAction ? { checkErrorAction: options.checkErrorAction } : {}),
  });
  const ingests: { result: IngestResult; context: HookContext }[] = [];
  const decisions: { decision: AccessDecision; context: HookContext }[] = [];
  const handler = new StiggLangChainCallbackHandler({
    stigg,
    stiggContext: {
      attributionKey: 'agentId',
      entitlement: credits,
      ingestMode: 'sync',
      usageMapper: unitsPerTokens('credits', 1_000),
    },
    hooks: {
      onIngest: (result, context) => ingests.push({ result, context }),
      onDecision: (decision, context) => decisions.push({ decision, context }),
    },
    agents: { lead: { stiggContext: { agentId: 'agent-1' }, tools: { web_search: credits } } },
  });
  openRun(handler, LEAD_RUN, 'lead');
  return { stigg, mock, handler, ingests, decisions, warnings };
}

const lead = { lc_agent_name: 'lead', stiggCustomerId: CUSTOMER };

describe('StiggLangChainCallbackHandler', () => {
  it('is a real LangChain callback handler, and blocks by default', async () => {
    const { handler } = await governed();
    assert.ok(handler instanceof BaseCallbackHandler);
    assert.equal(handler.name, 'StiggLangChainCallbackHandler');
    // Without both, LangChain logs a refusal and runs the call anyway.
    assert.equal(handler.raiseError, true);
    assert.equal(handler.awaitHandlers, true);
  });

  it('keeps blocking in a subclass, which is how a caller adds their own tracing', async () => {
    const { stigg } = await newStigg();
    class Traced extends StiggLangChainCallbackHandler {}
    const traced = new Traced({ stigg });
    assert.equal(traced.raiseError, true);
    assert.equal(traced.awaitHandlers, true);
  });

  it('needs the SDK it governs through', () => {
    assert.throws(
      () => new StiggLangChainCallbackHandler({} as ConstructorParameters<typeof StiggLangChainCallbackHandler>[0]),
      /needs `stigg`/,
    );
  });

  it("shares one middleware with LangChain's copy of it, so a nested run bills to the same graph", async () => {
    const { stigg } = await newStigg();
    // A subclass is how anyone reaches the middleware - which is exactly what a copy must share.
    class Probe extends StiggLangChainCallbackHandler {
      get shared() {
        return this.middleware;
      }
    }
    const handler = new Probe({ stigg });
    const copy = handler.copy() as Probe;

    assert.notEqual(copy, handler);
    assert.ok(copy instanceof Probe, 'LangChain copies through the subclass constructor');
    assert.equal(copy.shared, handler.shared);
  });

  it('exposes no governance handle of its own - flushing is the SDK it was given', async () => {
    const { handler } = await governed();
    assert.equal((handler as unknown as { stigg?: unknown }).stigg, undefined);
  });

  it("checks before its agent's model call and meters after it, keyed by the provider's id", async () => {
    const { stigg, handler, ingests, decisions } = await governed();

    await handler.handleChatModelStart(...modelStart('run-1', lead));
    await handler.handleLLMEnd(llmResult('msg_1'), 'run-1');
    await stigg.flush();

    assert.equal(decisions.length, 1);
    assert.equal(ingests.length, 1);
    assert.equal(ingests[0]!.result.ok, true);
    assert.equal(ingests[0]!.result.idempotencyKey, 'msg_1');
    assert.deepEqual(ingests[0]!.result.reported, { credits: 1 });
    // Whose step it was, for a hook to tell agents apart - and who it was billed as.
    assert.equal(ingests[0]!.context.agent, 'lead');
    assert.equal(ingests[0]!.context.dimensions.agentId, 'agent-1');
  });

  it('refuses with AccessDeniedError, carrying the decision', async () => {
    const { handler } = await governed({ agentBudget: 0 });

    await assert.rejects(handler.handleChatModelStart(...modelStart('run-1', lead)), (err) => {
      assert.ok(err instanceof AccessDeniedError);
      const decision = isAccessDenied(err);
      assert.equal(decision?.hasAccess, false);
      assert.equal(decision?.deniedBy, 'agent-1');
      return true;
    });
  });

  it("governs an unlisted agent's steps by the shared context, so another agent's budget never refuses them", async () => {
    const { handler, decisions } = await governed({ agentBudget: 0 });

    // `lead` has nothing left; `researcher` is not listed, so it is checked against the
    // customer's pool - resolving proves it was not checked as `lead`.
    await handler.handleChatModelStart(...modelStart('run-1', { ...lead, lc_agent_name: 'researcher' }, null));

    assert.equal(decisions[0]!.context.agent, 'researcher');
    assert.equal(decisions[0]!.context.dimensions.agentId, undefined, 'billed to the customer, not to an agent');
  });

  it('says once that an agent was left out of `agents`, rather than govern it silently as the customer', async () => {
    const { handler, warnings } = await governed();
    const unlisted = { ...lead, lc_agent_name: 'researcher' };

    await handler.handleChatModelStart(...modelStart('run-1', unlisted, null));
    await handler.handleChatModelStart(...modelStart('run-2', unlisted, null));

    assert.equal(warnings.filter((w) => w.includes('"researcher" is not listed')).length, 1);
  });

  it('refuses a call that names no customer, rather than check one that is not there', async () => {
    const { handler } = await governed();
    await assert.rejects(
      handler.handleChatModelStart(...modelStart('run-1', { lc_agent_name: 'lead' })),
      /No customerId.*stiggCustomerId/,
    );
  });

  it('meters without ever refusing when the graph gates on nothing', async () => {
    const { stigg } = await newStigg({ agentBudget: 0 });
    const ingests: IngestResult[] = [];
    let checks = 0;
    const handler = new StiggLangChainCallbackHandler({
      stigg,
      stiggContext: { agentId: 'agent-1', attributionKey: 'agentId', ingestMode: 'sync' },
      hooks: { onIngest: (result) => ingests.push(result), onDecision: () => (checks += 1) },
    });

    await handler.handleChatModelStart(...modelStart('run-1', { stiggCustomerId: CUSTOMER }));
    await handler.handleLLMEnd(llmResult('msg_1'), 'run-1');
    await stigg.flush();

    assert.equal(checks, 0);
    // LangChain's own counters, under its own names, as every recipe reports its vendor's.
    assert.deepEqual(ingests[0]!.reported, { input_tokens: 900, output_tokens: 100, total_tokens: 1000 });
  });

  it("gates an agent's paid tool, reports one unit for it, and lets every other tool through", async () => {
    const { stigg, handler, ingests, decisions } = await governed();
    const toolStart = (name: string, runId: string) =>
      handler.handleToolStart({}, '{}', runId, LEAD_RUN, [], lead, name, `call_${runId}`);

    await toolStart('web_search', 't1');
    await handler.handleToolEnd('result', 't1');
    await toolStart('calculator', 't2');
    await handler.handleToolEnd('result', 't2');
    await stigg.flush();

    assert.equal(decisions.length, 1, 'only the paid tool is checked');
    assert.equal(ingests.length, 1);
    assert.equal(ingests[0]!.result.idempotencyKey, 'call_t1:credits');
  });

  it("names a class-based tool from the model's own tool call, since LangChain passes no runName for one", async () => {
    const { handler, decisions } = await governed();
    // The model asked for `web_search` under this id; the tool then starts with the id and no name,
    // the way `TavilySearch` and other packaged tools do.
    await handler.handleChatModelStart(...modelStart('run-1', lead));
    await handler.handleLLMEnd(
      {
        generations: [
          [
            {
              message: {
                id: 'msg_1',
                tool_calls: [{ id: 'call_9', name: 'web_search' }],
                usage_metadata: { input_tokens: 1, output_tokens: 1 },
              },
            },
          ],
        ],
      },
      'run-1',
    );
    await handler.handleToolStart(
      { lc: 1, type: 'not_implemented', id: ['TavilySearch'] },
      '{}',
      't9',
      undefined,
      [],
      lead,
      undefined,
      'call_9',
    );

    assert.equal(decisions.length, 2, 'the model call and the tool were both checked');
  });

  it('refuses a paid tool the agent cannot afford', async () => {
    const { handler } = await governed({ agentBudget: 0 });
    await assert.rejects(
      handler.handleToolStart({}, '{}', 't1', LEAD_RUN, [], lead, 'web_search', 'call_t1'),
      (err) => isAccessDenied(err)?.hasAccess === false,
    );
  });

  it('fails open on an outage by default, and closed when told to', async () => {
    const open = await governed();
    await open.stigg.init();
    open.mock.failChecks = true;
    await open.handler.handleChatModelStart(...modelStart('run-1', lead));
    const allowed = open.decisions.at(-1)!.decision;
    assert.equal(allowed.hasAccess, true);
    assert.equal(allowed.source, 'policy', 'allowed by the error policy, not by Stigg');

    const closed = await governed({ checkErrorAction: 'deny' });
    await closed.stigg.init();
    closed.mock.failChecks = true;
    await assert.rejects(closed.handler.handleChatModelStart(...modelStart('run-1', lead)), AccessDeniedError);
  });
  it("is what a LangChain handler's copies share, so a reply on one names a tool started on another", async () => {
    const { handler, decisions } = await governed();
    const copy = handler.copy() as StiggLangChainCallbackHandler;

    await handler.handleChatModelStart(...modelStart('run-1', lead));
    await handler.handleLLMEnd(
      {
        generations: [
          [
            {
              message: {
                id: 'msg_1',
                tool_calls: [{ id: 'call_9', name: 'web_search' }],
                usage_metadata: { input_tokens: 1, output_tokens: 1 },
              },
            },
          ],
        ],
      },
      'run-1',
    );
    await copy.handleToolStart(
      { lc: 1, type: 'not_implemented', id: ['TavilySearch'] },
      '{}',
      't9',
      undefined,
      [],
      lead,
      undefined,
      'call_9',
    );

    assert.equal(decisions.length, 2, 'the model call and the tool, across the two copies');
  });

  it('parses what LangChain serialized - the input, and the output inside its ToolMessage - for a usage', async () => {
    const { stigg } = await newStigg({ agentBudget: 100 });
    const seen: ToolCallMeasurement[] = [];
    const handler = new StiggLangChainCallbackHandler({
      stigg,
      stiggContext: { attributionKey: 'agentId', entitlement: credits, ingestMode: 'sync' },
      tools: { web_search: { entitlement: credits, usage: (call) => (seen.push(call), { credits: 1 }) } },
    });

    await handler.handleToolStart({}, '{"query":"stigg"}', 't1', LEAD_RUN, [], lead, 'web_search', 'call_1');
    await handler.handleToolEnd(
      new ToolMessage({ content: '{"results":[1,2,3]}', tool_call_id: 'call_1', name: 'web_search' }),
      't1',
    );

    assert.deepEqual(seen, [{ name: 'web_search', input: { query: 'stigg' }, output: { results: [1, 2, 3] } }]);
  });

  it("governs a packaged tool a node calls directly by its class, under '*'", async () => {
    const { stigg } = await newStigg({ agentBudget: 100 });
    const checked: (string | undefined)[] = [];
    const handler = new StiggLangChainCallbackHandler({
      stigg,
      stiggContext: { attributionKey: 'agentId', entitlement: credits, ingestMode: 'sync' },
      tools: { '*': credits },
      hooks: { onDecision: (_decision, context) => checked.push(context.tool) },
    });

    // No runName, no tool call id: only the serialized class.
    const tavily = { lc: 1, type: 'not_implemented', id: ['langchain', 'tools', 'TavilySearch'] };
    await handler.handleToolStart(tavily, '{}', 't1', LEAD_RUN, [], lead);

    assert.deepEqual(checked, ['TavilySearch']);
  });

  it('bills nothing for a model call or a tool that failed', async () => {
    const { stigg, handler, ingests } = await governed();

    await handler.handleChatModelStart(...modelStart('run-1', lead));
    handler.handleLLMError(new Error('overloaded'), 'run-1');
    await handler.handleLLMEnd(llmResult('msg_1'), 'run-1');
    await handler.handleToolStart({}, '{}', 't1', LEAD_RUN, [], lead, 'web_search', 'call_t1');
    handler.handleToolError(new Error('timeout'), 't1');
    await handler.handleToolEnd('late', 't1');
    await stigg.flush();

    assert.equal(ingests.length, 0);
  });
});

describe('which agent a step belongs to: the run tree, not metadata', () => {
  /** A handler for `lead`, `researcher` and `billing_bot`, recording which agent each check was for. */
  async function attributed(rootAgent?: string) {
    const warnings: string[] = [];
    const { stigg } = await newStigg({
      agentBudget: 100,
      logger: { ...noopLogger, warn: (message: string) => warnings.push(message) },
    });
    const agents: (string | undefined)[] = [];
    const handler = new StiggLangChainCallbackHandler({
      stigg,
      stiggContext: { customerId: CUSTOMER, entitlement: credits },
      agents: { lead: {}, researcher: {}, billing_bot: {} },
      rootAgent,
      hooks: { onDecision: (_decision, context) => agents.push(context.agent) },
    });
    return { handler, agents, warnings };
  }
  const model = () => new FakeListChatModel({ responses: ['done'] });
  const ask = { messages: [{ role: 'user' as const, content: 'x' }] };

  it("bills a named sub-agent as itself when the tool that runs it passes on the parent's config", async () => {
    const { handler, agents } = await attributed();
    const researcher = createAgent({ name: 'researcher', model: model(), tools: [] });
    const research = tool(async (_input, config) => (await researcher.invoke(ask, config)).messages.at(-1)!.text, {
      name: 'research',
      schema: z.object({}),
    });

    // The parent's config carries `lc_agent_name: 'lead'` - which metadata alone would bill.
    await research.invoke({}, { callbacks: [handler], metadata: { lc_agent_name: 'lead' } });

    assert.deepEqual(agents, ['researcher']);
  });

  it('ignores an agent name a caller puts in the metadata - it cannot choose whose budget pays', async () => {
    const { handler, agents } = await attributed();
    const researcher = createAgent({ name: 'researcher', model: model(), tools: [] });

    await researcher.invoke(ask, { callbacks: [handler], metadata: { lc_agent_name: 'lead' } });

    assert.deepEqual(agents, ['researcher']);
  });

  it('knows a createReactAgent by its name, though it stamps none in metadata', async () => {
    const { handler, agents } = await attributed();

    await createReactAgent({ llm: model(), tools: [], name: 'billing_bot' }).invoke(ask, { callbacks: [handler] });

    assert.deepEqual(agents, ['billing_bot']);
  });
  it('keeps a top-level agent as itself with `rootAgent`, whatever the caller names the run', async () => {
    const { handler, agents } = await attributed('lead');
    const lead = createAgent({ name: 'lead', model: new FakeListChatModel({ responses: ['done'] }), tools: [] });

    for (const runName of ['researcher', 'anything-else']) {
      await lead.invoke({ messages: [{ role: 'user', content: 'x' }] }, { callbacks: [handler], runName });
    }

    assert.deepEqual(agents, ['lead', 'lead']);
  });

  it('refuses a `rootAgent` that `agents` does not list', async () => {
    const { stigg } = await newStigg();
    assert.throws(
      () => new StiggLangChainCallbackHandler({ stigg, agents: { lead: {} }, rootAgent: 'writer' }),
      /`rootAgent` names "writer"/,
    );
  });
});

describe('what decides the agent, and what cannot', () => {
  it("never takes a configured agent's name from metadata alone - and says so", async () => {
    const { handler, decisions, warnings } = await governed();

    // `lead` is configured, but no run above this step is named `lead`: metadata is not proof.
    await handler.handleChatModelStart(...modelStart('run-1', lead, null));

    assert.equal(decisions[0]!.context.agent, undefined, 'governed by the shared context');
    assert.equal(warnings.filter((w) => w.includes('names agent "lead", but no run above it')).length, 1);
  });

  it("attributes a nested run a copy handles through the original's run tree", async () => {
    const { handler, decisions } = await governed();
    const copy = handler.copy() as StiggLangChainCallbackHandler;

    // The agent's run started on the original; the model call inside it reaches the copy.
    await copy.handleChatModelStart(...modelStart('run-1', { stiggCustomerId: CUSTOMER }));

    assert.equal(decisions[0]!.context.agent, 'lead');
  });
});

describe('what a step is billed from', () => {
  it('treats an empty tokenUsage - a streamed completion - as no measurement, not as zero', async () => {
    const errors: unknown[] = [];
    const { stigg } = await newStigg({ onError: (err) => errors.push(err) });
    const ingests: IngestResult[] = [];
    const handler = new StiggLangChainCallbackHandler({
      stigg,
      stiggContext: { customerId: CUSTOMER, ingestMode: 'sync' },
      hooks: { onIngest: (result) => ingests.push(result) },
    });

    await handler.handleLLMStart({}, ['prompt'], 'run-8', undefined, {}, [], {});
    await handler.handleLLMEnd({ generations: [[{ text: 'answer' }]], llmOutput: { tokenUsage: {} } }, 'run-8');
    await stigg.flush();

    assert.equal(ingests.length, 0);
    assert.match(String(errors[0]), /without usage/);
  });

  it("reports a completion model's tokens under the chat model's names, keyed by its run", async () => {
    const { stigg } = await newStigg({ agentBudget: 100 });
    const ingests: IngestResult[] = [];
    // No mapper: what is reported is the counters themselves, so a wrong mapping shows.
    const handler = new StiggLangChainCallbackHandler({
      stigg,
      stiggContext: { customerId: CUSTOMER, ingestMode: 'sync' },
      hooks: { onIngest: (result) => ingests.push(result) },
    });

    await handler.handleLLMStart({}, ['prompt'], 'run-7', undefined, {}, [], {});
    await handler.handleLLMEnd(
      {
        generations: [[{ text: 'answer' }]],
        llmOutput: { tokenUsage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000 } },
      },
      'run-7',
    );
    await stigg.flush();

    assert.deepEqual(ingests[0]?.reported, { input_tokens: 900, output_tokens: 100, total_tokens: 1000 });
    assert.equal(ingests[0]?.idempotencyKey, 'run-7');
  });

  it('bills a completion model from its llmOutput.tokenUsage, since it has no chat message', async () => {
    const { stigg, handler, ingests } = await governed();

    await handler.handleLLMStart({}, ['prompt'], 'run-1', LEAD_RUN, {}, [], lead);
    await handler.handleLLMEnd(
      {
        generations: [[{ text: 'answer' }]],
        llmOutput: { tokenUsage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000 } },
      },
      'run-1',
    );
    await stigg.flush();

    assert.deepEqual(ingests[0]?.result.reported, { credits: 1 });
  });

  it('reports a priced tool that started with no name by the name its result carries, and says it ran unchecked', async () => {
    const { stigg, handler, ingests, decisions, warnings } = await governed();
    const tavily = { lc: 1, type: 'not_implemented', id: ['langchain', 'tools', 'TavilySearch'] };

    // No name, and a call id no model on this process issued - a resumed run, another pod.
    await handler.handleToolStart(tavily, '{}', 't1', LEAD_RUN, [], lead, undefined, 'call_elsewhere');
    await handler.handleToolEnd(
      new ToolMessage({ content: 'found', tool_call_id: 'call_elsewhere', name: 'web_search' }),
      't1',
    );
    await stigg.flush();

    assert.equal(decisions.length, 0, 'nothing could be checked before it ran');
    assert.equal(ingests[0]?.result.idempotencyKey, 'call_elsewhere:credits');
    assert.equal(warnings.filter((w) => w.includes('"web_search" was metered but not checked')).length, 1);
  });
});

describe("the application's own code, called from inside a step", () => {
  it('reports a tool that worked even when the logger throws on its warning', async () => {
    const { stigg } = await newStigg({
      agentBudget: 100,
      logger: {
        ...noopLogger,
        warn: () => {
          throw new Error('logger down');
        },
      },
    });
    const ingests: IngestResult[] = [];
    const handler = new StiggLangChainCallbackHandler({
      stigg,
      stiggContext: { customerId: CUSTOMER, entitlement: credits, ingestMode: 'sync' },
      tools: { web_search: credits },
      hooks: { onIngest: (result) => ingests.push(result) },
    });
    const tavily = { lc: 1, type: 'not_implemented', id: ['langchain', 'tools', 'TavilySearch'] };

    await handler.handleToolStart(tavily, '{}', 't1', undefined, [], {}, undefined, 'call_1');
    await handler.handleToolEnd(
      new ToolMessage({ content: 'found', tool_call_id: 'call_1', name: 'web_search' }),
      't1',
    );
    await stigg.flush();

    assert.equal(ingests.length, 1);
  });

  it('says once that the run tree is full, since steps beneath a forgotten run lose their agent', async () => {
    const { handler, warnings } = await governed();

    for (let n = 0; n <= 10_001; n += 1) openRun(handler, `run-${n}`, 'node');

    assert.equal(warnings.filter((w) => w.includes('LangChain runs are open at once')).length, 1);
  });
});

describe('a real createAgent, one handler for the graph', () => {
  let vendor: Awaited<ReturnType<typeof startMockServer>>;
  after(() => vendor?.close());

  async function graph(budgets: { lead: number; researcher: number }) {
    vendor ??= await startMockServer();
    const { stigg, mock } = await newStigg();
    for (const [entityId, usageLimit] of Object.entries({
      'agent-lead': budgets.lead,
      'agent-researcher': budgets.researcher,
    })) {
      seedBudget(mock.state, CUSTOMER, { entityId, entityTypeId: 'agent', capabilityId: 'credits', usageLimit });
    }
    // Who each step was checked and billed as - the agent's own entity, never another's.
    const checkedAs: Record<string, AccessDecision[]> = {};
    const billedAs: Record<string, string[]> = {};
    const handler = new StiggLangChainCallbackHandler({
      stigg,
      stiggContext: { attributionKey: 'agentId', entitlement: credits, ingestMode: 'sync' },
      agents: {
        lead: { stiggContext: { agentId: 'agent-lead' } },
        researcher: { stiggContext: { agentId: 'agent-researcher' } },
      },
      hooks: {
        onDecision: (decision, context) => (checkedAs[context.agent ?? '?'] ??= []).push(decision),
        onIngest: (_result, context) => (billedAs[context.agent ?? '?'] ??= []).push(context.dimensions.agentId ?? ''),
      },
    });

    const model = new ChatAnthropic({
      model: 'claude-opus-5',
      apiKey: 'offline-mock',
      anthropicApiUrl: vendor.baseUrl,
    });
    const researcher = createAgent({ name: 'researcher', model, tools: [] });
    const research = tool(
      async ({ brief }) => {
        const { messages } = await researcher.invoke({ messages: [{ role: 'user', content: brief }] });
        return messages.at(-1)?.text ?? '';
      },
      { name: 'research', description: 'Research a question.', schema: z.object({ brief: z.string() }) },
    );
    const leadAgent = createAgent({ name: 'lead', model, tools: [research] });
    const invoke = () =>
      leadAgent.invoke(
        { messages: [{ role: 'user', content: 'What is worth metering?' }] },
        { callbacks: [handler], metadata: { stiggCustomerId: CUSTOMER } },
      );
    return { stigg, checkedAs, billedAs, invoke };
  }

  it('keeps the run going when a sub-agent is refused - the lead reads it as a failed tool call', async () => {
    const { checkedAs, invoke } = await graph({ lead: 100, researcher: 0 });

    const { messages } = await invoke();

    const toolResult = messages.find((m) => m.getType() === 'tool');
    assert.match(String(toolResult?.content), /AccessDeniedError/);
    // The lead went on to answer: two model calls of its own, both checked as the lead.
    assert.equal(checkedAs.lead?.length, 2);
    assert.equal(checkedAs.researcher?.at(-1)?.hasAccess, false);
  });

  it("rejects the caller's invoke when the top-level agent is refused, and the denial reads back", async () => {
    const { stigg, invoke } = await graph({ lead: 0, researcher: 100 });

    await assert.rejects(invoke(), (err) => {
      const decision = stigg.denial(err);
      assert.equal(decision?.deniedBy, 'agent-lead');
      return true;
    });
  });

  it("bills each agent's calls to that agent", async () => {
    const { stigg, billedAs, invoke } = await graph({ lead: 100, researcher: 100 });

    await invoke();
    await stigg.flush();

    // The lead delegates once and then answers; the researcher answers in one call.
    assert.deepEqual(billedAs.lead, ['agent-lead', 'agent-lead']);
    assert.deepEqual(billedAs.researcher, ['agent-researcher']);
  });
});

describe('a hand-built LangGraph StateGraph, the same handler', () => {
  let vendor: Awaited<ReturnType<typeof startMockServer>>;
  after(() => vendor?.close());

  /** The integration is the createAgent one, word for word: one handler, `agents` by name. */
  async function governed(agents: string[]) {
    vendor ??= await startMockServer();
    const { stigg, mock } = await newStigg();
    for (const agent of agents) {
      seedBudget(mock.state, CUSTOMER, {
        entityId: `agent-${agent}`,
        entityTypeId: 'agent',
        capabilityId: 'credits',
        usageLimit: 100,
      });
    }
    const checkedAs: string[] = [];
    const handler = new StiggLangChainCallbackHandler({
      stigg,
      stiggContext: { attributionKey: 'agentId', entitlement: credits, ingestMode: 'sync' },
      agents: Object.fromEntries(
        agents.map((agent) => [agent, { stiggContext: { agentId: `agent-${agent}` }, tools: { web_search: credits } }]),
      ),
      hooks: {
        onDecision: (_decision, context) =>
          checkedAs.push(`${context.agent}${context.tool ? `/${context.tool}` : ''} as ${context.dimensions.agentId}`),
      },
    });
    const model = new ChatAnthropic({
      model: 'claude-opus-5',
      apiKey: 'offline-mock',
      anthropicApiUrl: vendor.baseUrl,
    });
    const config = { callbacks: [handler], metadata: { stiggCustomerId: CUSTOMER } };
    return { model, config, checkedAs };
  }

  it('governs each node as the agent of that name - a graph node is the agent', async () => {
    const { model, config, checkedAs } = await governed(['planner', 'writer']);
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('planner', async ({ messages }) => ({ messages: [await model.invoke(messages)] }))
      .addNode('writer', async ({ messages }) => ({ messages: [await model.invoke(messages)] }))
      .addEdge(START, 'planner')
      .addEdge('planner', 'writer')
      .addEdge('writer', END)
      .compile();

    await graph.invoke({ messages: [{ role: 'user', content: 'hi' }] }, config);

    assert.deepEqual(checkedAs, ['planner as agent-planner', 'writer as agent-writer']);
  });

  it("bills a paid tool in LangGraph's own ToolNode to the agent that called it, not to the `tools` node", async () => {
    const { model, config, checkedAs } = await governed(['researcher']);
    const search = tool(async ({ query }) => `results for ${query}`, {
      name: 'web_search',
      description: 'Search.',
      schema: z.object({ query: z.string() }),
    });
    const researcher = model.bindTools([search]);
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('researcher', async ({ messages }) => ({ messages: [await researcher.invoke(messages)] }))
      .addNode('tools', new ToolNode([search]))
      .addEdge(START, 'researcher')
      .addConditionalEdges('researcher', toolsCondition)
      .addEdge('tools', 'researcher')
      .compile();

    await graph.invoke({ messages: [{ role: 'user', content: 'find it' }] }, config);

    assert.deepEqual(checkedAs, [
      'researcher as agent-researcher',
      'researcher/web_search as agent-researcher',
      'researcher as agent-researcher',
    ]);
  });
});
