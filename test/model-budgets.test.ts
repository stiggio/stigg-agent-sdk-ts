/**
 * A budget per model: one agent, a budget scoped to each model it may call, and the model as a
 * dimension the node states on each call - so running out of one model leaves the other one open.
 *
 * Run for real: `register()` writes the scoped budgets, the node states each call's model in its
 * `stiggContext`, `ChatAnthropic` talks to the offline Anthropic mock, and the mock Stigg server
 * resolves a request's model to its entity and applies the budget scoped to it.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { AccessDecision, HookContext } from '../src';
import { StiggLangChainCallbackHandler } from '../src/integrations/langchain';
import { seedEntityTypes } from '../testing/mock-stigg-server';
import { startMockServer } from '../examples/shared/mock-server';
import { newStigg } from './stigg-harness';

const CUSTOMER = 'customer-acme';
const credits = { currencyId: 'credits' } as const;
const OPUS = 'claude-opus-5';
const HAIKU = 'claude-haiku-5-5';

describe('a budget per model, on one agent', () => {
  let vendor: Awaited<ReturnType<typeof startMockServer>>;
  after(() => vendor?.close());

  /** One agent with a budget scoped to each model, and a handler over it. */
  async function setUp(budgets: { opus: number; haiku: number }) {
    vendor ??= await startMockServer();
    const { stigg, mock } = await newStigg();
    seedEntityTypes(mock.state, [{ id: 'model', attributionKeys: ['model'], displayName: 'Model' }]);
    for (const model of [OPUS, HAIKU])
      await stigg.register({ customerId: CUSTOMER, agentId: model, entityTypeId: 'model' });
    for (const [model, limit] of [
      [OPUS, budgets.opus],
      [HAIKU, budgets.haiku],
    ] as const) {
      await stigg.register({
        customerId: CUSTOMER,
        agentId: 'agent-assistant',
        entityTypeId: 'agent',
        budget: { entitlement: credits, limit, cadence: 'P1M', scope: [model] },
      });
    }

    const decisions: { decision: AccessDecision; context: HookContext }[] = [];
    const handler = new StiggLangChainCallbackHandler({
      stigg,
      stiggContext: {
        attributionKey: 'agentId',
        entitlement: credits,
        ingestMode: 'sync',
        usageMapper: () => ({ credits: 1 }),
      },
      agents: { assistant: { stiggContext: { agentId: 'agent-assistant' } } },
      hooks: { onDecision: (decision, context) => decisions.push({ decision, context }) },
    });
    return { stigg, mock, handler, decisions };
  }

  /** One node that tries Opus and, when Stigg refuses it, answers with Haiku - the example's graph. */
  function assistantGraph(stigg: Awaited<ReturnType<typeof newStigg>>['stigg']) {
    const model = (name: string) => new ChatAnthropic({ model: name, apiKey: 'x', anthropicApiUrl: vendor.baseUrl });
    const [opus, haiku] = [model(OPUS), model(HAIKU)];
    const Turn = Annotation.Root({ request: Annotation<string>(), answeredBy: Annotation<string>() });
    // The call's own `stiggContext`: the model as a dimension, laid over the run's customer.
    const asModel = (model: string, config: RunnableConfig): RunnableConfig => ({
      ...config,
      metadata: { ...config.metadata, stiggContext: { dimensions: { model } } },
    });
    const assistant = async ({ request }: typeof Turn.State, config: RunnableConfig) => {
      const messages: BaseMessage[] | string = request;
      try {
        await opus.invoke(messages, asModel(OPUS, config));
        return { answeredBy: OPUS };
      } catch (err) {
        if (!stigg.denial(err)) throw err;
        await haiku.invoke(messages, asModel(HAIKU, config));
        return { answeredBy: HAIKU };
      }
    };
    return new StateGraph(Turn)
      .addNode('assistant', assistant)
      .addEdge(START, 'assistant')
      .addEdge('assistant', END)
      .compile();
  }

  it('answers with the expensive model until its own budget runs out, then with the cheaper one', async () => {
    const { stigg, handler } = await setUp({ opus: 2, haiku: 10 });
    const graph = assistantGraph(stigg);
    const turn = async () =>
      (
        await graph.invoke(
          { request: 'hi' },
          { callbacks: [handler], metadata: { stiggContext: { customerId: CUSTOMER } } },
        )
      ).answeredBy;

    assert.deepEqual([await turn(), await turn(), await turn(), await turn()], [OPUS, OPUS, HAIKU, HAIKU]);
  });

  it('resolves the agent, not its model, whichever entity type the account declared first', async () => {
    // An unparented agent and its model sit at the same depth; the model only scopes the agent's
    // budgets. Declared first, it must not become the subject - the scoped budgets would not apply.
    const { stigg, mock, handler } = await setUp({ opus: 2, haiku: 10 });
    const agentType = mock.state.entityTypes.get('agent')!;
    mock.state.entityTypes.delete('agent');
    mock.state.entityTypes.set('agent', agentType);
    assert.deepEqual([...mock.state.entityTypes.keys()].slice(-2), ['model', 'agent']);
    const graph = assistantGraph(stigg);
    const run = { callbacks: [handler], metadata: { stiggContext: { customerId: CUSTOMER } } };
    const turn = async () => (await graph.invoke({ request: 'hi' }, run)).answeredBy;

    assert.deepEqual([await turn(), await turn(), await turn()], [OPUS, OPUS, HAIKU]);
  });

  it('checks and reports each call with its model, as the agent that made it', async () => {
    const { stigg, mock, handler, decisions } = await setUp({ opus: 1, haiku: 10 });
    const graph = assistantGraph(stigg);
    for (let n = 0; n < 2; n += 1) {
      await graph.invoke(
        { request: 'hi' },
        { callbacks: [handler], metadata: { stiggContext: { customerId: CUSTOMER } } },
      );
    }
    await stigg.flush();

    // Opus, Opus refused, then Haiku - each checked as the assistant, with the model it asked for.
    assert.deepEqual(
      decisions.map(({ decision, context }) => [context.agent, context.dimensions.model, decision.hasAccess]),
      [
        ['assistant', OPUS, true],
        ['assistant', OPUS, false],
        ['assistant', HAIKU, true],
      ],
    );
    // And each report landed on its own model's budget, not on the other's.
    const reportedModels = mock.state.dimensionsSeen.map((dims) => (dims as { model?: string }).model).filter(Boolean);
    assert.deepEqual(reportedModels, [OPUS, HAIKU]);
  });

  it("re-registers a scoped budget seeded on create without touching the agent's other scopes", async () => {
    const { stigg, mock } = await newStigg();
    seedEntityTypes(mock.state, [{ id: 'model', attributionKeys: ['model'], displayName: 'Model' }]);
    const seed = (model: string, limit: number) =>
      stigg.register({
        customerId: CUSTOMER,
        agentId: 'agent-assistant',
        entityTypeId: 'agent',
        budget: { entitlement: credits, limit, cadence: 'P1M', apply: 'on-create', scope: [model] },
      });

    await seed(OPUS, 5);
    await seed(HAIKU, 50); // a different scope: its own budget, created though the agent has one
    await seed(OPUS, 999); // the same scope again: seeded once, left as it was

    assert.deepEqual(
      mock.state.assignmentWrites.map((write) => [write.scopeEntityIds, write.usageLimit]),
      [
        [[OPUS], 5],
        [[HAIKU], 50],
        [[OPUS], 5],
      ],
    );
  });
});
