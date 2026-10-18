/**
 * The wire convention, from the receiving side. Everything here is a header map some other
 * process built, so the cases are the shapes a sender can actually produce - not the ones the
 * type says it will.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GOVERNANCE_HEADERS, parseGovernanceHeaders } from '../src/headers';

describe('parseGovernanceHeaders', () => {
  it('reads the attribution a run sends', () => {
    const parsed = parseGovernanceHeaders({
      [GOVERNANCE_HEADERS.customer]: 'customer-acme',
      [GOVERNANCE_HEADERS.dimensions]: '{"agentId":"agent-1"}',
      [GOVERNANCE_HEADERS.run]: 'run-1',
    });
    assert.deepEqual(parsed, {
      customerId: 'customer-acme',
      dimensions: { agentId: 'agent-1' },
      runId: 'run-1',
    });
  });

  it('returns undefined when the request carries no customer to attribute to', () => {
    assert.equal(parseGovernanceHeaders({ [GOVERNANCE_HEADERS.run]: 'run-1' }), undefined);
  });

  /**
   * Which dimension is the agent, carried rather than inferred.
   *
   * The receiver sees a flat map, so `{ agentId: 'a-1', region: 'eu' }` gives it no way to tell
   * attribution from metadata - and either guess costs money: round on any dimension and an
   * ordinary `region` inflates a wallet draw; round on none and a real agent's budget stops
   * counting. Only the sending side knows, so only the sending side says.
   */
  it('carries the attribution key when it names a dimension that is there', () => {
    const parsed = parseGovernanceHeaders({
      [GOVERNANCE_HEADERS.customer]: 'customer-acme',
      [GOVERNANCE_HEADERS.dimensions]: '{"agentId":"agent-1","region":"eu"}',
      [GOVERNANCE_HEADERS.attributionKey]: 'agentId',
    });

    assert.equal(parsed?.attributionKey, 'agentId');
  });

  it('drops a key that names no dimension, which attributes to nothing', () => {
    const parsed = parseGovernanceHeaders({
      [GOVERNANCE_HEADERS.customer]: 'customer-acme',
      [GOVERNANCE_HEADERS.dimensions]: '{"region":"eu"}',
      [GOVERNANCE_HEADERS.attributionKey]: 'agentId',
    });

    assert.equal(parsed?.attributionKey, undefined);
  });

  it('leaves it absent when the sender names none', () => {
    const parsed = parseGovernanceHeaders({
      [GOVERNANCE_HEADERS.customer]: 'customer-acme',
      [GOVERNANCE_HEADERS.dimensions]: '{"agentId":"agent-1"}',
      [GOVERNANCE_HEADERS.attributionKey]: '',
    });

    assert.equal(parsed?.attributionKey, undefined);
  });

  it('reads mixed-case names, which is what a map built by hand looks like', () => {
    const parsed = parseGovernanceHeaders({
      'X-Stigg-Customer-Id': 'customer-acme',
      'X-Stigg-Dimensions': '{"agentId":"agent-1"}',
      'X-Stigg-Run-Id': 'run-1',
    });
    assert.equal(parsed?.customerId, 'customer-acme');
    assert.deepEqual(parsed?.dimensions, { agentId: 'agent-1' });
    assert.equal(parsed?.runId, 'run-1');
  });

  it('takes the first value when a name repeats', () => {
    const parsed = parseGovernanceHeaders({ [GOVERNANCE_HEADERS.customer]: ['customer-acme', 'customer-other'] });
    assert.equal(parsed?.customerId, 'customer-acme');
  });

  for (const [label, raw] of [
    ['malformed JSON', '{not json'],
    ['null, which JSON.parse accepts', 'null'],
    ['an array', '["agent-1"]'],
    ['a scalar', '7'],
    ['non-string values', '{"agentId":{"nested":true}}'],
  ] as const) {
    it(`falls back to no attribution for ${label}, rather than passing it on`, () => {
      const parsed = parseGovernanceHeaders({
        [GOVERNANCE_HEADERS.customer]: 'customer-acme',
        [GOVERNANCE_HEADERS.dimensions]: raw,
      });
      assert.deepEqual(parsed?.dimensions, {}, 'the request still bills, it just loses the entity');
    });
  }
});

describe('parseGovernanceHeaders refuses what it cannot read unambiguously', () => {
  it('returns nothing when one header arrives twice under different spellings', () => {
    const parsed = parseGovernanceHeaders({
      'x-stigg-customer-id': 'customer-acme',
      'X-Stigg-Customer-Id': 'customer-other',
    });
    // Folding case makes these one name. Billing whichever the map iterated second would be a
    // wrong customer that looks exactly like a right one.
    assert.equal(parsed, undefined);
  });

  it('accepts the same value in a different container, which is not a disagreement', () => {
    // The argument type is `string | string[]`; `'c'` and `['c']` are the same header.
    const parsed = parseGovernanceHeaders({
      'x-stigg-customer-id': 'customer-acme',
      'X-Stigg-Customer-Id': ['customer-acme'],
    });
    assert.equal(parsed?.customerId, 'customer-acme');
  });

  it('accepts a repeat that agrees with itself', () => {
    const parsed = parseGovernanceHeaders({
      'x-stigg-customer-id': 'customer-acme',
      'X-Stigg-Customer-Id': 'customer-acme',
    });
    assert.equal(parsed?.customerId, 'customer-acme');
  });

  it('treats a whitespace-only id as absent rather than passing it on', () => {
    assert.equal(parseGovernanceHeaders({ [GOVERNANCE_HEADERS.customer]: '   ' }), undefined);
  });

  it('trims an id that arrived padded', () => {
    const parsed = parseGovernanceHeaders({ [GOVERNANCE_HEADERS.customer]: '  customer-acme  ' });
    assert.equal(parsed?.customerId, 'customer-acme');
  });

  it('drops an ambiguous run id without losing the customer', () => {
    const parsed = parseGovernanceHeaders({
      [GOVERNANCE_HEADERS.customer]: 'customer-acme',
      'x-stigg-run-id': 'run-1',
      'X-Stigg-Run-Id': 'run-2',
    });
    assert.equal(parsed?.customerId, 'customer-acme');
    assert.equal(parsed?.runId, undefined, 'the run is what was ambiguous, not the customer');
  });
});
