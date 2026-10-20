/**
 * How the examples decide which account to talk to - and whether to talk to one at all.
 *
 * This had no test of any kind while it was being renamed. `STIGG_SERVER_API_KEY` is the name the
 * SDK itself reads, and `STIGG_API_KEY` is kept only so an existing `.env` keeps working: a
 * fallback that nothing exercises is a fallback somebody deletes while tidying, and the reader it
 * was there for is the one who finds out.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { resolveStiggEnv } from '../examples/shared/stigg-env';

const VARIABLES = ['STIGG_SERVER_API_KEY', 'STIGG_API_KEY', 'AGENT_SDK_OFFLINE', 'STIGG_BASE_URL'] as const;
const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));

/** Set exactly these, so a variable already exported in the shell cannot decide the outcome. */
const withEnv = (values: Partial<Record<(typeof VARIABLES)[number], string>>) => {
  for (const name of VARIABLES) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  return resolveStiggEnv();
};

afterEach(() => {
  for (const name of VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('which Stigg account the examples run against', () => {
  it('reads the name the SDK itself reads', () => {
    assert.equal(withEnv({ STIGG_SERVER_API_KEY: 'server-current' }).apiKey, 'server-current');
  });

  it('still honours the legacy name, so an existing .env keeps working', () => {
    const env = withEnv({ STIGG_API_KEY: 'server-legacy' });
    assert.equal(env.apiKey, 'server-legacy', 'the STIGG_API_KEY fallback was dropped');
    assert.equal(env.offline, false, 'a configured legacy key means a live run, not the mock');
  });

  it('prefers the current name when both are set', () => {
    assert.equal(
      withEnv({ STIGG_SERVER_API_KEY: 'server-current', STIGG_API_KEY: 'server-legacy' }).apiKey,
      'server-current',
    );
  });

  it('treats a blank or whitespace value as unset', () => {
    for (const blank of ['', '   ']) {
      assert.equal(withEnv({ STIGG_SERVER_API_KEY: blank, STIGG_API_KEY: blank }).offline, true, `[${blank}]`);
    }
  });

  it('runs on the mock when nothing is configured', () => {
    const env = withEnv({});
    assert.equal(env.offline, true);
    assert.equal(env.apiKey, undefined);
  });
});

describe('the escape hatch the examples tell people to use', () => {
  // Both offline errors say `AGENT_SDK_OFFLINE=1`. They used to say "leave STIGG_SERVER_API_KEY
  // blank", which the legacy fallback quietly defeated: the reader cleared the name they were told
  // to clear, stayed online, and hit the same error again.
  for (const configured of [
    { STIGG_SERVER_API_KEY: 'server-current' },
    { STIGG_API_KEY: 'server-legacy' },
    { STIGG_SERVER_API_KEY: 'server-current', STIGG_API_KEY: 'server-legacy' },
  ]) {
    it(`forces the mock over ${Object.keys(configured).join(' + ')}`, () => {
      const env = withEnv({ ...configured, AGENT_SDK_OFFLINE: '1' });
      assert.equal(env.offline, true, 'AGENT_SDK_OFFLINE did not reach the mock');
      assert.equal(env.apiKey, undefined, 'a configured key survived into an offline run');
    });
  }
});
