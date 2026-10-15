/**
 * A gateway you operate, as an actual second process would see it.
 *
 * A real HTTP server on a loopback socket, because the header contract is the thing being shown:
 * attribution goes out as headers and comes back as `req.headers`, which Node has lower-cased and
 * may have turned into arrays. Anything that passed the same object between two function calls
 * would be true about everything except the part that matters.
 *
 * What the handler can do is the whole of what a gateway can do: read who the work was for, and
 * report what it observed. It cannot check - the caller holding the budget is in another process -
 * which is why this path meters and never gates.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type OpenAI from 'openai';
import { unitsPerTokens, entitlementId } from '../../../src';
import type { IngestResult, StiggAgentSDK } from '../../../src';
import type { DemoEnv } from '../../shared/demo-env';
import type { GatewayVendor } from './vendor';

export type GovernedProxy = {
  /** Where to send the request. A real port, so the headers have to survive the trip. */
  baseUrl: string;
  /** What the proxy ingested, in order - the example prints these rather than guessing. */
  ingests: IngestResult[];
  close: () => Promise<void>;
};

/**
 * The request body, and the two ways it can fail to arrive.
 *
 * Resolving only on `end` meant a client that hung up mid-request left this promise pending for
 * good: the handler never answered, and `close()` waited on a connection that was already gone.
 */
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += String(chunk)));
    req.on('end', () => resolve(body));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('the client hung up before the request body arrived')));
  });

/**
 * Starts the proxy. `upstream` is the proxy's own client to the real gateway - unwrapped, because
 * out here there is no run to gate against and wrapping it would imply there was.
 */
export async function startGovernedProxy(options: {
  upstream: OpenAI;
  stigg: StiggAgentSDK;
  demoEnv: DemoEnv;
  vendor: GatewayVendor;
  onIngest?: (result: IngestResult, attribution: { runId?: string; customerId?: string }) => void;
}): Promise<GovernedProxy> {
  const { upstream, stigg, demoEnv, vendor } = options;
  const ingests: IngestResult[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const params = JSON.parse(await readBody(req)) as OpenAI.ChatCompletionCreateParamsNonStreaming;
        const { data, response } = await upstream.chat.completions.create(params).withResponse();

        // `req.headers` is the wire's own shape: lower-cased by Node, and `string | string[]`.
        // The parser folds case and refuses a name that arrived twice disagreeing, which is the
        // only reason attribution can be trusted after a hop it did not control.
        const result = await stigg.ingestFromHeaders(req.headers, {
          // The proxy has no run, so what to bill against comes with the call.
          entitlement: demoEnv.entitlement,
          // Priced onto the entitlement, exactly as the client examples do. Without it the report
          // carries the vendor's own counter names, which is honest but lands on whatever features
          // happen to be called that - and for a feature entitlement, on none of them.
          metrics: demoEnv.entitlement ? unitsPerTokens(entitlementId(demoEnv.entitlement), 1_000) : undefined,
          // Named, not sniffed: it observed somebody else's response, and reporting raw names off
          // a misread shape would land on another meter entirely.
          vendor: 'openai',
          event: demoEnv.ingestEventName,
          // The wire's own usage object, which is what `vendor: 'openai'` above says it is.
          usage: data.usage,
          idempotencyKey: vendor.proxyIdempotencyKey?.(data, response.headers) ?? data.id,
        });
        ingests.push(result);
        // Instrumentation, so its failure is not the caller's. By here the upstream call has
        // answered and the spend has been reported: letting an observer throw into the catch below
        // would return 502 for work that completed and was billed, and a caller that retries it
        // pays twice. The SDK holds its own hooks to this rule - see `core/hooks.ts`.
        try {
          options.onIngest?.(result, {
            runId: typeof req.headers['x-stigg-run-id'] === 'string' ? req.headers['x-stigg-run-id'] : undefined,
            customerId:
              typeof req.headers['x-stigg-customer-id'] === 'string' ? req.headers['x-stigg-customer-id'] : undefined,
          });
        } catch (err) {
          console.error(`[proxy] onIngest threw: ${err instanceof Error ? err.message : String(err)}`);
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        // A proxy that cannot meter still has to answer the caller; metering is instrumentation.
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    ingests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
