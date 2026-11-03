/**
 * The Google ADK binding: `StiggAdkPlugin`, over a graph's `stigg.middleware(...)`.
 *
 * Every case runs a real ADK Runner with the plugin installed, against a scripted model, because
 * what cannot be faked is how ADK drives a plugin: which callbacks a step fires, in what order, with
 * which context objects - and what it does with a plugin's throw.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AgentTool,
  BaseLlm,
  BasePlugin,
  ExitLoopTool,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  StreamingMode,
  type BaseAgent,
  type Event,
  type Context,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { unitsPerTokens, type AccessDecision, type HookContext, type IngestResult } from '../src';
import { DENIED_ERROR_CODE, StiggAdkPlugin, type StiggAdkPluginOptions } from '../src/integrations/adk';
import { newStigg } from './stigg-harness';
import { seedBudget } from '../testing/mock-stigg-server';

const CUSTOMER = 'customer-acme';
const credits = { currencyId: 'credits' } as const;
const APP = 'adk-test';

/** Gemini's finish reason for a call that ended normally. */
const STOP = 'STOP' as LlmResponse['finishReason'];

/** A Gemini `usageMetadata` block. */
const usage = (input: number, output: number) => ({
  promptTokenCount: input,
  candidatesTokenCount: output,
  totalTokenCount: input + output,
});

/** A call's whole answer: Gemini states a finish reason on a call's last response. */
const text = (value: string, input = 900, output = 100): LlmResponse => ({
  content: { role: 'model', parts: [{ text: value }] },
  usageMetadata: usage(input, output),
  finishReason: STOP,
});

const call = (name: string, args: Record<string, unknown> = {}, id = `call-${name}`): LlmResponse => ({
  content: { role: 'model', parts: [{ functionCall: { id, name, args } }] },
  usageMetadata: usage(900, 100),
  finishReason: STOP,
});

/** A model that answers each call with the next entry of its script - several responses for a stream. */
class ScriptedLlm extends BaseLlm {
  calls = 0;

  constructor(private readonly script: (LlmResponse | (LlmResponse | Error)[])[]) {
    super({ model: 'gemini-scripted' });
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    const next = this.script[this.calls++] ?? text('done');
    for (const response of Array.isArray(next) ? next : [next]) {
      if (response instanceof Error) throw response;
      yield response;
    }
  }

  connect(): never {
    throw new Error('live mode is not scripted');
  }
}

/**
 * One customer's graph, gating on credits at one credit per thousand tokens: `lead` governed as
 * `agent-1`, `researcher` as `agent-2`, the customer resolved from the invocation's user.
 */
async function governed(options: { leadBudget?: number; researcherBudget?: number } = {}) {
  const warnings: string[] = [];
  const { stigg, mock } = await newStigg({
    agentBudget: options.leadBudget ?? 100,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (m: string) => warnings.push(m),
      error: () => undefined,
    },
  });
  if (options.researcherBudget !== undefined) {
    seedBudget(mock.state, CUSTOMER, {
      entityId: 'agent-2',
      capabilityId: 'credits',
      usageLimit: options.researcherBudget,
    });
  }
  const ingests: { result: IngestResult; context: HookContext }[] = [];
  const decisions: { decision: AccessDecision; context: HookContext }[] = [];
  const pluginOptions: StiggAdkPluginOptions = {
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
    agents: {
      lead: { stiggContext: { agentId: 'agent-1' }, tools: { web_search: credits } },
      researcher: { stiggContext: { agentId: 'agent-2' } },
    },
    stepContext: ({ adkContext }) => (adkContext.userId === 'user-1' ? { customerId: CUSTOMER } : undefined),
  };
  return { stigg, mock, pluginOptions, ingests, decisions, warnings };
}

/** Runs one turn as `userId`, returning the events - or the error the run ended with. */
async function runTurn(
  agent: BaseAgent,
  plugin: BasePlugin | BasePlugin[],
  options: { userId?: string; streaming?: boolean; until?: (event: Event, abort: () => void) => boolean } = {},
) {
  const userId = options.userId ?? 'user-1';
  const runner = new InMemoryRunner({ agent, appName: APP, plugins: Array.isArray(plugin) ? plugin : [plugin] });
  const session = await runner.sessionService.createSession({ appName: APP, userId });
  const events = [];
  const controller = new AbortController();
  try {
    for await (const event of runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text: 'hello' }] },
      abortSignal: controller.signal,
      ...(options.streaming ? { runConfig: { streamingMode: StreamingMode.SSE } } : {}),
    })) {
      events.push(event);
      // The caller stops reading here - or aborts the run, and reads on to the end.
      if (options.until?.(event, () => controller.abort())) break;
    }
    return { events, error: undefined };
  } catch (error) {
    return { events, error };
  }
}

const webSearch = (onRun: () => unknown = () => ({ hits: 3 })) =>
  new FunctionTool({ name: 'web_search', description: 'Searches the web.', execute: async () => onRun() });

// A Runner that never ends must fail the test, not hang the suite.
describe('StiggAdkPlugin', { timeout: 30_000 }, () => {
  it('needs the SDK it governs through', () => {
    assert.throws(() => new StiggAdkPlugin({} as StiggAdkPluginOptions), /needs `stigg`/);
  });

  it("types a step's context without an idempotencyKey, which every report beneath it would share", () => {
    // @ts-expect-error - refused at compile time, not at the first step.
    const stepContext: StiggAdkPluginOptions['stepContext'] = () => ({ customerId: 'c', idempotencyKey: 'k' });
    assert.ok(stepContext);
  });

  it("checks before an agent's model call and reports its usage after, as that agent", async () => {
    const { stigg, pluginOptions, ingests, decisions } = await governed();
    const model = new ScriptedLlm([text('hi')]);
    const lead = new LlmAgent({ name: 'lead', model, instruction: 'Answer.' });

    const { error } = await runTurn(lead, new StiggAdkPlugin(pluginOptions));
    await stigg.flush();

    assert.equal(error, undefined);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.context.agent, 'lead');
    assert.equal(ingests.length, 1);
    assert.equal(ingests[0]!.result.ok, true);
    assert.deepEqual(ingests[0]!.result.reported, { credits: 1 });
    assert.equal(ingests[0]!.context.agent, 'lead');
    assert.equal(ingests[0]!.context.dimensions.agentId, 'agent-1');
  });

  it('answers a refused model call with an error event carrying the decision, never calling the model', async () => {
    const { pluginOptions } = await governed({ leadBudget: 0 });
    const model = new ScriptedLlm([text('hi')]);
    const lead = new LlmAgent({ name: 'lead', model, instruction: 'Answer.' });

    const plugin = new StiggAdkPlugin(pluginOptions);
    const { events, error } = await runTurn(lead, plugin);

    assert.equal(error, undefined, 'the run ends with an event, as ADK ends any refused step');
    const refused = events.find((event) => plugin.denialOf(event));
    assert.equal(refused?.author, 'lead');
    assert.equal(refused?.errorCode, DENIED_ERROR_CODE);
    assert.match(refused?.errorMessage ?? '', /agent-1/);
    assert.equal(plugin.denialOf(refused!)?.deniedBy, 'agent-1');
    assert.equal(model.calls, 0, 'the model was never called');
  });

  it('refuses a step whose customer `stepContext` did not resolve', async () => {
    const { pluginOptions } = await governed();
    const model = new ScriptedLlm([text('hi')]);
    const lead = new LlmAgent({ name: 'lead', model, instruction: 'Answer.' });

    const { events } = await runTurn(lead, new StiggAdkPlugin(pluginOptions), { userId: 'stranger' });

    assert.match(events.at(-1)?.errorMessage ?? '', /stepContext/);
    assert.equal(model.calls, 0);
  });

  it('answers a refused tool with a short error, keeping the decision from the model', async () => {
    // One credit: the first model call spends it, and is reported before the tool is checked.
    const { stigg, pluginOptions, ingests } = await governed({ leadBudget: 1 });
    let searched = false;
    const model = new ScriptedLlm([call('web_search'), text('answered without searching')]);
    const lead = new LlmAgent({
      name: 'lead',
      model,
      instruction: 'Answer.',
      tools: [webSearch(() => (searched = true))],
    });

    const plugin = new StiggAdkPlugin(pluginOptions);
    const { events, error } = await runTurn(lead, plugin);
    await stigg.flush();

    assert.equal(error, undefined);
    assert.equal(searched, false, 'the tool never ran');
    const response = events.find((event) => event.content?.parts?.some((part) => part.functionResponse));
    const result = response?.content?.parts?.[0]?.functionResponse?.response;
    assert.deepEqual(result, { error: 'web_search is not available: BudgetExceeded.' }, 'why, and nothing more');
    assert.equal(plugin.denialOf(response!)?.deniedBy, 'agent-1', 'the plugin keeps the decision');
    // A tool cannot pass off its own result as a refusal.
    const forged = {
      content: { parts: [{ functionResponse: { id: 'other', response: { stiggDecision: { hasAccess: false } } } }] },
    };
    assert.equal(plugin.denialOf(forged), undefined);
    // A later turn's response that reuses the call id was not refused.
    assert.equal(plugin.denialOf({ ...response!, invocationId: 'a-later-turn' }), undefined);
    assert.deepEqual(
      ingests.map(({ result }) => result.reported),
      [{ credits: 1 }],
      'the call that asked for the tool, and not the tool',
    );
  });

  it('checks a priced tool, reports it once it ran, and reports each model call around it', async () => {
    const { stigg, pluginOptions, ingests, decisions } = await governed();
    const model = new ScriptedLlm([call('web_search', { q: 'adk' }), text('found it', 1_500, 1_500)]);
    const lead = new LlmAgent({ name: 'lead', model, instruction: 'Answer.', tools: [webSearch()] });

    const { error } = await runTurn(lead, new StiggAdkPlugin(pluginOptions));
    await stigg.flush();

    assert.equal(error, undefined);
    assert.deepEqual(
      decisions.map(({ context }) => context.tool ?? 'model'),
      ['model', 'web_search', 'model'],
    );
    const reported = ingests.map(({ result }) => result.reported);
    assert.deepEqual(reported, [{ credits: 1 }, { credits: 1 }, { credits: 3 }], 'the call, the search, the answer');
    assert.ok(ingests.every(({ context }) => context.agent === 'lead'));
  });

  it('reports nothing for a tool that failed', async () => {
    const { stigg, pluginOptions, ingests } = await governed();
    const model = new ScriptedLlm([call('web_search'), text('it failed')]);
    const failing = webSearch(() => {
      throw new Error('search is down');
    });
    const lead = new LlmAgent({ name: 'lead', model, instruction: 'Answer.', tools: [failing] });

    const { error } = await runTurn(lead, new StiggAdkPlugin(pluginOptions));
    await stigg.flush();

    assert.equal(error, undefined, 'ADK hands the failure to the model as the tool result');
    assert.equal(ingests.length, 2, 'the two model calls, and not the tool');
  });

  it('reports each sub-agent as itself, and never the handoff between them', async () => {
    const { stigg, pluginOptions, ingests } = await governed({ researcherBudget: 100 });
    const researcher = new LlmAgent({
      name: 'researcher',
      description: 'Looks things up.',
      model: new ScriptedLlm([text('the facts')]),
    });
    const lead = new LlmAgent({
      name: 'lead',
      model: new ScriptedLlm([call('transfer_to_agent', { agent_name: 'researcher' })]),
      instruction: 'Delegate.',
      subAgents: [researcher],
    });

    const { error } = await runTurn(lead, new StiggAdkPlugin({ ...pluginOptions, tools: { '*': credits } }));
    await stigg.flush();

    assert.equal(error, undefined);
    const reported = ingests.map(({ context }) => [context.agent, context.dimensions.agentId]);
    assert.deepEqual(reported, [
      ['lead', 'agent-1'],
      ['researcher', 'agent-2'],
    ]);
  });

  it('refuses only the agent that ran dry, and reports the work before the refusal', async () => {
    const { stigg, pluginOptions, ingests } = await governed({ researcherBudget: 0 });
    const researcher = new LlmAgent({
      name: 'researcher',
      description: 'Looks things up.',
      model: new ScriptedLlm([text('the facts')]),
    });
    const lead = new LlmAgent({
      name: 'lead',
      model: new ScriptedLlm([call('transfer_to_agent', { agent_name: 'researcher' })]),
      instruction: 'Delegate.',
      subAgents: [researcher],
    });

    const plugin = new StiggAdkPlugin(pluginOptions);
    const { events } = await runTurn(lead, plugin);
    await stigg.flush();

    const refused = events.find((event) => plugin.denialOf(event));
    assert.equal(refused?.author, 'researcher');
    assert.equal(plugin.denialOf(refused!)?.deniedBy, 'agent-2');
    assert.deepEqual(
      ingests.map(({ context }) => context.agent),
      ['lead'],
      "the lead's call is reported although the run ended in a refusal",
    );
  });

  it("hands a refused agent's turn to another agent when `onRefusal` says so", async () => {
    const { stigg, pluginOptions, ingests } = await governed({ researcherBudget: 0 });
    const researcherModel = new ScriptedLlm([text('the facts')]);
    const researcher = new LlmAgent({ name: 'researcher', description: 'Looks things up.', model: researcherModel });
    const generalist = new LlmAgent({
      name: 'generalist',
      description: 'Answers from what it knows.',
      model: new ScriptedLlm([text('from memory')]),
    });
    const lead = new LlmAgent({
      name: 'lead',
      model: new ScriptedLlm([call('transfer_to_agent', { agent_name: 'researcher' })]),
      instruction: 'Delegate.',
      subAgents: [researcher, generalist],
    });
    const plugin = new StiggAdkPlugin({
      ...pluginOptions,
      onRefusal: ({ agent }) => (agent === 'researcher' ? { transferTo: 'generalist' } : undefined),
    });

    const { events, error } = await runTurn(lead, plugin);
    await stigg.flush();

    assert.equal(error, undefined);
    assert.equal(researcherModel.calls, 0, 'the refused model is never called');
    const handoff = events.find((event) => event.author === 'researcher' && plugin.denialOf(event));
    assert.equal(plugin.denialOf(handoff!)?.deniedBy, 'agent-2', 'the handoff carries the decision');
    assert.deepEqual(handoff?.content?.parts?.[0]?.functionCall?.args, { agent_name: 'generalist' });
    assert.equal(events.at(-1)?.author, 'generalist');
    assert.equal(events.at(-1)?.content?.parts?.[0]?.text, 'from memory');
    assert.deepEqual(
      ingests.map(({ context }) => context.agent),
      ['lead', 'generalist'],
    );
  });

  it('refuses a handoff to an agent the refused one cannot reach, rather than loop on it', async () => {
    const { pluginOptions } = await governed({ researcherBudget: 0 });
    const researcher = new LlmAgent({
      name: 'researcher',
      description: 'Looks things up.',
      model: new ScriptedLlm([text('the facts')]),
      disallowTransferToPeers: true,
      disallowTransferToParent: true,
    });
    const generalist = new LlmAgent({ name: 'generalist', description: 'Knows things.', model: new ScriptedLlm([]) });
    const lead = new LlmAgent({
      name: 'lead',
      model: new ScriptedLlm([call('transfer_to_agent', { agent_name: 'researcher' })]),
      instruction: 'Delegate.',
      subAgents: [researcher, generalist],
    });
    const plugin = new StiggAdkPlugin({ ...pluginOptions, onRefusal: () => ({ transferTo: 'generalist' }) });

    const { events } = await runTurn(lead, plugin);

    assert.match(events.at(-1)?.errorMessage ?? '', /cannot transfer to/);
  });

  it('makes a parallel branch wait for the usage another branch is still reporting', async () => {
    // One credit: the first call spends it, so both branches after it must be refused - including
    // the one whose check finds the first call's usage already being reported by the other.
    const { pluginOptions } = await governed({ leadBudget: 1 });
    // A slow network for the first call's ingest: a branch that does not wait for it checks the
    // balance from before it.
    class SlowIngest extends StiggAdkPlugin {
      constructor() {
        super(pluginOptions);
        const endModel = this.middleware.endModel.bind(this.middleware);
        this.middleware.endModel = async (...args) => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return endModel(...args);
        };
      }
    }
    const plugin = new SlowIngest();
    // What the plugin reads off ADK's context: the invocation, the agent, and the call's actions.
    const contextOf = () =>
      ({ invocationId: 'inv-1', agentName: 'lead', userId: 'user-1', actions: {} }) as unknown as Context;
    const llmRequest = { model: 'gemini-scripted' } as LlmRequest;

    const first = contextOf();
    assert.equal(await plugin.beforeModelCallback({ callbackContext: first, llmRequest }), undefined);
    // No finish reason, so the call stays open for the branches to report.
    const open = { ...text('one credit', 900, 100), finishReason: undefined };
    await plugin.afterModelCallback({ callbackContext: first, llmResponse: open });

    const branches = await Promise.all([
      plugin.beforeModelCallback({ callbackContext: contextOf(), llmRequest }),
      plugin.beforeModelCallback({ callbackContext: contextOf(), llmRequest }),
    ]);

    assert.deepEqual(
      branches.map((answer) => answer?.errorCode),
      [DENIED_ERROR_CODE, DENIED_ERROR_CODE],
      'neither branch is checked against the balance from before the first call',
    );
  });

  it("makes a parallel branch wait for a tool's usage another branch is still reporting", async () => {
    // One credit: the search spends it, so the branch checking while it is reported must be refused.
    const { pluginOptions } = await governed({ leadBudget: 1 });
    class SlowToolIngest extends StiggAdkPlugin {
      constructor() {
        super(pluginOptions);
        const endTool = this.middleware.endTool.bind(this.middleware);
        this.middleware.endTool = async (...args) => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return endTool(...args);
        };
      }
    }
    const plugin = new SlowToolIngest();
    const context = (extra: Record<string, unknown> = {}) =>
      ({ invocationId: 'inv-1', agentName: 'lead', userId: 'user-1', actions: {}, ...extra }) as unknown as Context;
    const search = webSearch();
    const toolContext = context({ functionCallId: 'c1' });

    assert.equal(await plugin.beforeToolCallback({ tool: search, toolArgs: {}, toolContext }), undefined);
    const [, branch] = await Promise.all([
      plugin.afterToolCallback({ tool: search, toolArgs: {}, toolContext, result: { hits: 3 } }),
      // The other branch checks once the search's report has started.
      new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
        plugin.beforeModelCallback({ callbackContext: context(), llmRequest: { model: 'm' } as LlmRequest }),
      ),
    ]);

    assert.equal(branch?.errorCode, DENIED_ERROR_CODE);
  });

  it('reports a streamed call once, by its last running total', async () => {
    const { stigg, pluginOptions, ingests } = await governed();
    const stream: LlmResponse[] = [
      { content: { role: 'model', parts: [{ text: 'he' }] }, usageMetadata: usage(900, 400), partial: true },
      { content: { role: 'model', parts: [{ text: 'llo' }] }, usageMetadata: usage(900, 800), partial: true },
      { ...text('hello', 900, 1_100), partial: false },
    ];
    const lead = new LlmAgent({ name: 'lead', model: new ScriptedLlm([stream]), instruction: 'Answer.' });

    const { error } = await runTurn(lead, new StiggAdkPlugin(pluginOptions), { streaming: true });
    await stigg.flush();

    assert.equal(error, undefined);
    assert.equal(ingests.length, 1);
    assert.deepEqual(ingests[0]!.result.reported, { credits: 2 });
  });

  it('passes each model step its model, for a budget per model', async () => {
    const { stigg, pluginOptions } = await governed();
    const seen: (string | undefined)[] = [];
    const plugin = new StiggAdkPlugin({
      ...pluginOptions,
      stepContext: (step) => {
        seen.push(step.model);
        return { customerId: CUSTOMER };
      },
    });
    const lead = new LlmAgent({ name: 'lead', model: new ScriptedLlm([text('hi')]), instruction: 'Answer.' });

    await runTurn(lead, plugin);
    await stigg.flush();

    assert.deepEqual(seen, ['gemini-scripted']);
  });
  it('reports the answer when the caller stops reading at it', async () => {
    const { stigg, pluginOptions, ingests } = await governed();
    const lead = new LlmAgent({ name: 'lead', model: new ScriptedLlm([text('the answer')]), instruction: 'Answer.' });

    await runTurn(lead, new StiggAdkPlugin(pluginOptions), { until: (event) => !!event.content?.parts?.[0]?.text });
    await stigg.flush();

    assert.deepEqual(
      ingests.map(({ result }) => result.reported),
      [{ credits: 1 }],
    );
  });

  it('reports the answer when the caller aborts the run at it', async () => {
    const { stigg, pluginOptions, ingests } = await governed();
    const lead = new LlmAgent({ name: 'lead', model: new ScriptedLlm([text('the answer')]), instruction: 'Answer.' });

    await runTurn(lead, new StiggAdkPlugin(pluginOptions), {
      until: (event, abort) => {
        if (event.content?.parts?.[0]?.text) abort();
        return false;
      },
    });
    await stigg.flush();

    assert.equal(ingests.length, 1);
  });

  it('reports a streamed call that asks for a tool once, by its final total, and never an unpriced tool', async () => {
    const { stigg, pluginOptions, ingests } = await governed();
    let looked = false;
    const lookup = new FunctionTool({ name: 'lookup', description: 'Looks up.', execute: async () => (looked = true) });
    const stream: LlmResponse[] = [
      // ADK runs the tool here, mid-stream: this response is not the call's last.
      {
        content: { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'lookup', args: {} } }] },
        usageMetadata: usage(900, 300),
      },
      { ...text('looking it up', 900, 1_100), partial: false },
    ];
    const lead = new LlmAgent({
      name: 'lead',
      model: new ScriptedLlm([stream]),
      instruction: 'Answer.',
      tools: [lookup],
    });

    const { error } = await runTurn(lead, new StiggAdkPlugin(pluginOptions), { streaming: true });
    await stigg.flush();

    assert.equal(error, undefined);
    assert.equal(looked, true);
    assert.deepEqual(
      ingests.map(({ result }) => result.reported),
      [{ credits: 2 }],
      'the streamed call by its final total, not by the response that asked for the tool - and no tool',
    );
  });

  it('reports nothing for a model call that failed after it began answering', async () => {
    const { stigg, pluginOptions, ingests } = await governed();
    const stream = [
      { content: { role: 'model', parts: [{ text: 'hal' }] }, usageMetadata: usage(900, 400), partial: true },
      new Error('stream broke'),
    ];
    const lead = new LlmAgent({ name: 'lead', model: new ScriptedLlm([stream]), instruction: 'Answer.' });

    await runTurn(lead, new StiggAdkPlugin(pluginOptions), { streaming: true });
    await stigg.flush();

    assert.equal(ingests.length, 0);
  });

  it('hands a refused turn off at most once per agent, so two refused agents cannot loop', async () => {
    const { pluginOptions, mock } = await governed({ researcherBudget: 0 });
    seedBudget(mock.state, CUSTOMER, { entityId: 'agent-3', capabilityId: 'credits', usageLimit: 0 });
    const researcher = new LlmAgent({ name: 'researcher', description: 'Looks up.', model: new ScriptedLlm([]) });
    const generalist = new LlmAgent({ name: 'generalist', description: 'Knows.', model: new ScriptedLlm([]) });
    const lead = new LlmAgent({
      name: 'lead',
      model: new ScriptedLlm([call('transfer_to_agent', { agent_name: 'researcher' })]),
      instruction: 'Delegate.',
      subAgents: [researcher, generalist],
    });
    const plugin = new StiggAdkPlugin({
      ...pluginOptions,
      agents: { ...pluginOptions.agents, generalist: { stiggContext: { agentId: 'agent-3' } } },
      onRefusal: ({ agent }) => ({ transferTo: agent === 'researcher' ? 'generalist' : 'researcher' }),
    });

    const { events, error } = await runTurn(lead, plugin);

    assert.equal(error, undefined);
    const handoffs = events.filter((event) => event.content?.parts?.[0]?.functionCall?.name === 'transfer_to_agent');
    assert.deepEqual(
      handoffs.map((event) => [event.author, event.content?.parts?.[0]?.functionCall?.args?.agent_name]),
      [
        ['lead', 'researcher'],
        ['researcher', 'generalist'],
        ['generalist', 'researcher'],
      ],
    );
    assert.equal(events.at(-1)?.author, 'researcher');
    assert.equal(events.at(-1)?.errorCode, DENIED_ERROR_CODE, 'the second refusal ends the turn');
  });

  it('answers a refused model call with the response `onRefusal` returns, keeping its own metadata', async () => {
    const { pluginOptions } = await governed({ leadBudget: 0 });
    const model = new ScriptedLlm([text('hi')]);
    const lead = new LlmAgent({ name: 'lead', model, instruction: 'Answer.' });
    const plugin = new StiggAdkPlugin({
      ...pluginOptions,
      onRefusal: () => ({
        content: { role: 'model', parts: [{ text: 'out of budget' }] },
        customMetadata: { mine: 1 },
      }),
    });

    const { events } = await runTurn(lead, plugin);

    const answer = events.at(-1)!;
    assert.equal(answer.content?.parts?.[0]?.text, 'out of budget');
    assert.equal(answer.customMetadata?.mine, 1);
    assert.equal(plugin.denialOf(answer)?.deniedBy, 'agent-1');
    assert.equal(model.calls, 0);
  });

  it("never checks ADK's own control tools, even under `'*'`", async () => {
    // One credit: the first call spends it, so a checked `exit_loop` would be refused.
    const { stigg, pluginOptions, decisions } = await governed({ leadBudget: 1 });
    const lead = new LlmAgent({
      name: 'lead',
      model: new ScriptedLlm([call('exit_loop')]),
      instruction: 'Stop.',
      tools: [new ExitLoopTool()],
    });

    const { events } = await runTurn(lead, new StiggAdkPlugin({ ...pluginOptions, tools: { '*': credits } }));
    await stigg.flush();

    assert.ok(
      events.some((event) => event.actions?.escalate),
      'exit_loop ran',
    );
    assert.ok(decisions.every(({ context }) => context.tool === undefined));
  });

  it('warns once that an AgentTool is not governed', async () => {
    const { stigg, pluginOptions, warnings } = await governed();
    const helper = new LlmAgent({ name: 'helper', description: 'Helps.', model: new ScriptedLlm([text('help')]) });
    const lead = new LlmAgent({
      name: 'lead',
      model: new ScriptedLlm([call('helper', { request: 'help' })]),
      instruction: 'Ask the helper.',
      tools: [new AgentTool({ agent: helper })],
    });

    await runTurn(lead, new StiggAdkPlugin(pluginOptions));
    await stigg.flush();

    assert.equal(warnings.filter((warning) => /AgentTool/.test(warning)).length, 1);
  });

  it('warns when another plugin comes before it', async () => {
    const { stigg, pluginOptions, warnings } = await governed();
    const lead = new LlmAgent({ name: 'lead', model: new ScriptedLlm([text('hi')]), instruction: 'Answer.' });
    class Other extends BasePlugin {}

    await runTurn(lead, [new Other('other'), new StiggAdkPlugin(pluginOptions)]);
    await stigg.flush();

    assert.equal(warnings.filter((warning) => /first/.test(warning)).length, 1);
  });

  it('does not warn when it is listed first', async () => {
    const { stigg, pluginOptions, warnings } = await governed();
    const lead = new LlmAgent({ name: 'lead', model: new ScriptedLlm([text('hi')]), instruction: 'Answer.' });
    class Other extends BasePlugin {}

    await runTurn(lead, [new StiggAdkPlugin(pluginOptions), new Other('other')]);
    await stigg.flush();

    assert.deepEqual(
      warnings.filter((warning) => /first/.test(warning)),
      [],
    );
  });
});
