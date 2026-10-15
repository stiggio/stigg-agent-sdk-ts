/**
 * What happens to an SDK whose very first engine probe failed.
 *
 * The engine is built once and memoized, which is right - it is a network probe, and concurrent
 * callers should share one. But a rejected promise is still a promise, so memoizing one has to
 * expire: a 503, a DNS blip or a key rotated a second early would otherwise outlive the failure
 * that caused it, and under the default `checkErrorAction: 'allow'` that means a process which
 * silently stops enforcing any budget at all.
 *
 * These cases go through a proxy that can be taken down and brought back at the same URL, because
 * "Stigg was down and then it wasn't" is the whole scenario and a second base URL would not be it.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StiggAgentSDK } from '../src/stigg-agent-sdk';
import { startMockStiggServer, type MockStiggServer } from '../testing/mock-stigg-server';

/** How long the SDK remembers a failed probe. Mirrors `RETRY_START_AFTER_MS`. */
const RETRY_WINDOW_MS = 2_000;

type Proxy = { baseUrl: string; down: boolean; close: () => Promise<void> };

/**
 * A pipe in front of the mock that can be taken down without moving.
 *
 * While `down` it answers everything with a 503, which is what `probe()` turns into a rejected
 * engine. Flipping it back is the recovery the SDK has to notice on its own.
 */
async function startProxy(target: string): Promise<Proxy> {
  const upstream = new URL(target);
  const proxy: Proxy = { baseUrl: '', down: false, close: async () => undefined };

  const server: Server = createServer((req, res) => {
    if (proxy.down) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'ServiceUnavailable', message: 'stigg is down' }));
      return;
    }
    const forwarded = request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: upstream.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    forwarded.on('error', () => {
      res.writeHead(502).end();
    });
    req.pipe(forwarded);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  proxy.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return proxy;
}

const open: { stigg: StiggAgentSDK; mock: MockStiggServer; proxy: Proxy }[] = [];

/** An SDK pointed at a proxy that starts out refusing everything. */
async function startedDown() {
  const mock = await startMockStiggServer({ governance: true });
  const proxy = await startProxy(mock.baseUrl);
  proxy.down = true;
  const stigg = new StiggAgentSDK({
    apiKey: 'server-retry-test',
    baseUrl: proxy.baseUrl,
    logger: 'none',
    timeoutMs: 200,
  });
  open.push({ stigg, mock, proxy });
  return { stigg, mock, proxy };
}

after(async () => {
  for (const { stigg, mock, proxy } of open) {
    await stigg.close();
    await proxy.close();
    await mock.close();
  }
});

describe('an engine whose first probe failed', () => {
  it('rejects while the probe is failing, rather than resolving to a client that cannot check', async () => {
    const { stigg } = await startedDown();
    await assert.rejects(() => stigg.init());
  });

  it('serves the same failure to callers inside the retry window, so an outage is not re-probed per call', async () => {
    const { stigg, proxy } = await startedDown();
    await assert.rejects(() => stigg.init());

    // Healthy again immediately - but the window has not elapsed, so this call is still answered
    // from the remembered failure. That is the deliberate half: a hard outage is probed on a
    // timer, not once per request.
    proxy.down = false;
    await assert.rejects(() => stigg.init());
  });

  it('recovers once the window elapses, which is what the window is for', async () => {
    const { stigg, proxy } = await startedDown();
    await assert.rejects(() => stigg.init());

    proxy.down = false;
    await new Promise((resolve) => setTimeout(resolve, RETRY_WINDOW_MS + 100));

    const resolution = await stigg.init();
    assert.ok(resolution, 'the engine should resolve once Stigg is reachable again');
    assert.ok(stigg.engine, 'and the engine should be available to the paths that need it');
  });

  it('keeps serving the engine once it resolved - a success is memoized for good', async () => {
    const { stigg, proxy } = await startedDown();
    await assert.rejects(() => stigg.init());

    proxy.down = false;
    await new Promise((resolve) => setTimeout(resolve, RETRY_WINDOW_MS + 100));
    const first = await stigg.init();

    // Down again. Nothing re-probes, because only a *failed* attempt expires - re-resolving a
    // healthy engine would throw away its cache and its connection pool on every call.
    proxy.down = true;
    assert.deepEqual(await stigg.init(), first);
  });
});
