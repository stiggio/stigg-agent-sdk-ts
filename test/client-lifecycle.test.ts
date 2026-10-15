/**
 * The run lifecycle on the SDK: how one is constructed, and the three calls that need no vendor
 * client at all - register, run, deregister.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StiggAgentSDK } from '../src/stigg-agent-sdk';
import type { AgentBudget, AgentOptions, DeregisterInput, RegisterInput } from '../src';
import { isGovernanceNotEnabled } from '../src/errors';
import { noopLogger } from '../src/logger';
import { seedBudget } from '../testing/mock-stigg-server';
import { context, newStigg, runOn, uniqueKey } from './stigg-harness';

/** Runs `body` with `STIGG_SERVER_API_KEY` set to `value`, and puts the environment back after. */
async function withEnvKey(value: string | undefined, body: () => void | Promise<void>): Promise<void> {
  const before = process.env.STIGG_SERVER_API_KEY;
  if (value === undefined) delete process.env.STIGG_SERVER_API_KEY;
  else process.env.STIGG_SERVER_API_KEY = value;
  try {
    await body();
  } finally {
    if (before === undefined) delete process.env.STIGG_SERVER_API_KEY;
    else process.env.STIGG_SERVER_API_KEY = before;
  }
}

describe('new StiggAgentSDK', () => {
  it('builds an instance per call - there is no registry keyed on the API key', () => {
    const apiKey = uniqueKey();
    assert.notEqual(new StiggAgentSDK(apiKey), new StiggAgentSDK(apiKey));
  });

  it('falls back to STIGG_SERVER_API_KEY, so the smallest program passes nothing', async () => {
    await withEnvKey('server-from-env', () => {
      assert.equal(new StiggAgentSDK().config.apiKey, 'server-from-env');
    });
  });

  it('names the variable to set when there is no key anywhere', async () => {
    await withEnvKey(undefined, () => {
      assert.throws(() => new StiggAgentSDK(), /STIGG_SERVER_API_KEY/);
    });
  });

  it('takes a target with a baseUrl instead of a key, which is how the mock is reached', () => {
    const stigg = new StiggAgentSDK({ baseUrl: 'http://127.0.0.1:4010' });
    assert.equal(stigg.config.baseUrl, 'http://127.0.0.1:4010');
  });

  it('still reads STIGG_SERVER_API_KEY when a baseUrl is named, which self-hosting needs', async () => {
    // A URL says where to send traffic and nothing about who is sending it. Substituting the
    // keyless sentinel here 401'd every self-hosted deployment that kept its key in the
    // environment, with nothing in the config to say why.
    await withEnvKey('server-from-env', () => {
      assert.equal(new StiggAgentSDK({ baseUrl: 'https://stigg.internal' }).config.apiKey, 'server-from-env');
    });
  });

  it('falls back to a keyless sentinel only when there is no key anywhere', async () => {
    await withEnvKey(undefined, () => {
      // How the offline examples and the mock are reached. Nothing authenticates with it.
      assert.equal(new StiggAgentSDK({ baseUrl: 'http://127.0.0.1:4010' }).config.apiKey, 'offline-mock');
    });
  });

  it('prefers an explicit key over the environment, wherever it points', async () => {
    await withEnvKey('server-from-env', () => {
      const stigg = new StiggAgentSDK({ apiKey: 'server-explicit', baseUrl: 'https://stigg.internal' });
      assert.equal(stigg.config.apiKey, 'server-explicit');
    });
  });

  it('takes everything in one object, which is the whole of the surface', () => {
    const stigg = new StiggAgentSDK({
      apiKey: 'server-abc',
      baseUrl: 'https://stigg.internal',
      timeoutMs: 1_234,
      ingest: 'sync',
      checkErrorAction: 'deny',
      logger: 'none',
    });

    assert.equal(stigg.config.apiKey, 'server-abc');
    assert.equal(stigg.config.baseUrl, 'https://stigg.internal');
    assert.equal(stigg.config.timeoutMs, 1_234);
    assert.equal(stigg.config.ingest, 'sync');
    assert.equal(stigg.config.checkErrorAction, 'deny');
  });

  it('takes a key and nothing else, which is the shorthand worth keeping', () => {
    const stigg = new StiggAgentSDK('server-abc', { timeoutMs: 1_234 });
    assert.equal(stigg.config.apiKey, 'server-abc');
    assert.equal(stigg.config.timeoutMs, 1_234);
  });

  it('pairs a key with a baseUrl, for a self-hosted environment that wants both', () => {
    const stigg = new StiggAgentSDK({ apiKey: 'server-abc', baseUrl: 'https://stigg.internal' });
    assert.equal(stigg.config.apiKey, 'server-abc');
    assert.equal(stigg.config.baseUrl, 'https://stigg.internal');
  });

  it('says so rather than silently ignoring a cacheTtlMs nobody reads any more', () => {
    const warnings: string[] = [];
    const stigg = new StiggAgentSDK('server-abc', {
      cacheTtlMs: 5_000,
      logger: { ...noopLogger, warn: (line: string) => warnings.push(line) },
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cacheTtlMs is ignored/);
    assert.ok(!('cacheTtlMs' in stigg.config), 'nothing downstream should be able to read it');
  });

  it('refuses a client and cache options together, rather than ignoring one of them', () => {
    const client = {} as never;
    assert.throws(
      () => new StiggAgentSDK('server-abc', { client, cache: { offline: true } }),
      /Pass one: `client` for a client you own/,
    );
  });

  it('passes cache configuration through to the engine rather than reinventing it', () => {
    const redis = { host: 'redis', port: 6379, environmentPrefix: 'prod', ttl: -1 };
    const stigg = new StiggAgentSDK('server-abc', { cache: { redis } });
    assert.deepEqual(stigg.config.cache?.redis, redis);
  });

  it('validates the URL at construction, not three calls later', () => {
    assert.throws(() => new StiggAgentSDK({ apiKey: uniqueKey(), baseUrl: 'not-a-url' }));
  });
});

describe('hooks', () => {
  it('tells the run that asked, and only it', async () => {
    const seen: string[] = [];
    const { stigg } = await newStigg();
    const watched = await runOn(stigg, {
      ...context,
      dimensions: { agentId: 'agent-1' },
      hooks: { onDecision: (decision) => seen.push(decision.hasAccess ? 'allow' : 'deny') },
    });
    // A second session on the same engine: hooks belong to a session, so this one observes nothing.
    const quiet = await runOn(stigg, { ...context, dimensions: { agentId: 'agent-1' } });
    await watched.check(1);
    await quiet.check(1);

    assert.deepEqual(seen, ['allow'], 'one session checked, one decision');
    await Promise.all([watched.drain(), quiet.drain()]);
  });

  it('reports a throwing hook to onError instead of failing the run it was watching', async () => {
    const errors: string[] = [];
    const { stigg } = await newStigg({ onError: (error) => errors.push(error.message) });
    const run = await runOn(stigg, {
      ...context,
      dimensions: { agentId: 'agent-1' },
      hooks: {
        onDecision: () => {
          throw new Error('run hook blew up');
        },
      },
    });
    await run.check(1);

    assert.equal(errors.length, 1);
    assert.match(errors[0], /hook blew up/);
    await run.drain();
  });

  it('reports a rejecting hook too, rather than leaving it unhandled', async () => {
    const errors: string[] = [];
    const { stigg } = await newStigg({ onError: (error) => errors.push(error.message) });
    const run = await runOn(stigg, {
      ...context,
      dimensions: { agentId: 'agent-1' },
      hooks: { onDecision: () => Promise.reject(new Error('run hook blew up')) as unknown as void },
    });
    await run.check(1);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(errors.length, 1);
    assert.match(errors[0], /run hook blew up/);
    await run.drain();
  });

  it('defaults onError to a warning through the logger, so a failure is never silent', async () => {
    const warnings: string[] = [];
    const { stigg } = await newStigg({
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (message) => void warnings.push(message),
        error: () => undefined,
      },
    });
    const run = await runOn(stigg, {
      ...context,
      dimensions: { agentId: 'agent-1' },
      hooks: {
        onDecision: () => {
          throw new Error('run hook blew up');
        },
      },
    });
    await run.check(1);

    assert.ok(
      warnings.some((message) => /hook blew up/.test(message)),
      'the default onError routes through the logger',
    );
    await run.drain();
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

  it('refuses a seed with nothing to seed, which the types forbid and JS does not', async () => {
    const { stigg, mock } = await newStigg();
    await assert.rejects(
      () =>
        stigg.register({
          entityTypeId: 'agent',
          customerId: context.customerId,
          agentId: 'agent-1',
          // `apply: 'on-create'` with no `limit`: a type error, and reachable from JavaScript.
          budget: { entitlement: context.entitlement, apply: 'on-create', cadence: 'P1M' } as never,
        }),
      /no limit to seed/,
    );
    assert.deepEqual(mock.state.entityWrites, [], 'and nothing is created half-configured');
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

describe('the lifecycle: register is optional, the run is not', () => {
  it('checks and meters without register ever being called', async () => {
    const { stigg, mock } = await newStigg();

    const run = await runOn(stigg, context);

    assert.equal(mock.state.entityWrites.length, 0, 'nothing was provisioned');
    assert.equal((await run.check(1)).hasAccess, true, 'a run needs no entity');
    assert.equal((await run.ingest(1)).ok, true);
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

  it('gives two reports of the same metric their own idempotency keys', async () => {
    const { stigg } = await newStigg();
    const run = await runOn(stigg, { ...context, dimensions: { agentId: 'agent-1' }, ingestMode: 'sync' });
    const first = await run.ingest(1);
    const second = await run.ingest(1);

    assert.notEqual(first.idempotencyKey, second.idempotencyKey, 'or the second would read as a replay');
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

describe('the three call types do not overlap', () => {
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

    // The register call has no context to take the scope from, so it asks for it.
    const register: RegisterInput = { ...agent, customerId: 'c' };
    const deregister: DeregisterInput = { customerId: 'c', agentId: agent.agentId };

    assert.deepEqual([register.agentId, deregister.agentId], ['a', 'a']);
  });
});

/**
 * The budgets that cannot be expressed, which is why nothing checks for them at runtime.
 *
 * `budget` states its mode in one `apply` and requires its entitlement, so each of these is a
 * type error rather than a refusal three frames in. Compile-time assertions for that reason.
 */
describe('an illegal budget does not reach the runtime', () => {
  it('cannot ask for both budget modes at once', () => {
    void (() => {
      // @ts-expect-error `apply: 'on-create'` with a null limit: there is nothing to clear on an
      // agent being created, and the union says so.
      const seedNothing: AgentBudget = { entitlement: { currencyId: 'credits' }, limit: null, apply: 'on-create' };
      void seedNothing;
    });
    assert.ok(true);
  });

  it('cannot write a budget with nothing to write it against', () => {
    void (() => {
      // @ts-expect-error a budget is an assignment over (entity x entitlement), so the
      // entitlement is required: there is nowhere to write one that names none.
      const nowhere: AgentBudget = { limit: 3, cadence: 'P1M' };
      void nowhere;
    });
    assert.ok(true);
  });

  it('cannot place an agent in the tree without one either', () => {
    void (() => {
      // @ts-expect-error the hierarchy is per-entitlement, so a parent needs one as much as a
      // limit does.
      const rootless: AgentBudget = { parentId: 'team-eng' };
      void rootless;
    });
    assert.ok(true);
  });
});

describe('flush drains the clients that are still open', () => {
  it('drains what a wrapped client still has in flight', async () => {
    const { stigg } = await newStigg();
    const client = stigg.wrap(
      { messages: { create: async () => ({ usage: { input_tokens: 0 } }), stream: () => undefined } },
      { stiggContext: { ...context, usageMapper: () => ({ credits: 3 }) } },
    );
    void client.stigg.report({ credits: 3 });

    const summaries = await stigg.flush();
    assert.equal(summaries.length, 1, 'the one client this SDK handed out');
    assert.deepEqual(summaries[0]?.reported, { credits: 3 });
  });
});

describe('registering the same agent from several runs at once', () => {
  it('writes the identity once, which is what "remembered per process" has to mean on a cold start', async () => {
    const { stigg, mock } = await newStigg();
    // The memo cannot help here: nothing has landed yet when all five ask.
    await Promise.all(
      Array.from({ length: 5 }, () => stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1' })),
    );
    assert.equal(mock.state.entityWrites.length, 1);
  });

  it('still writes every call that carries a budget, because each is its own instruction', async () => {
    const { stigg, mock } = await newStigg();
    await Promise.all([
      stigg.register({
        entityTypeId: 'agent',
        customerId: context.customerId,
        agentId: 'agent-1',
        budget: { entitlement: context.entitlement, limit: 3, cadence: 'P1M' },
      }),
      stigg.register({
        entityTypeId: 'agent',
        customerId: context.customerId,
        agentId: 'agent-1',
        budget: { entitlement: context.entitlement, limit: 9, cadence: 'P1M' },
      }),
    ]);
    assert.equal(mock.state.entityWrites.length, 2, 'collapsing these would drop one of them silently');
  });

  it('lets a failed registration be retried rather than remembering it as done', async () => {
    const { stigg, mock } = await newStigg();
    await stigg.init();
    const engine = stigg.engine;
    const real = engine.upsertEntity.bind(engine);
    let failing = true;
    engine.upsertEntity = async (...args: Parameters<typeof real>) => {
      if (failing) throw new Error('the write never landed');
      return real(...args);
    };

    const attempts = await Promise.allSettled([
      stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1' }),
      stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1' }),
    ]);
    assert.deepEqual(
      attempts.map((a) => a.status),
      ['rejected', 'rejected'],
      'everyone sharing the write hears that it failed',
    );
    assert.equal(mock.state.entityWrites.length, 0);

    failing = false;
    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1' });
    assert.equal(mock.state.entityWrites.length, 1, 'the failure left nothing behind to skip the retry');
  });
});

describe('the memo remembers the agent, not just its name', () => {
  it('writes again when the same agent is described differently', async () => {
    const { stigg, mock } = await newStigg();
    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1', displayName: 'Support bot' });
    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1', displayName: 'Renamed bot' });
    assert.deepEqual(
      mock.state.entityWrites.map((e) => e.displayName),
      ['Support bot', 'Renamed bot'],
      'the second call asked for that name to be written',
    );
  });

  it('still writes once when nothing about the agent changed', async () => {
    const { stigg, mock } = await newStigg();
    const agent = { ...context, entityTypeId: 'agent', agentId: 'agent-1', displayName: 'Support bot' };
    await stigg.register(agent);
    await stigg.register(agent);
    assert.equal(mock.state.entityWrites.length, 1, 'the hot path is still a memo');
  });

  it('refuses an entitlement that names nothing where a budget would be written', async () => {
    const { stigg } = await newStigg();
    await assert.rejects(
      () =>
        stigg.register({
          entityTypeId: 'agent',
          customerId: context.customerId,
          agentId: 'agent-1',
          budget: { entitlement: { currencyId: '  ' }, limit: 3, cadence: 'P1M' },
        }),
      /non-empty currencyId or featureId/,
    );
  });
});

describe('a feature entitlement is not drawn from the credit wallet', () => {
  // Attributed, so the check takes the REST path - the one that knows about entities and chains.
  const attributed = { agentId: 'agent-1' };

  it('allows a feature check against an unfunded pool, which is where credits live', async () => {
    // The pool is funded for credit entitlements and left at zero otherwise, so gating a feature
    // check on it denied every feature-mode run offline.
    const { stigg, mock } = await newStigg({ pool: 0 });
    seedBudget(mock.state, context.customerId, { entityId: 'agent-1', capabilityId: 'tokens', usageLimit: 100 });
    const run = await runOn(stigg, {
      customerId: context.customerId,
      entitlement: { featureId: 'tokens' },
      dimensions: attributed,
    });
    const decision = await run.check(1);
    assert.equal(decision.hasAccess, true);
    await run.drain();
  });

  it('still denies a credit check when the wallet is empty', async () => {
    const { stigg } = await newStigg({ pool: 0 });
    const run = await runOn(stigg, { ...context, dimensions: attributed });
    const decision = await run.check(1);
    assert.equal(decision.hasAccess, false);
    assert.equal(decision.reason, 'InsufficientCredits');
    await run.drain();
  });
});

/**
 * There is one switch, and it is the entitlement. A run that names one is gated exactly as it
 * always was; a run that names none meters and cannot refuse anything. What matters below is that
 * the two are told apart by a field the caller already writes, that the quiet one says so out loud,
 * and that the cases where "no entitlement" would mean something incoherent - an empty id, a budget
 * written against nothing - still fail where they always did.
 */
describe('the entitlement is the enforcement switch, and there is no other one', () => {
  it('gates a run that names one, exactly as it always did', async () => {
    const { stigg } = await newStigg({ agentBudget: 0 });
    const run = await runOn(stigg, { ...context, dimensions: { agentId: 'agent-1' } });

    const decision = await run.check(1);
    assert.equal(decision.hasAccess, false);
    assert.equal(decision.deniedBy, 'agent-1');
  });

  it('meters a run that names none, and says so once through the logger', async () => {
    const warnings: string[] = [];
    const { stigg } = await newStigg({
      agentBudget: 0,
      logger: { debug: () => {}, info: () => {}, warn: (line) => warnings.push(line), error: () => {} },
    });
    const client = stigg.wrap(
      { messages: { create: async () => ({ usage: {} }), stream: () => undefined } },
      { stiggContext: { customerId: context.customerId, dimensions: { agentId: 'agent-1' } } },
    );

    assert.equal((await client.stigg.check()).hasAccess, true, 'a budget of zero refuses nothing here');
    const said = warnings.filter((line) => line.includes('meters only'));
    assert.equal(said.length, 1, 'once per client, at the boundary that owns the decision');
    assert.match(said[0]!, /named no entitlement.*currencyId: 'credits'/s, 'and it names the fix');
  });

  it('still refuses an entitlement that names nothing - an empty one bills against nothing', async () => {
    const { stigg } = await newStigg();
    await assert.rejects(
      () => runOn(stigg, { customerId: context.customerId, entitlement: { currencyId: '' } }),
      /non-empty currencyId or featureId/,
    );
  });

  it('still registers a bare agent on a metering-only run, because an identity needs no budget', async () => {
    const { stigg, mock } = await newStigg();
    const agentId = await stigg.register({ entityTypeId: 'agent', customerId: context.customerId, agentId: 'agent-1' });

    assert.equal(agentId, 'agent-1');
    assert.deepEqual(
      mock.state.entityWrites.map((entity) => entity.id),
      ['agent-1'],
    );
    assert.deepEqual(mock.state.assignmentWrites, [], 'nothing to assign, and nothing assigned');
  });

  /** What the grouped budget actually writes, for each of the shapes it can take. */
  describe('register takes the budget as one object', () => {
    it('writes the same assignment the flat fields did', async () => {
      const { stigg, mock } = await newStigg();
      await stigg.register({
        entityTypeId: 'agent',
        customerId: context.customerId,
        agentId: 'agent-1',
        budget: { entitlement: { currencyId: 'credits' }, limit: 5, cadence: 'P1M' },
      });

      const [assignment] = mock.state.assignmentWrites;
      assert.equal(assignment?.usageLimit, 5);
      assert.equal(assignment?.cadence, 'P1M');
    });

    it("seeds once under apply: 'on-create', which is what usageLimitOnCreate meant", async () => {
      const { stigg, mock } = await newStigg();
      const seed = {
        entityTypeId: 'agent' as const,
        customerId: context.customerId,
        agentId: 'agent-1',
        budget: { entitlement: { currencyId: 'credits' }, limit: 5, apply: 'on-create' as const, cadence: 'P1M' },
      };

      await stigg.register(seed);
      assert.equal(mock.state.assignmentWrites.at(-1)?.usageLimit, 5, 'the seed landed');

      // An admin raises it out of band. A second start must not stamp on that - which is the
      // whole difference between the two modes, and the only way to assert it.
      seedBudget(mock.state, context.customerId, { entityId: 'agent-1', capabilityId: 'credits', usageLimit: 50 });
      await stigg.register(seed);
      assert.equal(mock.state.assignmentWrites.at(-1)?.usageLimit, 50, 'the raise survived');
    });

    it("overwrites every time under the default apply: 'always'", async () => {
      const { stigg, mock } = await newStigg();
      const budget = { entitlement: { currencyId: 'credits' }, limit: 5, cadence: 'P1M' };
      const input = { entityTypeId: 'agent' as const, customerId: context.customerId, agentId: 'agent-1', budget };

      await stigg.register(input);
      seedBudget(mock.state, context.customerId, { entityId: 'agent-1', capabilityId: 'credits', usageLimit: 50 });
      await stigg.register(input);

      assert.equal(mock.state.assignmentWrites.at(-1)?.usageLimit, 5, 'the configured limit won, as it should');
    });

    it('clears a budget with a null limit, the way usageLimit: null did', async () => {
      const { stigg, mock } = await newStigg({ agentBudget: 5 });
      await stigg.register({
        entityTypeId: 'agent',
        customerId: context.customerId,
        agentId: 'agent-1',
        budget: { entitlement: { currencyId: 'credits' }, limit: null },
      });

      assert.equal(mock.state.assignmentWrites[0]?.usageLimit, null);
    });

    it('writes an identity and no assignment when no budget is named', async () => {
      const { stigg, mock } = await newStigg();
      await stigg.register({ entityTypeId: 'agent', customerId: context.customerId, agentId: 'agent-1' });

      assert.equal(mock.state.entityWrites.length, 1, 'the agent exists');
      assert.deepEqual(mock.state.assignmentWrites, [], 'and has no budget');
    });
  });

  it('writes the assignment against the run entitlement when there is one, unchanged', async () => {
    const { stigg, mock } = await newStigg();
    await stigg.register({
      entityTypeId: 'agent',
      customerId: context.customerId,
      agentId: 'agent-1',
      budget: { entitlement: context.entitlement, limit: 5, cadence: 'P1M' },
    });

    assert.deepEqual(
      mock.state.assignmentWrites.map((assignment) => assignment.usageLimit),
      [5],
    );
  });
});

describe('register validates before it reaches the network', () => {
  /**
   * A malformed call is a property of its arguments, so the answer does not depend on an account
   * being reachable. Pointed at a port with nothing behind it, the probe would fail - and if the
   * engine were built first, a typo would report itself as a transport timeout and send the
   * reader looking at the network for something they can see in their own code.
   */
  const unreachable = () =>
    // Reserved by RFC 5737 for documentation, so nothing answers and nothing is contacted.
    new StiggAgentSDK({ apiKey: uniqueKey(), baseUrl: 'http://192.0.2.1:9', logger: 'none' });

  it('names the empty entitlement rather than the unreachable account', async () => {
    await assert.rejects(
      unreachable().register({
        entityTypeId: 'agent',
        customerId: 'customer-acme',
        agentId: 'agent-1',
        budget: { entitlement: { currencyId: '' }, limit: 5 },
      }),
      /non-empty currencyId or featureId/,
    );
  });

  it('names an empty agentId the same way', async () => {
    await assert.rejects(
      unreachable().register({
        entityTypeId: 'agent',
        customerId: 'customer-acme',
        agentId: '  ',
        budget: { entitlement: { currencyId: 'credits' } },
      }),
      /register needs an agentId/,
    );
  });
});

describe('the registration memo', () => {
  /**
   * The memo exists so a registration repeated every run is written once. Metadata assembled by a
   * spread or `Object.fromEntries` has no guaranteed key order, so comparing the serialized object
   * would miss on the very calls the memo is for - the identical ones, arriving again.
   */
  it('treats the same metadata in a different order as the same description', async () => {
    const { stigg, mock } = await newStigg();
    const metadata = { team: 'research', tier: 'gold' };
    const reordered = { tier: 'gold', team: 'research' };

    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1', metadata });
    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1', metadata: reordered });

    assert.equal(mock.state.entityWrites.length, 1, 'the second call describes nothing new');
  });

  it('still writes when the description actually changes', async () => {
    const { stigg, mock } = await newStigg();
    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1', metadata: { tier: 'gold' } });
    await stigg.register({ entityTypeId: 'agent', ...context, agentId: 'agent-1', metadata: { tier: 'silver' } });

    assert.equal(mock.state.entityWrites.length, 2, 'a changed description has to reach the account');
  });
});

/**
 * `wrap` starts the engine probe and does not await it, so between a failing probe and the first
 * call there is a rejected promise nobody is holding. Node calls that an unhandled rejection and
 * ends the process over it - so an unreachable Stigg, or a bad key, would take the application
 * down at startup rather than failing the call that needed it.
 *
 * Marking it handled costs an awaiter nothing: attaching a handler does not consume a rejection,
 * so `init()` still rejects and the error policy still decides what a call does about it.
 */
describe('an engine that cannot start', () => {
  const unreachable = () => new StiggAgentSDK({ baseUrl: 'http://127.0.0.1:1' });

  it('does not take the process down when nothing is awaiting the probe', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (err: unknown) => rejections.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const stigg = unreachable();
      stigg.wrap({ messages: { create: async () => ({}), stream: () => ({}) } }, { stiggContext: {} } as never);
      // Long enough for the probe to fail and for Node to have flagged it. Short of that this
      // test passes against the bug it exists for, which is worse than not having it.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.deepEqual(rejections, [], 'a probe nobody awaited became an unhandled rejection');
      await stigg.close().catch(() => undefined);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('still reports the failure to anyone who asks for it', async () => {
    const stigg = unreachable();
    await assert.rejects(() => stigg.init(), /probe/);
    await stigg.close().catch(() => undefined);
  });
});
