/**
 * What a recipe says it meters, and whether that is true.
 *
 * Separating where a counter is read from what it is called leaves two lists per surface, and two
 * lists describing one thing drift. These are the guards that make that a test failure rather
 * than a billing one - and the typing checks, without which the whole feature can rot silently:
 * a union widened back to `string` passes every runtime assertion there is.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ANTHROPIC_COMPONENT_METRICS,
  ANTHROPIC_METRICS,
  COMPUTED_TOTALS,
  GATEWAY_METRICS,
  GEMINI_METRICS,
  MISTRAL_METRICS,
  MISTRAL_METRIC_NAME_MAP,
  DATABRICKS_QUERY_METRIC_NAME_MAP,
  OLLAMA_COMPONENT_METRICS,
  OLLAMA_METRICS,
  TOTAL_TOKENS,
  TYPESAFE_COMPONENT_METRICS,
  withComputedTotal,
  TYPESAFE_METRICS,
  BEDROCK_METRICS,
  DATABRICKS_METRICS,
  WORKERS_AI_METRICS,
  METRIC_PATHS,
  OPENAI_CHAT_METRICS,
  OPENAI_METRICS,
  OPENAI_RESPONSES_METRICS,
  metricName,
  metricNamesMatchPaths,
  pickMetrics,
  pickRenamedMetrics,
} from '../src/bindings/shared/token-usage';
import { anthropicRecipe } from '../src/bindings/client/providers/anthropic/anthropic-recipe';
import { geminiChatRecipe, geminiRecipe } from '../src/bindings/client/providers/gemini/gemini-recipe';
import { openAIRecipe } from '../src/bindings/client/providers/openai/openai-recipe';
import { openrouterRecipe } from '../src/bindings/client/gateways/openrouter/openrouter-recipe';
import { litellmRecipe } from '../src/bindings/client/gateways/litellm/litellm-recipe';
import {
  databricksRecipe,
  databricksExternalRecipe,
} from '../src/bindings/client/gateways/databricks/databricks-recipe';
import { cloudflareRecipe } from '../src/bindings/client/gateways/cloudflare/cloudflare-recipe';
import { typesafeRecipe } from '../src/bindings/client/providers/typesafe/typesafe-recipe';
import { weightedMetrics } from '../src/bindings/shared/weighted-metrics';
import type { ClientRecipe, MetricsOf } from '../src/bindings/client/core/types';
import type {
  AnthropicMetric,
  AnthropicMetrics,
  GeminiMetrics,
  LiteLLMMetrics,
  GroqMetrics,
  MistralMetrics,
  OllamaMetrics,
  OpenAIMetrics,
  OpenRouterMetrics,
} from '../src';
import type { Metrics, TokenUsage } from '../src/types';

describe('a path list and a name list say the same thing', () => {
  it('for Anthropic, where they are the same strings', () => {
    // Its *read* counters only. Anthropic publishes no total, so the one this SDK reports is
    // computed rather than read, and has no path to agree with - see the computed-total cases.
    assert.equal(metricNamesMatchPaths(METRIC_PATHS.anthropic, ANTHROPIC_COMPONENT_METRICS), true);
  });

  it('for Ollama, whose counters are flat on the response root', () => {
    assert.equal(metricNamesMatchPaths(METRIC_PATHS.ollama, OLLAMA_COMPONENT_METRICS), true);
    // Its reported list is those two plus the total this SDK computes, since Ollama states none.
    assert.deepEqual([...OLLAMA_METRICS], [...OLLAMA_COMPONENT_METRICS, TOTAL_TOKENS]);
  });

  it('for Mistral, where the read key and the reported name are different strings', () => {
    // The one vocabulary here that is renamed rather than read through. `metricNamesMatchPaths`
    // cannot speak to it - it derives the name from the path, and the whole point of this map is
    // that the two differ - so the guard is that the map's values are exactly the declared list.
    assert.deepEqual(Object.values(MISTRAL_METRIC_NAME_MAP).slice().sort(), [...MISTRAL_METRICS].slice().sort());
  });

  it('reads Mistral camelCase and reports the wire name', () => {
    assert.deepEqual(
      pickRenamedMetrics({ promptTokens: 600, completionTokens: 400, totalTokens: 1000 }, MISTRAL_METRIC_NAME_MAP),
      {
        prompt_tokens: 600,
        completion_tokens: 400,
        total_tokens: 1000,
      },
    );
  });

  it('skips a Mistral counter that is absent, fractional or zero rather than reporting it', () => {
    // Same guards as `pickMetrics`: an absent counter is absent, not zero, and Stigg rejects
    // fractions. Mistral's schema defaults each counter to 0, so this is the common case.
    assert.deepEqual(pickRenamedMetrics({ promptTokens: 0, completionTokens: 1.5 }, MISTRAL_METRIC_NAME_MAP), {});
  });

  it('for Chat Completions, where the cache detail is nested', () => {
    assert.equal(metricNamesMatchPaths(METRIC_PATHS.openaiChat, OPENAI_CHAT_METRICS), true);
    assert.equal(metricName('prompt_tokens_details.cached_tokens'), 'cached_tokens');
  });

  it('for the Responses API, which nests it under another name again', () => {
    assert.equal(metricNamesMatchPaths(METRIC_PATHS.openaiResponses, OPENAI_RESPONSES_METRICS), true);
  });

  it('for TypeSafe, which has two flat counters and no cache detail to nest', () => {
    assert.equal(metricNamesMatchPaths(METRIC_PATHS.typesafe, TYPESAFE_COMPONENT_METRICS), true);
  });

  it('for Gemini, which is flat too but in the vendor’s own camelCase', () => {
    assert.equal(metricNamesMatchPaths(METRIC_PATHS.gemini, GEMINI_METRICS), true);
  });

  it('for Bedrock, flat and camelCased like Gemini, and with no price among them', () => {
    assert.equal(metricNamesMatchPaths(METRIC_PATHS.bedrock, BEDROCK_METRICS), true);
  });

  it('for Databricks, flat and spelled in two vendors’ vocabularies at once', () => {
    // Two path lists here, not one: Databricks serves both OpenAI surfaces and they spell the
    // same counters differently, so the declared names are the union of what either can send.
    // The guard is that the union is exactly that - no name declared that no surface reports,
    // and no surface reporting a name the catalog was never told about.
    const fromBothSurfaces = [...new Set([...METRIC_PATHS.databricks, ...METRIC_PATHS.databricksResponses])];
    assert.deepEqual([...DATABRICKS_METRICS].slice().sort(), fromBothSurfaces.slice().sort());
    // The pair that makes this its own list rather than a reuse of the OpenAI one: Databricks puts
    // its cache counters flat on the block under Anthropic's names, where an OpenAI-shaped reader
    // looks for `prompt_tokens_details.cached_tokens` and finds nothing.
    assert.equal(DATABRICKS_METRICS.includes('cache_read_input_tokens'), true);
    assert.equal(DATABRICKS_METRICS.includes('cached_tokens' as never), false);
  });

  it('for Databricks’ first-party client, which camelCases the same wire', () => {
    // The second renamed vocabulary in this package, and it exists for the reason Mistral's does.
    // `@databricks/sdk-modelservingquery` is generated: its zod schema parses `prompt_tokens` off
    // the wire and hands the caller `promptTokens`. Reported verbatim, ONE Databricks account
    // would produce two different feature ids depending on which package the application imported
    // - the `OpenAI` client's snake_case or this client's camelCase - splitting one bill across
    // two meters. So the map's values must be the wire's names, which is what this pins.
    assert.deepEqual(Object.values(DATABRICKS_QUERY_METRIC_NAME_MAP).slice().sort(), [
      'completion_tokens',
      'prompt_tokens',
      'total_tokens',
    ]);
    // And every reported name must be one the recipe already declares, so the two surfaces of one
    // recipe cannot report under names a mapper typed off `DatabricksMetrics` has never heard of.
    for (const name of Object.values(DATABRICKS_QUERY_METRIC_NAME_MAP)) {
      assert.ok(DATABRICKS_METRICS.includes(name as never), `${name} is not a Databricks metric`);
    }
    // No camelCase key may survive into what is reported - the whole failure being prevented.
    for (const name of Object.values(DATABRICKS_QUERY_METRIC_NAME_MAP)) {
      assert.equal(/[A-Z]/.test(name), false, `${name} reports a camelCase feature id`);
    }
  });

  it('reads the Databricks camelCase block and reports the wire name', () => {
    assert.deepEqual(
      pickRenamedMetrics({ promptTokens: 30, completionTokens: 12, totalTokens: 42 }, DATABRICKS_QUERY_METRIC_NAME_MAP),
      { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
    );
    // Identical output to what the OpenAI route reports for the same call, which is the point:
    // one workspace, one vocabulary, whichever client the application holds.
    assert.deepEqual(
      pickRenamedMetrics({ promptTokens: 30, completionTokens: 12, totalTokens: 42 }, DATABRICKS_QUERY_METRIC_NAME_MAP),
      pickMetrics({ prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 }, METRIC_PATHS.databricks),
    );
  });

  it('for Workers AI, three flat counters and nothing nested beneath them', () => {
    assert.equal(metricNamesMatchPaths(METRIC_PATHS.workersAi, WORKERS_AI_METRICS), true);
  });

  it('notices when they do not - which is the only reason this exists', () => {
    assert.equal(metricNamesMatchPaths(['a.b'], ['b_wrong']), false);
    assert.equal(metricNamesMatchPaths(['a', 'b'], ['a']), false);
  });
});

describe('a recipe reports what it says it reports', () => {
  it('Anthropic: every declared name comes back off a real response', () => {
    const usage = {
      input_tokens: 9,
      output_tokens: 46,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 5,
    };
    const measured = anthropicRecipe.methods[0].extractUsage?.({ usage });
    assert.deepEqual(Object.keys((measured as { metrics: object }).metrics).sort(), [...ANTHROPIC_METRICS].sort());
  });

  it('OpenAI declares both surfaces, because one client can speak either', () => {
    assert.deepEqual([...openAIRecipe.metrics].sort(), [...OPENAI_METRICS].sort());
    // And each surface reports its own half, under the leaf names.
    const chat = pickMetrics(
      { prompt_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } },
      METRIC_PATHS.openaiChat,
    );
    assert.deepEqual(Object.keys(chat).sort(), ['cached_tokens', 'prompt_tokens']);
  });

  it('TypeSafe declares only what it reports, which is neither cache nor cost', () => {
    assert.deepEqual([...typesafeRecipe.metrics], [...TYPESAFE_METRICS]);
    const measured = typesafeRecipe.methods[0].extractUsage?.({ usage: { input_tokens: 282, output_tokens: 20 } });
    assert.deepEqual(Object.keys((measured as { metrics: object }).metrics).sort(), [...TYPESAFE_METRICS].sort());
    assert.equal(typesafeRecipe.metrics.includes('cost' as never), false);
  });

  it('every recipe declares a total metric, stated by the vendor or computed here', () => {
    // The breakdown answers "what did this call spend it on"; the total answers "what did it
    // cost". Both are sent, and which one bills is a decision for the Stigg catalog.
    //
    // Declaring one is not the same as the vendor publishing one: Gemini, OpenAI and the
    // gateways state theirs and it is read, while Anthropic and TypeSafe publish none and this
    // SDK sums their disjoint counters - see the computed-totals cases below.
    for (const [vendor, metrics] of [
      ['anthropic', anthropicRecipe.metrics],
      ['openai', openAIRecipe.metrics],
      ['gemini', geminiRecipe.metrics],
      ['typesafe', typesafeRecipe.metrics],
      ['openrouter', openrouterRecipe().metrics],
      ['litellm', litellmRecipe().metrics],
      ['databricks', databricksRecipe().metrics],
      ['cloudflare', cloudflareRecipe().metrics],
    ] as const) {
      const total = vendor === 'gemini' ? 'totalTokenCount' : TOTAL_TOKENS;
      assert.ok(metrics.includes(total as never), `${vendor} declares no total`);
    }
  });

  it('names its total on the recipe, so a caller need not know each vendor by heart', () => {
    // The *name* differs per vendor, which is the whole reason it is declared: a table pricing
    // metrics otherwise cannot tell the total apart from the counters underneath it, and billing
    // both double-charges the same tokens.
    for (const [vendor, recipe] of [
      ['anthropic', anthropicRecipe],
      ['openai', openAIRecipe],
      ['gemini', geminiRecipe],
      ['gemini-chat', geminiChatRecipe],
      ['typesafe', typesafeRecipe],
      ['openrouter', openrouterRecipe()],
      ['litellm', litellmRecipe()],
      ['databricks', databricksRecipe()],
      ['databricks-external', databricksExternalRecipe()],
      ['cloudflare', cloudflareRecipe()],
    ] as const) {
      const total = (recipe as ClientRecipe).totalTokensMetric;
      assert.ok(total, `${vendor} declares no total`);
      assert.ok(
        (recipe as ClientRecipe).metrics.includes(total as never),
        `${vendor} names a total it does not report`,
      );
    }
  });

  it('carries the total in the usage digest too, read where the vendor states one', () => {
    // A mapper wanting one number should use the vendor's own rather than re-adding the parts:
    // the two can differ, and the vendor's is the one that gets invoiced.
    const gemini = geminiRecipe.methods[0].extractUsage?.({
      usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 250, totalTokenCount: 1000 },
    });
    assert.equal((gemini as { usage: TokenUsage }).usage.total, 1000, 'the stated total, not a recomputed one');

    // Anthropic states none, so the digest carries the sum of its four disjoint counters.
    const anthropic = anthropicRecipe.methods[0].extractUsage?.({
      usage: { input_tokens: 9, output_tokens: 46, cache_read_input_tokens: 2, cache_creation_input_tokens: 5 },
    });
    assert.equal((anthropic as { usage: TokenUsage }).usage.total, 62);
  });

  it('computes a total only where the counters underneath it are disjoint', () => {
    // Anthropic's four, TypeSafe's two and Ollama's two do not overlap, so adding them up is the
    // whole call. Gemini and OpenAI nest their cached tokens inside another counter, so summing
    // theirs would be arithmetic the vendor never agreed to - and Mistral states a total of its
    // own. Those three are read, never computed, which is why they are absent here.
    assert.deepEqual(Object.keys(COMPUTED_TOTALS).sort(), ['anthropic', 'ollama', 'typesafe']);
    assert.deepEqual(withComputedTotal({ prompt_eval_count: 600, eval_count: 400 }, COMPUTED_TOTALS.ollama), {
      prompt_eval_count: 600,
      eval_count: 400,
      total_tokens: 1000,
    });
    assert.deepEqual(withComputedTotal({ input_tokens: 9, output_tokens: 46 }, COMPUTED_TOTALS.typesafe), {
      input_tokens: 9,
      output_tokens: 46,
      total_tokens: 55,
    });
    // Nothing measured, nothing reported - a zero would be a number somebody has to interpret.
    assert.deepEqual(withComputedTotal({}, COMPUTED_TOTALS.typesafe), {});
  });

  it('Anthropic: the computed total covers all four of its disjoint counters', () => {
    const usage = { input_tokens: 9, output_tokens: 46, cache_read_input_tokens: 2, cache_creation_input_tokens: 5 };
    const measured = anthropicRecipe.methods[0].extractUsage?.({ usage });
    assert.equal((measured as { metrics: Metrics }).metrics.total_tokens, 9 + 46 + 2 + 5);
  });

  it('Gemini: every declared name comes back, the vendor’s own total included', () => {
    const usageMetadata = {
      promptTokenCount: 600,
      candidatesTokenCount: 250,
      cachedContentTokenCount: 100,
      thoughtsTokenCount: 100,
      toolUsePromptTokenCount: 50,
      totalTokenCount: 1000,
    };
    const measured = geminiRecipe.methods[0].extractUsage?.({ usageMetadata });
    assert.deepEqual(Object.keys((measured as { metrics: object }).metrics).sort(), [...GEMINI_METRICS].sort());
    // Read, not computed: it is the vendor's own word for what the call cost, and the breakdown
    // beside it is what lets a customer price something other than the whole.
    assert.equal((measured as { metrics: Metrics }).metrics.totalTokenCount, 1000);
  });

  it('Gemini’s two recipes meter the same counters, so one vendor bills one way', () => {
    // A chat turn and a one-shot call are the same traffic reached through different objects.
    assert.deepEqual([...geminiChatRecipe.metrics], [...geminiRecipe.metrics]);
    assert.equal(geminiChatRecipe.vendor, geminiRecipe.vendor);
  });

  it('Databricks declares no price, because no response carries one', () => {
    // The whole platform, both routes. DBUs land in `system.billing.usage` and external spend in
    // `system.ai_gateway.external_model_spend`, both asynchronously - so a `cost` here would type
    // a pricing table against a number that never arrives.
    assert.equal(databricksRecipe().metrics.includes('cost' as never), false);
    assert.equal(databricksExternalRecipe().metrics.includes('cost' as never), false);
  });

  it('the two Databricks recipes meter identically and differ only in who is billed', () => {
    // The traffic is genuinely the same wire; a divergence here would be a claim about a
    // difference the response does not contain.
    assert.deepEqual([...databricksExternalRecipe().metrics], [...databricksRecipe().metrics]);
    assert.notEqual(databricksExternalRecipe().vendor, databricksRecipe().vendor);
  });

  it('a gateway adds the price it charged, under its own field name', () => {
    assert.equal(openrouterRecipe().metrics.includes('cost'), true);
    assert.equal(litellmRecipe().metrics.includes('cost'), true);
    assert.deepEqual([...litellmRecipe().metrics], [...GATEWAY_METRICS]);
  });
});

describe('weightedMetrics prices what the vendor reported', () => {
  const price = (per?: number) =>
    weightedMetrics(
      anthropicRecipe,
      'data_credit',
      { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 0.1, cache_creation_input_tokens: 1.25 },
      per === undefined ? {} : { per },
    );

  it('weights each metric and reports the price as it comes out', () => {
    // 9*1 + 46*5 + 2*0.1 = 239.2 -> one unit per 100 -> 2.392, not 3.
    //
    // Verified against the API rather than assumed: `credits.consumption.consume` answers 200 to
    // a fractional `amount`, so rounding here would be this SDK's arithmetic on someone's price.
    // `POST /api/v1/usage` is the one that refuses a float, and the ingest path checks for that.
    const metrics = price(100)({ metrics: { input_tokens: 9, output_tokens: 46, cache_read_input_tokens: 2 } });
    assert.deepEqual(metrics, { data_credit: 2.392 });
  });

  it('reports nothing for a turn that measured nothing, rather than a zero', () => {
    assert.deepEqual(price(100)({ metrics: {} }), {});
    assert.deepEqual(price(100)({}), {});
  });

  it('treats a counter the response omitted as absent, not as zero', () => {
    // Only output was reported; the other three contribute nothing rather than NaN.
    assert.deepEqual(price(1)({ metrics: { output_tokens: 2 } }), { data_credit: 10 });
  });

  it('prices only what the recipe declares, so a stray key cannot bill', () => {
    const metrics = price(1)({ metrics: { output_tokens: 1, total_tokens: 9_999 } });
    assert.deepEqual(metrics, { data_credit: 5 });
  });
});

describe('the metric names are literals, not strings', () => {
  it('names the union off the recipe without repeating it', () => {
    type Anthropic = MetricsOf<typeof anthropicRecipe>;
    const priced: Record<Anthropic, number> = {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 1,
      // The computed total is a name this vendor reports, so it is a name a table must price.
      total_tokens: 1,
    };
    assert.equal(Object.keys(priced).length, 5);
  });

  it('refuses a metric this vendor does not report', () => {
    void weightedMetrics(anthropicRecipe, 'data_credit', {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 1,
      // @ts-expect-error `prompt_tokens` is OpenAI's name, not Anthropic's
      prompt_tokens: 1,
    });
    assert.ok(true);
  });

  it('takes a table that prices only some of them, because the rest are free', () => {
    const priced = weightedMetrics(anthropicRecipe, 'data_credit', { output_tokens: 0.5 });
    // Half a credit per output token; the three unnamed metrics cost nothing.
    assert.deepEqual(priced({ metrics: { input_tokens: 400, output_tokens: 46 } }), { data_credit: 23 });
  });
});

describe('an unpriced metric is free', () => {
  it('charges nothing for the metrics the table does not name', () => {
    const outputOnly = weightedMetrics(anthropicRecipe, 'data_credit', { output_tokens: 1 });
    const both = weightedMetrics(anthropicRecipe, 'data_credit', { output_tokens: 1, input_tokens: 1 });
    const usage = { metrics: { input_tokens: 10, output_tokens: 5 } };

    assert.deepEqual(outputOnly(usage), { data_credit: 5 }, 'the ten input tokens were free');
    assert.deepEqual(both(usage), { data_credit: 15 });
  });

  it('meters nothing at all when the table prices nothing', () => {
    const free = weightedMetrics(anthropicRecipe, 'data_credit', {});
    assert.deepEqual(free({ metrics: { input_tokens: 9, output_tokens: 46 } }), {});
  });

  it('reads a weight as the price of one unit, so no `per` is needed for that', () => {
    const half = weightedMetrics(anthropicRecipe, 'data_credit', { output_tokens: 0.5 });
    // 46 output tokens at half a credit each, rounded up to a whole unit.
    assert.deepEqual(half({ metrics: { output_tokens: 46 } }), { data_credit: 23 });
  });
});

describe('a vendor ships the type its own mapper is written against', () => {
  // Named off the barrel, the way an application would import it.
  const dataCredits = (metrics: AnthropicMetrics): Metrics => {
    const billable = (metrics.output_tokens ?? 0) * 5 + (metrics.input_tokens ?? 0);
    return billable > 0 ? { data_credit: Math.ceil(billable / 100) } : {};
  };

  it('types a hand-written mapper off the recipe, no Record to build', () => {
    assert.deepEqual(dataCredits({ input_tokens: 400, output_tokens: 46 }), { data_credit: 7 });
    assert.deepEqual(dataCredits({}), {}, 'a call that metered nothing reports nothing');
  });

  it('names one metric, for a signature that takes a single counter', () => {
    const named: AnthropicMetric = 'cache_read_input_tokens';
    assert.ok(anthropicRecipe.metrics.includes(named));
  });

  it('refuses a counter that vendor never reports', () => {
    // @ts-expect-error `prompt_tokens` is OpenAI's name for it
    const wrong: AnthropicMetrics = { prompt_tokens: 1 };
    assert.ok(wrong);
  });

  it('keeps each vendor to its own names', () => {
    const gemini: GeminiMetrics = { promptTokenCount: 7, thoughtsTokenCount: 3 };
    assert.deepEqual([gemini.promptTokenCount, gemini.thoughtsTokenCount], [7, 3]);
    const openai: OpenAIMetrics = { prompt_tokens: 10, cached_tokens: 2 };
    const gateway: OpenRouterMetrics = { cost: 1 };
    const proxied: LiteLLMMetrics = { completion_tokens: 3 };
    const groq: GroqMetrics = { prompt_tokens: 3, cached_tokens: 1 };
    assert.deepEqual([groq.prompt_tokens, groq.cached_tokens], [3, 1]);
    const ollama: OllamaMetrics = { prompt_eval_count: 11, eval_count: 4 };
    assert.deepEqual([ollama.prompt_eval_count, ollama.eval_count], [11, 4]);
    const mistral: MistralMetrics = { prompt_tokens: 5, total_tokens: 9 };
    assert.deepEqual([mistral.prompt_tokens, mistral.total_tokens], [5, 9]);
    assert.deepEqual([openai.prompt_tokens, gateway.cost, proxied.completion_tokens], [10, 1, 3]);
  });
});
