/**
 * The Mistral surfaces, and the two places this binding could silently meter nothing.
 *
 * Mistral's generated SDK camelCases the wire, so a reader written against `prompt_tokens` finds
 * none of its fields and reports a zero that looks like data. And its streamed counters sit a
 * level down, under `data` - reading `chunk.usage` finds nothing on every chunk. Both are the
 * failure shape nothing downstream can notice, so both are pinned here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mistralRecipe } from '../src/bindings/client/providers/mistral/mistral-recipe';
import { normalizeUsage } from '../src/bindings/shared/token-usage';
import type { Measurement } from '../src/types';
import type { ClientRecipe, MethodRecipe } from '../src/bindings/client/core/types';

const methodAt = (path: string): MethodRecipe | undefined =>
  (mistralRecipe as ClientRecipe).methods.find((m) => m.path.join('.') === path);

/** What the SDK actually hands back: camelCase, because it renamed the wire on the way in. */
const USAGE = { promptTokens: 600, completionTokens: 400, totalTokens: 1000 };

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

describe('a buffered Mistral call', () => {
  it('reports the wire names, not the camelCase the client handed over', () => {
    const measured = methodAt('chat.complete')?.extractUsage?.({ usage: USAGE }) as Measurement;
    assert.deepEqual(measured.metrics, { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 });
  });

  it('normalizes the counters a mapper of its own would read', () => {
    const measured = methodAt('chat.complete')?.extractUsage?.({ usage: USAGE }) as Measurement;
    assert.deepEqual(measured.usage, { input: 600, output: 400, cacheRead: 0, cacheCreate: 0, total: 1000 });
  });

  it('carries raw under the same names as the metrics, so an event agrees with itself', () => {
    const measured = methodAt('chat.complete')?.extractUsage?.({ usage: USAGE }) as Measurement;
    assert.deepEqual(measured.raw, { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 });
  });

  it('reports nothing at all for a response that carried no usage', () => {
    assert.equal(methodAt('chat.complete')?.extractUsage?.({ id: 'x' }), undefined);
  });

  it('reports nothing rather than zeroes when every counter defaulted to zero', () => {
    // Mistral's inbound schema defaults each counter to 0, so "absent" and "genuinely nothing"
    // arrive looking identical. Either way there is no measurement worth reporting.
    const measured = methodAt('chat.complete')?.extractUsage?.({
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    assert.equal(measured, undefined);
  });

  it('reads fim and agents with the same extractor, because they are the same shape', () => {
    for (const path of ['fim.complete', 'agents.complete', 'chat.parse']) {
      const measured = methodAt(path)?.extractUsage?.({ usage: USAGE }) as Measurement;
      assert.equal(measured?.metrics?.total_tokens, 1000, `${path} reads its usage`);
    }
  });
});

describe('a streamed Mistral call', () => {
  it('finds usage nested under data, where the chunk actually keeps it', async () => {
    const metered = await meter('chat.stream', [{ data: { id: 'a' } }, { data: { usage: USAGE } }]);
    assert.equal(metered?.metrics?.total_tokens, 1000, 'a 1000-token stream is 1000 tokens, not nothing');
    assert.equal(metered?.usage?.input, 600);
  });

  it('emits exactly one measurement, at completion', async () => {
    const stream: any = streamOf([{ data: { usage: USAGE } }, { data: { usage: USAGE } }]);
    const measured: Measurement[] = [];
    methodAt('chat.stream')?.attachStream?.(stream, (m: unknown) => measured.push(m as Measurement));
    for await (const _ of stream) void _;
    assert.equal(measured.length, 1, 'one completed response is one measurement');
    // Stated whole on each chunk rather than as deltas, so the last wins outright - never summed.
    assert.equal(measured[0]?.metrics?.total_tokens, 1000);
  });

  it('reports no raw when no chunk carried usage, rather than an empty object', async () => {
    const metered = await meter('chat.stream', [{ data: { id: 'a' } }]);
    assert.equal(metered?.raw, undefined);
    assert.deepEqual(metered?.metrics, {});
  });

  it('reports nothing for a stream that failed before its usage arrived', async () => {
    const stream: any = (async function* () {
      yield { data: { id: 'a' } };
      throw new Error('upstream died');
    })();
    let metered: Measurement | undefined;
    methodAt('chat.stream')?.attachStream?.(stream, (m: unknown) => (metered = m as Measurement));
    await assert.rejects(async () => {
      for await (const _ of stream) void _;
    });
    // A broken stream reports what it could read - nothing - rather than a zero that would bill a
    // call which cost something at nothing.
    assert.deepEqual(metered?.metrics, {});
    assert.equal(metered?.raw, undefined);
  });

  it('covers the streamed fim and agents surfaces too', async () => {
    for (const path of ['fim.stream', 'agents.stream', 'chat.parseStream']) {
      const metered = await meter(path, [{ data: { usage: USAGE } }]);
      assert.equal(metered?.metrics?.total_tokens, 1000, `${path} meters its stream`);
    }
  });
});

describe('matching a Mistral client', () => {
  it('claims the vendor SDK, which has chat.complete and chat.stream', () => {
    const client = { chat: { complete: () => undefined, stream: () => undefined } };
    assert.equal(mistralRecipe.matches(client), true);
  });

  it('does not claim an OpenAI client pointed at Mistral, which speaks the other wire', () => {
    // That route is governed by `openAIRecipe` and reports `openai.*`; see the README.
    const client = { chat: { completions: { create: () => undefined } } };
    assert.equal(mistralRecipe.matches(client), false);
  });

  it('needs both signals, so a lone complete() does not make something a Mistral client', () => {
    assert.equal(mistralRecipe.matches({ chat: { complete: () => undefined } }), false);
  });
});

describe('normalizeUsage recognises Mistral', () => {
  it('reads its camelCase rather than falling through to the flat reader as zeroes', () => {
    assert.deepEqual(normalizeUsage(USAGE), {
      input: 600,
      output: 400,
      cacheRead: 0,
      cacheCreate: 0,
      total: 1000,
    });
  });
});
