/**
 * The Groq recipe: a hostname away from the generic OpenAI one, and one surface wide.
 *
 * Two things are worth pinning here. Groq's streamed counters ride `x_groq.usage` because its
 * chunks carry no top-level `usage` at all - so a reader that only looks at the root meters every
 * streamed call at nothing. And that same field holds hardware cache statistics on a buffered
 * response, so reading it unconditionally reports a real call as three zeroes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groqRecipe } from '../src/bindings/client/providers/groq/groq-recipe';
import { openAIRecipe } from '../src/bindings/client/providers/openai/openai-recipe';
import { createClientRegistry } from '../src/bindings/client/core/registry';
import { eventNameFor } from '../src/bindings/client/core/types';
import type { Measurement } from '../src/types';
import type { ClientRecipe, MethodRecipe } from '../src/bindings/client/core/types';

const chat = (recipe: ClientRecipe): MethodRecipe | undefined =>
  recipe.methods.find((m) => m.path.join('.') === 'chat.completions.create');

const USAGE = { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 };

/** A client shaped like either route to Groq: both carry a `baseURL` on the same host. */
const clientAt = (baseURL: string) => ({
  baseURL,
  chat: { completions: { create: () => undefined } },
});

const streamOf = (chunks: unknown[]) =>
  (async function* () {
    for (const chunk of chunks) yield chunk;
  })();

const meter = async (recipe: ClientRecipe, chunks: unknown[]) => {
  const stream: any = streamOf(chunks);
  let metered: Measurement | undefined;
  chat(recipe)?.attachStream?.(stream, (m: unknown) => (metered = m as Measurement));
  for await (const _ of stream) void _;
  return metered;
};

describe('matching a Groq client', () => {
  it('claims the native groq-sdk client, which defaults to the bare host', () => {
    assert.equal(groqRecipe.matches(clientAt('https://api.groq.com')), true);
  });

  it('claims an OpenAI client pointed at the compat endpoint - the same hostname', () => {
    assert.equal(groqRecipe.matches(clientAt('https://api.groq.com/openai/v1')), true);
  });

  it('compares the host, not a substring, so a lookalike domain is not claimed', () => {
    // `api.groq.com.example.com` is somebody else's domain; claiming it would meter an unrelated
    // client as Groq and bill the wrong account.
    assert.equal(groqRecipe.matches(clientAt('https://api.groq.com.example.com/v1')), false);
  });

  it('does not claim OpenAI itself', () => {
    assert.equal(groqRecipe.matches(clientAt('https://api.openai.com/v1')), false);
  });

  it('does not claim a client with no baseURL at all', () => {
    assert.equal(groqRecipe.matches({ chat: { completions: { create: () => undefined } } }), false);
  });

  it('still needs the OpenAI shape, so a bare baseURL is not enough', () => {
    assert.equal(groqRecipe.matches({ baseURL: 'https://api.groq.com' }), false);
  });

  it('wins over openAIRecipe when both are registered in the shipped order', () => {
    const registry = createClientRegistry([groqRecipe, openAIRecipe] as ClientRecipe[]);
    assert.equal(registry.find(clientAt('https://api.groq.com/openai/v1'))?.vendor, 'groq');
    // And the generic recipe still claims everything else.
    assert.equal(registry.find(clientAt('https://api.openai.com/v1'))?.vendor, 'openai');
  });
});

describe('what a Groq call is called', () => {
  it('reports under its own vendor name, so a meter can tell it from OpenAI', () => {
    const names = (groqRecipe as ClientRecipe).methods.map((m) => eventNameFor(groqRecipe, m));
    assert.deepEqual(names, ['groq.chat.completions.create']);
  });

  it('gates one surface, because Groq serves no Responses endpoint', () => {
    // Declaring `groq.responses.create` would publish an event name that can never fire - the
    // `groq-sdk` client has no such module and the API answers 404.
    assert.equal((groqRecipe as ClientRecipe).methods.length, 1);
  });
});

describe('a buffered Groq call', () => {
  it('reads the OpenAI-shaped usage at the response root', () => {
    const measured = chat(groqRecipe)?.extractUsage?.({ usage: USAGE }) as Measurement;
    assert.equal(measured.metrics?.total_tokens, 1000);
    assert.equal(measured.usage?.input, 600);
  });

  it('reports nothing when the only x_groq block is cache statistics', () => {
    // On a buffered response `x_groq.usage` is `dram_cached_tokens`/`sram_cached_tokens` - not
    // tokens. The extractor reads `result.usage` and never consults it, so there is nothing here.
    const measured = chat(groqRecipe)?.extractUsage?.({
      x_groq: { id: 'req_1', usage: { dram_cached_tokens: 50, sram_cached_tokens: 10 } },
    });
    assert.equal(measured, undefined, 'nothing to report is reported as nothing, not as zeroes');
  });
});

describe('a streamed Groq call', () => {
  it('finds the counters under x_groq, where Groq actually puts them', async () => {
    const metered = await meter(groqRecipe, [
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [], x_groq: { usage: USAGE } },
    ]);
    assert.equal(metered?.metrics?.total_tokens, 1000, 'a 1000-token Groq stream is 1000 tokens');
    assert.equal(metered?.usage?.input, 600);
  });

  it('would have metered that stream at nothing with a root-only reader', async () => {
    // The regression this read exists for, stated as the counterfactual: nothing in those chunks
    // has a top-level `usage`, so a reader looking only there collects an empty measurement.
    const chunks: any[] = [{ choices: [] }, { choices: [], x_groq: { usage: USAGE } }];
    assert.deepEqual(
      chunks.map((chunk) => chunk.usage),
      [undefined, undefined],
      'no chunk carries a root usage, which is the whole problem',
    );
  });

  it('does not mistake streamed cache statistics for token counts', async () => {
    const metered = await meter(groqRecipe, [
      { choices: [] },
      { choices: [], x_groq: { usage: { dram_cached_tokens: 50, sram_cached_tokens: 10 } } },
    ]);
    assert.deepEqual(metered?.metrics, {});
    assert.equal(metered?.raw, undefined);
  });

  it('prefers a root usage when include_usage put one there', async () => {
    const metered = await meter(groqRecipe, [
      { choices: [], usage: USAGE, x_groq: { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } },
    ]);
    assert.deepEqual(metered?.raw, USAGE);
  });
});

describe('a Groq client the host matcher declines', () => {
  it('is still metered by openAIRecipe, streamed counters included', async () => {
    // `GROQ_BASE_URL` pointed at a proxy or a regional endpoint is not claimed by `groqRecipe`,
    // so it lands in the generic recipe - which keeps the `x_groq` fallback for exactly this.
    const proxied = clientAt('https://llm-proxy.internal.example.com/groq/v1');
    assert.equal(groqRecipe.matches(proxied), false);
    assert.equal(openAIRecipe.matches(proxied), true);

    const metered = await meter(openAIRecipe as ClientRecipe, [{ choices: [], x_groq: { usage: USAGE } }]);
    assert.equal(metered?.metrics?.total_tokens, 1000, 'a proxied Groq stream is not metered at zero');
  });
});
