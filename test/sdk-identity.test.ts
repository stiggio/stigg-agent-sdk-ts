/**
 * That an agent-sdk install is visible to Stigg at all.
 *
 * There are no telemetry events to assert on - adoption is read off headers the SDK's two clients
 * already send - which is exactly why this needs pinning. Drop the identity from either client
 * and nothing throws, no typecheck fails, and every other test passes; the only symptom is traffic
 * that reports as a plain node-server-sdk client, or as nothing at all, in a dashboard nobody is
 * looking at on the day the change lands.
 *
 * The version is checked against the manifest rather than a literal, since a literal here would
 * just be the same forgettable constant twice.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_SDK_CLIENT_NAME, AGENT_SDK_REST_HEADERS, AGENT_SDK_VERSION } from '../src/sdk-identity';

const ROOT = join(__dirname, '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const manifest: { name: string; version: string } = JSON.parse(read('package.json'));

describe('how Stigg can tell this SDK apart', () => {
  it('reports the version the package is actually published at', () => {
    assert.equal(AGENT_SDK_VERSION, manifest.version);
    // A manifest read that silently resolved to the wrong file would still pass the line above.
    assert.equal(manifest.name, '@stigg/agent-sdk-js');
  });

  it('names itself something other than the SDK it sits on', () => {
    assert.equal(AGENT_SDK_CLIENT_NAME, 'agent-sdk-js');
    assert.notEqual(AGENT_SDK_CLIENT_NAME, 'node-server-sdk');
  });

  it('carries the same name and version on the REST half', () => {
    assert.deepEqual(AGENT_SDK_REST_HEADERS, {
      'X-SDK-CLIENT-NAME': AGENT_SDK_CLIENT_NAME,
      'X-SDK-CLIENT-VERSION': AGENT_SDK_VERSION,
    });
  });

  /**
   * Source-level, because the alternative is constructing the clients: the Node SDK's
   * `initialize` opens a socket and holds a process-global instance, and neither client exposes
   * the configuration it was built with. What a reader checks here by eye, this checks on CI.
   */
  it('passes that identity to both clients', () => {
    const nodeEngine = read(join('src', 'engine', 'node-sdk-engine.ts'));
    assert.match(nodeEngine, /clientName: AGENT_SDK_CLIENT_NAME/);
    assert.match(nodeEngine, /clientVersion: AGENT_SDK_VERSION/);

    const restEngine = read(join('src', 'engine', 'rest-governance-engine.ts'));
    assert.match(restEngine, /defaultHeaders: AGENT_SDK_REST_HEADERS/);
  });
});
