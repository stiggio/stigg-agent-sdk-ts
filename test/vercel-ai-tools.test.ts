/**
 * Paid tools on the Vercel AI SDK: `stiggVercelMiddleware({ tools }).tools(...)`, run by the AI SDK's
 * own tool loop, on `ai` 7 and `ai` 6. Most tests record what the binding asks of the core; the last
 * ones run against the mock Stigg server.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateText, stepCountIs, streamText, tool, wrapLanguageModel } from 'ai';
import * as v6 from 'ai-v6';
import { z } from 'zod';
import { AccessDeniedError, isAccessDenied, stiggVercelMiddleware } from '../src';
import { newStigg } from './stigg-harness';
import { seedBudget } from '../testing/mock-stigg-server';

const CUSTOMER = 'customer-acme';
const credits = { currencyId: 'credits' } as const;
const USAGE = { inputTokens: { total: 3, noCache: 3 }, outputTokens: { total: 2 } };
const toolCall = (toolCallId = 'call_1', toolName = 'web_search') => ({
  type: 'tool-call',
  toolCallId,
  toolName,
  input: '{"query":"q"}',
});

/** A model that asks for `web_search` on its first step and answers on the next, recording each prompt. */
function toolCallingModel(specificationVersion = 'v4', closeAfterMs?: number, toolCallId = 'call_1') {
  const prompts: unknown[] = [];
  const reply = () =>
    prompts.length === 1
      ? { content: [toolCall(toolCallId)], finishReason: { unified: 'tool-calls', raw: 'tool_use' } }
      : { content: [{ type: 'text', text: 'done' }], finishReason: { unified: 'stop', raw: 'stop' } };
  const model = {
    specificationVersion,
    provider: 'fake',
    modelId: 'fake-1',
    supportedUrls: {},
    doGenerate: async ({ prompt }: { prompt: unknown }) => {
      prompts.push(prompt);
      return { ...reply(), usage: USAGE, response: { id: `resp_${prompts.length}` }, warnings: [] };
    },
    doStream: async ({ prompt }: { prompt: unknown }) => {
      prompts.push(prompt);
      const { content, finishReason } = reply();
      const text = content[0]?.type === 'text';
      const parts = [
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: `resp_${prompts.length}` },
        ...(text
          ? [
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'done' },
              { type: 'text-end', id: 't' },
            ]
          : content),
        { type: 'finish', finishReason, usage: USAGE },
      ];
      if (closeAfterMs === undefined) {
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const part of parts) controller.enqueue(part);
              controller.close();
            },
          }),
        };
      }
      // As an HTTP provider's stream is: read part by part, and closed on a later read than `finish`.
      let next = 0;
      return {
        stream: new ReadableStream({
          async pull(controller) {
            if (next < parts.length) return controller.enqueue(parts[next++]);
            await new Promise((resolve) => setTimeout(resolve, closeAfterMs));
            controller.close();
          },
        }),
      };
    },
  };
  return { model, prompts };
}

/** A stand-in for `stigg`, recording what the binding asks of the core, in order. */
function fakeStigg(overrides: Record<string, unknown> = {}) {
  const log: unknown[][] = [];
  const core = {
    stigg: {},
    startModel: async () => void log.push(['startModel']),
    endModel: async () => void log.push(['endModel']),
    startTool: async (_runId: string, step: { name?: string; callId?: string; input?: unknown }, attribution: any) =>
      void log.push(['startTool', step.name, step.callId, step.input, attribution.stiggContexts]),
    endTool: async (_runId: string, output: unknown, name?: string) => void log.push(['endTool', name, output]),
    abandon: () => void log.push(['abandon']),
    ...overrides,
  };
  let options: any;
  const warnings: string[] = [];
  const stigg = {
    config: { logger: { warn: (message: string) => warnings.push(message) } },
    middleware: (given: unknown) => {
      options = given;
      return core;
    },
  };
  return { log, warnings, stigg: stigg as never, options: () => options };
}

/** The tools, governed, and a model behind the same middleware. */
function governed(
  overrides: Record<string, unknown> = {},
  execute?: (input: { query: string }) => unknown,
  closeAfterMs?: number,
) {
  const fake = fakeStigg(overrides);
  const middleware = stiggVercelMiddleware({ stigg: fake.stigg, tools: { web_search: credits } });
  const { model, prompts } = toolCallingModel('v4', closeAfterMs);
  const ran: unknown[] = [];
  const tools = middleware.tools({
    web_search: tool({
      description: 'Search the web.',
      inputSchema: z.object({ query: z.string() }),
      execute: execute ?? (async (input) => (ran.push(input), 'result')),
    }),
  });
  return { ...fake, ran, prompts, tools, model: wrapLanguageModel({ model: model as never, middleware }) };
}

const request = { providerOptions: { stigg: { customerId: CUSTOMER } }, prompt: 'hi', stopWhen: stepCountIs(3) };

describe('stiggVercelMiddleware().tools() - paid tools', () => {
  it('checks a tool before it runs and reports it after, as the step that asked for it', async () => {
    const { log, ran, model, tools, options } = governed();

    await generateText({ model, tools, ...request });

    assert.deepEqual(options().tools, { web_search: credits });
    assert.deepEqual(ran, [{ query: 'q' }]);
    assert.deepEqual(log, [
      ['startModel'],
      ['endModel'],
      ['startTool', 'web_search', 'call_1', { query: 'q' }, [{ customerId: CUSTOMER }]],
      ['endTool', 'web_search', 'result'],
      ['startModel'],
      ['endModel'],
    ]);
  });

  it('knows who a streamed tool call is for, and checks it only once that step has reported', async () => {
    const { log, model, tools } = governed({
      // Lands late: a tool checked without waiting would be checked first.
      endModel: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        log.push(['endModel']);
      },
    });

    const result = streamText({ model, tools, ...request });
    await result.consumeStream();

    assert.deepEqual(log.slice(0, 3), [
      ['startModel'],
      ['endModel'],
      ['startTool', 'web_search', 'call_1', { query: 'q' }, [{ customerId: CUSTOMER }]],
    ]);
  });

  for (const closeAfterMs of [0, 50]) {
    it(`checks a streamed tool after its step reported, though the stream closes ${closeAfterMs}ms later`, async () => {
      const { log, model, tools } = governed({}, undefined, closeAfterMs);

      await streamText({ model, tools, ...request }).consumeStream();

      assert.deepEqual(
        log.map(([step]) => step),
        ['startModel', 'endModel', 'startTool', 'endTool', 'startModel', 'endModel'],
      );
    });
  }

  it('does not run a refused tool in a stream either', async () => {
    const decision = { hasAccess: false, reason: 'BudgetExceeded' } as never;
    const { ran, model, tools } = governed({
      startTool: async () => {
        throw new AccessDeniedError(decision);
      },
    });

    const result = streamText({ model, tools, ...request });
    await result.consumeStream();

    assert.deepEqual(ran, []);
    const failed = (await result.steps).flatMap((step) => step.content).find((part) => part.type === 'tool-error');
    assert.equal((failed as { error: Error }).error.message, 'web_search is not available: BudgetExceeded.');
  });

  it('does not run a refused tool, and tells the model why without naming who refused', async () => {
    const decision = { hasAccess: false, reason: 'BudgetExceeded', deniedBy: 'agent-secret-id' } as never;
    const { log, ran, model, tools, prompts } = governed({
      startTool: async () => {
        throw new AccessDeniedError(decision);
      },
    });

    const result = await generateText({ model, tools, ...request });

    assert.deepEqual(ran, []);
    assert.equal(log.filter(([step]) => step === 'endTool').length, 0);
    const failed = result.steps.flatMap((step) => step.content).find((part) => part.type === 'tool-error');
    const error = (failed as { error: Error }).error;
    assert.equal(error.message, 'web_search is not available: BudgetExceeded.');
    assert.equal(isAccessDenied(error), decision, 'the decision rides along, for stigg.denial()');
    // The model read the message, and nothing of who refused.
    const seen = JSON.stringify(prompts[1]);
    assert.match(seen, /web_search is not available: BudgetExceeded/);
    assert.doesNotMatch(seen, /agent-secret-id/);
  });

  it('passes on an error that is not a refusal, as it was thrown', async () => {
    const { model, tools } = governed({
      startTool: async () => {
        throw new Error('No customerId for this call.');
      },
    });

    const result = await generateText({ model, tools, ...request });

    const failed = result.steps.flatMap((step) => step.content).find((part) => part.type === 'tool-error');
    assert.equal((failed as { error: Error }).error.message, 'No customerId for this call.');
  });

  it('reports nothing for a tool that throws, and passes the error on', async () => {
    const { log, model, tools } = governed({}, async () => {
      throw new Error('search is down');
    });

    const result = await generateText({ model, tools, ...request });

    assert.deepEqual(
      log.filter(([step]) => step === 'abandon' || step === 'endTool'),
      [['abandon']],
    );
    const failed = result.steps.flatMap((step) => step.content).find((part) => part.type === 'tool-error');
    assert.equal((failed as { error: Error }).error.message, 'search is down');
  });

  it('streams an async generator through, and reports its last result', async () => {
    const { log, model, tools } = governed({}, async function* () {
      yield 'searching';
      yield 'found';
    } as never);

    const result = await generateText({ model, tools, ...request });

    assert.deepEqual(
      log.find(([step]) => step === 'endTool'),
      ['endTool', 'web_search', 'found'],
    );
    const output = result.steps.flatMap((step) => step.content).find((part) => part.type === 'tool-result');
    assert.equal((output as { output: unknown }).output, 'found');
  });

  it('runs an async iterable a plain function returns, and answers with its last value', async () => {
    const { log, model, tools } = governed({}, () =>
      (async function* () {
        yield 'searching';
        yield 'found';
      })(),
    );

    const result = await generateText({ model, tools, ...request });

    assert.deepEqual(
      log.find(([step]) => step === 'endTool'),
      ['endTool', 'web_search', 'found'],
    );
    const output = result.steps.flatMap((step) => step.content).find((part) => part.type === 'tool-result');
    assert.equal((output as { output: unknown }).output, 'found');
  });

  it('lets go of a generator its reader stops, and reports nothing for it', async () => {
    const { log, tools } = governed({}, async function* () {
      yield 'searching';
      yield 'found';
    } as never);

    const run = tools.web_search.execute!({ query: 'q' }, {
      toolCallId: 'x',
      messages: [],
    } as never) as AsyncIterable<unknown>;
    for await (const first of run) if (first) break;

    assert.deepEqual(log.at(-1), ['abandon']);
  });

  it("keeps a tool's other fields, and leaves a tool with no execute as it is", () => {
    const middleware = stiggVercelMiddleware({ stigg: fakeStigg().stigg, tools: { '*': credits } });
    const clientSide = { description: 'Ask the user.', inputSchema: z.object({}) };
    const search = { description: 'Search.', needsApproval: true, execute: async () => 'x' };

    const tools = middleware.tools({ ask: clientSide, search });

    assert.equal(tools.ask, clientSide);
    assert.equal(tools.search.description, 'Search.');
    assert.equal(tools.search.needsApproval, true);
    assert.notEqual(tools.search.execute, search.execute);
  });

  it('throws when the middleware was given no tools to govern', () => {
    const middleware = stiggVercelMiddleware({ stigg: fakeStigg().stigg });

    assert.throws(() => middleware.tools({}), /needs a `tools` option/);
  });

  it("governs an approved tool, run before any model step, as its own context's customer", async () => {
    const fake = fakeStigg();
    const middleware = stiggVercelMiddleware({ stigg: fake.stigg, tools: { web_search: credits } });
    const { model } = toolCallingModel();
    const tools = middleware.tools({
      web_search: tool({
        inputSchema: z.object({ query: z.string() }),
        needsApproval: true,
        execute: async () => 'result',
      }),
    });
    const wrapped = wrapLanguageModel({ model: model as never, middleware });
    const toolsContext = { web_search: { stigg: { customerId: CUSTOMER } } };

    // The first call stops at the approval request; the tool has not run.
    const first = await generateText({ model: wrapped, tools, toolsContext, ...request } as never);
    const approval = first.content.find((part) => part.type === 'tool-approval-request') as { approvalId: string };
    assert.ok(approval, 'the first call asks for approval');
    fake.log.length = 0;

    // The next call carries the approval: the AI SDK runs the tool before any model step.
    await generateText({
      model: wrapped,
      tools,
      toolsContext,
      providerOptions: { stigg: { customerId: CUSTOMER } },
      messages: [
        { role: 'user', content: 'hi' },
        ...first.response.messages,
        {
          role: 'tool',
          content: [{ type: 'tool-approval-response', approvalId: approval.approvalId, approved: true }],
        },
      ],
    } as never);

    assert.deepEqual(fake.log[0], ['startTool', 'web_search', 'call_1', { query: 'q' }, [{ customerId: CUSTOMER }]]);
    assert.deepEqual(fake.warnings, []);
  });

  it("reads an approved tool's customer from experimental_context, as ai 6 passes it", async () => {
    const { log, tools, warnings } = governed();

    await tools.web_search.execute!({ query: 'q' }, {
      toolCallId: 'approved',
      messages: [],
      experimental_context: { stigg: { customerId: CUSTOMER } },
    } as never);

    assert.deepEqual(log[0], ['startTool', 'web_search', 'approved', { query: 'q' }, [{ customerId: CUSTOMER }]]);
    assert.deepEqual(warnings, []);
  });

  it('refuses a tool context whose stigg is not an object, before the tool runs', async () => {
    const { ran, tools } = governed();

    await assert.rejects(
      Promise.resolve(
        tools.web_search.execute!({ query: 'q' }, {
          toolCallId: 'x',
          messages: [],
          context: { stigg: 'acme' },
        } as never),
      ),
      /must be a stiggContext object/,
    );
    assert.deepEqual(ran, []);
  });

  it('governs a tool whose call it never saw as the middleware itself, and says so once', async () => {
    const { log, tools, warnings } = governed();

    await tools.web_search.execute!({ query: 'q' }, { toolCallId: 'unknown', messages: [] } as never);

    assert.deepEqual(log[0], ['startTool', 'web_search', 'unknown', { query: 'q' }, []]);
    await tools.web_search.execute!({ query: 'q' }, { toolCallId: 'unknown-2', messages: [] } as never);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /tool "web_search" ran without a model step/);
  });
});

describe('paid tools against Stigg', () => {
  async function run(ai: { generateText: any; wrapLanguageModel: any; stepCountIs: any }, version: string) {
    const { stigg } = await newStigg();
    const middleware = stiggVercelMiddleware({
      stigg,
      stiggContext: { entitlement: credits, ingestMode: 'sync' },
      tools: { web_search: credits },
    });
    const { model } = toolCallingModel(version);
    const tools = middleware.tools({
      web_search: { inputSchema: z.object({ query: z.string() }), execute: async () => 'result' },
    });
    await ai.generateText({
      model: ai.wrapLanguageModel({ model, middleware }),
      tools,
      ...request,
      stopWhen: ai.stepCountIs(3),
    });
    return middleware.stigg.flush();
  }

  it('reports both model calls and the tool on ai 7', async () => {
    const summary = await run({ generateText, wrapLanguageModel, stepCountIs }, 'v4');
    assert.equal(summary.ingested, 3);
    assert.equal(summary.ingestFailures, 0);
  });

  it('reports both model calls and the tool on ai 6', async () => {
    const summary = await run(v6, 'v3');
    assert.equal(summary.ingested, 3);
    assert.equal(summary.ingestFailures, 0);
  });
});

/** Each AI SDK major, and where it hands a tool its own context. */
const MAJORS = [
  {
    major: 'ai 7',
    ai: { generateText, streamText, wrapLanguageModel, stepCountIs },
    version: 'v4',
    toolContext: (stigg: object) => ({ toolsContext: { web_search: { stigg } } }),
  },
  {
    major: 'ai 6',
    ai: v6 as unknown as { generateText: any; streamText: any; wrapLanguageModel: any; stepCountIs: any },
    version: 'v3',
    toolContext: (stigg: object) => ({ experimental_context: { stigg } }),
  },
];

for (const { major, ai, version, toolContext } of MAJORS) {
  describe(`paid tools through the AI SDK's own loop, on ${major}`, () => {
    /** As `governed()`, on this major. */
    function governedOn(overrides: Record<string, unknown> = {}, closeAfterMs?: number, needsApproval = false) {
      const fake = fakeStigg(overrides);
      const middleware = stiggVercelMiddleware({ stigg: fake.stigg, tools: { web_search: credits } });
      const { model } = toolCallingModel(version, closeAfterMs);
      const ran: unknown[] = [];
      const tools = middleware.tools({
        web_search: {
          inputSchema: z.object({ query: z.string() }),
          needsApproval,
          execute: async (input: unknown) => (ran.push(input), 'result'),
        },
      });
      return { ...fake, ran, tools, model: ai.wrapLanguageModel({ model, middleware }) };
    }
    const call = { ...request, stopWhen: ai.stepCountIs(3) };

    it('checks a streamed tool after its step reported, though the stream closes later', async () => {
      const { log, model, tools } = governedOn({}, 50);

      await ai.streamText({ model, tools, ...call }).consumeStream();

      assert.deepEqual(
        log.map(([step]) => step),
        ['startModel', 'endModel', 'startTool', 'endTool', 'startModel', 'endModel'],
      );
      assert.deepEqual(log[2]?.[4], [{ customerId: CUSTOMER }]);
    });

    it('does not run a refused tool in a stream', async () => {
      const { ran, model, tools } = governedOn({
        startTool: async () => {
          throw new AccessDeniedError({ hasAccess: false, reason: 'BudgetExceeded' } as never);
        },
      });

      const result = ai.streamText({ model, tools, ...call });
      await result.consumeStream();

      assert.deepEqual(ran, []);
      const steps: { content: { type: string; error?: Error }[] }[] = await result.steps;
      const failed = steps.flatMap((step) => step.content).find((part) => part.type === 'tool-error');
      assert.equal(failed?.error?.message, 'web_search is not available: BudgetExceeded.');
    });

    it("governs an approved tool as its own context's customer", async () => {
      const { log, model, tools, warnings, ran } = governedOn({}, undefined, true);
      const context = toolContext({ customerId: CUSTOMER });

      const first = await ai.generateText({ model, tools, ...context, ...call });
      const approval = first.content.find((part: { type: string }) => part.type === 'tool-approval-request');
      assert.ok(approval, 'the first call asks for approval');
      assert.deepEqual(ran, []);
      log.length = 0;

      await ai.generateText({
        model,
        tools,
        ...context,
        providerOptions: call.providerOptions,
        stopWhen: call.stopWhen,
        messages: [
          { role: 'user', content: 'hi' },
          ...first.response.messages,
          {
            role: 'tool',
            content: [{ type: 'tool-approval-response', approvalId: approval.approvalId, approved: true }],
          },
        ],
      });

      assert.deepEqual(ran, [{ query: 'q' }]);
      assert.deepEqual(log[0], ['startTool', 'web_search', 'call_1', { query: 'q' }, [{ customerId: CUSTOMER }]]);
      assert.deepEqual(warnings, []);
    });
  });
}

describe('which tool calls are remembered, and which tools are wrapped', () => {
  /** A middleware whose model step asks for the given tool calls, run through `wrapGenerate`. */
  async function asked(parts: object[], tools: Record<string, unknown> = { web_search: credits }) {
    const fake = fakeStigg();
    const middleware = stiggVercelMiddleware({ stigg: fake.stigg, tools: tools as never });
    const governed = middleware.tools({ web_search: { execute: async (..._args: unknown[]) => 'result' } });
    const params = await middleware.transformParams({
      params: { providerOptions: { stigg: { customerId: CUSTOMER } } },
    });
    await middleware.wrapGenerate({ doGenerate: async () => ({ content: parts, usage: USAGE }), params });
    const run = async (toolCallId: string) => {
      fake.log.length = 0;
      await governed.web_search.execute({ query: 'q' }, { toolCallId, messages: [] });
      return fake.log[0]?.[4];
    };
    return { ...fake, run };
  }

  it('takes a remembered call once: the same id run again is one no step asked for', async () => {
    const { run } = await asked([toolCall('call_1')]);

    assert.deepEqual(await run('call_1'), [{ customerId: CUSTOMER }]);
    assert.deepEqual(await run('call_1'), []);
  });

  it('forgets the oldest call past 1,000', async () => {
    const parts = [toolCall('first'), ...Array.from({ length: 1_000 }, (_, i) => toolCall(`call_${i}`))];
    const { run } = await asked(parts);

    assert.deepEqual(await run('first'), []);
    assert.deepEqual(await run('call_999'), [{ customerId: CUSTOMER }]);
  });

  it('does not remember a call the provider runs, nor one to a tool it did not wrap', async () => {
    const others = Array.from({ length: 1_000 }, (_, i) => toolCall(`other_${i}`, 'calculator'));
    const { run } = await asked([{ ...toolCall('provider'), providerExecuted: true }, toolCall('first'), ...others]);

    assert.deepEqual(await run('provider'), []);
    assert.deepEqual(await run('first'), [{ customerId: CUSTOMER }], 'unwrapped calls did not push it out');
  });

  it('leaves an exempt tool, and one the config does not cover, as they are', () => {
    const middleware = stiggVercelMiddleware({
      stigg: fakeStigg().stigg,
      tools: { web_search: credits, writer: false },
    });
    const writer = { execute: async () => 'x' };
    const lookup = { execute: async () => 'y' };

    const tools = middleware.tools({ web_search: { execute: async () => 'z' }, writer, lookup });

    assert.equal(tools.writer, writer);
    assert.equal(tools.lookup, lookup);
    assert.notEqual(tools.web_search.execute, undefined);
  });

  it("wraps every tool under '*' except the ones set to false", () => {
    const middleware = stiggVercelMiddleware({ stigg: fakeStigg().stigg, tools: { '*': credits, writer: false } });
    const writer = { execute: async () => 'x' };
    const lookup = { execute: async () => 'y' };

    const tools = middleware.tools({ writer, lookup });

    assert.equal(tools.writer, writer);
    assert.notEqual(tools.lookup, lookup);
  });

  it('throws for an empty tools config too', () => {
    const middleware = stiggVercelMiddleware({ stigg: fakeStigg().stigg, tools: {} });

    assert.throws(() => middleware.tools({}), /needs a `tools` option/);
  });
});

describe('edges of a governed tool', () => {
  it('runs the tool when the logger that warns throws', async () => {
    const fake = fakeStigg();
    (fake.stigg as any).config.logger.warn = () => {
      throw new Error('logger down');
    };
    const middleware = stiggVercelMiddleware({ stigg: fake.stigg, tools: { web_search: credits } });
    const tools = middleware.tools({ web_search: { execute: async (..._args: unknown[]) => 'result' } });

    assert.equal(await tools.web_search.execute({}, { toolCallId: 'x', messages: [] }), 'result');
  });

  it("ignores a context `stigg` that is not a plain object - ai 6's may be the SDK itself - and warns", async () => {
    const { log, tools, warnings } = governed();

    await tools.web_search.execute!({ query: 'q' }, {
      toolCallId: 'x',
      messages: [],
      experimental_context: { stigg: new (class StiggAgentSDK {})() },
    } as never);

    assert.deepEqual(log[0]?.[4], []);
    assert.equal(warnings.length, 1);
  });

  it("says 'access denied' when the decision gives no reason", async () => {
    const { tools } = governed({
      startTool: async () => {
        throw new AccessDeniedError({ hasAccess: false } as never);
      },
    });

    await assert.rejects(
      Promise.resolve(tools.web_search.execute!({ query: 'q' }, { toolCallId: 'x', messages: [] } as never)),
      /^Error: web_search is not available: access denied\.$/,
    );
  });

  it('does not start a refused generator', async () => {
    let started = false;
    const { tools } = governed(
      {
        startTool: async () => {
          throw new AccessDeniedError({ hasAccess: false, reason: 'BudgetExceeded' } as never);
        },
      },
      async function* () {
        started = true;
        yield 'found';
      } as never,
    );

    const run = tools.web_search.execute!({ query: 'q' }, {
      toolCallId: 'x',
      messages: [],
    } as never) as AsyncIterable<unknown>;
    await assert.rejects(async () => {
      for await (const value of run) void value;
    }, /web_search is not available: BudgetExceeded/);
    assert.equal(started, false);
  });

  it('lets go of a generator that throws after a result, and reports nothing', async () => {
    const { log, tools } = governed({}, async function* () {
      yield 'searching';
      throw new Error('search is down');
    } as never);

    const run = tools.web_search.execute!({ query: 'q' }, {
      toolCallId: 'x',
      messages: [],
    } as never) as AsyncIterable<unknown>;
    await assert.rejects(async () => {
      for await (const value of run) void value;
    }, /search is down/);
    assert.deepEqual(
      log.filter(([step]) => step === 'abandon' || step === 'endTool'),
      [['abandon']],
    );
  });

  it('keeps two customers apart on one middleware, their calls in flight at once', async () => {
    const fake = fakeStigg();
    const middleware = stiggVercelMiddleware({ stigg: fake.stigg, tools: { web_search: credits } });
    const tools = middleware.tools({
      web_search: tool({ inputSchema: z.object({ query: z.string() }), execute: async () => 'result' }),
    });
    const run = (customerId: string, toolCallId: string) =>
      generateText({
        model: wrapLanguageModel({ model: toolCallingModel('v4', undefined, toolCallId).model as never, middleware }),
        tools,
        ...request,
        providerOptions: { stigg: { customerId } },
      });

    await Promise.all([run(CUSTOMER, 'call_a'), run('customer-globex', 'call_b')]);

    const checked = Object.fromEntries(
      fake.log.filter(([step]) => step === 'startTool').map((entry) => [entry[2], entry[4]]),
    );
    assert.deepEqual(checked, { call_a: [{ customerId: CUSTOMER }], call_b: [{ customerId: 'customer-globex' }] });
  });
});

describe('a tool Stigg itself refuses', () => {
  it('fails with the neutral message, the decision as its cause, while the model call goes on', async () => {
    const { stigg, mock } = await newStigg();
    seedBudget(mock.state, CUSTOMER, {
      entityId: 'agent-a',
      entityTypeId: 'agent',
      capabilityId: 'credits',
      usageLimit: 0,
    });
    // The model is metered and never checked; the tool is checked against the agent's empty budget.
    const middleware = stiggVercelMiddleware({
      stigg,
      stiggContext: { agentId: 'agent-a', attributionKey: 'agentId', ingestMode: 'sync' },
      tools: { web_search: credits },
    });
    const ran: unknown[] = [];
    const tools = middleware.tools({
      web_search: tool({
        inputSchema: z.object({ query: z.string() }),
        execute: async (input) => (ran.push(input), 'r'),
      }),
    });

    const result = await generateText({
      model: wrapLanguageModel({ model: toolCallingModel().model as never, middleware }),
      tools,
      ...request,
    });

    assert.deepEqual(ran, []);
    const failed = result.steps.flatMap((step) => step.content).find((part) => part.type === 'tool-error');
    const error = (failed as { error: Error }).error;
    assert.match(error.message, /^web_search is not available: /);
    assert.equal(isAccessDenied(error)?.hasAccess, false);
    assert.ok(error.cause instanceof AccessDeniedError);
    assert.equal(result.text, 'done', 'the model answered after the refusal');
  });
});
