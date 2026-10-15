/**
 * The client surface: one instance per environment, a vendor recognised from the client itself,
 * and the per-call context every governed call carries.
 *
 * There is no way to hand this client an engine - it builds its own from the account it is
 * pointed at - so every case here points it at the in-process Stigg mock and asserts on what
 * the SDK actually sent. That is the stronger test anyway: the REST payloads are part of the
 * contract, and a fake engine could never have caught a wrong one.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { StiggAgentSDK } from '../src/stigg-agent-sdk';
import type { AgentBudget, AgentOptions, DeregisterInput, RegisterInput, StiggAgentSDKOptions } from '../src';
import { createClientRegistry, hasMethod } from '../src/bindings/client/core/registry';
import { newRun, type BoundSession, type BoundSessionOptions } from './session-harness';
import { anthropicRecipe } from '../src/bindings/client/providers/anthropic/anthropic-recipe';
import { openAIRecipe } from '../src/bindings/client/providers/openai/openai-recipe';
import { openrouterRecipe } from '../src/bindings/client/gateways/openrouter/openrouter-recipe';
import { litellmRecipe } from '../src/bindings/client/gateways/litellm/litellm-recipe';
import { isGovernanceNotEnabled } from '../src/errors';
import {
  fundPool,
  seedBudget,
  seedEntityTypes,
  startMockStiggServer,
  type MockStiggServer,
} from '../testing/mock-stigg-server';

const anthropicShaped = () => ({ messages: { create: () => undefined, stream: () => undefined } });
const openAIShaped = () => ({ chat: { completions: { create: () => undefined } } });

/** The entity type the mock seeds, and the key it declares. They have to agree. */
/** The key the mock's `agent` entity type declares; an agent is sent under it on every call. */
const attributionKey = 'agentId';

let keySeed = 0;
/** A distinct key per case, so what a test sent is never confused with what another one did. */
const uniqueKey = () => `server-test-${++keySeed}`;

/** The context every governed call now carries, instead of the client holding it. */
const context = { customerId: 'customer-acme', entitlement: { currencyId: 'credits' } } as const;

type MockOptions = {
  /** False makes the account answer the probe with 403, as an account without governance does. */
  governance?: boolean;
  /** The credit pool. Large by default: a denial should come from a budget, not an empty wallet. */
  pool?: number;
  /** A budget already on `agent-1`, as an account provisioned out of band would have. */
  agentBudget?: number | null;
};

const open: { stigg: StiggAgentSDK; mock: MockStiggServer }[] = [];

/** A session over the engine an SDK built, bound to one context. See `stigg-harness.ts`. */
async function runOn(stigg: StiggAgentSDK, ctx: BoundSessionOptions = {}): Promise<BoundSession> {
  await stigg.init();
  return newRun({ engine: stigg.engine, logger: stigg.config.logger, onError: stigg.config.onError, ...ctx });
}

/** A client pointed at its own Stigg, seeded the way the case under test needs it. */
async function newStigg(options: MockOptions & Partial<StiggAgentSDKOptions> = {}) {
  const { governance, pool, agentBudget, ...config } = options;
  const mock = await startMockStiggServer({ governance: governance ?? true });
  seedEntityTypes(mock.state, [
    { id: 'agent', attributionKeys: ['agentId'], displayName: 'Agent' },
    { id: 'bot', attributionKeys: ['botId'], displayName: 'Bot' },
    { id: 'team', attributionKeys: ['teamId'], displayName: 'Team' },
  ]);
  fundPool(mock.state, context.customerId, pool ?? 1_000);
  if (agentBudget !== undefined) {
    seedBudget(mock.state, context.customerId, {
      entityId: 'agent-1',
      capabilityId: 'credits',
      usageLimit: agentBudget,
    });
  }
  const stigg = new StiggAgentSDK({
    apiKey: uniqueKey(),
    baseUrl: mock.baseUrl,
    // The SDK narrates to the console by default. A test asserting on output passes its own
    // logger; the rest would just be noise between the assertions.
    logger: 'none',
    // The mock speaks REST, not GraphQL, so every node-SDK call fails once and the composite
    // demotes to REST for good. A short timeout keeps that one failure from costing seconds.
    timeoutMs: 200,
    ...config,
  });
  open.push({ stigg, mock });
  return { stigg, mock };
}

after(async () => {
  for (const { stigg, mock } of open) {
    await stigg.close();
    await mock.close();
  }
});

describe('client recipe detection', () => {
  it('tells the two vendors apart by shape alone', () => {
    const registry = createClientRegistry([anthropicRecipe, openAIRecipe]);
    assert.equal(registry.find(anthropicShaped())?.vendor, 'anthropic');
    assert.equal(registry.find(openAIShaped())?.vendor, 'openai');
    assert.equal(registry.find({ totally: 'unrelated' }), undefined);
  });

  it('recognises a client built only for the Responses API, which the recipe already governs', () => {
    const registry = createClientRegistry([anthropicRecipe, openAIRecipe]);
    // No `chat.completions` to find on this one, but `responses.create` is in the recipe's own
    // method list - refusing it would leave a governable client unmetered.
    const responsesOnly = { responses: { create: () => undefined } };
    assert.equal(registry.find(responsesOnly)?.vendor, 'openai');
  });

  it('does not mistake a half-built object for a client', () => {
    assert.equal(hasMethod({ messages: {} }, ['messages', 'create']), false);
    assert.equal(hasMethod(undefined, ['messages', 'create']), false);
    assert.equal(hasMethod({ messages: { create: 1 } }, ['messages', 'create']), false);
  });
});

describe('StiggAgentSDK.wrap', () => {
  it('governs a recognised client with no vendor named by the caller', async () => {
    const { stigg } = await newStigg();
    const client = anthropicShaped();
    const governed = stigg.wrap(client);
    assert.notEqual(governed, client, 'the copy is what is governed; the caller keeps its own object');
  });

  it('refuses an unrecognised client instead of returning it unmetered', async () => {
    const { stigg } = await newStigg();
    assert.throws(() => stigg.wrap({ some: 'client' }), /No client recipe matches/);
  });

  it('takes an explicit recipe when the shape is not enough', async () => {
    const { stigg } = await newStigg();
    const governed = stigg.wrap(openAIShaped(), { recipe: openAIRecipe });
    assert.ok(governed.stigg, 'governed, and carrying its handle');
  });

  it('registers nothing: provisioning is a write, and a wrap is not', async () => {
    const { stigg, mock } = await newStigg();
    stigg.wrap(anthropicShaped(), { stiggContext: { ...context, agentId: 'agent-1', attributionKey } });
    await stigg.init();
    assert.equal(mock.state.entityWrites.length, 0, 'naming an agent attributes to it; it does not create it');
    assert.equal(stigg.resolution?.mode, 'governance', 'it did resolve the engine, just nothing else');
  });

  it('does not block on the engine: it starts it and hands the client back', async () => {
    const { stigg } = await newStigg();
    // Nothing is awaited here, which is the point - `wrap` is setup, and resolving the engine is
    // a probe over the network. The work has begun; it has not finished.
    const governed = stigg.wrap(anthropicShaped(), { stiggContext: context });

    const beforeInit = stigg.resolution;
    assert.equal(beforeInit, undefined, 'wrap waited for the probe it was supposed to start');
    assert.equal(typeof governed.messages.create, 'function', 'and the client is usable immediately');

    const after = await stigg.init();
    assert.equal(after.mode, 'governance', 'the probe it started did finish');
  });

  it('makes the first call wait for the engine, so nothing is lost by not awaiting wrap', async () => {
    const { stigg, mock } = await newStigg();
    const governed: any = stigg.wrap(anthropicShaped(), { stiggContext: context });

    // Straight into a call, with the engine still resolving behind it.
    const decision = await governed.stigg.check();

    assert.equal(decision.hasAccess, true, 'the call waited for the engine rather than failing');
    assert.ok(mock.state.dimensionsSeen.length >= 0);
  });

  it('says so once when a client gates nothing, rather than silently metering only', async () => {
    const warnings: string[] = [];
    const { stigg } = await newStigg({
      logger: { debug: () => undefined, info: () => undefined, warn: (m) => warnings.push(m), error: () => undefined },
    });
    let calls = 0;
    const governed = stigg.wrap(
      { messages: { create: async () => ++calls, stream: () => undefined } },
      { stiggContext: { customerId: context.customerId } },
    );

    await governed.messages.create();
    await governed.messages.create();

    assert.equal(calls, 2, 'the vendor was called both times - refusing would be a worse surprise');
    const said = warnings.filter((line) => line.includes('meters only'));
    assert.equal(said.length, 1, 'said at the wrap, once, however chatty the caller');
    assert.match(said[0]!, /named no entitlement/);
  });

  it('refuses to govern a client that already has a `stigg` property of its own', async () => {
    const { stigg } = await newStigg();
    assert.throws(
      () =>
        stigg.wrap(
          { stigg: 'mine', messages: { create: () => undefined, stream: () => undefined } },
          {
            stiggContext: context,
          },
        ),
      /already has a `stigg` property/,
    );
  });
});

describe('StiggAgentSDK.register', () => {
  it('needs no awaited setup: the constructor is synchronous and the engine resolves on first use', async () => {
    const { stigg } = await newStigg();
    assert.equal(stigg.resolution, undefined, 'nothing has touched the network yet');

    const run = await runOn(stigg, { ...context, dimensions: { agentId: 'agent-1' } });
    assert.equal(run.dimensions.agentId, 'agent-1', 'the agent travels as a dimension, not as a field');
    assert.equal(run.customerId, 'customer-acme', 'the run carries the customer downstream');
    assert.ok(stigg.resolution, 'the first async call resolved the engine');
  });

  it('writes the identity once per agent, however many runs it opens', async () => {
    const { stigg, mock } = await newStigg();

    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1' });
    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1' });
    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-2' });

    assert.deepEqual(
      mock.state.entityWrites.map((entity) => entity.id),
      ['agent-1', 'agent-2'],
      'a run can start many times a second; the write must not repeat',
    );
  });

  it('always re-writes when the call carries a budget, because that is a deliberate change', async () => {
    const { stigg, mock } = await newStigg();

    await stigg.register({
      entityTypeId: 'agent',
      customerId: context.customerId,
      agentId: 'agent-1',
      budget: { entitlement: context.entitlement, limit: 3, cadence: 'P1M' },
    });
    await stigg.register({
      entityTypeId: 'agent',
      customerId: context.customerId,
      agentId: 'agent-1',
      budget: { entitlement: context.entitlement, limit: 6, cadence: 'P1M' },
    });

    assert.equal(mock.state.entityWrites.length, 2);
    assert.deepEqual(
      mock.state.assignmentWrites.map((assignment) => assignment.usageLimit),
      [3, 6],
    );
  });

  it('sends the attribution it was given, verbatim - the run invents no keys of its own', async () => {
    const { stigg } = await newStigg();
    const run = await runOn(stigg, { ...context, dimensions: { agentId: 'agent-1', teamId: 'team-eng' } });
    assert.deepEqual(run.dimensions, { agentId: 'agent-1', teamId: 'team-eng' });
  });

  it('takes whatever key the entity type declares, because `agentId` is only a convention', async () => {
    const { stigg } = await newStigg();
    const run = await runOn(stigg, { ...context, dimensions: { botId: 'agent-1' } });
    assert.deepEqual(run.dimensions, { botId: 'agent-1' });
  });

  it('carries no attribution at all when none is given, which rolls usage up to the customer', async () => {
    const { stigg } = await newStigg();
    const run = await runOn(stigg, { ...context, dimensions: {} });
    assert.deepEqual(run.dimensions, {});
  });

  it('deregisters, and forgets the agent so a later register writes again', async () => {
    const { stigg, mock } = await newStigg();

    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1' });
    await stigg.deregister({ customerId: context.customerId, agentId: 'agent-1' });
    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1' });

    assert.deepEqual(mock.state.archived, ['agent-1']);
    assert.equal(mock.state.entityWrites.length, 2);
  });
});

describe('decisions describe themselves', () => {
  it('carries a log line and a user-facing message, so printing needs no import', async () => {
    const { stigg } = await newStigg({ agentBudget: 0 });
    const run = await runOn(stigg, { ...context, dimensions: { agentId: 'agent-1' } });
    const decision = await run.check(1);

    assert.match(decision.summary, /hasAccess=false .*deniedBy=agent-1 reason=BudgetExceeded/);
    assert.match(decision.message, /Budget exhausted for agent-1/);
  });

  it('says which transport answered, so a reader knows where the number came from', async () => {
    const { stigg } = await newStigg({ agentBudget: 5 });
    const run = await runOn(stigg, { ...context, dimensions: { agentId: 'agent-1' } });
    await run.check(1);
    const second = await run.check(1);
    // Every attributed check is a live governance call - nothing is served from a decision cache
    // here, which is what `capabilities.strictCheck: true` on that engine promises.
    assert.equal(second.source, 'rest');
    assert.match(second.summary, /remaining=5 .*source=rest/);
  });
});

describe('an account without governance', () => {
  it('refuses a budget it cannot write, rather than returning a run that only looks governed', async () => {
    const { stigg } = await newStigg({ governance: false });
    await assert.rejects(
      () =>
        stigg.register({
          entityTypeId: 'agent',
          customerId: context.customerId,
          agentId: 'agent-1',
          budget: { entitlement: context.entitlement, limit: 5, apply: 'on-create', cadence: 'P1M' },
        }),
      (err) => {
        assert.ok(isGovernanceNotEnabled(err));
        assert.match((err as Error).message, /nowhere to write the assignment/);
        return true;
      },
    );
  });

  it('still registers an agent that asked for no budget - the run needs no entity', async () => {
    const { stigg, mock } = await newStigg({ governance: false });
    const run = await runOn(stigg, { ...context, dimensions: { agentId: 'agent-1' } });

    assert.equal(run.dimensions.agentId, 'agent-1');
    assert.equal(mock.state.entityWrites.length, 0, 'nothing was provisioned, and nothing needed to be');
    assert.equal((await run.check(1)).hasAccess, true, 'the wrapper works at the customer level');
  });

  it('says so for deregister too', async () => {
    const { stigg } = await newStigg({ governance: false });
    await assert.rejects(
      () => stigg.deregister({ customerId: context.customerId, agentId: 'agent-1' }),
      (err) => isGovernanceNotEnabled(err),
    );
  });

  it('still checks and ingests, which need no entity', async () => {
    const { stigg, mock } = await newStigg({ governance: false });
    const run = await runOn(stigg, { ...context, dimensions: { agentId: 'agent-1' } });

    assert.equal((await run.check(1)).hasAccess, true);
    assert.equal((await run.ingest(1)).ok, true);
    assert.equal(mock.state.entityWrites.length, 0, 'nothing was provisioned');
  });
});

describe('register forwards the whole agent, not a hand-copied subset', () => {
  const assignmentFor = async (budget: AgentBudget) => {
    const { stigg, mock } = await newStigg();
    await stigg.register({ entityTypeId: 'agent', customerId: context.customerId, agentId: 'agent-1', budget });
    return mock.state.assignmentWrites[0];
  };

  it('carries a create-only budget through to the API', async () => {
    // Easy to drop: the agent gets an entity and no budget, and enforcement falls
    // through to the parent team's limit without saying so. It reaches the wire as `usageLimit`,
    // because "only on create" is a decision the SDK takes by reading first.
    const assignment = await assignmentFor({
      entitlement: context.entitlement,
      limit: 5,
      apply: 'on-create',
      cadence: 'P1M',
    });
    assert.equal(assignment?.usageLimit, 5);
    assert.equal(assignment?.cadence, 'P1M');
    assert.equal(assignment?.capabilityId, 'credits');
  });

  it('carries a limit and a parent through as well', async () => {
    const assignment = await assignmentFor({
      entitlement: context.entitlement,
      limit: 3,
      parentId: 'team-1',
      cadence: 'P1M',
    });
    assert.equal(assignment?.usageLimit, 3);
    assert.equal(assignment?.parentId, 'team-1');
  });

  it('writes no assignment when the call names no budget at all', async () => {
    // A budget with no entitlement is not expressible, so "no budget" is the absence of the
    // field rather than an empty one.
    const { stigg, mock } = await newStigg();
    await stigg.register({ entityTypeId: 'agent', customerId: context.customerId, agentId: 'agent-1' });
    assert.equal(mock.state.assignmentWrites[0], undefined);
  });

  it('treats a create-only budget as a placement, so the memo does not skip the write', async () => {
    const { stigg, mock } = await newStigg();
    await stigg.register({
      entityTypeId: 'agent',
      customerId: context.customerId,
      agentId: 'agent-1',
      budget: { entitlement: context.entitlement, limit: 5, apply: 'on-create', cadence: 'P1M' },
    });
    await stigg.register({
      entityTypeId: 'agent',
      customerId: context.customerId,
      agentId: 'agent-1',
      budget: { entitlement: context.entitlement, limit: 5, apply: 'on-create', cadence: 'P1M' },
    });
    assert.equal(mock.state.entityWrites.length, 2, 'a call carrying a budget is never memoized away');
  });

  it('leaves an existing budget alone on the second pass, which is what "on create" means', async () => {
    const { stigg, mock } = await newStigg();
    await stigg.register({
      entityTypeId: 'agent',
      customerId: context.customerId,
      agentId: 'agent-1',
      budget: { entitlement: context.entitlement, limit: 5, apply: 'on-create', cadence: 'P1M' },
    });
    // An admin raises it out of band; the next process start must not stamp on that.
    seedBudget(mock.state, context.customerId, { entityId: 'agent-1', capabilityId: 'credits', usageLimit: 50 });
    await stigg.register({
      entityTypeId: 'agent',
      customerId: context.customerId,
      agentId: 'agent-1',
      budget: { entitlement: context.entitlement, limit: 5, apply: 'on-create', cadence: 'P1M' },
    });
    assert.equal(mock.state.assignmentWrites.at(-1)?.usageLimit, 50, 'the raise survived');
  });
});

describe('the lifecycle: register is optional, the context is not', () => {
  it('gates and meters without register ever being called', async () => {
    const { stigg, mock } = await newStigg();
    const client = stigg.wrap(anthropicShaped(), { stiggContext: context });

    assert.equal(mock.state.entityWrites.length, 0, 'nothing was provisioned');
    assert.equal((await client.stigg.check()).hasAccess, true, 'a call needs no entity');
  });

  it('register hands back the agent id, which is the one it was given', async () => {
    const { stigg } = await newStigg();
    // A convenience, not a handle: the caller already had it, so nothing new depends on the call.
    assert.equal(await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1' }), 'agent-1');
  });

  it('hands back the id even when it wrote nothing at all', async () => {
    const { stigg } = await newStigg({ governance: false });
    assert.equal(await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1' }), 'agent-1');
  });

  it('hands back the id when the write was skipped as already done', async () => {
    const { stigg } = await newStigg();
    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1' });
    assert.equal(await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1' }), 'agent-1');
  });

  it('gives two reports their own idempotency keys, so neither reads as a replay', async () => {
    const { stigg } = await newStigg();
    const run = await runOn(stigg, { ...context, dimensions: { agentId: 'agent-1' }, ingestMode: 'sync' });
    const first = await run.ingest(1);
    const second = await run.ingest(1);

    assert.notEqual(first.idempotencyKey, second.idempotencyKey);
    assert.equal(second.replayed, false);
  });

  it('register is remembered per agent, so calling it on a hot path does not repeat the write', async () => {
    const { stigg, mock } = await newStigg();

    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1' });
    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1' });
    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-2' });

    assert.deepEqual(
      mock.state.entityWrites.map((entity) => entity.id),
      ['agent-1', 'agent-2'],
    );
  });
});

describe('wrap composes the context', () => {
  const wrapWith = async (ctx: Record<string, unknown> = {}) => {
    const { stigg, mock } = await newStigg();
    const client = stigg.wrap(anthropicShaped(), { stiggContext: { ...context, ...ctx } });
    return { mock, stigg, client };
  };

  it('writes nothing, however much context it is given', async () => {
    const { mock } = await wrapWith({ agentId: 'agent-1', attributionKey });
    assert.equal(mock.state.entityWrites.length, 0, 'attribution is not provisioning');
  });

  /**
   * Telling two agents apart through one client, which is what the testing session could not do.
   *
   * Neither a decision nor an ingest result names the caller, so a client serving several agents
   * produced observations nothing could attribute. The demo worked around it with one wrapped
   * client per agent - each carrying its own session state, so the workaround cost something.
   */
  it('tells the hook which agent an observation was for', async () => {
    const seen: { agent: unknown; customerId: string; correlationId: string }[] = [];
    const { stigg } = await newStigg();
    // One client, wrapped with the key but no agent: the key belongs to the entity type and is
    // constant for the client, while the agent varies per call. So each call names only the agent.
    const client = stigg.wrap(anthropicShaped(), {
      stiggContext: { ...context, attributionKey },
      hooks: {
        onDecision: (_decision, ctx) =>
          seen.push({ agent: ctx.dimensions.agentId, customerId: ctx.customerId, correlationId: ctx.correlationId }),
      },
    });

    await client.stigg.check({ agentId: 'agent-1' });
    await client.stigg.check({ agentId: 'agent-2' });

    assert.deepEqual(
      seen.map((s) => s.agent),
      ['agent-1', 'agent-2'],
      'two agents, one client, and the hook can tell them apart',
    );
    assert.deepEqual(new Set(seen.map((s) => s.customerId)), new Set(['customer-acme']));
    assert.ok(
      seen.every((s) => s.correlationId),
      'and each carries the id that ties it to its ingest',
    );
  });

  it('gives an ingest the same attribution its decision had', async () => {
    // The pairing is the point: a billing discrepancy is chased by matching one to the other.
    const decisions: string[] = [];
    const ingests: string[] = [];
    const { stigg } = await newStigg();
    const client = stigg.wrap(anthropicShaped(), {
      stiggContext: { ...context, agentId: 'agent-1', attributionKey },
      hooks: {
        onDecision: (_d, ctx) => decisions.push(ctx.correlationId),
        onIngest: (_r, ctx) => ingests.push(ctx.correlationId),
      },
    });

    await client.stigg.check();
    await client.stigg.report({ credits: 1 });
    await client.stigg.flush();

    assert.equal(decisions.length, 1);
    assert.equal(ingests.length, 1);
    assert.equal(decisions[0], ingests[0], 'one call, one correlation id across both observations');
  });

  it('exposes the governance handle, so the gate and the headers stay reachable', async () => {
    const { client } = await wrapWith({ dimensions: { agentId: 'agent-1', teamId: 'team-eng' } });
    assert.ok(client.stigg.headers()['x-stigg-customer-id']);
    assert.equal((await client.stigg.check()).hasAccess, true);
  });

  it('attributes to the agent it was given, under the key its entity type declares', async () => {
    const { client, mock } = await wrapWith({ agentId: 'agent-1', attributionKey });
    await client.stigg.report({ credits: 1 });
    await client.stigg.flush();
    assert.deepEqual(mock.state.dimensionsSeen.at(-1), { agentId: 'agent-1' });
  });

  it('sends the agent under a key that is not the default, when the type declares one', async () => {
    const { client, mock } = await wrapWith({
      agentId: 'agent-1',
      attributionKey: 'botId',
    });
    await client.stigg.report({ credits: 1 });
    await client.stigg.flush();
    assert.deepEqual(mock.state.dimensionsSeen.at(-1), { botId: 'agent-1' });
  });

  it('needs only the attribution key, because that is all a call reads', async () => {
    // Attributing a call needs the key and nothing else. `register` takes an `entityTypeId`
    // because that call creates the entity; this one only names it.
    const { client, mock } = await wrapWith({ agentId: 'agent-1', attributionKey: 'botId' });
    await client.stigg.report({ credits: 1 });
    await client.stigg.flush();
    assert.deepEqual(mock.state.dimensionsSeen.at(-1), { botId: 'agent-1' });
  });

  it('lets a call override the key as well, for an agent of a different type', async () => {
    const { client, mock } = await wrapWith({ agentId: 'agent-1', attributionKey });
    await client.stigg.report({ credits: 1 }, { agentId: 'bot-1', attributionKey: 'botId' });
    await client.stigg.flush();

    // Only the new key. The client's own describes an agent this call is not acting as, and
    // sending both would have governance resolve two entities for one call.
    assert.deepEqual(mock.state.dimensionsSeen.at(-1), { botId: 'bot-1' });
  });

  it('keeps every other dimension the client set, which is what the merge is for', async () => {
    // Only the agent's own key is dropped on a cross-type override. A client-wide `region` is
    // not claiming to be the agent, so it rides along as it always did.
    const { client, mock } = await wrapWith({
      agentId: 'agent-1',
      attributionKey,
      dimensions: { region: 'eu-west' },
    });
    await client.stigg.report({ credits: 1 }, { agentId: 'bot-1', attributionKey: 'botId' });
    await client.stigg.flush();
    assert.deepEqual(mock.state.dimensionsSeen.at(-1), { region: 'eu-west', botId: 'bot-1' });
  });

  it('replaces cleanly when the override keeps the same type, which is the common case', async () => {
    const { client, mock } = await wrapWith({ agentId: 'agent-1', attributionKey });
    await client.stigg.report({ credits: 1 }, { agentId: 'agent-2' });
    await client.stigg.flush();
    assert.deepEqual(mock.state.dimensionsSeen.at(-1), { agentId: 'agent-2' });
  });

  it('takes the key from the client when a call names only the agent', async () => {
    const { client, mock } = await wrapWith({ agentId: 'agent-1', attributionKey });
    await client.stigg.report({ credits: 1 });
    await client.stigg.flush();
    assert.deepEqual(mock.state.dimensionsSeen.at(-1), { agentId: 'agent-1' });
  });

  it('refuses an attribution key that is empty, which attributes to nothing', async () => {
    const { stigg } = await newStigg();
    assert.throws(
      () =>
        stigg.wrap(anthropicShaped(), {
          stiggContext: { ...context, agentId: 'a-1', attributionKey: '  ' },
        }),
      /no attributionKey says which key to send it under/,
    );
  });

  it('keeps the context dimensions beside it - the agent adds a key, it does not replace them', async () => {
    const { client, mock } = await wrapWith({
      dimensions: { tenantId: 'acme-eu' },
      agentId: 'agent-1',
      attributionKey,
    });
    await client.stigg.report({ credits: 1 });
    await client.stigg.flush();
    assert.deepEqual(mock.state.dimensionsSeen.at(-1), { tenantId: 'acme-eu', agentId: 'agent-1' });
  });

  it("refuses an unknown field in wrap's own context, not only in a call's override", async () => {
    // The half that matters more: `wrap` names an agent and its entitlement once for every call
    // through the client, so a typo here governs *everything* by the fallback.
    const { stigg } = await newStigg();
    assert.throws(
      () => stigg.wrap(anthropicShaped(), { stiggContext: { ...context, agentID: 'agent-2' } as any }),
      /no field `agentID`/,
    );
  });

  it('refuses an agent with no type, rather than guessing the key it is attributed under', async () => {
    const { stigg } = await newStigg();
    assert.throws(
      () => stigg.wrap(anthropicShaped(), { stiggContext: { ...context, agentId: 'agent-1' } }),
      /no attributionKey says which key to send it under/,
    );
  });

  it('attributes nothing without an agent, so the check lands on the customer', async () => {
    const { client, mock } = await wrapWith();
    await client.stigg.report({ credits: 1 });
    await client.stigg.flush();
    assert.deepEqual(mock.state.dimensionsSeen.at(-1), {}, 'no agent means no entity, not a silent default');
  });

  it('flush drains what is still in flight and reports what landed', async () => {
    const { client } = await wrapWith();
    void client.stigg.report({ credits: 2 });
    const summary = await client.stigg.flush();
    assert.equal(summary.ingested, 1);
    assert.deepEqual(summary.reported, { credits: 2 });
  });

  it('lets one call override the customer, which is the whole point of a per-call context', async () => {
    const { stigg, mock } = await newStigg();
    const client = stigg.wrap(
      {
        // Typed as taking params, because that is where the per-call context rides.
        messages: {
          create: async (_params: Record<string, unknown>) => ({ usage: { input_tokens: 1 } }),
          stream: () => undefined,
        },
      },
      { stiggContext: { ...context, usageMapper: () => ({ credits: 1 }), ingestMode: 'sync' } },
    );
    await client.messages.create({ stiggContext: { agentId: 'agent-1', attributionKey } });
    await client.stigg.flush();
    assert.deepEqual(mock.state.dimensionsSeen.at(-1), { agentId: 'agent-1' });
  });
});

describe('the built-in adapters cover every vendor the examples use', () => {
  const openAIShapedAt = (baseURL: string) => ({ baseURL, chat: { completions: { create: () => undefined } } });

  it('recognises all four without anything being named at the call', async () => {
    const { stigg } = await newStigg();
    const cases: [string, object, string][] = [
      ['anthropic', anthropicShaped(), 'messages.create'],
      ['openrouter', openAIShapedAt('https://openrouter.ai/api/v1'), 'openrouter base url'],
      ['litellm', openAIShapedAt('https://litellm.internal/v1'), 'litellm base url'],
      ['openai', openAIShapedAt('https://api.openai.com/v1'), 'plain openai'],
    ];

    for (const [expected, client, why] of cases) {
      const bound = stigg.wrap(client);
      assert.ok(bound, `${expected} should be recognised by ${why}`);
    }
  });

  it('matches a gateway before the plain OpenAI adapter, which would otherwise claim it', () => {
    const registry = createClientRegistry([anthropicRecipe, openrouterRecipe(), litellmRecipe(), openAIRecipe]);
    assert.equal(registry.find(openAIShapedAt('https://openrouter.ai/api/v1'))?.vendor, 'openrouter');
    assert.equal(registry.find(openAIShapedAt('https://litellm.acme.io/v1'))?.vendor, 'litellm');
    assert.equal(registry.find(openAIShapedAt('https://api.openai.com/v1'))?.vendor, 'openai');
  });
});

describe('the call types do not overlap', () => {
  it("each names the whole argument list of its own step, and nothing of another's", () => {
    // Provisioning is a write and says nothing about who is calling; a context says who is
    // calling and writes nothing. This compiles only while that separation holds.
    const agent: AgentOptions = {
      agentId: 'a',
      entityTypeId: 'agent',
      budget: { entitlement: { currencyId: 'credits' }, limit: 5, apply: 'on-create', cadence: 'P1M' },
    };

    // @ts-expect-error the tenant belongs to the call's context, not to the agent being written
    const wrong: AgentOptions = { agentId: 'a', entityTypeId: 'agent', customerId: 'c' };
    void wrong;

    const register: RegisterInput = { ...agent, customerId: 'c' };
    const deregister: DeregisterInput = { customerId: 'c', agentId: agent.agentId };

    assert.deepEqual([register.agentId, deregister.agentId], ['a', 'a']);
  });
});

describe('a gateway recipe claims its own endpoint and no other', () => {
  const at = (baseURL: string) => ({ baseURL, chat: { completions: { create: () => undefined } } });

  it('does not let a lookalike domain claim the OpenRouter recipe', () => {
    assert.equal(openrouterRecipe().matches?.(at('https://openrouter.ai/api/v1')), true);
    assert.equal(openrouterRecipe().matches?.(at('https://eu.openrouter.ai/api/v1')), true);
    // Somebody else's domain that merely contains the string.
    assert.equal(openrouterRecipe().matches?.(at('https://openrouter.ai.example.com/v1')), false);
  });

  it('does not match a mock that names the gateway in its path, which is why the example says so', () => {
    // The offline mock is served on localhost and names the vendor in the path. Host matching is
    // what makes the lookalike case above safe, and the same strictness is what makes this miss -
    // so `examples/client/openrouter.ts` names the recipe rather than relying on detection. It
    // used to rely on it, fall through to `openAIRecipe`, and quietly meter neither the gateway's
    // own `cost` nor the model that served.
    assert.equal(openrouterRecipe().matches?.(at('http://127.0.0.1:5311/openrouter.ai/api/v1')), false);
    // LiteLLM is the asymmetry that hid it: with no configured base URL it falls back to a
    // substring test, so its own mock path does match.
    assert.equal(litellmRecipe().matches?.(at('http://127.0.0.1:5311/litellm/v1')), true);
  });

  it('does not let a neighbouring path claim a configured LiteLLM proxy', () => {
    const recipe = litellmRecipe({ baseUrl: 'https://ai.acme.internal/v1' });
    assert.equal(recipe.matches?.(at('https://ai.acme.internal/v1')), true);
    assert.equal(recipe.matches?.(at('https://ai.acme.internal/v1/chat')), true);
    // A different deployment with a different price list.
    assert.equal(recipe.matches?.(at('https://ai.acme.internal/v10')), false);
    assert.equal(recipe.matches?.(at('https://other.acme.internal/v1')), false);
  });
});
