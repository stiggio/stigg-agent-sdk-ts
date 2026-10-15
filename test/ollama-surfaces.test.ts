/**
 * The Ollama surfaces, and the three ways this binding could report a number that is wrong.
 *
 * Ollama's counters are flat on the response root, its TypeScript types declare them required
 * while the wire marks them `omitempty`, and its client is close enough to TypeSafe's that one
 * method name separates them. Each of those is a silent failure rather than a loud one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ollamaRecipe } from '../src/bindings/client/providers/ollama/ollama-recipe';
import { typesafeRecipe } from '../src/bindings/client/providers/typesafe/typesafe-recipe';
import { createClientRegistry } from '../src/bindings/client/core/registry';
import { normalizeUsage } from '../src/bindings/shared/token-usage';
import type { Measurement } from '../src/types';
import type { ClientRecipe, MethodRecipe } from '../src/bindings/client/core/types';

const methodAt = (path: string): MethodRecipe | undefined =>
  (ollamaRecipe as ClientRecipe).methods.find((m) => m.path.join('.') === path);

/** A completed `chat`, as the server actually sends it - counters flat on the root. */
const DONE = {
  model: 'llama3.3',
  done: true,
  done_reason: 'stop',
  message: { role: 'assistant', content: '' },
  prompt_eval_count: 600,
  eval_count: 400,
  total_duration: 1_234_567_890,
  load_duration: 12_345,
};

const streamOf = (chunks: unknown[]) =>
  (async function* () {
    for (const chunk of chunks) yield chunk;
  })();

const meter = async (path: string, chunks: unknown[]) => {
  const stream: any = streamOf(chunks);
  let metered: Measurement | undefined;
  methodAt(path)?.attachStream?.(stream, (m: unknown) => (metered = m as Measurement));
  for await (const _ of stream) void _;
  return metered;
};

describe('a buffered Ollama call', () => {
  it('reads the counters off the response root, where they actually sit', () => {
    const measured = methodAt('chat')?.extractUsage?.(DONE) as Measurement;
    assert.deepEqual(measured.metrics, { prompt_eval_count: 600, eval_count: 400, total_tokens: 1000 });
  });

  it('computes the total Ollama does not publish, from two disjoint counters', () => {
    const measured = methodAt('chat')?.extractUsage?.(DONE) as Measurement;
    assert.equal(measured.usage?.total, 1000);
    assert.deepEqual(measured.usage, { input: 600, output: 400, cacheRead: 0, cacheCreate: 0, total: 1000 });
  });

  it('never lets the response body reach raw, because raw becomes event dimensions', () => {
    // The counters share a root with `message.content` - the model's own reply text. Passing the
    // response through as `raw` would flatten that into the dimensions of every event.
    const measured = methodAt('chat')?.extractUsage?.(DONE) as Measurement;
    assert.deepEqual(measured.raw, { prompt_eval_count: 600, eval_count: 400 });
    assert.equal(JSON.stringify(measured.raw).includes('message'), false);
  });

  it('does not report the nanosecond durations as if they were tokens', () => {
    const measured = methodAt('chat')?.extractUsage?.(DONE) as Measurement;
    assert.equal(measured.metrics?.total_duration, undefined);
    assert.equal(measured.metrics?.load_duration, undefined);
  });

  it('governs generate as well as chat', () => {
    const measured = methodAt('generate')?.extractUsage?.(DONE) as Measurement;
    assert.equal(measured.metrics?.total_tokens, 1000);
  });

  it('reports nothing for a response carrying no counters at all', () => {
    assert.equal(methodAt('chat')?.extractUsage?.({ model: 'llama3.3', done: false }), undefined);
  });
});

describe('an Ollama stream', () => {
  it('meters the final done chunk, which is the only one carrying counters', async () => {
    const metered = await meter('chat', [
      { model: 'llama3.3', done: false, message: { content: 'hi' } },
      { model: 'llama3.3', done: false, message: { content: ' there' } },
      DONE,
    ]);
    assert.equal(metered?.metrics?.total_tokens, 1000);
    assert.equal(metered?.usage?.input, 600);
  });

  it('treats an intermediate chunk as absent counters, not as zeroes', async () => {
    // The vendor's own `.d.ts` says `prompt_eval_count: number` is always there; the server marks
    // the whole struct `omitempty` and sends none of it until the end. A reader trusting the type
    // would meter each intermediate chunk at zero and overwrite the real count with the last one.
    const metered = await meter('chat', [{ done: false, message: { content: 'hi' } }, DONE]);
    assert.equal(metered?.metrics?.prompt_eval_count, 600, 'the real count survives the empty chunks');
  });

  it('emits exactly one measurement for one completed stream', async () => {
    const stream: any = streamOf([{ done: false }, DONE]);
    const measured: Measurement[] = [];
    methodAt('chat')?.attachStream?.(stream, (m: unknown) => measured.push(m as Measurement));
    for await (const _ of stream) void _;
    assert.equal(measured.length, 1);
  });

  it('reports nothing for a stream that ended before its done chunk', async () => {
    const metered = await meter('chat', [{ done: false, message: { content: 'hi' } }]);
    assert.deepEqual(metered?.metrics, {});
    assert.equal(metered?.raw, undefined);
  });

  it('reports nothing for a stream that failed, rather than a zero', async () => {
    const stream: any = (async function* () {
      yield { done: false, message: { content: 'hi' } };
      throw new Error('the model crashed');
    })();
    let metered: Measurement | undefined;
    methodAt('chat')?.attachStream?.(stream, (m: unknown) => (metered = m as Measurement));
    await assert.rejects(async () => {
      for await (const _ of stream) void _;
    });
    assert.deepEqual(metered?.metrics, {});
  });
});

describe('matching an Ollama client', () => {
  const ollamaClient = () => ({
    chat: () => undefined,
    generate: () => undefined,
    ps: () => undefined,
    config: { host: 'http://127.0.0.1:11434' },
  });

  it('claims a client carrying all three markers', () => {
    assert.equal(ollamaRecipe.matches(ollamaClient()), true);
  });

  it('needs all three, so a bare chat() method is not an Ollama client', () => {
    assert.equal(ollamaRecipe.matches({ chat: () => undefined }), false);
    assert.equal(ollamaRecipe.matches({ chat: () => undefined, generate: () => undefined }), false);
  });

  it('claims a proxy-mode client, whose host is an empty string', () => {
    // `new Ollama({ proxy: true })` leaves `config.host` as '', which a host-based guard would
    // miss entirely. This recipe matches on shape, so that client is governed like any other.
    assert.equal(ollamaRecipe.matches({ ...ollamaClient(), config: { host: '' } }), true);
  });

  it('does not claim an OpenAI client pointed at the Ollama compat endpoint', () => {
    // That route already works: `openAIRecipe` matches it and `/v1` returns OpenAI-shaped usage.
    assert.equal(ollamaRecipe.matches({ chat: { completions: { create: () => undefined } } }), false);
  });
});

describe('Ollama and TypeSafe, whose clients are one method name apart', () => {
  it('leaves typesafeRecipe to the client that is actually TypeSafe', () => {
    // `systemOne` alone is enough - a thin adapter exposing only that surface is still TypeSafe.
    assert.equal(typesafeRecipe.matches({ systemOne: () => undefined }), true);
    assert.equal(typesafeRecipe.matches({ systemOne: () => undefined, models: { list: () => undefined } }), true);
  });

  it('does not let typesafeRecipe claim an Ollama client that also has systemone', () => {
    // `ollama` ships `systemone` - lowercase - returning `{ input_tokens, output_tokens }`, the
    // same shape TypeSafe reports. Casing is the only thing between them, so both the registry
    // order and the exclusion of the Ollama shape are checked here rather than assumed.
    const client = {
      chat: () => undefined,
      generate: () => undefined,
      ps: () => undefined,
      systemone: () => undefined,
    };
    assert.equal(typesafeRecipe.matches(client), false);
    assert.equal(ollamaRecipe.matches(client), true);
  });

  it('keeps the two guards mutually exclusive, so registry order cannot decide it', () => {
    // Stronger than asserting the order in `DEFAULT_RECIPES`: if neither recipe can claim the
    // other's client, then whichever is consulted first makes no difference. The order is still
    // set deliberately - see the comment there - but nothing depends on it holding.
    const ollamaish = { chat: () => undefined, generate: () => undefined, ps: () => undefined };
    const registry = createClientRegistry([typesafeRecipe, ollamaRecipe] as ClientRecipe[]);
    // Even with typesafe registered *first*, and even on a client carrying its exact method name.
    assert.equal(registry.find({ ...ollamaish, systemOne: () => undefined })?.vendor, 'ollama');
    assert.equal(registry.find({ systemOne: () => undefined })?.vendor, 'typesafe');
  });
});

describe('normalizeUsage recognises Ollama', () => {
  it('reads the root counters rather than falling through to the flat reader as zeroes', () => {
    // The recipe never calls this - it reads the root with `fromOllamaUsage` directly - but
    // `normalizeUsage` is exported, and the examples print what it returns beside the numbers the
    // recipe metered. A shape it does not know lands on `fromFlatTokenUsage`, which looks for
    // `input_tokens`, finds none, and prints a zeroed turn for a call that billed correctly.
    assert.deepEqual(normalizeUsage({ prompt_eval_count: 600, eval_count: 400 }), {
      input: 600,
      output: 400,
      cacheRead: 0,
      cacheCreate: 0,
      total: 1000,
    });
  });

  it('reads them off a whole response, which is the shape the examples actually hold', () => {
    assert.equal(normalizeUsage(DONE).total, 1000);
  });

  it('takes one counter alone, because the wire marks both omitempty', () => {
    assert.equal(normalizeUsage({ eval_count: 400 }).output, 400);
    assert.equal(normalizeUsage({ prompt_eval_count: 600 }).input, 600);
  });
});
