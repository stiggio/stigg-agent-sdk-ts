/**
 * Two agents, one team, one budget between them.
 *
 * Every other example runs a single agent, which hides the thing governance is actually for: with
 * one agent `deniedBy` can only ever name that agent, and a budget shared with anybody is
 * indistinguishable from a budget of its own. This one runs two siblings under one team and
 * spends until the tree answers back, twice, for two different reasons:
 *
 *   1. The drafter exhausts its own cap. The reviewer, untouched, keeps working - per-entity
 *      budgets isolate siblings, which is why one runaway agent is not an outage.
 *   2. The reviewer then hits the *team's* cap, with most of its own budget unspent. `deniedBy`
 *      names the team, because the binding constraint is whichever runs out first - and that is
 *      exactly what `remaining` reports: the tightest bound across the pool and every node above.
 *
 * Nothing here is interactive, so it is also the one example a test can run end to end.
 *
 * Run:  yarn workspace @stigg/agent-sdk-js run example-two-agents
 */
import '../shared/load-env';
import Anthropic from '@anthropic-ai/sdk';
import { StiggAgentSDK, entitlementId, type AccessDecision, type WrappedClient } from '../../src';
import { maybeStartMockServer } from '../shared/mock-server';
import { maybeStartMockStiggServer } from '../shared/mock-stigg-server';
import { seedMock } from '../shared/setup-governance';
import { describeSetup, requireFixture, resolveDemoEnv } from '../shared/demo-env';
import { requireKey, resolveStiggEnv } from '../shared/stigg-env';
import { optionalEnv } from './core/vendor';

const MODEL = process.env.AGENT_SDK_ANTHROPIC_MODEL ?? 'claude-opus-5';
const PROMPT = 'Name one thing worth metering in an agent, in a few words.';

/**
 * Sized so both refusals happen, in order, within a handful of turns: one chat turn costs about
 * one credit under the demo rates. The drafter runs out first on its own cap; the team then runs
 * out while the reviewer still has budget left, which is the only way to see an ancestor deny.
 */
const TEAM_BUDGET = 8;
const DRAFTER_BUDGET = 3;
const REVIEWER_BUDGET = 10;
const TURNS = 24;

type Agent = {
  name: string;
  client: WrappedClient<Anthropic>;
  spent: number;
  /** Who refused it - absent when the refusal came from the error policy, which names nobody. */
  blockedBy?: string;
  /** Whether it was refused at all. Separate, because a policy denial has no entity to name. */
  blocked?: boolean;
};

const line = (agent: Agent, text: string): void => console.log(`  ${agent.name.padEnd(22)} ${text}`);

/** What a refusal is worth saying out loud: who stopped it, and what the caller should do. */
function reportDenial(agent: Agent, decision: AccessDecision): void {
  // Blocked either way; named only when an entity did it. A check that failed under
  // `checkErrorAction: 'deny'` is a refusal nobody signed, and reading `deniedBy` alone left the
  // agent looking runnable - so the loop kept calling it and reported it as still running.
  agent.blocked = true;
  agent.blockedBy = decision.deniedBy;
  const by = decision.deniedBy ? `by ${decision.deniedBy}` : 'by the check itself (it could not be made)';
  line(agent, `DENIED   ${by} - ${decision.reason} (remaining=${decision.remaining})`);
  line(agent, `         ${decision.message}`);
}

async function main(): Promise<void> {
  const apiKey = optionalEnv('AGENT_SDK_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY');
  // `env` is what any application has - which Stigg to talk to. `demoEnv` is what only a demo
  // reads from a file: the tenant, the agent, what to gate on.
  const env = resolveStiggEnv();
  const demoEnv = resolveDemoEnv(env);
  // The two fixtures this example IS. Its whole subject is an agent inside its own budget being
  // refused by the team above it, so without a parent and something to gate on there is nothing
  // to watch happen - better to say which variable is missing than to print a run that proves
  // nothing. The other examples are content without either.
  const team = requireFixture(
    demoEnv.teamId,
    'AGENT_SDK_DEMO_TEAM_ID',
    'this example is two agents sharing a parent budget, which needs that parent.',
  );
  const entitlement = requireFixture(
    demoEnv.entitlement,
    'AGENT_SDK_DEMO_CURRENCY_ID or AGENT_SDK_DEMO_FEATURE_ID',
    'budgets are assigned over an entitlement, and a run without one gates nothing.',
  );
  const mock = await maybeStartMockServer(apiKey);
  const stiggMock = await maybeStartMockStiggServer(env.offline);

  // The account's own setup: entity types, the parent team, a funded pool. The pool has to dwarf
  // the team's cap, or the first denial would come from an empty wallet and tell a different story.
  if (stiggMock) {
    await seedMock(demoEnv, stiggMock, {
      agents: [],
      teamLimit: TEAM_BUDGET,
      poolMin: TEAM_BUDGET * 20,
      log: () => undefined,
    });
  }
  console.log(`[governance] ${describeSetup(env, demoEnv)}`);

  // Nothing to turn off: both handles are attributed, so every check is a live governance call
  // and neither can serve itself a stale allow while the other empties the shared team budget.
  const stigg = stiggMock
    ? new StiggAgentSDK({ baseUrl: stiggMock.baseUrl })
    : new StiggAgentSDK({ apiKey: requireKey(env), baseUrl: env.baseUrl });
  const agentType = requireFixture(
    demoEnv.agentType,
    'AGENT_SDK_DEMO_ENTITY_TYPE_ID / AGENT_SDK_DEMO_ATTRIBUTION_KEY',
    'this example is about two agents sharing a team budget, and an agent needs an entity type ' +
      'to be attributed under.',
  );

  /** The agent, its budget, and its place in the tree - one write, before anything is governed. */
  const provision = (agentId: string, usageLimit: number) =>
    stigg.register({
      customerId: demoEnv.customerId,
      agentId,
      entityTypeId: agentType.entityTypeId,
      displayName: agentId,
      budget: {
        entitlement,
        // What makes these two siblings rather than two unrelated budgets.
        parentId: team,
        limit: usageLimit,
        cadence: 'P1M',
      },
    });

  /**
   * One governed client per agent, over its own Anthropic client.
   *
   * They could share one wrapped client and name the agent per call - the context travels with
   * each call, so that works - but then they would share a warm cache and a set of counters, and
   * this example is entirely about watching two budgets fall against each other. Separate wraps
   * keep `lastDecision` separate, which is the number it prints.
   */
  const anthropic = () => new Anthropic({ apiKey: apiKey ?? 'offline-mock', baseURL: mock?.baseUrl });
  const govern = async (agentId: string) =>
    stigg.wrap(anthropic(), {
      stiggContext: {
        customerId: demoEnv.customerId,
        agentId,
        attributionKey: agentType.attributionKey,
        entitlement,
        // The usage API rather than events, because this example is about budgets moving. Under
        // the default - events - whether anything is metered depends on meters configured in the
        // account, and the event API cannot answer whether they were; a demo that silently meters
        // nothing would show two agents happily running forever, the opposite of the point.
        ingestMode: 'sync',
        // Report against the thing the budgets are denominated in. Left to the default these would
        // report the vendor's own token names, and a budget assigned on the currency is not an
        // assignment on `input_tokens` - the team would drop out of the chain and its cap would
        // never bind.
        //
        // One turn, one credit, stated rather than derived: this example is about two siblings
        // sharing a parent's cap, and token-denominated prices would make the arithmetic below
        // depend on how long the canned replies happen to be. `unitsPerTokens` is the mapper for
        // real pricing - see the other examples - and it reports fractions, because the wallet
        // takes them.
        usageMapper: () => ({ [entitlementId(entitlement)]: 1 }),
      },
    });

  await provision('agent-drafter', DRAFTER_BUDGET);
  await provision('agent-reviewer', REVIEWER_BUDGET);

  const drafter: Agent = { name: 'agent-drafter', client: await govern('agent-drafter'), spent: 0 };
  const reviewer: Agent = { name: 'agent-reviewer', client: await govern('agent-reviewer'), spent: 0 };

  console.log(
    `\nteam ${team} limit=${TEAM_BUDGET}  |  ${drafter.name} limit=${DRAFTER_BUDGET}  |  ` +
      `${reviewer.name} limit=${REVIEWER_BUDGET}\n`,
  );

  let isolated = false;
  for (let turn = 1; turn <= TURNS; turn += 1) {
    // Alternating, so neither finishes before the other starts - the point is what they do to
    // each other's budget, which only shows while both are live.
    const agent = turn % 2 === 1 ? drafter : reviewer;
    if (agent.blocked) continue;

    try {
      await agent.client.messages.create({
        model: MODEL,
        max_tokens: 256,
        messages: [{ role: 'user', content: PROMPT }],
      });
      agent.spent += 1;
      // Ingest is fire-and-forget; the next check has to see this turn's spend to be the demo.
      await agent.client.stigg.flush();
      // `remaining` is the tightest bound across the pool and every node above this agent - so
      // once the team is the binding constraint, both siblings watch the same number fall.
      const left = agent.client.stigg.lastDecision?.remaining;
      line(agent, `ok       turn ${String(agent.spent).padStart(2)}  remaining=${left}`);
    } catch (err) {
      const decision = stigg.denial(err);
      if (!decision) throw err;
      reportDenial(agent, decision);
      // Recorded as it happens: by the end both are blocked, and "the other one kept going" is
      // only true at the moment the first one stopped.
      if (agent === drafter && !reviewer.blocked) isolated = true;
    }
  }

  console.log('');
  for (const agent of [drafter, reviewer]) {
    const verdict = agent.blocked
      ? `stopped ${agent.blockedBy ? `by ${agent.blockedBy}` : 'by a failed check'}`
      : 'still running';
    console.log(`[summary] ${agent.name.padEnd(22)} ${String(agent.spent).padStart(2)} turns, ${verdict}`);
  }
  // Derived, not asserted: a narrative printed regardless of what happened is how an example
  // starts lying the first time the numbers move.
  if (isolated) {
    console.log(
      `\n${drafter.name} hit its own cap while ${reviewer.name} kept working - sibling budgets are independent,\n` +
        'which is why one runaway agent is not an outage for the rest of the team.',
    );
  }
  if (reviewer.blockedBy === team) {
    console.log(
      `${reviewer.name} was then refused by ${team} with ${REVIEWER_BUDGET - reviewer.spent} of its own ` +
        `${REVIEWER_BUDGET} unspent:\nan ancestor running dry binds every agent beneath it, which is what ` +
        `\`remaining\` was counting down all along.`,
    );
  } else if (reviewer.blocked) {
    console.log(
      `\n${reviewer.name} was refused ${reviewer.blockedBy ? `by ${reviewer.blockedBy}` : 'by a check that failed'}, not by the team.`,
    );
  } else {
    console.log(`\nNeither agent reached the team's cap in ${TURNS} turns.`);
  }

  await drafter.client.stigg.flush();
  await reviewer.client.stigg.flush();
  await stigg.flush({ close: true });
  await mock?.close();
  await stiggMock?.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
