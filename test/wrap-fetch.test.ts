/**
 * The fetch binding - the client binding's gate and meter, reached through plain HTTP.
 *
 * These pin that a raw request to a governed route is treated exactly like the same call through
 * a wrapped SDK client - checked first, refused before anything leaves, metered from a JSON reply
 * and from an SSE one, under the same event name - and that everything else the `fetch` reaches
 * passes through untouched.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { wrapFetch } from '../src/bindings/fetch/wrap-fetch';
import { agentgatewayRecipe } from '../src/bindings/client/gateways/agentgateway/agentgateway-recipe';
import { openAIRecipe } from '../src/bindings/client/providers/openai/openai-recipe';
import { isAccessDenied } from '../src/errors';
import { resolveContext } from '../src/core/context';
import { vendorMetrics } from '../src/types';
import { newRun } from './session-harness';
import { FakeEngine } from './fake-engine';
import type { ClientRecipe } from '../src/bindings/client/core/types';
import type { EngineReportParams } from '../src/engine/engine';
import type { FetchLike } from '../src/bindings/fetch/types';

const GATEWAY = 'http://agentgateway.internal:8080';
const CHAT = `${GATEWAY}/v1/chat/completions`;
const USAGE = { prompt_tokens: 50, completion_tokens: 45, total_tokens: 95 };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sse = (events: unknown[]) => {
  const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  // Split mid-event and across a CRLF, the way a real body arrives in arbitrary reads.
  const bytes = new TextEncoder().encode(text.replace(/\n/g, '\r\n'));
  const cut = Math.floor(bytes.length / 3);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
};

const MESSAGE_START = {
  type: 'message_start',
  message: { id: 'msg-1', model: 'claude-sonnet-5', usage: { input_tokens: 70, output_tokens: 1 } },
};
const TEXT_DELTA = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } };

/** An SSE body that sends each event as its own read and then stays open - or fails, if given an error. */
const openSse = (events: unknown[], failure?: Error) => {
  let i = 0;
  return new Response(
    new ReadableStream(
      {
        pull(controller) {
          if (i < events.length)
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(events[i++])}\n\n`));
          else if (failure) controller.error(failure);
          // Neither done nor failed: a connection still open, waiting on the gateway.
          else return new Promise<void>(() => undefined);
          return undefined;
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { 'content-type': 'text/event-stream' } },
  );
};

function harness(reply: () => Response, options: { usageLimit?: number | null; baseUrl?: string } = {}) {
  const engine = new FakeEngine({ usageLimit: options.usageLimit === undefined ? null : options.usageLimit });
  const sent: EngineReportParams[] = [];
  const report = engine.report.bind(engine);
  engine.report = (customerId, params) => {
    sent.push(params);
    return report(customerId, params);
  };
  const run = newRun({ engine, usageMapper: vendorMetrics, ingestMode: 'async', checkErrorAction: 'deny' });
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    requests.push({ url: String(input instanceof Request ? input.url : input), init });
    return reply();
  };
  const governed = wrapFetch(
    fetchFn,
    agentgatewayRecipe() as ClientRecipe,
    options.baseUrl ?? GATEWAY,
    run.session,
    run.context,
  );
  return { engine, run, sent, requests, governed };
}

const post = (body: unknown, extra: Record<string, unknown> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  ...extra,
});

describe('a governed request', () => {
  it('is checked, sent, and metered from its JSON reply under the method’s event name', async () => {
    const { governed, engine, run, sent, requests } = harness(() =>
      json({ id: 'chatcmpl-1', model: 'gpt-5-mini-2025-08-07', usage: USAGE }),
    );
    const response = await governed(CHAT, post({ model: 'gpt-5-mini', messages: [] }));
    await run.drain();

    assert.equal(requests.length, 1);
    assert.equal(engine.checks, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.event?.name, 'agentgateway.chat.completions.create');
    assert.equal(sent[0]!.metrics.total_tokens, 95);
    assert.equal(sent[0]!.dimensions.model, 'gpt-5-mini-2025-08-07');
    assert.equal(sent[0]!.idempotencyKey, 'chatcmpl-1');
    // The caller's body is untouched - the meter read a copy.
    assert.equal(((await response.json()) as { id: string }).id, 'chatcmpl-1');
  });

  it('is refused before anything leaves when the budget is spent', async () => {
    const { governed, requests, sent } = harness(() => json({ usage: USAGE }), { usageLimit: 0 });
    await assert.rejects(
      () => governed(CHAT, post({ model: 'x', messages: [] })),
      (err) => isAccessDenied(err)?.hasAccess === false,
    );
    assert.equal(requests.length, 0, 'no spend was attempted');
    assert.equal(sent.length, 0);
  });

  it('takes a per-request context off the init, and never sends it', async () => {
    const { governed, engine, requests, run } = harness(() => json({ usage: USAGE }));
    await governed(CHAT, post({ model: 'x', messages: [] }, { stiggContext: { dimensions: { agentId: 'per-call' } } }));
    await run.drain();
    assert.equal(engine.dimensionsSeen.at(-1)?.agentId, 'per-call');
    assert.equal('stiggContext' in (requests[0]!.init ?? {}), false);
  });

  it('strips an explicit stiggContext: undefined too, because presence is what is not the wire’s', async () => {
    const { governed, requests } = harness(() => json({ usage: USAGE }));
    await governed(CHAT, post({ model: 'x', messages: [] }, { stiggContext: undefined }));
    assert.equal('stiggContext' in (requests[0]!.init ?? {}), false);
  });

  it('recognises a stream whatever case its media type is written in', async () => {
    const { governed, run, sent } = harness(() => {
      const reply = sse([{ id: 'c-1', model: 'm', choices: [], usage: USAGE }, '[DONE]']);
      return new Response(reply.body, { headers: { 'content-type': 'Text/Event-Stream; charset=utf-8' } });
    });
    const response = await governed(CHAT, post({ model: 'x', stream: true, messages: [] }));
    await response.text();
    await run.drain();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.metrics.total_tokens, 95);
  });

  it('meters a streamed reply as the caller reads it, and hands back every byte', async () => {
    const { governed, run, sent } = harness(() =>
      sse([
        { id: 'c-1', model: 'gpt-5-mini-2025-08-07', choices: [{ delta: { content: 'hi' } }] },
        { id: 'c-1', model: 'gpt-5-mini-2025-08-07', choices: [], usage: USAGE },
        '[DONE]',
      ]),
    );
    const response = await governed(CHAT, post({ model: 'x', stream: true, messages: [] }));
    assert.equal(sent.length, 0, 'nothing is known until the body is read');

    const text = await response.text();
    await run.drain();

    assert.match(text, /\[DONE\]/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.metrics.total_tokens, 95);
    assert.equal(sent[0]!.dimensions.model, 'gpt-5-mini-2025-08-07');
  });

  it('meters an Anthropic Messages stream through the same recipe reader', async () => {
    const { governed, run, sent } = harness(() =>
      sse([
        {
          type: 'message_start',
          message: { id: 'msg-1', model: 'claude-sonnet-5', usage: { input_tokens: 70, output_tokens: 1 } },
        },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
        { type: 'message_delta', usage: { output_tokens: 30 } },
        { type: 'message_stop' },
      ]),
    );
    const response = await governed(`${GATEWAY}/v1/messages`, post({ model: 'x', stream: true, max_tokens: 10 }));
    await response.text();
    await run.drain();

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.event?.name, 'agentgateway.messages.create');
    assert.equal(sent[0]!.metrics.input_tokens, 70);
    assert.equal(sent[0]!.metrics.output_tokens, 30);
    assert.equal(sent[0]!.dimensions.model, 'claude-sonnet-5');
  });

  it('meters nothing for a stream cancelled before anything was read', async () => {
    const { governed, engine, run, sent } = harness(() => sse([{ id: 'c-1', model: 'm', choices: [], usage: USAGE }]));
    const response = await governed(CHAT, post({ model: 'x', stream: true, messages: [] }));
    await response.body!.cancel();
    await run.drain();
    assert.equal(engine.checks, 1);
    assert.equal(sent.length, 0, 'no zero-token ingest');
  });

  it('refuses a null per-request context, as a wrapped client does', async () => {
    const { governed, requests } = harness(() => json({ usage: USAGE }));
    await assert.rejects(() => governed(CHAT, post({ model: 'x', messages: [] }, { stiggContext: null })));
    assert.equal(requests.length, 0);
  });

  it('reads a JSON Blob body for the estimate, and still sends it', async () => {
    const seen: unknown[] = [];
    const recipe = agentgatewayRecipe({ estimate: (params) => (seen.push(params), 1) });
    const run = newRun({ engine: new FakeEngine({ usageLimit: null }), usageMapper: vendorMetrics });
    let sent: RequestInit['body'];
    const fetchFn: FetchLike = async (_input, init) => ((sent = init?.body), json({ usage: USAGE }));
    const governed = wrapFetch(fetchFn, recipe as ClientRecipe, GATEWAY, run.session, run.context);
    const body = new Blob([JSON.stringify({ model: 'gpt-5-mini', messages: [] })], { type: 'application/json' });
    await governed(CHAT, { method: 'POST', body });
    assert.deepEqual(seen, [{ model: 'gpt-5-mini', messages: [] }]);
    assert.equal(await (sent as Blob).text(), await body.text());
  });

  it('meters what was read when the caller cancels a stream part way', async () => {
    const { governed, run, sent } = harness(() => openSse([MESSAGE_START, TEXT_DELTA]));
    const response = await governed(`${GATEWAY}/v1/messages`, post({ model: 'x', stream: true, max_tokens: 10 }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    await run.drain();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.metrics.input_tokens, 70);
  });

  it('meters what was read when the body fails part way, and the caller still sees the failure', async () => {
    const { governed, run, sent } = harness(() => openSse([MESSAGE_START], new Error('connection reset')));
    const response = await governed(`${GATEWAY}/v1/messages`, post({ model: 'x', stream: true, max_tokens: 10 }));
    await assert.rejects(() => response.text(), /connection reset/);
    await run.drain();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.metrics.input_tokens, 70);
  });

  it('reads nothing ahead of the caller', async () => {
    let pulled = 0;
    const { governed } = harness(
      () =>
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                pulled += 1;
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(MESSAGE_START)}\n\n`));
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const response = await governed(`${GATEWAY}/v1/messages`, post({ model: 'x', stream: true, max_tokens: 10 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pulled, 0, 'nothing is read before the caller asks');
    await response.body!.getReader().read();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pulled, 1);
  });

  it('hands an estimate an empty object for a body that is not JSON, rather than failing the request', async () => {
    const seen: unknown[] = [];
    const recipe = agentgatewayRecipe({ estimate: (params) => (seen.push(params), params.max_tokens) });
    const engine = new FakeEngine({ usageLimit: null });
    const run = newRun({ engine, usageMapper: vendorMetrics });
    const requests: unknown[] = [];
    const fetchFn: FetchLike = async (input) => (requests.push(input), json({ usage: USAGE }));
    const governed = wrapFetch(fetchFn, recipe as ClientRecipe, GATEWAY, run.session, run.context);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"max_tokens": 10}'));
        controller.close();
      },
    });
    await governed(CHAT, { method: 'POST', body, duplex: 'half' } as RequestInit);
    await governed(CHAT, { method: 'POST', body: 'not json' });
    assert.deepEqual(seen, [{}, {}]);
    assert.equal(requests.length, 2, 'both requests went out');
    assert.equal(engine.checks, 2);
  });

  it('accepts a URL object, and a base URL with a path prefix', async () => {
    const { governed, run, sent, requests } = harness(() => json({ id: 'c-1', usage: USAGE }), {
      baseUrl: `${GATEWAY}/openai`,
    });
    await governed(new URL(`${GATEWAY}/openai/chat/completions`), post({ model: 'x', messages: [] }));
    await governed(`${GATEWAY}/v1/chat/completions`, post({ model: 'x', messages: [] }));
    await run.drain();
    assert.equal(requests.length, 2);
    assert.equal(sent.length, 1, 'only the request under the prefix is metered');
  });

  it('runs requests concurrently, each metered once under its own key', async () => {
    let n = 0;
    const { governed, run, sent } = harness(() => json({ id: `c-${(n += 1)}`, model: 'm', usage: USAGE }));
    await Promise.all(Array.from({ length: 5 }, () => governed(CHAT, post({ model: 'x', messages: [] }))));
    await run.drain();
    assert.equal(sent.length, 5);
    assert.equal(new Set(sent.map((params) => params.idempotencyKey)).size, 5);
  });

  it('reports a 2xx reply that is not JSON without quoting its body', async () => {
    const errors: unknown[] = [];
    const engine = new FakeEngine({ usageLimit: null });
    const run = newRun({ engine, usageMapper: vendorMetrics, onError: (err) => errors.push(err) });
    const fetchFn: FetchLike = async () => new Response('<html>secret page</html>', { status: 200 });
    const governed = wrapFetch(fetchFn, agentgatewayRecipe() as ClientRecipe, GATEWAY, run.session, run.context);
    const response = await governed(CHAT, post({ model: 'x', messages: [] }));
    assert.equal(await response.text(), '<html>secret page</html>');
    assert.equal(errors.length, 1);
    assert.doesNotMatch(String((errors[0] as Error).message), /secret/);
  });

  it('sends a passthrough request unchecked and unmetered', async () => {
    const recipe: ClientRecipe = {
      ...(agentgatewayRecipe() as ClientRecipe),
      methods: (agentgatewayRecipe() as ClientRecipe).methods.map((method) => ({
        ...method,
        passthrough: (params: any) => params.skip === true,
      })),
    };
    const engine = new FakeEngine({ usageLimit: 0 });
    const run = newRun({ engine, usageMapper: vendorMetrics });
    let requests = 0;
    const governed = wrapFetch(
      async () => ((requests += 1), json({ usage: USAGE })),
      recipe,
      GATEWAY,
      run.session,
      run.context,
    );
    await governed(CHAT, post({ model: 'x', messages: [], skip: true }));
    await run.drain();
    assert.equal(requests, 1);
    assert.equal(engine.checks, 0);
  });

  it('refuses a governed request with no customer, before it is sent', async () => {
    const run = newRun();
    // What `stigg.wrapFetch` holds when it was given no customer.
    const anonymous = resolveContext({ entitlement: { currencyId: 'credits' } }, 'run-1', { requireCustomer: false });
    let requests = 0;
    const governed = wrapFetch(
      async () => ((requests += 1), json({})),
      agentgatewayRecipe() as ClientRecipe,
      GATEWAY,
      run.session,
      anonymous,
    );
    await assert.rejects(() => governed(CHAT, post({ model: 'x', messages: [] })), /customer/i);
    assert.equal(requests, 0);
  });

  it('reads a Request object’s own method and body', async () => {
    const { governed, engine, sent, run } = harness(() => json({ usage: USAGE }));
    await governed(new Request(CHAT, post({ model: 'x', messages: [] })));
    await run.drain();
    assert.equal(engine.checks, 1);
    assert.equal(sent.length, 1);
  });
});

describe('what passes through untouched', () => {
  for (const [label, url, init] of [
    ['another host', 'https://api.example.com/v1/chat/completions', post({})],
    ['another port on the same host', 'http://agentgateway.internal:8081/v1/chat/completions', post({})],
    ['a GET', `${GATEWAY}/v1/models`, { method: 'GET' }],
    ['a route the recipe does not declare', `${GATEWAY}/v1/embeddings`, post({})],
    ['a free token count', `${GATEWAY}/v1/messages/count_tokens`, post({})],
    ['an Assistants thread’s messages', `${GATEWAY}/v1/threads/thread_1/messages`, post({})],
    ['an error reply', CHAT, post({})],
  ] as const) {
    it(label, async () => {
      const { governed, engine, sent, run, requests } = harness(() =>
        label === 'an error reply' ? json({ error: 'nope', usage: USAGE }, 429) : json({ usage: USAGE }),
      );
      await governed(url, init as RequestInit);
      await run.drain();
      assert.equal(requests.length, 1, 'the request still goes out');
      assert.equal(sent.length, 0, 'and nothing is metered');
      if (label !== 'an error reply') assert.equal(engine.checks, 0, 'nor checked');
    });
  }
});

describe('what wrapFetch refuses', () => {
  it('a recipe with no route it knows, rather than a fetch that looks governed', () => {
    const run = newRun();
    const noRoutes: ClientRecipe = { vendor: 'x', metrics: [], methods: [{ path: ['ai', 'run'] }] };
    assert.throws(
      () => wrapFetch(fetch, noRoutes, GATEWAY, run.session, run.context),
      /none of those has an HTTP route/,
    );
  });

  it('a relative base URL, which would match nothing', () => {
    const run = newRun();
    assert.throws(() => wrapFetch(fetch, openAIRecipe, '/v1', run.session, run.context), /absolute base URL/);
  });
});
