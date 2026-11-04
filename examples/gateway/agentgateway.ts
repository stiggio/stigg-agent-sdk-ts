/**
 * The agentgateway helper - a gateway called with plain HTTP, and no SDK in sight.
 *
 * Plenty of services reach their gateway this way: they post JSON to `/v1/chat/completions` and
 * read the reply. `wrap` has no client object to hold there, and the proxy binding does not help
 * either - it ingests what a proxy *you* operate observed, and agentgateway never calls Stigg. So
 * this wraps the one thing such a service does hold: its `fetch`.
 *
 * `stigg.wrapFetch` routes each request by its path to the recipe method that names it, and from
 * there it is that method's call - the same gate before it leaves, the same reader on the reply,
 * the same event name. `agentgateway.chat.completions.create` is what a meter sees whether the
 * call came through the `openai` SDK (`example-client-agentgateway`) or through this `fetch`.
 *
 * Three requests, each a different door:
 *
 *   1. Chat Completions, buffered  - metered from the JSON, before the caller has the response
 *   2. Chat Completions, streamed  - metered from the SSE as the caller reads it
 *   3. Anthropic Messages, streamed - the same gateway on its other wire, same recipe
 *
 * Set `AGENT_SDK_AGENTGATEWAY_BASE_URL` to your gateway's `/v1` route to talk to the real thing,
 * and `AGENT_SDK_AGENTGATEWAY_API_KEY` only if it enforces API-key auth. With no base URL set the
 * example runs against the built-in offline mock.
 *
 * Run:  yarn example-gateway-agentgateway
 */
import '../shared/load-env';
import { StiggAgentSDK, agentgatewayRecipe, entitlementId, unitsPerTokens } from '../../src';
import { maybeStartMockServer } from '../shared/mock-server';
import { maybeStartMockStiggServer } from '../shared/mock-stigg-server';
import { prepareDemo } from '../shared/setup-governance';
import { agentIdFor, describeSetup, resolveDemoEnv } from '../shared/demo-env';
import { requireKey, resolveStiggEnv } from '../shared/stigg-env';
import { optionalEnv } from './core/vendor';

const MODEL = process.env.AGENT_SDK_AGENTGATEWAY_MODEL ?? 'gpt-5-mini';
const PROMPT = 'Name one thing worth metering in an agent, in a few words.';
/** The agent's budget, in the entitlement's own units - small, so a few runs drain it. */
const AGENT_BUDGET = 5;
/** ISO-8601 single-unit duration. Governance requires a cadence whenever it creates a budget. */
const BUDGET_CADENCE = 'P1M';

const describeMetrics = (metrics: Record<string, number>) =>
  Object.entries(metrics)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ') || 'nothing';

/** The text a streamed reply carried, from whichever wire it came in on. */
function textOf(sse: string): string {
  return sse
    .split('\n')
    .filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))
    .map((line) => {
      try {
        const event = JSON.parse(line.slice(5));
        return event.choices?.[0]?.delta?.content ?? event.delta?.text ?? '';
      } catch {
        return '';
      }
    })
    .join('');
}

async function main(): Promise<void> {
  const env = resolveStiggEnv();
  const demoEnv = resolveDemoEnv(env);
  const configured = optionalEnv('AGENT_SDK_AGENTGATEWAY_BASE_URL');

  // Demo scaffolding: with no gateway configured, the vendor mock stands in for it.
  const mock = await maybeStartMockServer(configured);
  const stiggMock = await maybeStartMockStiggServer(env.offline);
  console.log(`[governance] ${describeSetup(env, demoEnv)}`);

  // The `/agentgateway` prefix is only how the shared mock tells this wire from the other
  // OpenAI-shaped ones. Against a real gateway the base URL is whatever its listener serves.
  const baseUrl = mock ? `${mock.baseUrl}/agentgateway/v1` : configured!;
  const apiKey = optionalEnv('AGENT_SDK_AGENTGATEWAY_API_KEY', 'AGENTGATEWAY_API_KEY');

  const stigg = stiggMock
    ? new StiggAgentSDK({ baseUrl: stiggMock.baseUrl })
    : new StiggAgentSDK({ apiKey: requireKey(env), baseUrl: env.baseUrl });
  // The account's setup, created if missing - not the agent: this example registers its own below.
  const { governanceEnabled } = await prepareDemo(env, demoEnv, stigg, stiggMock, {
    agents: [],
    teamLimit: 100,
    log: () => undefined,
  });

  /**
   * The agent these requests spend as, registered with its budget. Unset AGENT_SDK_DEMO_AGENT_ID,
   * or run on an account without governance - which cannot register one - and there is no agent:
   * the requests spend the customer's own pool instead.
   *
   * The budget only goes in when the example gates on something - an assignment is written over
   * (entity x entitlement). `on-create`, so re-running never overwrites a limit changed since.
   */
  const agentId = governanceEnabled && demoEnv.agentType ? agentIdFor(demoEnv, 'gateway-agentgateway') : undefined;
  if (agentId && demoEnv.agentType) {
    await stigg.register({
      customerId: demoEnv.customerId,
      // A customer Stigg does not know yet is provisioned onto the demo plan first.
      defaultPlanId: demoEnv.planId,
      agentId,
      entityTypeId: demoEnv.agentType.entityTypeId,
      displayName: 'agentgateway fetch',
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
   * The whole integration: the application's `fetch`, governed. Everything below calls it exactly
   * as it would call `fetch` - the one addition is an optional `stiggContext` on the init.
   */
  const gatewayFetch = stigg.wrapFetch({
    baseUrl,
    recipe: agentgatewayRecipe(),
    stiggContext: {
      customerId: demoEnv.customerId,
      defaultPlanId: demoEnv.planId,
      agentId,
      attributionKey: demoEnv.agentType?.attributionKey,
      entitlement: demoEnv.entitlement,
      usageMapper: demoEnv.entitlement ? unitsPerTokens(entitlementId(demoEnv.entitlement), 1_000) : undefined,
      ingestMode: 'sync',
    },
    hooks: {
      onDecision: (decision) => console.log(`[governance] check ${decision.summary}`),
      onIngest: (result) =>
        console.log(
          `[governance] ingest ${describeMetrics(result.reported)} key=${result.idempotencyKey} ok=${result.ok}`,
        ),
    },
  });

  const headers = {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };

  try {
    console.log('\n1. Chat Completions, buffered');
    const buffered = await gatewayFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], max_tokens: 256 }),
    });
    const completion = (await buffered.json()) as { model?: string; choices?: { message?: { content?: string } }[] };
    console.log(`   ${completion.choices?.[0]?.message?.content ?? ''}`);
    console.log(`   [served by] ${completion.model}`);

    console.log('\n2. Chat Completions, streamed');
    const streamed = await gatewayFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: PROMPT }],
        max_tokens: 256,
        stream: true,
        // Without this the gateway's upstream sends no usage at all, and there is nothing to meter.
        stream_options: { include_usage: true },
      }),
    });
    // Metered once this read reaches the end of the body - nothing is buffered on our behalf.
    console.log(`   ${textOf(await streamed.text())}`);

    console.log('\n3. Anthropic Messages, streamed');
    const messages = await gatewayFetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { ...headers, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: PROMPT }],
        max_tokens: 256,
        stream: true,
      }),
    });
    console.log(`   ${textOf(await messages.text())}`);

    const summary = await gatewayFetch.stigg.flush();
    console.log(
      `\n[governance] checks=${summary.checks} ingested=${summary.ingested} failed_ingests=${summary.ingestFailures}`,
    );
  } finally {
    await stigg.close();
    await mock?.close();
    await stiggMock?.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
