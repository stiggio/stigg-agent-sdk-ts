/**
 * The two OpenAI surfaces. Chat Completions and Responses are the same API family with different
 * field names, and reading one with the other's extractor finds nothing at all - which meters the
 * call at zero and reports it as a success, the one failure shape nothing downstream can notice.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openAIRecipe } from '../src/bindings/client/providers/openai/openai-recipe';
import { openrouterRecipe } from '../src/bindings/client/gateways/openrouter/openrouter-recipe';
import { litellmRecipe } from '../src/bindings/client/gateways/litellm/litellm-recipe';
import { fromResponsesUsage, normalizeUsage } from '../src/bindings/shared/token-usage';
import type { Measurement, TokenUsage } from '../src/types';

/** What the Responses API actually returns. */
const RESPONSES_USAGE = {
  input_tokens: 600,
  output_tokens: 400,
  input_tokens_details: { cached_tokens: 100 },
  total_tokens: 1000,
};

import type { ClientRecipe, MethodRecipe } from '../src/bindings/client/core/types';

const methodAt = (recipe: ClientRecipe, path: string): MethodRecipe | undefined =>
  recipe.methods.find((m) => m.path.join('.') === path);

describe('fromResponsesUsage', () => {
  it('reads the counts the Responses API actually reports', () => {
    assert.deepEqual(fromResponsesUsage(RESPONSES_USAGE), {
      input: 500,
      output: 400,
      cacheRead: 100,
      cacheCreate: 0,
      // The vendor's own total rides the digest, so a mapper need not re-add the parts.
      total: 1000,
    });
  });

  it('is empty rather than wrong when there is nothing to read', () => {
    assert.deepEqual(fromResponsesUsage(undefined), { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  });
});

describe('openAIRecipe covers both surfaces', () => {
  it('meters a Responses call instead of silently billing nothing', () => {
    const method = methodAt(openAIRecipe, 'responses.create');
    const measured = (method?.extractUsage?.({ usage: RESPONSES_USAGE }) as Measurement).usage!;
    assert.equal(measured.input + measured.output + measured.cacheRead, 1000, 'a 1000-token call is 1000 tokens');
  });

  it('still reads a Chat Completions call the other way', () => {
    const method = methodAt(openAIRecipe, 'chat.completions.create');
    const measured = (
      method?.extractUsage?.({
        usage: { prompt_tokens: 600, completion_tokens: 400 },
      }) as Measurement
    ).usage!;
    assert.equal(measured.input + measured.output, 1000);
  });

  it('reports nothing for a buffered response whose only x_groq block is cache statistics', () => {
    // `extractUsage` reads `result.usage` and never consults `x_groq`, which is what keeps the
    // streamed read above from leaking into the buffered path where that field means cache stats.
    const method = methodAt(openAIRecipe, 'chat.completions.create');
    const measured = method?.extractUsage?.({
      x_groq: { id: 'req_1', usage: { dram_cached_tokens: 50, sram_cached_tokens: 10 } },
    });
    assert.equal(measured, undefined, 'nothing to report is reported as nothing, not as zeroes');
  });

  it('finds usage on the Responses completion event, which nests it under the response', async () => {
    const method = methodAt(openAIRecipe, 'responses.create');
    const stream: any = {
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'response.output_text.delta', delta: 'hi' };
        yield { type: 'response.completed', response: { usage: RESPONSES_USAGE } };
      },
    };
    let metered: Measurement | undefined;
    method?.attachStream?.(stream, (measurement: unknown) => (metered = measurement as Measurement));
    for await (const _ of stream) void _;
    const usage = metered?.usage;
    assert.equal((usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0), 1000);
    // And the vendor's own names came through beside them, which is what gets reported.
    assert.equal(metered?.metrics?.input_tokens, RESPONSES_USAGE.input_tokens);
  });
});

describe('a streamed call states its usage as fully as a buffered one', () => {
  // `extractUsage` attached the vendor's own block as `raw` and `attachStream` did not, so every
  // `raw.*` dimension - `total_tokens`, the reasoning-token detail, anything the recipe does not
  // name - was missing from exactly the calls that stream, which is most chat traffic.
  const streamOf = (chunks: unknown[]) =>
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })();

  const meter = async (path: string, chunks: unknown[]) => {
    const stream: any = streamOf(chunks);
    let metered: Measurement | undefined;
    methodAt(openAIRecipe, path)?.attachStream?.(stream, (m: unknown) => (metered = m as Measurement));
    for await (const _ of stream) void _;
    return metered;
  };

  it('carries it on a chat completions stream', async () => {
    const usage = { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 };
    const metered = await meter('chat.completions.create', [{ choices: [] }, { usage }]);
    assert.deepEqual(metered?.raw, usage);
    // The counter the recipe deliberately does not meter, still readable as a dimension.
    assert.equal((metered?.raw as Record<string, number>).total_tokens, 1000);
  });

  it('carries it on a Responses stream, off the completion event', async () => {
    const metered = await meter('responses.create', [
      { type: 'response.output_text.delta', delta: 'hi' },
      { type: 'response.completed', response: { usage: RESPONSES_USAGE } },
    ]);
    assert.deepEqual(metered?.raw, RESPONSES_USAGE);
  });

  it('reports no raw at all when no chunk carried usage, rather than an empty object', async () => {
    const metered = await meter('chat.completions.create', [{ choices: [] }]);
    assert.equal(metered?.raw, undefined);
  });

  // Groq speaks the OpenAI wire format well enough that `openAIRecipe` matches its own `groq-sdk`
  // client by shape - and its streamed chunks carry no top-level `usage` at all. So every streamed
  // Groq call was wrapped, stamped governed, and metered at nothing. These three pin the fix.
  it('reads a Groq stream, whose usage rides x_groq rather than the chunk root', async () => {
    const usage = { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 };
    const metered = await meter('chat.completions.create', [
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [], x_groq: { usage } },
    ]);
    assert.equal(metered?.metrics?.total_tokens, 1000, 'a 1000-token Groq stream is 1000 tokens, not nothing');
    assert.equal(metered?.usage?.input, 600);
    assert.deepEqual(metered?.raw, usage);
  });

  it('does not read Groq hardware cache stats as token counts', async () => {
    // The same field name means something else entirely on a buffered response. Read as usage it
    // would meter three zeroes and carry cache statistics into the event's dimensions as `raw`.
    const metered = await meter('chat.completions.create', [
      { choices: [] },
      { choices: [], x_groq: { usage: { dram_cached_tokens: 50, sram_cached_tokens: 10 } } },
    ]);
    assert.deepEqual(metered?.metrics, {}, 'cache statistics are not token counters');
    assert.equal(metered?.raw, undefined);
  });

  it('still prefers a top-level usage when the endpoint sends one', async () => {
    // Groq's own spec says `stream_options: { include_usage: true }` populates the root as well,
    // so the fallback must stay a fallback rather than overriding what the standard field said.
    const usage = { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 };
    const metered = await meter('chat.completions.create', [
      { choices: [], usage, x_groq: { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } },
    ]);
    assert.deepEqual(metered?.raw, usage);
  });
});

describe('a gateway governs every surface the OpenAI recipe does', () => {
  for (const [label, recipe] of [
    ['openrouter', openrouterRecipe()],
    ['litellm', litellmRecipe()],
  ] as const) {
    it(`${label} declares at least the same methods, so none is left ungated by matching first`, () => {
      // A superset, not an equal set: these recipes are matched ahead of the OpenAI one, so every
      // surface it governs must be governed here too - but a gateway may reach further. OpenRouter
      // does, through its own SDK, whose methods the OpenAI recipe has never heard of.
      const declared = new Set(recipe.methods.map((m) => m.path.join('.')));
      for (const path of openAIRecipe.methods.map((m) => m.path.join('.'))) {
        assert.ok(declared.has(path), `${label} leaves ${path} ungated`);
      }
    });

    it(`${label} reads a Responses call with the right extractor`, () => {
      const method = methodAt(recipe, 'responses.create');
      const measured = method?.extractUsage?.({ usage: RESPONSES_USAGE, model: 'gpt-5', id: 'req_1' }) as {
        usage: TokenUsage;
      };
      assert.equal(measured.usage.input + measured.usage.output + measured.usage.cacheRead, 1000);
    });
  }
});

describe('normalizeUsage tells the two input_tokens shapes apart', () => {
  it('routes a Responses object to its own reader rather than the Anthropic one', () => {
    // Both count `input_tokens`/`output_tokens`, so the fallback reads one as the other happily -
    // and loses the cache detail only Responses nests, overstating the input it was hiding in.
    assert.deepEqual(normalizeUsage(RESPONSES_USAGE), {
      input: 500,
      output: 400,
      cacheRead: 100,
      cacheCreate: 0,
      total: 1000,
    });
  });

  it('still reads an Anthropic object the Anthropic way', () => {
    assert.deepEqual(normalizeUsage({ input_tokens: 600, output_tokens: 400, cache_read_input_tokens: 100 }), {
      input: 600,
      output: 400,
      cacheRead: 100,
      cacheCreate: 0,
      // Anthropic states no total, so this one is the sum of its four disjoint counters.
      total: 1100,
    });
  });
});

describe('normalizeUsage hands back a complete measurement', () => {
  it('fills the counters a partial object left out, rather than passing undefined on', () => {
    // Recognised as already-normalized by one field. The rest would be `undefined`, and
    // `undefined + number` is NaN - a measurement of nothing, reported as a broken one.
    assert.deepEqual(normalizeUsage({ cacheRead: 100 }), {
      input: 0,
      output: 0,
      cacheRead: 100,
      cacheCreate: 0,
    });
  });

  it('leaves a complete one exactly as it was given', () => {
    const usage = { input: 600, output: 400, cacheRead: 100, cacheCreate: 20 };
    assert.deepEqual(normalizeUsage(usage), usage);
  });
});
