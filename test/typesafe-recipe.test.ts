/**
 * The TypeSafe recipe: one method, two counters, nothing streamed.
 *
 * The cases worth writing here are the ones about what is *absent*. A vendor with no cache
 * counters and no cost is easy to meter and easy to get quietly wrong - a recipe that reported a
 * zero for a counter this API does not have would bill a feature the catalog never agreed to, and
 * a recipe that walked the usage object would start doing that the day TypeSafe adds a field.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClientRegistry } from '../src/bindings/client/core/registry';
import { anthropicRecipe } from '../src/bindings/client/providers/anthropic/anthropic-recipe';
import { openAIRecipe } from '../src/bindings/client/providers/openai/openai-recipe';
import { estimateFromState, typesafeRecipe } from '../src/bindings/client/providers/typesafe/typesafe-recipe';
import { TYPESAFE_METRICS, normalizeUsage } from '../src/bindings/shared/token-usage';
import type { MethodRecipe } from '../src/bindings/client/core/types';
import type { Measurement } from '../src/types';
import type { TypeSafeMetric, TypeSafeMetrics } from '../src';

/** The client shape, as the SDK presents it. */
const typesafeShaped = () => ({ systemOne: () => undefined, models: { list: () => undefined } });

/** A real response body, copied from the wire rather than imagined. */
const response = {
  model: 'jev-1.13.0',
  answers: { q: { type: 'noul', noul: 0.93 } },
  usage: { input_tokens: 282, output_tokens: 20 },
};

const measure = () => typesafeRecipe.methods[0].extractUsage?.(response) as Measurement;

/**
 * The method as the generic wrapper sees it. `satisfies` narrows the literal down to the hooks it
 * actually supplies, so reading an absent one off the recipe is a type error - but "absent" is
 * exactly the claim worth testing, and against the contract is where it can be made.
 */
const method: MethodRecipe = typesafeRecipe.methods[0];

describe('what the recipe reads off a call', () => {
  it('reports the two counters TypeSafe states, under its own names, and a total it does not', () => {
    // TypeSafe publishes no total, so this one is the SDK adding up the two counters it does
    // publish - safe only because they are disjoint, which is why the table of computed totals
    // names this vendor and not the ones whose counters nest inside each other.
    assert.deepEqual(measure().metrics, { input_tokens: 282, output_tokens: 20, total_tokens: 302 });
  });

  it('normalizes the same two, leaving the cache counters at zero because there are none', () => {
    assert.deepEqual(measure().usage, { input: 282, output: 20, cacheRead: 0, cacheCreate: 0, total: 302 });
  });

  it('meters nothing for a response that carried no usage, rather than a zeroed measurement', () => {
    assert.equal(typesafeRecipe.methods[0].extractUsage?.({ model: 'jev-1.13.0', answers: {} }), undefined);
  });

  it('ignores a counter TypeSafe might add later, so a changelog cannot invent a billable feature', () => {
    const widened = { usage: { ...response.usage, reasoning_tokens: 99, cost: 0.0004 } };
    assert.deepEqual(typesafeRecipe.methods[0].extractUsage?.(widened)?.metrics, {
      input_tokens: 282,
      output_tokens: 20,
      total_tokens: 302,
    });
  });

  it('computes the total rather than reading one the response happens to carry', () => {
    // If TypeSafe starts publishing a total of its own, the recipe keeps adding up the counters
    // it declares. Taking the vendor's would mean reporting a number whose parts this SDK cannot
    // show - and the two disagreeing is exactly when somebody needs to be able to see why.
    const withVendorTotal = { usage: { ...response.usage, total_tokens: 9_999 } };
    assert.equal(typesafeRecipe.methods[0].extractUsage?.(withVendorTotal)?.metrics?.total_tokens, 302);
  });

  it('declares exactly what it reports - no cache counters, no cost', () => {
    assert.deepEqual([...typesafeRecipe.metrics], [...TYPESAFE_METRICS]);
    assert.deepEqual([...typesafeRecipe.metrics], ['input_tokens', 'output_tokens', 'total_tokens']);
  });
});

describe('the shape of the binding', () => {
  it('gates the one method that reaches the wire', () => {
    assert.deepEqual(
      typesafeRecipe.methods.map((method) => method.path),
      [['systemOne']],
    );
  });

  it('hooks no stream, because a systemOne call answers once and whole', () => {
    assert.equal(method.attachStream, undefined);
  });

  it('is recognised by shape, and does not claim a client of another vendor', () => {
    const registry = createClientRegistry([anthropicRecipe, openAIRecipe, typesafeRecipe]);
    assert.equal(registry.find(typesafeShaped())?.vendor, 'typesafe');
    assert.equal(registry.find({ chat: { completions: { create: () => undefined } } })?.vendor, 'openai');
    assert.equal(registry.find({ systemOne: 'not a function' }), undefined);
  });
});

describe('the shared normalizer reads a TypeSafe response too', () => {
  it('recognises the two flat counters, which is what makes the reuse safe', () => {
    // The same pair Anthropic uses, which is why the recipe reuses that reader by name.
    assert.deepEqual(normalizeUsage(response.usage), {
      input: 282,
      output: 20,
      cacheRead: 0,
      cacheCreate: 0,
      total: 302,
    });
  });
});

describe('estimating before the call', () => {
  it('defaults to one unit, the way every other recipe does', () => {
    assert.equal(method.estimate, undefined);
  });

  it('sizes the document, which is where an input-heavy call spends', () => {
    // A bare string is measured as itself: 400 chars at ~4 a token is 100 tokens, one per unit.
    assert.equal(estimateFromState(1)({ state: 'x'.repeat(400) }), 100);
    // And at 1000 tokens to a unit, those 100 round up to the one unit they are part of.
    assert.equal(estimateFromState(1_000)({ state: 'x'.repeat(400) }), 1);
  });

  it('counts the JSON envelope of a structured state, which is what is actually sent', () => {
    const state = { article: 'x'.repeat(4_000) };
    // `{"article":"..."}` is 14 characters beyond the text itself, and they go on the wire too.
    assert.equal(JSON.stringify(state).length, 4_014);
    assert.equal(estimateFromState(1)({ state }), 1_004);
    // Just past 1000 tokens, so it asks for two units rather than rounding its way down to one.
    assert.equal(estimateFromState(1_000)({ state }), 2);
  });

  it('asks for one unit when there is no state to size - is there any budget at all?', () => {
    assert.equal(estimateFromState(1_000)({ state: null }), 1);
    assert.equal(estimateFromState(1_000)({}), 1);
  });
});

describe('a vendor ships the type its own mapper is written against', () => {
  it('types a hand-written mapper off the recipe', () => {
    const answerCredits = (metrics: TypeSafeMetrics) => {
      const billable = (metrics.input_tokens ?? 0) + (metrics.output_tokens ?? 0) * 5;
      return billable > 0 ? { answer_credit: Math.ceil(billable / 1_000) } : {};
    };
    assert.deepEqual(answerCredits({ input_tokens: 11_850, output_tokens: 331 }), { answer_credit: 14 });
    assert.deepEqual(answerCredits({}), {});
  });

  it('refuses a counter TypeSafe never reports', () => {
    const named: TypeSafeMetric = 'input_tokens';
    assert.ok(typesafeRecipe.metrics.includes(named));
    // @ts-expect-error TypeSafe reports no cache counters at all
    const wrong: TypeSafeMetrics = { cache_read_input_tokens: 1 };
    assert.ok(wrong);
  });
});
