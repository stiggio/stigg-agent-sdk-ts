/**
 * The orchestration binding's core: an agent graph's middleware, with no framework in it.
 *
 * It splits the way the client binding does: `wrapClient` gates and meters a call and a recipe
 * knows one vendor; here the middleware governs a graph's steps and a framework binding (the
 * LangChain callback handler, or a harness of your own) knows how its framework announces them.
 *
 * Every step is checked and billed as the agent that took it, so one agent running dry refuses
 * that agent's steps and nothing else. A refusal is the SDK's own `AccessDeniedError`, thrown from
 * inside the step - the frameworks worth binding to offer hooks that observe a step, not ones that
 * replace its result - and what it means for the run is the graph's to decide. Nothing else throws
 * into the run: ingest never does, and a check that could not be made resolves through
 * `checkErrorAction`.
 *
 * Steps are keyed by the run id the framework gives each one, because the end of a step usually
 * carries nothing else: what the start resolved is what the end bills.
 */
import { AccessDeniedError } from '../../../errors';
import { isEnforced, noCustomer, overrideContext, type ResolvedContext } from '../../../core/context';
import type { GovernanceSession } from '../../../core/session';
import {
  entitlementError,
  type Entitlement,
  type Measurement,
  type Metrics,
  type MiddlewareOptions,
  type MiddlewareTools,
  type ToolUsageMapper,
} from '../../../types';

/** Who a step is for, as the framework stated it on that step. */
export type StepAttribution = {
  /** The agent that took the step, by the framework's own name for it. */
  agent?: string;
  /** The customer the run is for, when the run named one. */
  customerId?: string;
};

/** A tool call the model issued in its reply: the id the tool step will refer back to, and what it named. */
export type IssuedToolCall = { id: string; name: string };

/** A tool about to run, as the framework announced it. */
export type ToolStep = {
  /** The tool's name, when the framework passes one - some do not, for some tools. */
  name?: string;
  /** The id of the model's tool call this step runs, when the framework passes it. */
  callId?: string;
  /**
   * What the tool is when it has no name and no model called it - its class, for a packaged tool
   * a node invokes directly. Only `'*'` can match it, so the catch-all still covers the call.
   */
  kind?: string;
  /** What the tool was called with, for a `usage` mapper. */
  input?: unknown;
};

/** What a framework binding drives: the start and end of every step a graph takes. */
export type AgentMiddleware = {
  /** Before a model call: checked, and raises `AccessDeniedError` when refused. */
  startModel(runId: string, attribution: StepAttribution, eventName: string): Promise<void>;
  /**
   * After a model call: its measurement is ingested, or the missing one reported. Never throws.
   * `issued` is the tool calls the reply asked for, so a tool step that arrives with only its call
   * id is named, and billed to the agent that called it.
   */
  endModel(runId: string, measurement: Measurement | undefined, issued?: readonly IssuedToolCall[]): Promise<void>;
  /** Before a tool runs: checked when the tool is a paid one, raising when refused. */
  startTool(runId: string, tool: ToolStep, attribution: StepAttribution): Promise<void>;
  /** After a tool succeeded: what its `usage` makes of the call, or one unit. Never throws. */
  endTool(runId: string, output?: unknown): Promise<void>;
  /** A step that failed: forgotten, and billed nothing - it did not deliver what it charges for. */
  abandon(runId: string): void;
};

/** How one tool is governed, its shorthand expanded. */
export type ResolvedTool = { entitlement?: Entitlement; usage?: ToolUsageMapper };

/** A graph's tools by name, `'*'` for the rest - `false` for one left ungoverned. */
export type ResolvedTools = Readonly<Record<string, ResolvedTool | false>>;

/** One agent's part of the graph, already resolved over the shared context. */
export type ResolvedAgent = {
  context: ResolvedContext;
  tools: ResolvedTools;
};

/** The key that stands for every tool a configuration does not name. */
export const ALL_TOOLS = '*';

/** One tool's entry, validated and expanded. A mistake here is said at startup, not on the first call. */
function resolveTool(name: string, tool: unknown, where: string): ResolvedTool | false {
  if (tool === false) return false;
  const at = `${where}.${name === ALL_TOOLS ? `'${ALL_TOOLS}'` : name}`;
  if (!tool || typeof tool !== 'object') {
    throw new Error(`${at} must be an entitlement, { entitlement, usage }, or false.`);
  }
  const shorthand = 'currencyId' in tool || 'featureId' in tool;
  if (shorthand && ('usage' in tool || 'entitlement' in tool)) {
    throw new Error(
      `${at} mixes an entitlement's own fields with \`usage\` or \`entitlement\`, so one of them would be ` +
        'ignored. Write it as { entitlement: { currencyId }, usage }.',
    );
  }
  const resolved = (shorthand ? { entitlement: tool } : tool) as ResolvedTool;
  if (resolved.usage !== undefined && typeof resolved.usage !== 'function') {
    throw new Error(`${at}.usage must be a function from the tool call to the metrics it reports.`);
  }
  if (resolved.entitlement === undefined && !resolved.usage) {
    throw new Error(
      `${at} names neither an entitlement to check nor a usage to report, so it would do nothing. ` +
        'Give it one of them, or false to leave the tool ungoverned.',
    );
  }
  const invalid = resolved.entitlement && entitlementError(resolved.entitlement);
  if (invalid) throw invalid;
  return resolved;
}

/** A configuration's tools, each validated and expanded once, when the graph is configured. */
export function resolveTools(tools: MiddlewareTools | undefined, where: string): ResolvedTools {
  return Object.fromEntries(Object.entries(tools ?? {}).map(([name, tool]) => [name, resolveTool(name, tool, where)]));
}

/**
 * The graph's agents, each resolved once over the shared context and tools, so a step does no
 * more than look its agent up. An agent's tools are laid over the shared ones, name by name.
 */
export function resolveAgents(
  shared: ResolvedContext,
  { tools, agents }: Pick<MiddlewareOptions, 'tools' | 'agents'>,
): { shared: ResolvedAgent; agents: Map<string, ResolvedAgent> } {
  const sharedTools = resolveTools(tools, 'stigg.middleware tools');
  const resolved = new Map<string, ResolvedAgent>();
  for (const [name, agent] of Object.entries(agents ?? {})) {
    // An agent's context is a default for every step it takes, so one key would dedupe them all
    // into the first. The shared context is refused the same way, in `resolveContext`.
    if (agent.stiggContext?.idempotencyKey !== undefined) {
      throw new Error(
        `stigg.middleware's agents.${name}.stiggContext cannot set \`idempotencyKey\` - one key shared ` +
          'by every step that agent takes would bill the first and discard the rest. Each step is keyed by its own id.',
      );
    }
    resolved.set(name, {
      context: agent.stiggContext ? overrideContext(shared, agent.stiggContext) : shared,
      tools: { ...sharedTools, ...resolveTools(agent.tools, `stigg.middleware agents.${name}.tools`) },
    });
  }
  return { shared: { context: shared, tools: sharedTools }, agents: resolved };
}

/**
 * The tool's own entry, else the catch-all - only the catch-all for a tool with no name, so a
 * class name never matches an entry written for a tool's name. An exempted tool, or one not
 * covered, is ungoverned. Own keys only: a tool named `toString` must not find `Object.prototype`'s.
 */
function toolFor(tools: ResolvedTools, name: string | undefined): ResolvedTool | undefined {
  if (name !== undefined && Object.hasOwn(tools, name)) return tools[name] || undefined;
  if (Object.hasOwn(tools, ALL_TOOLS)) return tools[ALL_TOOLS] || undefined;
  return undefined;
}

export type AgentMiddlewareConfig = {
  /** The shared context and tools - what a step from an agent not listed resolves to. */
  shared: ResolvedAgent;
  /** Each listed agent's own, by name. */
  agents: ReadonlyMap<string, ResolvedAgent>;
  /** Told once per agent that was not listed, so the caller can say so. */
  onUnlisted(agent: string): void;
  /** Where the caller puts the customer - quoted when a step has none. */
  missingCustomer: string;
};

/** A step in flight: what its start resolved, kept until its end bills it. */
type Step = {
  context: ResolvedContext;
  idempotencyKey?: string;
  /** For a tool step: what its `usage` is given when the tool ends, and the call it runs. */
  tool?: { name: string; input: unknown; usage?: ToolUsageMapper; callId?: string };
};

/** A tool call a model issued: the tool it named, and the agent whose model asked for it. */
type IssuedCall = { name: string; agent?: string };

/**
 * How many issued calls are remembered, and how many steps can be in flight. An issued call is
 * kept so a re-run finds its owner, and a step whose end never comes would otherwise stay for the
 * life of the process, so past these the oldest go first.
 */
const ISSUED_CALLS_LIMIT = 1_000;
const STEPS_LIMIT = 10_000;

/** Adds to a map that drops its oldest entry past `limit`, and hands back what it dropped. */
function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): V | undefined {
  map.set(key, value);
  if (map.size <= limit) return undefined;
  const [oldest, dropped] = map.entries().next().value!;
  map.delete(oldest);
  return dropped;
}

export function createAgentMiddleware(session: GovernanceSession, config: AgentMiddlewareConfig): AgentMiddleware {
  /** Steps that started and have not ended, by run id. */
  const steps = new Map<string, Step>();
  /** The tool calls models issued, by call id - kept for re-runs, until the cap drops them. */
  const issuedCalls = new Map<string, IssuedCall>();
  const warnedUnlisted = new Set<string>();

  /**
   * The agent a step belongs to. One the configuration does not list - or a step attributed to no
   * agent - resolves to the shared context, so nothing runs unbilled for having been left out.
   */
  const agentFor = (agent: string | undefined): ResolvedAgent => {
    const own = agent === undefined ? undefined : config.agents.get(agent);
    if (!own && agent !== undefined && config.agents.size > 0 && !warnedUnlisted.has(agent)) {
      warnedUnlisted.add(agent);
      config.onUnlisted(agent);
    }
    return own ?? config.shared;
  };

  /** The context for one step. The customer is required: an empty one would be billed to nobody. */
  const contextFor = (base: ResolvedContext, { agent, customerId }: StepAttribution): ResolvedContext => {
    const context = customerId ? overrideContext(base, { customerId }) : base;
    if (!context.customerId) throw noCustomer(config.missingCustomer);
    return agent === undefined ? context : { ...context, agent };
  };

  /** The gate, raising rather than returning - the hooks it runs in have no return path. */
  const check = async (context: ResolvedContext): Promise<void> => {
    if (!isEnforced(context)) return;
    const decision = await session.check(context);
    if (!decision.hasAccess) throw new AccessDeniedError(decision);
  };

  /** A step in flight. One dropped to make room is never billed, so that is said, not silent. */
  const rememberStep = (runId: string, step: Step): void => {
    const dropped = remember(steps, runId, step, STEPS_LIMIT);
    if (dropped) {
      session.failedToMeasure(
        dropped.context,
        new Error(`a step was still in flight after ${STEPS_LIMIT} newer ones started, so it was dropped unbilled`),
      );
    }
  };

  /** The tool calls a reply asked for, kept until each tool has run. */
  const rememberIssuedCalls = (issued: readonly IssuedToolCall[], agent: string | undefined): void => {
    for (const call of issued) remember(issuedCalls, call.id, { name: call.name, agent }, ISSUED_CALLS_LIMIT);
  };

  /** A tool step's context: priced by the tool's own entitlement, when it has one, and labelled with the tool. */
  const toolContext = (agent: ResolvedAgent, tool: ResolvedTool, name: string, attribution: StepAttribution) => {
    const eventName = { name: `tool.${name}` };
    const priced = overrideContext(
      agent.context,
      tool.entitlement ? { entitlement: tool.entitlement, eventName } : { eventName },
    );
    return { ...contextFor(priced, attribution), tool: name };
  };

  /** Bills a tool step that ended: its `usage`, or one unit. A bad `usage` is a metering failure. */
  const billTool = async ({ context, idempotencyKey, tool }: Step, output: unknown): Promise<void> => {
    const options = { idempotencyKey };
    if (!tool?.usage) {
      await session.ingest(context, 1, options);
      return;
    }
    try {
      const metrics: unknown = tool.usage({ name: tool.name, input: tool.input, output });
      if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
        throw new Error(`the usage of tool ${tool.name} returned ${String(metrics)}, not metrics by feature id`);
      }
      await session.ingestMetrics(context, metrics as Metrics, options);
    } catch (err) {
      session.failedToMeasure(context, err);
    }
  };

  return {
    async startModel(runId, attribution, eventName) {
      const resolved = contextFor(agentFor(attribution.agent).context, attribution);
      const context = resolved.eventName ? resolved : { ...resolved, eventName: { name: eventName } };
      await check(context);
      rememberStep(runId, { context });
    },

    // Awaited by the binding, so the agent's next check sees this spend. Safe to wait on: ingest
    // never throws.
    async endModel(runId, measurement, issued = []) {
      const step = steps.get(runId);
      rememberIssuedCalls(issued, step?.context.agent);
      if (!step) return;
      steps.delete(runId);
      if (!measurement) {
        session.failedToMeasure(step.context, new Error('the model call ended without usage, so nothing was metered'));
        return;
      }
      await session.ingestMeasurement(step.context, measurement);
    },

    async startTool(runId, { name, callId, kind, input }, attribution) {
      // Never taken, only looked up - the cap drops old ones: a tools node that runs again, before
      // or after the call succeeded, is the same call, owned by the same agent, billed under one key.
      const issued = callId === undefined ? undefined : issuedCalls.get(callId);
      const named = name ?? issued?.name;
      const toolName = named ?? kind;
      // Billed to the agent whose model asked for the call: a tool can run in a node of its own.
      const owner = { ...attribution, agent: issued?.agent ?? attribution.agent };
      const agent = agentFor(owner.agent);
      const tool = toolName ? toolFor(agent.tools, named) : undefined;
      if (!toolName || !tool) return;
      const context = toolContext(agent, tool, toolName, owner);
      if (tool.entitlement) await check(context);
      rememberStep(runId, {
        context,
        tool: { name: toolName, input, usage: tool.usage, callId },
        // One tool call is one report, and two entitlements on one call must not collide.
        idempotencyKey: callId ? `${callId}:${context.checkedId ?? toolName}` : undefined,
      });
    },

    async endTool(runId, output) {
      const step = steps.get(runId);
      if (!step) return;
      steps.delete(runId);
      await billTool(step, output);
    },

    abandon(runId) {
      steps.delete(runId);
    },
  };
}
