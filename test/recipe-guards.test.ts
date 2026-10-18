/**
 * The refusals a binding owes its caller.
 *
 * Each of these used to produce a call that looked governed and was not: a client wrapped against
 * a recipe that matched nothing, a price divided by a denomination that cannot divide, a gate
 * asked for a negative amount no balance can refuse, a turn reported to a feature named `''`.
 * None of them failed anything at the time - which is what made them worth refusing out loud.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openrouterRecipe } from '../src/bindings/client/gateways/openrouter/openrouter-recipe';
import { litellmRecipe } from '../src/bindings/client/gateways/litellm/litellm-recipe';
import { weightedMetrics } from '../src/bindings/shared/weighted-metrics';
import { estimateFromMaxOutputTokens, estimateFromMaxTokens, estimateFromState } from '../src';
import { wrapClient } from '../src/bindings/client/core/wrap-client';
import { resolveContext } from '../src/core/context';
import { newRun } from './session-harness';
import type { ClientRecipe } from '../src/bindings/client/core/types';

const context = resolveContext({ customerId: 'customer-acme' }, 'correlation-1');

describe('a recipe that gates nothing on this client', () => {
  const recipe: ClientRecipe = {
    vendor: 'imaginary',
    metrics: ['input_tokens'],
    methods: [{ path: ['conversations', 'create'] }],
  };

  it('is refused rather than handed back looking governed', () => {
    const client = { chat: { completions: { create: () => undefined } } };
    assert.throws(
      () => wrapClient(client, recipe, newRun().session, context),
      /gates conversations.create, and this client has none of them/,
    );
  });

  it('still accepts a client that has some of the declared methods', () => {
    // `openAIRecipe` declares both surfaces because one client can speak either; a client built
    // for only one is the normal case, not a failure.
    const partial = { responses: { create: () => undefined } };
    const twoSurfaces: ClientRecipe = {
      vendor: 'openai',
      metrics: ['input_tokens'],
      methods: [{ path: ['chat', 'completions', 'create'] }, { path: ['responses', 'create'] }],
    };
    assert.doesNotThrow(() => wrapClient(partial, twoSurfaces, newRun().session, context));
  });
});

describe('a denomination that cannot divide a price', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`refuses ${String(bad)} where it was configured`, () => {
      assert.throws(() => openrouterRecipe({ unitsPerCredit: bad }), /unitsPerCredit must be a finite positive number/);
      assert.throws(() => litellmRecipe({ unitsPerDollar: bad }), /unitsPerDollar must be a finite positive number/);
    });
  }

  it('leaves a sane one alone', () => {
    assert.doesNotThrow(() => openrouterRecipe({ unitsPerCredit: 1_000 }));
  });

  it('refuses one an estimator cannot divide by', () => {
    // Same hazard, other end of the call: zero divides to `Infinity` and a negative to less than
    // one, and `requestedUnits` clamps both back to asking for a single unit - so a misconfigured
    // rate would gate on nothing and never say so.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => estimateFromMaxOutputTokens(bad), /tokensPerUnit must be a finite positive number/);
      assert.throws(() => estimateFromMaxTokens(bad), /tokensPerUnit must be a finite positive number/);
    }
  });

  it('still estimates from a rate it can divide by', () => {
    assert.equal(estimateFromMaxOutputTokens(100)({ config: { maxOutputTokens: 950 } }), 10);
    assert.equal(estimateFromMaxTokens(100)({ max_tokens: 950 }), 10);
  });

  it('refuses either divisor of the estimator that divides twice', () => {
    // TypeSafe estimates from a document's length, so it has a second rate of its own - and it
    // had no guard at all until the three estimators were given one shared implementation.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => estimateFromState(bad), /tokensPerUnit must be a finite positive number/);
      assert.throws(() => estimateFromState(1, bad), /charsPerToken must be a finite positive number/);
    }
  });

  it('still estimates from a document, and floors a call with nothing to measure at one unit', () => {
    assert.equal(estimateFromState(1, 4)({ state: 'x'.repeat(400) }), 100);
    assert.equal(estimateFromState(1, 4)({}), 1);
  });
});

describe('a weighted table', () => {
  const recipe = { vendor: 'v', metrics: ['input_tokens'] as const, methods: [] };

  it('refuses an empty target, which reports to no feature at all', () => {
    assert.throws(() => weightedMetrics(recipe, '   ', { input_tokens: 1 }), /needs a target to price into/);
  });

  it('charges a name declared twice only once', () => {
    const twice = { vendor: 'v', metrics: ['input_tokens', 'input_tokens'] as const, methods: [] };
    const mapper = weightedMetrics(twice, 'credits', { input_tokens: 1 });

    assert.deepEqual(mapper({ metrics: { input_tokens: 10 } }), { credits: 10 });
  });
});
