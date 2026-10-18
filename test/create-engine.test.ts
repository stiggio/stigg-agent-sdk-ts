/**
 * Which client serves which operation, and why.
 *
 * The factory answers this by asking the account, so the only honest way to test it is to let it
 * ask: every case below runs the real REST and Node-SDK engines against the in-process Stigg
 * mock, with governance switched on or off there rather than declared here. There is no seam to
 * inject an engine through - the SDK builds its own, which is exactly the thing being asserted.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createGovernanceEngine, type CreatedEngine } from '../src/engine/create-engine';
import { noopLogger } from '../src/logger';
import { startMockStiggServer, type MockStiggServer } from '../testing/mock-stigg-server';
import { NodeSdkEngine, type NodeSdkClient } from '../src/engine/node-sdk-engine';
import { uniqueKey } from './stigg-harness';

const open: { engine: CreatedEngine; mock: MockStiggServer }[] = [];

/** Builds an engine against a mock with governance in the given state, and remembers to close it. */
async function engineAgainst(governance: boolean) {
  const mock = await startMockStiggServer({ governance });
  const engine = await createGovernanceEngine({
    // Unique per engine: `Stigg.initialize` keeps one global client and hands it back when the
    // API key matches, so a shared key would point every later engine at the first mock.
    apiKey: uniqueKey(),
    baseUrl: mock.baseUrl,
    timeoutMs: 1_000,
    logger: noopLogger,
  });
  open.push({ engine, mock });
  return engine;
}

after(async () => {
  for (const { engine, mock } of open) {
    await engine.engine.close?.();
    await mock.close();
  }
});

describe('createGovernanceEngine', () => {
  it('splits the work when governance is enabled: chains from REST, ingest on the cached SDK', async () => {
    const created = await engineAgainst(true);
    assert.equal(created.resolution.mode, 'governance');
    assert.deepEqual(created.resolution.ops, {
      upsertEntity: 'rest',
      check: 'rest',
      // No dimensions means no entity to resolve, so the cached client answers the same question.
      unattributedCheck: 'node-sdk',
      report: 'node-sdk',
      archiveEntity: 'rest',
    });
    assert.equal(created.engine.capabilities.provisioning, true);
    assert.equal(created.engine.capabilities.chains, true);
  });

  it('falls back to customer-level when the account has no governance - not every account does', async () => {
    const created = await engineAgainst(false);
    assert.equal(created.resolution.mode, 'customer-level');
    assert.match(created.resolution.reason, /governance not enabled/);
    assert.equal(created.engine.capabilities.provisioning, false);
    assert.equal(created.engine.capabilities.chains, false, 'no chains without governance, so no deniedBy');
  });

  it('asks the account rather than being told: the same code resolves both ways', async () => {
    const [on, off] = await Promise.all([engineAgainst(true), engineAgainst(false)]);
    assert.notEqual(on.resolution.mode, off.resolution.mode);
  });
});

/**
 * Who may close the Node SDK client.
 *
 * `Stigg.initialize` keeps one global instance per process and hands it back when the API key
 * matches, and `close()` nulls that global and tears the runtime down - so closing a client the
 * application is still using takes its cache and its socket with it. Nothing observable from out
 * here distinguishes a client that was just built from one that was handed back: the instance
 * exposes neither its configuration nor its identity. So ownership is declared, not detected.
 */
describe('client ownership', () => {
  /** Enough of the client's surface to watch `close`, which is all these cases touch. */
  const borrowable = () => {
    let closed = 0;
    const client = { close: async () => void (closed += 1) } as unknown as NodeSdkClient;
    return { client, closes: () => closed };
  };

  it('borrows a client that was handed in, and never closes it', async () => {
    const { client, closes } = borrowable();
    const engine = new NodeSdkEngine({ apiKey: 'unused-when-a-client-is-given', client });

    assert.equal(engine.ownsClient, false);
    await engine.close();
    assert.equal(closes(), 0, "the application's client must survive the SDK closing");
  });

  it('owns a client it built, and closes it', async () => {
    const mock = await startMockStiggServer({ governance: true });
    const engine = new NodeSdkEngine({ apiKey: uniqueKey(), baseUrl: mock.baseUrl });

    assert.equal(engine.ownsClient, true);
    await engine.close();
    await mock.close();
  });
});
