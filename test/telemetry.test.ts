/**
 * The OpenTelemetry spans an orchestrator's checks and ingests emit - what Langfuse and the rest see.
 *
 * A real provider with an in-memory exporter, registered globally the way an application would, so
 * the assertions are on spans exactly as a vendor's exporter receives them.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { unitsPerTokens } from '../src';
import { newStigg } from './stigg-harness';

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));

const CUSTOMER = 'customer-acme';
const credits = { currencyId: 'credits' } as const;

const spans = (name: string) => exporter.getFinishedSpans().filter((span) => span.name === name);

/** A graph with one agent, `planner`, governed as `agent-1` - driven the way any binding drives it. */
async function graph(agentBudget: number) {
  const { stigg } = await newStigg({ agentBudget });
  const middleware = stigg.middleware({
    stiggContext: {
      attributionKey: 'agentId',
      entitlement: credits,
      ingestMode: 'sync',
      usageMapper: unitsPerTokens('credits', 1_000),
    },
    agents: { planner: { stiggContext: { agentId: 'agent-1' }, tools: { web_search: credits } } },
  });
  return { stigg, middleware, step: { agent: 'planner', customerId: CUSTOMER } };
}

describe('OpenTelemetry spans', () => {
  beforeEach(() => exporter.reset());

  it('reports an allowed check under the SDK scope, with who it was for and what it found', async () => {
    const { middleware, step } = await graph(100);

    await middleware.startModel('m1', step, 'harness.model');

    const [check] = spans('stigg.check');
    assert.ok(check, 'a stigg.check span');
    assert.equal(check.instrumentationScope.name, '@stigg/agent-sdk-js');
    assert.equal(check.status.code, SpanStatusCode.UNSET);
    assert.equal(check.attributes['stigg.customer.id'], CUSTOMER);
    assert.equal(check.attributes['gen_ai.agent.name'], 'planner');
    assert.equal(check.attributes['stigg.agent.id'], 'agent-1');
    assert.equal(check.attributes['stigg.entitlement.id'], 'credits');
    assert.equal(check.attributes['stigg.decision.has_access'], true);
    assert.equal(typeof check.attributes['stigg.decision.remaining'], 'number');
  });

  it('marks a refusal as an error, with the AccessDeniedError a vendor can show', async () => {
    const { middleware, step } = await graph(0);

    await assert.rejects(middleware.startModel('m1', step, 'harness.model'));

    const [check] = spans('stigg.check');
    assert.equal(check?.status.code, SpanStatusCode.ERROR);
    assert.equal(check?.attributes['stigg.decision.has_access'], false);
    assert.equal(check?.attributes['stigg.decision.denied_by'], 'agent-1');
    const exception = check?.events.find((event) => event.name === 'exception');
    assert.equal(exception?.attributes?.['exception.type'], 'AccessDeniedError');
  });

  it('names a paid tool on its check, under the GenAI convention', async () => {
    const { middleware, step } = await graph(100);

    await middleware.startTool('t1', { name: 'web_search', callId: 'call_1' }, step);

    assert.equal(spans('stigg.check')[0]?.attributes['gen_ai.tool.name'], 'web_search');
  });

  it('reports each ingest with what it reported', async () => {
    const { stigg, middleware, step } = await graph(100);

    await middleware.startModel('m1', step, 'harness.model');
    await middleware.endModel('m1', { usage: { input: 900, output: 100, cacheRead: 0, cacheCreate: 0 } });
    await stigg.flush();

    const [ingest] = spans('stigg.ingest');
    assert.ok(ingest, 'a stigg.ingest span');
    assert.equal(ingest.attributes['stigg.ingest.ok'], true);
    assert.equal(ingest.attributes['stigg.metric.credits'], 1);
    assert.equal(ingest.attributes['gen_ai.agent.name'], 'planner');
  });

  it('emits nothing outside an orchestrator - a check or report made without the middleware', async () => {
    const { stigg } = await newStigg({ agentBudget: 100 });

    await stigg.check({ customerId: CUSTOMER, entitlement: credits });
    await stigg.report({ customerId: CUSTOMER, entitlement: credits, ingestMode: 'sync' }, { credits: 1 });
    await stigg.flush();

    assert.deepEqual(exporter.getFinishedSpans(), []);
  });
});
