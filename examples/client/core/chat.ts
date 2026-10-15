/**
 * The shared chat script: one governed conversation, for any vendor.
 *
 * What it shows: wrapping a client turns an ordinary LLM client into a governed one without
 * touching a single call site. Every turn is checked before the request and metered after it, and
 * when the budget runs out the refusal is a commercial event - it names which entity blocked,
 * what to do about it, and the chat stays open so a top-up takes effect on the very next message.
 *
 * Nothing below is vendor-specific. The entry points beside this directory differ only in
 * the helper they hand it.
 */
import '../../shared/load-env';
import { clearLine, cursorTo } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { StiggAgentSDK, unitsPerTokens, entitlementId, normalizeUsage, type TokenUsage } from '../../../src';
import { maybeStartMockServer } from '../../shared/mock-server';
import { maybeStartMockStiggServer } from '../../shared/mock-stigg-server';
import { seedMock } from '../../shared/setup-governance';
import { agentIdFor, describeSetup, resolveDemoEnv, type DemoEnv } from '../../shared/demo-env';
import { requireKey, resolveStiggEnv, type StiggEnv } from '../../shared/stigg-env';
import { optionalEnv, type ChatMessage, type ChatVendor } from './vendor';

const SYSTEM = 'You are a concise assistant. Answer in a few sentences.';
/** Credits per agent, per window. Small on purpose: the demo is worth nothing if it never denies. */
const AGENT_BUDGET = 50;
/** ISO-8601 single-unit duration. Governance requires a cadence whenever it creates a budget. */
const BUDGET_CADENCE = 'P1M';
const EXIT_WORDS = new Set(['exit', 'quit', '']);

const round = (value: number) => Math.round(value * 100) / 100;

/** `input_tokens=9 output_tokens=46` - the vendor's own names, which is what was reported. */
const describeMetrics = (metrics: Record<string, number>) =>
  Object.entries(metrics)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ') || 'nothing';

const emptyTotals = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });

function addTotals(into: TokenUsage, add: TokenUsage): void {
  into.input += add.input;
  into.output += add.output;
  into.cacheRead += add.cacheRead;
  into.cacheCreate += add.cacheCreate;
}

function printUsage(label: string, t: TokenUsage): void {
  console.log(
    `  [usage:${label}] input=${t.input} output=${t.output} cache_read=${t.cacheRead} cache_creation=${t.cacheCreate}`,
  );
}

async function startMocksAndGovernance(apiKey: string | undefined, env: StiggEnv, demoEnv: DemoEnv) {
  // Vendor side: with no key (or with AGENT_SDK_OFFLINE set), fall back to the local mock.
  const vendorMock = await maybeStartMockServer(apiKey);

  // Stigg side: whichever environment STIGG_API_KEY and STIGG_BASE_URL point at.
  const stiggMock = await maybeStartMockStiggServer(env.offline);
  // The account's own setup: the entity types, the parent team, a funded pool. Not the agent -
  // that is this application's to provision, below.
  if (stiggMock) {
    await seedMock(demoEnv, stiggMock, {
      agents: [],
      teamLimit: AGENT_BUDGET * 2,
      // The pool must dwarf the per-agent budget, or a denial would come from an empty wallet.
      poolMin: AGENT_BUDGET * 4,
      log: () => undefined,
    });
  }
  return { vendorMock, stiggMock };
}

/**
 * One governed conversation, for any vendor.
 *
 * Four steps, and only two of them are Stigg:
 *
 *   1. construct the SDK          - once per environment
 *   2. register the agent         - a write, so it is its own call, and optional
 *   3. wrap the vendor client     - the whole integration, in one call
 *   4. call the vendor as before  - every call site below is untouched
 *
 * Everything that is not those four lines is this example being an example: mocks, a readline
 * loop, and printing. An application doing this for real writes steps 1 and 3 once at startup.
 */
export async function runChat(vendor: ChatVendor): Promise<void> {
  // Two environments, deliberately kept apart. `env` is what any application deploying this SDK
  // has - which Stigg to talk to. `demoEnv` is what only a demo reads from a file: the tenant, the
  // agent, what to gate on. A real app has the first and knows the second from its own code.
  const env: StiggEnv = resolveStiggEnv();
  const demoEnv: DemoEnv = resolveDemoEnv(env);
  console.log(`[governance] ${describeSetup(env, demoEnv)}`);

  const vendorApiKey = optionalEnv(...vendor.keyVars);

  // Demo scaffolding: with no keys, stand-ins for the LLM vendor and for Stigg, both in-process.
  const { vendorMock, stiggMock } = await startMocksAndGovernance(vendorApiKey, env, demoEnv);

  // 1. One SDK per environment. A key talks to the configured Stigg; a mock needs none.
  const stigg = stiggMock
    ? new StiggAgentSDK({ baseUrl: stiggMock.baseUrl })
    : new StiggAgentSDK({ apiKey: requireKey(env), baseUrl: env.baseUrl });

  // The agent this chat spends as. Unset AGENT_SDK_DEMO_AGENT_ID (or the agent type) and there is
  // no agent at all: the turns are checked against the customer's own pool instead.
  const agentId = demoEnv.agentType ? agentIdFor(demoEnv, vendor.id) : undefined;

  /**
   * 2. Provisioning the agent: a **write**, and so its own call rather than something a turn
   * carries. Idempotent and remembered per process, so it is safe at startup or per request.
   *
   * The budget only goes in when the chat gates on something: an assignment is written over
   * (entity x entitlement), so there is nowhere to put one when no entitlement is named. Without
   * it the agent is still registered and still metered - it just has no budget of its own.
   *
   * Call `stigg.deregister({ customerId, agentId })` when an agent is **ephemeral** instead: one
   * per task or per session, with an id that is never reused. Then not archiving leaks an entity
   * per run. To clear this demo's entities, `yarn example-setup --archive`.
   */
  if (agentId && demoEnv.agentType) {
    await stigg.register({
      customerId: demoEnv.customerId,
      agentId,
      entityTypeId: demoEnv.agentType.entityTypeId,
      displayName: `${vendor.label} chat`,
      // A budget is one object because it is one write, and the entitlement is required inside
      // it - so a demo configured without one provisions an identity and nothing else.
      ...(demoEnv.entitlement
        ? {
            budget: {
              entitlement: demoEnv.entitlement,
              parentId: demoEnv.teamId ?? null,
              limit: AGENT_BUDGET,
              apply: 'on-create' as const,
              cadence: BUDGET_CADENCE,
            },
          }
        : {}),
    });
  }

  /**
   * Declared here because the hooks below close over it, but **assigned only once everything that
   * awaits is done**. A readline interface starts consuming stdin the moment it exists, so one
   * created before those awaits eats piped input while they run and the loop never sees it.
   */

  let rl: ReturnType<typeof createInterface> | undefined;
  /** True while `you> ` is on screen and the user may be mid-word. */
  let prompting = false;

  /**
   * Prints a line that arrived on its own schedule, without eating the prompt.
   *
   * Ingest is fire-and-forget, so a report settles whenever it settles - often just after `you> `
   * was written and while the next message is half-typed. Writing straight to stdout there splices
   * the line into the prompt and the demo reads as broken. So: wipe the line, print, and redraw
   * the prompt with its buffer intact, which is what `rl.prompt(true)` preserves.
   *
   * Only while a prompt is actually up. Mid-stream there is nothing to protect and redrawing would
   * invent a prompt in the middle of an answer; off a TTY there is no cursor to move at all.
   */
  const logAsync = (line: string): void => {
    if (!rl || !prompting || !process.stdout.isTTY) {
      console.log(line);
      return;
    }
    cursorTo(process.stdout, 0);
    clearLine(process.stdout, 0);
    console.log(line);
    rl.prompt(true);
  };

  // The vendor client, built exactly as it would be without Stigg.
  const client = vendor.createClient({
    apiKey: vendorApiKey ?? 'offline-mock',
    baseUrl: vendorMock ? vendor.mockBaseUrl(vendorMock.baseUrl) : undefined,
  });

  /**
   * 3. The whole integration. `wrap` returns a governed **copy**; `client` keeps working ungoverned.
   *
   * `stiggContext` is the default for every call through this copy, and any single call overrides
   * it by putting its own `stiggContext` in the vendor's own parameters - which is how a server
   * handling many tenants through one client varies `customerId`. See `vendor.send`.
   *
   * `entitlement` is the enforcement switch: name one and every turn is checked before the
   * request; name none and the chat meters without gating. No `dimensions` here - the agent is
   * attribution enough, and governance walks the chain up from it, so the team's budget binds
   * without the team being named.
   */

  const govClient = stigg.wrap(client, {
    // Named only by a vendor the built-ins cannot recognise from the client alone - which offline
    // includes OpenRouter, whose mock is reached on a localhost host. Detection covers the rest.
    ...(vendor.recipe ? { recipe: vendor.recipe } : {}),
    stiggContext: {
      customerId: demoEnv.customerId,
      agentId,
      attributionKey: demoEnv.agentType?.attributionKey,
      entitlement: demoEnv.entitlement,
      // Under `'async'` this is what a Stigg meter filters on. Configured once for the demo, so
      // one meter can cover every vendor; unset, each call is reported under `vendor.method`.
      eventName: demoEnv.ingestEventName,
      usageMapper: demoEnv.entitlement ? unitsPerTokens(entitlementId(demoEnv.entitlement), 1_000) : undefined,
      ingestMode: 'sync',
    },
    hooks: {
      onDecision: (decision) => logAsync(`[governance] check ${decision.summary}`),
      // Printed where it lands - the `key` says which turn it was for wherever that is. Through
      // `logAsync`, because "where it lands" is often on top of the prompt.
      onIngest: (result) =>
        logAsync(
          `[governance] ingest ${describeMetrics(result.reported)} key=${result.idempotencyKey} ok=${result.ok}` +
            `${result.creditsConsumed !== undefined ? ` credits=${round(result.creditsConsumed)}` : ''}` +
            `${result.replayed ? ' replayed=true' : ''}`,
        ),
    },
  });

  try {
    console.log(`\nChatting with ${vendor.model} via ${vendor.label}. Type "exit", "quit" or an empty line to end.\n`);

    const history: ChatMessage[] = [];
    const session = emptyTotals();
    let turns = 0;

    rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
    // Ctrl-C: close the interface so the loop below ends like any other end-of-input.
    rl.on('SIGINT', () => rl?.close());

    // Iterating the interface ends cleanly on end-of-input (Ctrl-D, or piped stdin running out),
    // which `rl.question()` in a loop does not - it throws ERR_USE_AFTER_CLOSE instead.
    prompting = true;
    rl.prompt();
    for await (const answer of rl) {
      prompting = false;
      const line = answer.trim();
      if (EXIT_WORDS.has(line.toLowerCase())) break;

      history.push({ role: 'user', content: line });

      try {
        process.stdout.write('assistant> ');
        // 4. The vendor call, unchanged. Checked before it leaves, metered after it answers.
        //
        // The fourth argument is a per-turn `stiggContext`, and this chat has nothing to vary - it
        // is one customer and one agent - so it passes none and every turn uses the wrap's own.
        // A multi-tenant server would pass `{ customerId }` here instead of wrapping per request.
        const reply = await vendor.send(govClient, history, SYSTEM);
        process.stdout.write('\n');

        if (reply.stopReason) console.log(`  [stop_reason=${reply.stopReason}]`);
        if (reply.servedModel && reply.servedModel !== vendor.model) {
          console.log(`  [routing drift] asked for ${vendor.model}, served by ${reply.servedModel}`);
        }

        // The wrapper already read this exact object and ingested it; normalizing it here with the
        // SDK's own function shows the printed numbers are the ones that were metered.
        const turn = normalizeUsage(reply.usage);
        turns += 1;
        addTotals(session, turn);
        printUsage(`turn ${turns}`, turn);
      } catch (err) {
        // A refusal arrives as an exception here and nowhere else: the vendor's signature owns the
        // return type, so there is no decision to hand back. `denial` turns it back into one, and
        // returns undefined when it was a real failure - so an unrelated error still propagates.
        const decision = stigg.denial(err);
        if (!decision) throw err;

        // The request never left the process, so the turn never happened - and was never paid for.
        history.pop();
        process.stdout.write('\n');
        console.log(`  ${decision.message}`);
        console.log('  Raise the budget in another shell, then just keep typing - the next message re-checks:');
        console.log('    yarn workspace @stigg/agent-sdk-js run example-setup --agent-limit 6');
      }
      prompting = true;
      rl.prompt();
    }

    prompting = false;
    rl.close();
    // Ingest is fire-and-forget, so something is usually still in flight at the end. `flush` waits
    // for it and reports what this client actually delivered; the SDK-level one drains every client
    // and closes the engine. Explicit because an exit hook does not fire in a serverless runtime.
    //
    // In a `finally`, because a turn that threw something other than a denial used to escape this
    // whole block: the spend already reported was never flushed, and both mock servers were left
    // listening - so the process hung on an error instead of reporting it.
    const summary = await govClient.stigg.flush();

    console.log('\nConversation ended.');
    printUsage(`session (${turns} turns)`, session);
    console.log(
      `[governance] checks=${summary.checks} ingested=${summary.ingested} ` +
        `${describeMetrics(summary.reported)} failed_ingests=${summary.ingestFailures}`,
    );
  } finally {
    // Whatever happened - a denial, a vendor error, a Ctrl-C handler - the spend already
    // reported still has to land and both servers still have to stop. A turn that threw
    // something other than a denial used to skip all of this and leave the process hanging.
    await stigg.flush({ close: true });
    await vendorMock?.close();
    await stiggMock?.close();
  }
}

/** Entry point for every vendor file beside this one. */
export function startChat(vendor: ChatVendor): void {
  runChat(vendor).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
