/**
 * The shared gateway script: both topologies, for any gateway.
 *
 * "Gateway" covers two deployments that want opposite bindings, and this runs each:
 *
 *   A. Calling one. The response lands in this process carrying the money it charged and the
 *      model that actually served after routing. A client recipe reads both, so the call is gated
 *      before it leaves and billed on real spend rather than a token count priced by guesswork.
 *
 *   B. Operating one. There is no client object out there to wrap, only an HTTP request, so
 *      attribution travels as headers and the proxy ingests against them. It sees requests, not
 *      runs: it cannot provision, cannot check against run-scoped state, and cannot archive -
 *      so that path never gates. `core/proxy.ts` is that process, on a real socket.
 *
 * The two seams are the same either way - the real cost, and the routing drift that silently
 * changes COGS. What differs is who can see them, and whether anything can still be refused.
 */
import OpenAI from 'openai';
import { StiggAgentSDK, entitlementId, weightedMetrics } from '../../../src';
import type { IngestResult } from '../../../src';
import { maybeStartMockServer } from '../../shared/mock-server';
import { maybeStartMockStiggServer } from '../../shared/mock-stigg-server';
import { seedMock } from '../../shared/setup-governance';
import { agentIdFor, describeSetup, requireFixture, resolveDemoEnv } from '../../shared/demo-env';
import { requireKey, resolveStiggEnv } from '../../shared/stigg-env';
import { startGovernedProxy } from './proxy';
import { optionalEnv, type CostReading, type GatewayVendor } from './vendor';

const PROMPT = 'In two sentences, what is a usage-based pricing model?';
/** ISO-8601 single-unit duration. Governance requires a cadence whenever it creates a budget. */
const BUDGET_CADENCE = 'P1M';

/** `cost=1080 prompt_tokens=30` - the names that were reported, which is what a meter reads. */
const describeMetrics = (metrics: Record<string, number>) =>
  Object.entries(metrics)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ') || 'nothing';

function report(vendor: GatewayVendor, label: string, reading: CostReading): void {
  console.log(`\n--- ${label} ---`);
  // [STIGG SEAM: routing-drift] The gateway may serve a different model than was asked for,
  // which silently changes COGS. Compare what was requested with what actually ran.
  const drift = reading.servedModel && reading.servedModel !== vendor.model ? '  <- routing drift' : '';
  console.log(`requested model : ${vendor.model}`);
  console.log(`served model    : ${reading.servedModel ?? '(unknown)'}${drift}`);
  if (!reading.tokens) {
    console.log('usage           : (none reported)');
    return;
  }
  // [STIGG SEAM: cost-truth] The gateway states what it charged, so billing can use real spend
  // instead of a client-side price table. Cache and reasoning tokens explain the number.
  console.log(`cost            : ${reading.cost ?? '(not reported)'}`);
  console.log(`prompt tokens   : ${reading.tokens.prompt} (cached: ${reading.tokens.cached})`);
  console.log(`completion tok. : ${reading.tokens.completion} (reasoning: ${reading.tokens.reasoning})`);
}

// ------------------------------------------------------------------------------------------
// A. Calling a gateway - the client recipe. Gated in-process, billed on what it really cost.
// ------------------------------------------------------------------------------------------

async function callGateway(
  vendor: GatewayVendor,
  govClient: object,
  stigg: StiggAgentSDK,
  stream: boolean,
): Promise<void> {
  const label = stream ? 'wrapped, streaming' : 'wrapped, non-streaming';
  try {
    // The vendor's own client, called the vendor's own way. Everything after this line - the
    // report, the denial, the budget - is the same for any gateway, which is the whole claim.
    report(vendor, label, await vendor.turn(govClient, { prompt: PROMPT, stream }));
  } catch (err) {
    // The one thing the header path cannot do: refuse before the request ever leaves.
    const decision = stigg.denial(err);
    if (!decision) throw err;
    console.log(`\n--- ${label} ---\nrefused before the request left: ${decision.message}`);
  }
}

export async function runGateway(vendor: GatewayVendor): Promise<void> {
  const apiKey = optionalEnv(...vendor.keyVars);
  // Whether to call the real service. Usually that is "is a key set", but a vendor whose
  // credentials do not live in one variable answers for itself - see `hasCredentials`.
  const configured = vendor.hasCredentials ? await vendor.hasCredentials() : apiKey !== undefined;
  const mock = await maybeStartMockServer(configured ? (apiKey ?? 'resolved-elsewhere') : undefined);
  // `env` is what any application has - which Stigg to talk to. `demoEnv` is what only a demo
  // reads from a file: the tenant, the agent, what to gate on.
  const env = resolveStiggEnv();
  const demoEnv = resolveDemoEnv(env);
  const stiggMock = await maybeStartMockStiggServer(env.offline);
  if (stiggMock) {
    await seedMock(demoEnv, stiggMock, {
      // The account's setup, not the agent: this example provisions its own below, with the same
      // budget, so the offline path and a real account take the same route in.
      agents: [],
      teamLimit: vendor.budget * 2,
      // The pool must dwarf the per-agent budget, or a denial would come from an empty wallet.
      poolMin: vendor.budget * 4,
      log: () => undefined,
    });
  }

  console.log(`[governance] ${describeSetup(env, demoEnv)}`);
  const stigg = stiggMock
    ? new StiggAgentSDK({ baseUrl: stiggMock.baseUrl })
    : new StiggAgentSDK({ apiKey: requireKey(env), baseUrl: env.baseUrl });
  const baseUrl = mock ? vendor.mockBaseUrl(mock.baseUrl) : vendor.baseUrl;

  // This example's subject is a budget visibly draining and then refusing, and `vendor.budget` is
  // denominated in the entitlement's own units - so unlike the chat examples it cannot run ungated.
  const entitlement = requireFixture(
    demoEnv.entitlement,
    'AGENT_SDK_DEMO_CURRENCY_ID or AGENT_SDK_DEMO_FEATURE_ID',
    'this example spends a budget down until it refuses, which needs something to gate on.',
  );

  /**
   * Optional, and the calls' attribution: provisioning it here makes every check and ingest
   * below land on that agent. Leave it out and the calls spend the customer's pool
   * instead - which is what an unset AGENT_SDK_DEMO_AGENT_ID gets you, so the alternative is
   * runnable rather than only described here. No separate flag: an agent id that names no agent
   * and a flag saying there is no agent would only be two places for one fact to disagree.
   */
  const agentId = demoEnv.agentType ? agentIdFor(demoEnv, vendor.agentSuffix) : undefined;
  if (agentId && demoEnv.agentType) {
    await stigg.register({
      customerId: demoEnv.customerId,
      agentId,
      entityTypeId: demoEnv.agentType.entityTypeId,
      displayName: `${vendor.label} caller`,
      // `null` rather than undefined: with no team this agent is a root, which is a placement -
      // undefined would mean "leave whatever parent it already has".
      //
      // The limit and the cadence are what make this a budget rather than a bare placement, and
      // governance requires both whenever it *creates* an assignment. Omitting them worked only
      // against the offline mock, where `seedMock` above has already written the assignment and
      // this call is therefore an update; against a real Stigg the first run for an agent is a
      // create, and it was refused with a 400 that said only "Bad Request".
      //
      // `on-create` rather than the default `always`: this is the same number `seedMock` seeds
      // with, so re-running the example must not overwrite a budget an admin has since changed.
      ...(demoEnv.entitlement
        ? {
            budget: {
              entitlement: demoEnv.entitlement,
              parentId: demoEnv.teamId ?? null,
              limit: vendor.budget,
              apply: 'on-create' as const,
              cadence: BUDGET_CADENCE,
            },
          }
        : {}),
    });
  }

  const credentials = { apiKey: apiKey ?? 'offline-mock', baseUrl };

  let proxy: Awaited<ReturnType<typeof startGovernedProxy>> | undefined;
  try {
    // A. One wrap is the whole setup: every call through this client is checked and metered
    // against the context below, and `govClient.stigg` is what the header path attributes with.
    const govClient = stigg.wrap(vendor.createClient(credentials), {
      recipe: vendor.recipe(baseUrl),
      stiggContext: {
        customerId: demoEnv.customerId,
        agentId,
        attributionKey: demoEnv.agentType?.attributionKey,
        entitlement,
        eventName: demoEnv.ingestEventName,
        // The usage API, so the budget visibly moves. Under the default - events - whether
        // anything is metered depends on meters configured in the account, and the event API
        // cannot confirm that it was, so `remaining` would sit unchanged and mean nothing.
        ingestMode: 'sync',
        // Bill the money, not the tokens. The recipe reports both; which of them is worth
        // something is this client's decision and never the recipe's, which is why it is spelled
        // out here rather than inferred from a base URL. Reported against what the calls check,
        // because a budget on a currency is not an assignment on `cost`.
        usageMapper: weightedMetrics(vendor.recipe(baseUrl), entitlementId(entitlement), vendor.billedMetrics),
      },
      hooks: {
        onIngest: (result: IngestResult) =>
          console.log(
            `[governance] ingest ${describeMetrics(result.reported)} key=${result.idempotencyKey} ok=${result.ok}`,
          ),
      },
    });
    await callGateway(vendor, govClient, stigg, false);
    console.log(`[governance] ${govClient.stigg.lastDecision?.summary}`);
    if (vendor.streams === false) {
      console.log(
        `\n--- wrapped, streaming ---\n${vendor.label}'s client cannot stream a turn, so this pass ` +
          'does not apply. Running it anyway would issue a second buffered request and bill it,\n' +
          'which is worse than not running it: the output would claim one call and the meter two.',
      );
    } else {
      await callGateway(vendor, govClient, stigg, true);
      console.log(`[governance] ${govClient.stigg.lastDecision?.summary}`);
    }

    // B. A second process, near enough: its own socket, its own headers, no run handle.
    //
    // Only for a gateway something can proxy. The header path forwards the OpenAI wire format,
    // and a gateway that does not speak it - Bedrock, whose protocol is SigV4 and Converse - has
    // no proxy to stand in front of it here. Said out loud rather than skipped silently, because
    // "the second half did not run" should never look like "the second half found nothing".
    if (!vendor.createProxyClient) {
      console.log(
        `\n--- header path ---\n${vendor.label} is not fronted by an OpenAI-compatible proxy, so this ` +
          'half of the example does not apply: the ingest-from-headers path forwards that wire format,\n' +
          'and a proxy for this gateway would have to speak its own protocol instead. The half above -\n' +
          'gating and metering in-process - is the half that governs either way.',
      );
      return;
    }

    proxy = await startGovernedProxy({
      // The wire format, not the vendor's SDK: a proxy forwards the request it was handed.
      upstream: vendor.createProxyClient(credentials),
      stigg,
      demoEnv,
      vendor,
      onIngest: (result, attribution) =>
        console.log(
          `[proxy] ingested ${describeMetrics(result.reported)} ok=${result.ok} ` +
            `for run=${attribution.runId ?? '(none)'} customer=${attribution.customerId ?? '(none)'}`,
        ),
    });

    console.log(`\n--- header path, over a real socket (${proxy.baseUrl}) ---`);
    const headers = govClient.stigg.headers();
    const upstream = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      // The attribution is serialised here and parsed on the other side. Nothing in this process
      // hands the proxy an object; it gets what the wire carried, like any other request.
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: vendor.model, max_tokens: 300, messages: [{ role: 'user', content: PROMPT }] }),
    });
    const served = (await upstream.json()) as OpenAI.ChatCompletion;
    console.log(`served model    : ${served.model}`);
    console.log(
      'The proxy could read who this was for and report what it saw. It could not check: the\n' +
        'caller is in another process, and a budget is only enforceable where the caller is.\n' +
        'It also billed tokens rather than cost - the mapper lives with the wrapped client, and what\n' +
        'crosses the boundary is a usage report, so the price the gateway stated has nowhere to go.',
    );
  } finally {
    await proxy?.close();
    await stigg.flush({ close: true });
    await mock?.close();
    await stiggMock?.close();
  }
}

/** Entry point for every gateway file beside this directory. */
export function startGateway(vendor: GatewayVendor): void {
  runGateway(vendor).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
