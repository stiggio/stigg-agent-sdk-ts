/**
 * `demo.env` - the half of the environment **only a demo** reads.
 *
 * Which tenant, which agent, what to gate on. A real application knows its tenant from the request
 * it is serving, its agent from the code that spawned it, and what it bills against from its own
 * pricing - none of it from an env file. `stigg-env.ts` beside this holds the half that an
 * application does have: which Stigg to talk to.
 *
 * The examples keep both in scope, named `env` and `demoEnv`, so a reader can tell scaffolding
 * from real configuration at the call site.
 */
import type { EventIngest } from '../../src/engine/engine';
import type { Entitlement } from '../../src/types';
import { text, type StiggEnv } from './stigg-env';

/**
 * Both halves of an entity type, because these examples use both.
 *
 * A call reads `attributionKey` and nothing else - it is a field on `stiggContext` for exactly
 * that reason. `register` is what creates the entity, and that call takes its own `entityTypeId`.
 * The examples do both, so they carry both, and this is the pair that says so.
 */
type DemoAgentType = { attributionKey: string; entityTypeId: string };

export type DemoEnv = {
  /** The tenant. The one fixture with no meaningful absence: every call is scoped to a customer. */
  customerId: string;
  /** Parent of the agent. Unset: the agent is a root entity, and no ancestor budget binds it. */
  teamId?: string;
  /** Unset: no agent is registered, and a run spends the customer's own pool instead. */
  agentId?: string;
  /**
   * The entity type agents are registered and attributed as. Both halves or neither: the SDK has
   * no default for either, because a guessed attribution key resolves no entity and the spend
   * lands on the customer looking exactly like a call that was never governed.
   */
  agentType?: DemoAgentType;
  /**
   * What a run gates on. Unset is legal and means ungated: no check leaves the process, nothing
   * can be refused, and metering is unchanged - `RunOptions.entitlement` is itself the
   * enforcement switch, so an absent one is a configuration, not a missing value.
   */
  entitlement?: Entitlement;
  /** Overrides the event name a wrapped client would derive from the vendor call it gated. */
  ingestEventName?: EventIngest;
};

/**
 * A demo fixture: its compiled-in default, but only against the mock, and only when the variable
 * is absent rather than blank.
 *
 * Offline a default has nothing to get wrong - the mock is seeded from these same ids, so a fresh
 * clone with no `demo.demoEnv` still runs end to end. Against a real environment an invented id is
 * either some other tenant's data or a `customer-acme` nobody asked for, so there an absent
 * variable stays absent and each reader below decides what that costs it.
 *
 * Blank is the third state and means "none, deliberately": `AGENT_SDK_DEMO_AGENT_ID=` asks for a
 * run with no agent at all, which is how the customer-pool path stays runnable against the mock
 * instead of being only described in a comment. An absent variable cannot carry that meaning -
 * it is also what a fresh clone has.
 */
const fixture = (offline: boolean, variable: string, demo: string): string | undefined => {
  const raw = process.env[variable];
  if (raw === undefined) return offline ? demo : undefined;
  return text(raw);
};

function pickCustomerId(offline: boolean): string {
  const customerId = fixture(offline, 'AGENT_SDK_DEMO_CUSTOMER_ID', 'customer-acme');
  // Every other fixture degrades to a smaller demo when it is missing. This one cannot: a guessed
  // tenant would provision itself into whichever environment STIGG_SERVER_API_KEY points at.
  if (customerId) return customerId;
  throw new Error(
    'No AGENT_SDK_DEMO_CUSTOMER_ID - every governance call is scoped to a tenant, and the ' +
      'examples will not invent one for a real environment. Set it in examples/demo.env, or ' +
      'set AGENT_SDK_OFFLINE=1 to run against the built-in mock.',
  );
}

/**
 * The agent's entity type and the key it is identified under. Either, both, or neither.
 *
 * The two do have to agree - a run attributes by the key, so a type declaring a different one
 * resolves nothing and the spend lands on the customer, looking exactly like a run that was never
 * governed. But leaving one of them unset cannot break that agreement: the SDK and the seeding
 * script fall back to the same pair (DEFAULT_ENTITY_TYPE and DEFAULT_ATTRIBUTION_KEY in
 * src/stigg-agent-sdk.ts), so naming a type alone pairs it with `agentId` on both sides. That is
 * a working combination - metering a type of your own should not also require restating the
 * default key - so there is nothing to refuse here.
 *
 * What can still disagree is an entity type that already exists in the account under some other
 * attribution key. Two demoEnv vars cannot see that, so it is not something to guess at from here.
 */
function pickAgentType(offline: boolean): DemoAgentType | undefined {
  const entityTypeId = fixture(offline, 'AGENT_SDK_DEMO_ENTITY_TYPE_ID', 'agent');
  const attributionKey = fixture(offline, 'AGENT_SDK_DEMO_ATTRIBUTION_KEY', 'agentId');
  if (entityTypeId && attributionKey) return { entityTypeId, attributionKey };
  if (entityTypeId || attributionKey) {
    throw new Error(
      'AGENT_SDK_DEMO_ENTITY_TYPE_ID and AGENT_SDK_DEMO_ATTRIBUTION_KEY go together - an ' +
        'entity type and the key it identifies its agents under are one setting. Set both, or ' +
        'neither to run with no agent at all.',
    );
  }
  return undefined;
}

/**
 * What the examples gate on, if anything.
 *
 * Three outcomes, not two. A feature or a currency is an entitlement and the runs are gated.
 * **Neither is equally valid** and means ungated: `RunOptions.entitlement` is itself the
 * enforcement switch, so nothing is checked, nothing can be refused, and metering carries on - in
 * either mode, with or without a key. Only naming *both* is refused, because preferring the
 * feature silently would meter against something the configured currency says nothing about.
 */
function pickEntitlement(offline: boolean): Entitlement | undefined {
  const featureId = text(process.env.AGENT_SDK_DEMO_FEATURE_ID);
  const currencyId = featureId
    ? text(process.env.AGENT_SDK_DEMO_CURRENCY_ID)
    : fixture(offline, 'AGENT_SDK_DEMO_CURRENCY_ID', 'credits');

  if (featureId && currencyId) {
    throw new Error(
      'Both AGENT_SDK_DEMO_FEATURE_ID and AGENT_SDK_DEMO_CURRENCY_ID are set - an entitlement ' +
        'is either a metered feature or a credit currency, never both. Clear one of them, or ' +
        'clear both: a run with no entitlement meters without gating, which is a configuration ' +
        'rather than a missing value.',
    );
  }
  if (featureId) return { featureId };
  return currencyId ? { currencyId } : undefined;
}

/**
 * The fixtures, which only default while the examples are pointed at the mock - hence the `env`.
 * Against a real environment a guessed id is either another tenant's data or a customer nobody
 * asked for, so there an absent variable stays absent and each reader decides what that costs it.
 */
export function resolveDemoEnv({ offline }: StiggEnv): DemoEnv {
  return {
    customerId: pickCustomerId(offline),
    teamId: fixture(offline, 'AGENT_SDK_DEMO_TEAM_ID', 'team-research'),
    agentId: fixture(offline, 'AGENT_SDK_DEMO_AGENT_ID', 'agent-support-bot'),
    agentType: pickAgentType(offline),
    entitlement: pickEntitlement(offline),
    // Left unset, a wrapped client names its events after the vendor call it gated -
    // `anthropic.messages.create` - which is what a Stigg meter should filter on.
    ingestEventName: process.env.AGENT_SDK_DEMO_EVENT_NAME
      ? { name: process.env.AGENT_SDK_DEMO_EVENT_NAME }
      : undefined,
  };
}

/** The vendors the client examples cover; each registers its own agent. */
export const CLIENT_AGENT_SUFFIXES = ['anthropic', 'openai', 'gemini', 'openrouter', 'litellm'] as const;

/**
 * One Stigg agent per example, derived from the configured base id.
 *
 * They are separate entities on purpose: budgets attach to the agent, so sharing one would mean
 * running the OpenAI example spends what the Anthropic example had left. Separate agents also make
 * the governance tree worth reading - spend per vendor rather than one lump - while the shared
 * parent team keeps the ancestor rule demonstrable.
 */
export const agentIdFor = (demoEnv: DemoEnv, suffix?: string): string | undefined =>
  demoEnv.agentId && suffix ? `${demoEnv.agentId}-${suffix}` : demoEnv.agentId;

/** One line for the top of every example, so it is never a mystery what was just exercised. */
export function describeSetup(env: StiggEnv, demoEnv: DemoEnv): string {
  const where = env.offline ? 'in-process mock' : env.baseUrl;
  // Said out loud rather than left blank: a run with no entitlement is not a misconfigured run,
  // but it is also not enforcing anything, and that is the first thing to know about its output.
  const capability = !demoEnv.entitlement
    ? 'ungated (no entitlement - metering only)'
    : demoEnv.entitlement.currencyId
      ? `currency=${demoEnv.entitlement.currencyId}`
      : `feature=${demoEnv.entitlement.featureId}`;
  return `stigg=${where} customer=${demoEnv.customerId} ${capability}`;
}

/**
 * A fixture one example cannot do without, demanded where it is needed rather than at resolve
 * time. Most examples degrade perfectly well without these - a run with no agent bills the
 * customer, a run with no entitlement meters without gating - and failing all of them for the
 * sake of the one whose whole subject is the missing piece would be the wrong trade.
 */
export function requireFixture<T>(value: T | undefined, variable: string, why: string): T {
  if (value !== undefined) return value;
  throw new Error(
    `No ${variable} - ${why} Set it in examples/demo.env, or set AGENT_SDK_OFFLINE=1 to run ` +
      'against the built-in mock.',
  );
}
