/**
 * Gemini's two surfaces, and the three ways reading its `usageMetadata` naively gets a bill wrong.
 *
 * Every case here is a number that would have been reported confidently and silently: this vendor
 * overlaps its counters in both directions at once, repeats cumulative totals on every stream
 * chunk, and hands its conversational API a privately-held reference to the module this binding
 * patches. None of the four failures below throws anything, fails a typecheck, or looks wrong in
 * a log - which is the whole reason they are pinned here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  estimateFromMaxOutputTokens,
  geminiChatRecipe,
  geminiRecipe,
} from '../src/bindings/client/providers/gemini/gemini-recipe';
import { anthropicRecipe } from '../src/bindings/client/providers/anthropic/anthropic-recipe';
import { openAIRecipe } from '../src/bindings/client/providers/openai/openai-recipe';
import { GEMINI_COMPONENT_METRICS, fromGeminiUsage, normalizeUsage } from '../src/bindings/shared/token-usage';
import { createClientRegistry } from '../src/bindings/client/core/registry';
import { wrapClient } from '../src/bindings/client/core/wrap-client';
import { eventNameFor } from '../src/bindings/client/core/types';
import { resolveContext } from '../src/core/context';
import { newRun } from './session-harness';
import { FakeEngine } from './fake-engine';
import {
  AFC_EVERY_CHUNK_SUMMED,
  AFC_LAST_BLOCK_ONLY,
  AFC_STREAM,
  AFC_TOTAL,
  THINKING_STREAM,
  THINKING_TOTAL,
} from './fixtures/gemini-streams';
import { StiggAgentSDK } from '../src';
import type { ClientRecipe, MethodRecipe } from '../src/bindings/client/core/types';
import type { Measurement } from '../src/types';
import type { EngineReportParams } from '../src/engine/engine';

/**
 * A response that exercises every counter at once, with both overlaps live.
 *
 * `totalTokenCount` is the vendor's own invariant - "the sum of `prompt_token_count`,
 * `candidates_token_count`, `tool_use_prompt_token_count`, and `thoughts_token_count`" - and
 * 1000 = 600 + 250 + 50 + 100 holds, with the 100 cached tokens already inside the 600.
 */
const USAGE = {
  promptTokenCount: 600,
  candidatesTokenCount: 250,
  cachedContentTokenCount: 100,
  thoughtsTokenCount: 100,
  toolUsePromptTokenCount: 50,
  totalTokenCount: 1000,
};

const methodAt = (recipe: ClientRecipe, path: string): MethodRecipe | undefined =>
  recipe.methods.find((m) => m.path.join('.') === path);

const context = resolveContext({ customerId: 'customer-acme' }, 'correlation-1');

describe('fromGeminiUsage reads both overlaps the way the vendor documents them', () => {
  it('takes the cached tokens out of the prompt total instead of billing them twice', () => {
    // 600 prompt INCLUDES the 100 cached, so the uncached input is 500 - plus the 50 tool-use
    // prompt tokens, which `totalTokenCount` adds alongside rather than within.
    assert.equal(fromGeminiUsage(USAGE).input, 550);
    assert.equal(fromGeminiUsage(USAGE).cacheRead, 100);
  });

  it('counts thinking tokens as output, which sit beside the candidates rather than inside', () => {
    // 250 candidates + 100 thoughts. Dropping the thoughts undercounts the output of every
    // reasoning model this vendor sells, by exactly the part that is most expensive.
    assert.equal(fromGeminiUsage(USAGE).output, 350);
  });

  it('adds back up to the vendor’s own total, which is what proves neither overlap was misread', () => {
    const { input, output, cacheRead, cacheCreate } = fromGeminiUsage(USAGE);
    assert.equal(input + output + cacheRead + cacheCreate, USAGE.totalTokenCount);
  });

  it('reports no cache writes, because a generation never performs one', () => {
    // An explicit cache is written by `caches.create`, whose own response carries that count.
    assert.equal(fromGeminiUsage(USAGE).cacheCreate, 0);
  });

  it('is empty rather than wrong when there is nothing to read', () => {
    assert.deepEqual(fromGeminiUsage(undefined), { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
    assert.deepEqual(fromGeminiUsage({}), { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  });
});

describe('normalizeUsage tells Gemini apart from the shapes it sits beside', () => {
  it('routes camelCase counters to the Gemini reader rather than metering them at zero', () => {
    // No field here is spelled the way any other vendor spells it, so the fallback flat reader
    // would find nothing at all and report a 1000-token call as nothing.
    assert.deepEqual(normalizeUsage(USAGE), {
      input: 550,
      output: 350,
      cacheRead: 100,
      cacheCreate: 0,
      total: 1000,
    });
  });

  it('recognises a payload carrying any single one of its counters', () => {
    // A proxy forwards what it observed, which need not be the whole block. Matching on the two
    // headline counters alone meant the other three fell through to the snake_case reader, which
    // finds nothing in them - so `{ thoughtsTokenCount: 100 }` metered a real turn as zero.
    const landings: Record<string, keyof ReturnType<typeof normalizeUsage>> = {
      promptTokenCount: 'input',
      candidatesTokenCount: 'output',
      cachedContentTokenCount: 'cacheRead',
      // Thinking tokens are output, and tool-use prompt tokens are input - the same reading the
      // full block gets, rather than a special case for arriving alone.
      thoughtsTokenCount: 'output',
      toolUsePromptTokenCount: 'input',
    };

    for (const [key, lands] of Object.entries(landings)) {
      const measured = normalizeUsage({ [key]: 100 });
      assert.equal(measured[lands], 100, `${key} alone should land on ${lands}`);
      const total = measured.input + measured.output + measured.cacheRead + measured.cacheCreate;
      assert.equal(total, 100, `${key} alone was metered as ${total}, not 100`);
    }
  });

  it('recognises every counter the recipe reads, so the two cannot drift', () => {
    // The discriminator reads the component list. The recipe also reports `totalTokenCount`, and
    // that one is deliberately absent here: a total is not identifying - more than one vendor
    // publishes one - so recognising a payload by it would claim objects that are not Gemini's.
    for (const key of GEMINI_COMPONENT_METRICS) {
      const measured = normalizeUsage({ [key]: 7 });
      const total = measured.input + measured.output + measured.cacheRead + measured.cacheCreate;
      assert.equal(total, 7, `${key} is a declared metric but normalizeUsage does not recognise it`);
    }
    // And the total alone identifies nothing, so it must not claim another vendor's payload.
    assert.deepEqual(normalizeUsage({ input_tokens: 600, output_tokens: 400, totalTokenCount: 1000 }), {
      input: 600,
      output: 400,
      cacheRead: 0,
      cacheCreate: 0,
      // Read by the flat reader, so the total is its own sum - not the Gemini field it ignored.
      total: 1000,
    });
  });

  it('ignores a Gemini key that carries no number, which would erase a real count', () => {
    // `'promptTokenCount' in raw` is true for a key whose value is `undefined` - what an object
    // built by spreading optional fields carries. Selecting the Gemini reader on mere presence
    // sent payloads that had counted their tokens some other way down a path that finds nothing
    // numeric under any of these names, normalizing 1000 real tokens to zero.
    for (const absent of [undefined, null, 'lots', {}]) {
      assert.deepEqual(
        normalizeUsage({ input_tokens: 600, output_tokens: 400, promptTokenCount: absent }),
        { input: 600, output: 400, cacheRead: 0, cacheCreate: 0, total: 1000 },
        `a ${String(absent)} promptTokenCount should not claim the payload`,
      );
    }
    // And the nested shapes keep their own readers rather than being swallowed on the way past.
    assert.deepEqual(
      normalizeUsage({
        input_tokens: 600,
        output_tokens: 400,
        input_token_details: { cache_read: 100 },
        thoughtsTokenCount: undefined,
      }),
      // LangChain publishes no total and its input count already contains the cached tokens, so
      // there is nothing safe to add up - absent is the honest answer.
      { input: 500, output: 400, cacheRead: 100, cacheCreate: 0 },
    );
  });

  it('still reads every other vendor the way it always did', () => {
    assert.equal(normalizeUsage({ prompt_tokens: 600, completion_tokens: 400 }).input, 600);
    assert.equal(normalizeUsage({ input_tokens: 600, output_tokens: 400 }).input, 600);
    // The widened guard must not claim a shape it does not own: these carry no camelCase counter.
    assert.deepEqual(
      normalizeUsage({ input_tokens: 600, output_tokens: 400, input_tokens_details: { cached_tokens: 100 } }),
      {
        input: 500,
        output: 400,
        cacheRead: 100,
        cacheCreate: 0,
      },
    );
  });
});

describe('a completed call reports both views of itself', () => {
  for (const path of ['models.generateContent', 'models.generateContentStream']) {
    it(`${path} states the vendor’s own names beside the normalized counters`, () => {
      const measured = methodAt(geminiRecipe, path)?.extractUsage?.({ usageMetadata: USAGE }) as Measurement;
      assert.equal(measured.metrics?.promptTokenCount, 600);
      assert.equal(measured.metrics?.thoughtsTokenCount, 100);
      assert.equal(measured.usage?.input, 550);
      // The vendor's own total, reported beside the breakdown rather than instead of it: the
      // breakdown prices parts, the total prices the call, and the catalog picks.
      assert.equal(measured.metrics?.totalTokenCount, 1000);
      assert.equal((measured.raw as Record<string, unknown>).totalTokenCount, 1000);
    });
  }

  it('reports nothing for a response that carried no usage at all', () => {
    assert.equal(methodAt(geminiRecipe, 'models.generateContent')?.extractUsage?.({ text: 'hi' }), undefined);
  });
});

describe('a streamed call, whose chunks are running totals rather than deltas', () => {
  /**
   * A **bare async generator**, which is what `generateContentStream` actually resolves to - not
   * a wrapper object with an `[Symbol.asyncIterator]` method on it, the way the OpenAI and
   * Anthropic SDKs hand their streams back.
   *
   * The distinction is the whole of `meterStream`'s hardest case and has to be reproduced here
   * rather than approximated: a generator's `[Symbol.asyncIterator]()` returns *itself*, so a
   * `for await` over it re-enters whatever that property currently holds. An object literal whose
   * method builds a fresh generator per call cannot reproduce that, passes every assertion below,
   * and leaves a stack overflow waiting on the first real Gemini stream.
   */
  const streamOf = (chunks: unknown[]) =>
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })();

  const meter = async (recipe: ClientRecipe, path: string, chunks: unknown[]) => {
    const stream: any = streamOf(chunks);
    let metered: Measurement | undefined;
    methodAt(recipe, path)?.attachStream?.(stream, (m: unknown) => (metered = m as Measurement));
    for await (const _ of stream) void _;
    return metered;
  };

  it('bills the last total once instead of summing every chunk that repeated it', async () => {
    // Gemini repeats `usageMetadata` on every chunk: `promptTokenCount` is constant and
    // `candidatesTokenCount` grows. Summing them would bill this 1000-token answer as 2550.
    const metered = await meter(geminiRecipe, 'models.generateContentStream', [
      { usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 10, totalTokenCount: 610 } },
      { usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 120, totalTokenCount: 720 } },
      { usageMetadata: USAGE },
    ]);

    assert.equal(metered?.metrics?.promptTokenCount, 600, 'the prompt was counted once, not once per chunk');
    assert.equal(metered?.metrics?.candidatesTokenCount, 250);
    assert.equal((metered?.usage?.input ?? 0) + (metered?.usage?.output ?? 0) + (metered?.usage?.cacheRead ?? 0), 1000);
  });

  it('carries the vendor’s own usage block, so a streamed turn states as much as a buffered one', async () => {
    // The gap this closes: `extractUsage` attached `raw` and `attachStream` did not, so every
    // `raw.*` dimension - `raw.totalTokenCount` above all, which is what a meter reads to bill
    // totals without maintaining a weight table - was missing from exactly the calls that stream.
    const metered = await meter(geminiRecipe, 'models.generateContentStream', [
      { usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 10, totalTokenCount: 610 } },
      { usageMetadata: USAGE },
    ]);
    assert.deepEqual(metered?.raw, USAGE, 'the last complete block, not the first partial one');
    assert.equal((metered?.raw as Record<string, number>).totalTokenCount, 1000);
  });

  it('reports the counters it measured, even if the consumer edits the chunk afterwards', async () => {
    // `raw` is held until the stream ends, and the chunk it came from is the consumer's. Keeping
    // a reference let the dimensions reported disagree with the metrics computed beside them.
    const usage = { promptTokenCount: 600, candidatesTokenCount: 250, totalTokenCount: 850 };
    const stream: any = streamOf([{ usageMetadata: usage }]);
    let metered: Measurement | undefined;
    methodAt(geminiRecipe, 'models.generateContentStream')?.attachStream?.(
      stream,
      (m: unknown) => (metered = m as Measurement),
    );
    for await (const chunk of stream) (chunk as any).usageMetadata.promptTokenCount = 999_999;

    assert.equal(metered?.metrics?.promptTokenCount, 600);
    assert.equal((metered?.raw as Record<string, number>).promptTokenCount, 600, 'raw drifted from the metrics');
  });

  it('keeps the last chunk that carried usage, since the final one does not always', async () => {
    const metered = await meter(geminiRecipe, 'models.generateContentStream', [
      { usageMetadata: USAGE },
      { text: 'trailing chunk with no usage on it' },
    ]);
    assert.equal(metered?.metrics?.promptTokenCount, 600);
  });

  it('meters what was produced even when the consumer stops reading early', async () => {
    const stream: any = (async function* () {
      yield { usageMetadata: USAGE };
      yield { text: 'never read' };
    })();
    let metered: Measurement | undefined;
    methodAt(geminiRecipe, 'models.generateContentStream')?.attachStream?.(
      stream,
      (m: unknown) => (metered = m as Measurement),
    );
    for await (const _ of stream) {
      void _;
      break;
    }
    assert.equal(metered?.usage?.output, 350);
  });

  it('iterates a generator-shaped stream without re-entering itself', async () => {
    // The regression guard for the above: before `meterStream` drove the iterator by hand, this
    // recursed through the patched `[Symbol.asyncIterator]` until the stack ran out. It fails as
    // a RangeError rather than a wrong number, but only against a real generator.
    const metered = await meter(geminiRecipe, 'models.generateContentStream', [
      { text: 'a' },
      { text: 'b' },
      { usageMetadata: USAGE },
    ]);
    assert.equal(metered?.metrics?.promptTokenCount, 600);
  });

  it('meters one completed stream once, however many times it is iterated', async () => {
    // A bare generator can be looped over again, and `onComplete` used to fire on every pass -
    // so a second loop re-ingested the full usage of the first. With no idempotency key on these
    // reports, that is a duplicate the backend cannot drop.
    const stream: any = streamOf([{ usageMetadata: USAGE }]);
    const ingests: Measurement[] = [];
    methodAt(geminiRecipe, 'models.generateContentStream')?.attachStream?.(stream, (m: unknown) =>
      ingests.push(m as Measurement),
    );

    for await (const _ of stream) void _;
    for await (const _ of stream) void _;

    assert.equal(ingests.length, 1, 'the same stream was billed twice');
    assert.equal(ingests[0]?.metrics?.promptTokenCount, 600);
  });

  it('meters a consumer that drives `next()` by hand, which a generator exposes as public API', async () => {
    // Only `[Symbol.asyncIterator]` used to be patched. A generator's `next()` is a documented
    // way to read it, and that path was metered at nothing at all.
    const stream: any = streamOf([{ usageMetadata: USAGE }]);
    const ingests: Measurement[] = [];
    methodAt(geminiRecipe, 'models.generateContentStream')?.attachStream?.(stream, (m: unknown) =>
      ingests.push(m as Measurement),
    );

    let result = await stream.next();
    while (!result.done) result = await stream.next();

    assert.equal(ingests.length, 1);
    assert.equal(ingests[0]?.metrics?.promptTokenCount, 600, 'a hand-driven stream metered nothing');
  });

  it('treats a few chunks by hand then a loop as one stream, not two', async () => {
    const stream: any = streamOf([{ usageMetadata: USAGE }, { text: 'more' }]);
    const ingests: Measurement[] = [];
    methodAt(geminiRecipe, 'models.generateContentStream')?.attachStream?.(stream, (m: unknown) =>
      ingests.push(m as Measurement),
    );

    await stream.next();
    for await (const _ of stream) void _;

    assert.equal(ingests.length, 1, 'the two read styles opened two streams');
  });

  it('meters nothing for a stream the caller never reads', async () => {
    const stream: any = streamOf([{ usageMetadata: USAGE }]);
    const ingests: Measurement[] = [];
    methodAt(geminiRecipe, 'models.generateContentStream')?.attachStream?.(stream, (m: unknown) =>
      ingests.push(m as Measurement),
    );
    assert.deepEqual(ingests, [], 'an unread stream produced a measurement');
  });

  it('leaves a stream that ran itself out alone, rather than closing a spent one', async () => {
    // The iteration protocol closes an iterator on abrupt completion and deliberately not when it
    // exhausted itself. Driving `next()` by hand means saying so: `return()` is a no-op on a
    // spent generator, but a vendor may implement it as "abort the request", and aborting a
    // stream that already delivered its last chunk is a cancellation nobody asked for.
    let closed = false;
    let metered = false;
    const source: any = {
      i: 0,
      async next() {
        return this.i++ < 1 ? { value: { usageMetadata: USAGE }, done: false } : { value: undefined, done: true };
      },
      async return() {
        closed = true;
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    methodAt(geminiRecipe, 'models.generateContentStream')?.attachStream?.(source, () => (metered = true));
    for await (const _ of source) void _;

    assert.equal(closed, false, 'a source that finished on its own was asked to close anyway');
    assert.equal(metered, true, 'the turn is still metered either way');
  });

  it('closes the vendor’s stream when the consumer walks away from it', async () => {
    // `for await` used to do this on the way out; driving `next()` by hand means saying so.
    let closed = false;
    const source = (async function* () {
      try {
        yield { usageMetadata: USAGE };
        yield { text: 'never read' };
      } finally {
        closed = true;
      }
    })();
    methodAt(geminiRecipe, 'models.generateContentStream')?.attachStream?.(source, () => undefined);
    for await (const _ of source as any) {
      void _;
      break;
    }
    assert.equal(closed, true, 'an abandoned stream would hold its connection open');
  });

  it('reports a measurement of nothing rather than NaN when no chunk carried usage', async () => {
    const metered = await meter(geminiRecipe, 'models.generateContentStream', [{ text: 'hi' }]);
    assert.deepEqual(metered, { metrics: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 } });
  });
});

describe('a streamed call, measured against streams recorded off the wire', () => {
  const play = async (chunks: readonly unknown[]) => {
    const stream: any = (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
    let metered: Measurement | undefined;
    methodAt(geminiRecipe, 'models.generateContentStream')?.attachStream?.(stream, (m: unknown) => {
      metered = m as Measurement;
    });
    for await (const _ of stream) void _;
    return metered;
  };

  const billed = (m: Measurement | undefined) =>
    (m?.usage?.input ?? 0) + (m?.usage?.output ?? 0) + (m?.usage?.cacheRead ?? 0);

  it('bills a thinking model’s single round at the total Google charged', async () => {
    const metered = await play(THINKING_STREAM);
    assert.equal(billed(metered), THINKING_TOTAL);
    // The claim this recipe rests on, checked against the wire rather than against our own mock:
    // thinking tokens are on the last block too, so taking it loses none of them.
    assert.equal(metered?.metrics?.thoughtsTokenCount, 157);
    // One round, so the block describes the whole measurement and rides along.
    assert.equal((metered?.raw as Record<string, number>).totalTokenCount, THINKING_TOTAL);
    assert.equal(metered?.dimensions, undefined);
  });

  it('bills automatic function calling for every round, not just the last', async () => {
    const metered = await play(AFC_STREAM);

    assert.equal(billed(metered), AFC_TOTAL, 'the sum of each round’s final block is what was charged');
    assert.notEqual(billed(metered), AFC_LAST_BLOCK_ONLY, 'billed one round of two');
    assert.notEqual(billed(metered), AFC_EVERY_CHUNK_SUMMED, 'billed every repeat of a running total');
    assert.equal(metered?.dimensions?.gemini_afc_rounds, '2');
  });

  it('states no raw block for a multi-round stream, because none describes the whole', async () => {
    // Each round's block states only its own round. Passing the last would hand a meter
    // dimensions that disagree with the metrics beside them.
    const metered = await play(AFC_STREAM);
    assert.equal(metered?.raw, undefined);
  });

  it('does not read a counter a chunk simply left out as a round restarting', async () => {
    // On the fallback path a counter going backwards is the only boundary signal, so an absent
    // one read as zero looks like a reset and banks a round that never ended. A decrease counts
    // only where both the new value and the old one were stated. (With ids present this cannot
    // arise: the id decides and the counters are not consulted at all.)
    const metered = await play([
      {
        usageMetadata: { promptTokenCount: 19, candidatesTokenCount: 10, thoughtsTokenCount: 46, totalTokenCount: 75 },
      },
      { usageMetadata: { promptTokenCount: 19, candidatesTokenCount: 20, totalTokenCount: 85 } },
    ]);
    assert.equal(metered?.dimensions, undefined, 'banked a round on a counter that was merely absent');
  });

  it('meters a stream the consumer closes by hand, rather than losing what it produced', async () => {
    // `return()` is how a hand-driven consumer stops early. Only `for await` had a `finally`, so
    // closing this way reported nothing at all - the tokens were produced and paid for either way.
    const stream: any = (async function* () {
      yield { usageMetadata: USAGE };
      yield { text: 'never read' };
    })();
    const ingests: Measurement[] = [];
    methodAt(geminiRecipe, 'models.generateContentStream')?.attachStream?.(stream, (m: unknown) =>
      ingests.push(m as Measurement),
    );

    await stream.next();
    await stream.return();

    assert.equal(ingests.length, 1, 'closing by hand lost the measurement');
    assert.equal(ingests[0]?.metrics?.promptTokenCount, 600);
  });

  it('meters what a stream produced before it failed partway through', async () => {
    const failing: any = (async function* () {
      yield { usageMetadata: USAGE };
      throw new Error('upstream died');
    })();
    const ingests: Measurement[] = [];
    methodAt(geminiRecipe, 'models.generateContentStream')?.attachStream?.(failing, (m: unknown) =>
      ingests.push(m as Measurement),
    );

    await failing.next();
    await assert.rejects(() => failing.next(), /upstream died/);

    assert.equal(ingests.length, 1, 'a stream that failed partway reported nothing');
  });

  it('meters nothing when a stream is closed without ever being read', async () => {
    const stream: any = (async function* () {
      yield { usageMetadata: USAGE };
    })();
    const ingests: Measurement[] = [];
    methodAt(geminiRecipe, 'models.generateContentStream')?.attachStream?.(stream, (m: unknown) =>
      ingests.push(m as Measurement),
    );
    await stream.return();
    assert.deepEqual(ingests, [], 'closing an unread stream produced a measurement');
  });

  it('starts a new round’s baselines from that round, not the one before it', async () => {
    // Where no id is reported, a counter running backwards is the only boundary signal. Carrying
    // the previous round's baseline past the boundary made the next chunk that stated the
    // counter look like a further restart, banking a round mid-round: 232 billed as 337.
    const metered = await play([
      {
        usageMetadata: { promptTokenCount: 59, candidatesTokenCount: 17, thoughtsTokenCount: 46, totalTokenCount: 122 },
      },
      // Round two opens without stating thoughts at all.
      { usageMetadata: { promptTokenCount: 92, candidatesTokenCount: 13, totalTokenCount: 105 } },
      {
        usageMetadata: { promptTokenCount: 92, candidatesTokenCount: 13, thoughtsTokenCount: 5, totalTokenCount: 110 },
      },
    ]);
    assert.equal(metered?.dimensions?.gemini_afc_rounds, '2', 'banked a round that had not ended');
    assert.equal(metered?.metrics?.totalTokenCount, 232);
  });

  it('states no total for a call where some round stated none', async () => {
    // Passing the other round's total on as the call's would understate it silently. Absent is
    // the honest answer, and the breakdown beside it is still reported.
    const metered = await play([
      {
        responseId: 'a',
        usageMetadata: { promptTokenCount: 59, candidatesTokenCount: 17, thoughtsTokenCount: 46, totalTokenCount: 122 },
      },
      { responseId: 'b', usageMetadata: { promptTokenCount: 92, candidatesTokenCount: 13, thoughtsTokenCount: 5 } },
    ]);
    assert.equal(metered?.usage?.total, undefined, 'one round’s total was passed off as the call’s');
    assert.equal(metered?.usage?.input, 59 + 92);
  });

  it('banks a round on the id alone, even when no counter goes down', async () => {
    // The id decides on its own. Requiring a counter to drop as well looked safer and was not: a
    // round that ends on a function call is easily smaller than the first usage chunk of the one
    // after it, and the boundary was then missed and the round never billed - 223 as 147.
    const metered = await play([
      { responseId: 'a', usageMetadata: { promptTokenCount: 59, candidatesTokenCount: 17, totalTokenCount: 76 } },
      { responseId: 'b', usageMetadata: { promptTokenCount: 92, candidatesTokenCount: 40, totalTokenCount: 132 } },
      { responseId: 'b', usageMetadata: { promptTokenCount: 92, candidatesTokenCount: 55, totalTokenCount: 147 } },
    ]);
    assert.equal(metered?.dimensions?.gemini_afc_rounds, '2', 'a round that only grew was never banked');
    assert.equal(billed(metered), 76 + 147);
  });

  it('falls back to a counter running backwards where nothing names the round', async () => {
    const metered = await play([
      {
        usageMetadata: { promptTokenCount: 59, candidatesTokenCount: 17, thoughtsTokenCount: 46, totalTokenCount: 122 },
      },
      {
        usageMetadata: { promptTokenCount: 92, candidatesTokenCount: 13, thoughtsTokenCount: 19, totalTokenCount: 124 },
      },
    ]);
    assert.equal(metered?.dimensions?.gemini_afc_rounds, '2');
    assert.equal(billed(metered), 122 + 124);
  });

  it('does not treat a prompt count that grows mid-round as a new round', async () => {
    // 92 -> 138 inside the second round, on the wire. Reading that as a boundary banked a round
    // that had not ended: 437 billed against 292 charged.
    const insideOneRound = AFC_STREAM.slice(2);
    const metered = await play(insideOneRound);
    assert.equal(billed(metered), 170, 'one round, so its final block and nothing more');
    assert.equal(metered?.dimensions, undefined);
  });
});

describe('automatic function calling, where the response hides what it cost', () => {
  /** What the SDK appends per round that invoked a tool: the model's call, then the reply. */
  const afcHistory = (rounds: number) => [
    { role: 'user', parts: [{ text: 'weather?' }] },
    ...Array.from({ length: rounds - 1 }).flatMap(() => [
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: {} } }] },
    ]),
  ];

  const measure = (rounds: number) =>
    methodAt(geminiRecipe, 'models.generateContent')?.extractUsage?.({
      usageMetadata: { promptTokenCount: 149, candidatesTokenCount: 13, thoughtsTokenCount: 19, totalTokenCount: 181 },
      responseId: 'resp_last_round',
      ...(rounds > 1 ? { automaticFunctionCallingHistory: afcHistory(rounds) } : {}),
    }) as Measurement;

  it('still reports the round it can see, because a short measurement beats none', () => {
    const measured = measure(2);
    assert.equal(measured.metrics?.totalTokenCount, 181);
    assert.equal(measured.usage?.total, 181);
  });

  it('says how many rounds there were, which is the part the response does let us count', () => {
    // The history is `Content` - role and parts - and carries no token counts at all, so the
    // rounds can be counted and not priced. Measured on the wire: 134 + 181 billed, 181 visible.
    assert.equal(measure(2).dimensions?.gemini_afc_rounds, '2');
    assert.equal(measure(4).dimensions?.gemini_afc_rounds, '4');
  });

  it('raises the shortfall rather than leaving it to whoever reads the docs', () => {
    const reason = measure(2).incomplete;
    assert.ok(reason, 'a call billed twice and metered once said nothing about it');
    // Actionable: what happened, what is missing, and the two ways to not have the problem.
    assert.match(reason!, /2 model calls/);
    assert.match(reason!, /181 tokens/);
    assert.match(reason!, /automaticFunctionCalling: \{ disable: true \}/);
  });

  it('says nothing of the sort for an ordinary call', () => {
    const plain = measure(1);
    assert.equal(plain.incomplete, undefined);
    assert.equal(plain.dimensions, undefined);
  });

  it('reports what it could and counts the shortfall as a metering failure', async () => {
    // Both, not one or the other: the ingest succeeds and `onError` still fires, so an operator
    // sees a number land *and* sees that it was short.
    const run = newRun();
    const client: any = wrapClient(
      {
        models: {
          generateContent: async () => ({
            usageMetadata: { promptTokenCount: 149, candidatesTokenCount: 13, totalTokenCount: 162 },
            automaticFunctionCallingHistory: afcHistory(2),
          }),
        },
      },
      geminiRecipe,
      run.session,
      context,
    );

    await client.models.generateContent({ model: 'gemini-3.8-flash' });
    await run.drain();

    assert.equal(run.summary().ingested, 1, 'the round it could see was dropped');
    assert.equal(run.summary().ingestFailures, 1, 'the shortfall was silent');
  });

  it('marks nothing incomplete on a streamed call, which sees every round', async () => {
    // The streamed surface has no such gap - every round's chunks pass through it - so it sums
    // them rather than apologising for them.
    const stream: any = (async function* () {
      for (const chunk of AFC_STREAM) yield chunk;
    })();
    let metered: Measurement | undefined;
    methodAt(geminiRecipe, 'models.generateContentStream')?.attachStream?.(stream, (m: unknown) => {
      metered = m as Measurement;
    });
    for await (const _ of stream) void _;

    assert.equal(metered?.incomplete, undefined);
    assert.equal(metered?.metrics?.totalTokenCount, AFC_TOTAL);
  });
});

describe('the chat surface, which is why there are two recipes', () => {
  /** A `Chat` as `ai.chats.create(...)` hands one back. */
  const chatShaped = (chunks: readonly unknown[] = THINKING_STREAM) => ({
    sendMessage: async () => ({ usageMetadata: USAGE, responseId: 'resp_chat_1' }),
    // A real stream, not `undefined`. With a stub that streamed nothing, deleting the metering
    // from this surface changed no assertion - the test that claimed to cover it proved only
    // that nothing happened.
    sendMessageStream: async () =>
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
    getHistory: () => [],
  });
  /** A `GoogleGenAI` client, whose `chats` module is built over the real `models`. */
  const clientShaped = () => ({
    models: { generateContent: async () => ({ usageMetadata: USAGE }), generateContentStream: async () => undefined },
    chats: { create: () => chatShaped() },
  });

  it('gates a chat’s own methods, which the client recipe never reaches', () => {
    const run = newRun();
    const chat = wrapClient(chatShaped(), geminiChatRecipe, run.session, context);
    assert.ok(chat);
    // The client recipe addresses `models.*`, which a chat does not have - so wrapping a chat
    // against it is the refusal `wrap-client` exists to raise rather than a client that meters
    // nothing.
    assert.throws(() => wrapClient(chatShaped(), geminiRecipe, newRun().session, context), /has none of them/);
  });

  it('meters a streamed chat turn, which is how a conversation actually runs', async () => {
    const run = newRun();
    const chat: any = wrapClient(chatShaped(), geminiChatRecipe, run.session, context);

    const stream = await chat.sendMessageStream({ message: 'hi' });
    for await (const _ of stream) void _;
    await run.drain();

    // The recorded single-round stream: its last block is the whole turn.
    assert.equal(run.summary().ingested, 1, 'a streamed chat turn metered nothing');
    assert.deepEqual(run.summary().reported, {
      promptTokenCount: 19,
      candidatesTokenCount: 75,
      thoughtsTokenCount: 157,
      totalTokenCount: THINKING_TOTAL,
    });
  });

  it('sums the rounds of a chat turn that called tools, like the one-shot surface does', async () => {
    // `Chat.sendMessageStream` reaches the wire through `generateContentStream`, so automatic
    // function calling splits a chat turn into rounds here too.
    const run = newRun();
    const chat: any = wrapClient(chatShaped(AFC_STREAM), geminiChatRecipe, run.session, context);

    const stream = await chat.sendMessageStream({ message: 'weather?' });
    for await (const _ of stream) void _;
    await run.drain();

    const reported = run.summary().reported;
    assert.equal(reported.totalTokenCount, AFC_TOTAL, 'billed one round of two');
    assert.notEqual(reported.totalTokenCount, AFC_LAST_BLOCK_ONLY);
  });

  it('names a streamed chat turn by the vendor’s own response id', async () => {
    // The key is what deduplicates a turn reported twice. A local step counter is stable only
    // within a process, so two replicas handed the same work would each invent one and both
    // would be charged; the vendor's id is the same number on both.
    const engine = new FakeEngine({ usageLimit: 100_000 });
    const sent: EngineReportParams[] = [];
    const report = engine.report.bind(engine);
    engine.report = (customerId, params) => {
      sent.push(params);
      return report(customerId, params);
    };
    const run = newRun({ engine });
    const chat: any = wrapClient(chatShaped(), geminiChatRecipe, run.session, context);

    const stream = await chat.sendMessageStream({ message: 'hi' });
    for await (const _ of stream) void _;
    await run.drain();

    assert.equal(sent[0]?.idempotencyKey, THINKING_STREAM[0].responseId);
  });

  it('meters a chat turn through the same reader as a one-shot call', async () => {
    const run = newRun();
    const chat: any = wrapClient(chatShaped(), geminiChatRecipe, run.session, context);
    await chat.sendMessage({ message: 'hi' });
    await run.drain();
    // The counters the one-shot surface would have reported, under the vendor's own names.
    assert.deepEqual(run.summary().reported, {
      promptTokenCount: 600,
      candidatesTokenCount: 250,
      cachedContentTokenCount: 100,
      thoughtsTokenCount: 100,
      toolUsePromptTokenCount: 50,
      totalTokenCount: 1000,
    });
  });

  it('names a chat turn after the API it came from, not after the bare method', () => {
    // `gemini.sendMessage` would say nothing about which Gemini API it is, and the event name is
    // what somebody has to recognise when configuring a meter to filter on it.
    assert.deepEqual(
      geminiChatRecipe.methods.map((method) => eventNameFor(geminiChatRecipe, method)),
      ['gemini.chats.sendMessage', 'gemini.chats.sendMessageStream'],
    );
  });

  it('leaves a chat built from a wrapped client ungoverned, which is why wrapping it is required', async () => {
    // Not a defect being enshrined - it is the vendor's construction. `new GoogleGenAI()` does
    // `new Chats(this.models, ...)` and each chat keeps that reference privately, so a chat made
    // from the wrapped copy still calls the original, unpatched module. Documented by a failing
    // meter here so that the day it changes, this test says so.
    const run = newRun();
    const client: any = wrapClient(clientShaped(), geminiRecipe, run.session, context);
    await client.chats.create().sendMessage({ message: 'hi' });
    await run.drain();
    assert.equal(run.summary().ingested, 0, 'the chat bypassed the gate, so it had to be wrapped in its own right');
    assert.deepEqual(run.summary().reported, {});
  });
});

describe('the registry picks each Gemini surface out by its own shape', () => {
  const registry = createClientRegistry([anthropicRecipe, openAIRecipe, geminiRecipe, geminiChatRecipe]);

  it('matches a GoogleGenAI client, and a client that only ever streams', () => {
    assert.equal(registry.find({ models: { generateContent: () => undefined } })?.vendor, 'gemini');
    assert.equal(registry.find({ models: { generateContentStream: () => undefined } })?.vendor, 'gemini');
  });

  it('claims no client another vendor owns', () => {
    assert.equal(registry.find({ chat: { completions: { create: () => undefined } } })?.vendor, 'openai');
    assert.equal(
      registry.find({ messages: { create: () => undefined, stream: () => undefined } })?.vendor,
      'anthropic',
    );
    // `models.list` is OpenAI's; only `generateContent` on it is Gemini's.
    assert.equal(registry.find({ models: { list: () => undefined } }), undefined);
  });

  it('refuses to claim any object that merely has a sendMessage', () => {
    // The guard that keeps a duck-typed registry from wrapping somebody else's queue client and
    // metering its calls as Gemini traffic.
    assert.equal(registry.find({ sendMessage: () => undefined }), undefined);
    assert.equal(registry.find({ sendMessage: () => undefined, sendMessageStream: () => undefined }), undefined);
    assert.equal(
      registry.find({ sendMessage: () => undefined, sendMessageStream: () => undefined, getHistory: () => [] })?.vendor,
      'gemini',
    );
  });
});

describe('the per-call context is typed onto exactly what gets gated', () => {
  /**
   * Compile-time assertions - `yarn build` typechecks this directory, so the `@ts-expect-error`
   * below fails the build if the overlay ever widens again.
   *
   * The regression this guards: `['sendMessage']` is one segment, and putting it in the global
   * fallback list typed `stiggContext` onto any client that had a method by that name. On a
   * client some *other* recipe matched, `wrap` then succeeded, the method was never gated, and
   * the context object was handed to the vendor as an unknown field it would forward rather than
   * strip - checks 0, ingested 0, and a `stiggContext` in the request body.
   */
  type GeminiChat = {
    sendMessage(p: { message: string }): Promise<{ usageMetadata?: unknown }>;
    sendMessageStream(p: { message: string }): Promise<AsyncGenerator<unknown>>;
    getHistory(curated?: boolean): unknown[];
  };
  /** Matches `openAIRecipe`, and happens to expose a `sendMessage` helper of its own. */
  type OpenAIishWithHelper = {
    chat: { completions: { create(p: { model: string }): Promise<{ usage?: unknown }> } };
    sendMessage(p: { text: string }): Promise<void>;
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function assertions() {
    // Never called - this function exists to be typechecked, not run.
    const stigg = null as unknown as StiggAgentSDK;
    const chat = null as unknown as GeminiChat;
    const other = null as unknown as OpenAIishWithHelper;

    const governedChat = stigg.wrap(chat, { stiggContext: { customerId: 'cust' } });
    // A real chat is what the recipe gates, so both of its methods take a context.
    await governedChat.sendMessage({ message: 'hi', stiggContext: { customerId: 'other' } });
    await governedChat.sendMessageStream({ message: 'hi', stiggContext: { customerId: 'other' } });

    // Named explicitly, the recipe's own literal paths are what the overlay uses - so a client
    // that `matches` would have rejected still types the context onto the two methods
    // `wrapClient` really does patch and strip it on. An explicit recipe never consults
    // `matches`, so the types must not apply the detection rule here.
    const twoMethod = null as unknown as Omit<GeminiChat, 'getHistory'>;
    const explicit = stigg.wrap(twoMethod, {
      recipe: geminiChatRecipe,
      stiggContext: { customerId: 'cust' },
    });
    await explicit.sendMessage({ message: 'hi', stiggContext: { customerId: 'other' } });
    await explicit.sendMessageStream({ message: 'hi', stiggContext: { customerId: 'other' } });

    // A client carrying both a gated vendor's shape and a chat's is matched as that vendor, so
    // its chat methods are never patched - and the overlay must not invite a context onto them.
    const hybrid = null as unknown as GeminiChat & OpenAIishWithHelper;
    const governedHybrid = stigg.wrap(hybrid, { stiggContext: { customerId: 'cust' } });
    await governedHybrid.chat.completions.create({ model: 'gpt-5', stiggContext: { customerId: 'other' } });
    // @ts-expect-error matched as OpenAI, so `sendMessage` is unpatched however chat-shaped it looks
    await governedHybrid.sendMessage({ message: 'hi', stiggContext: { customerId: 'other' } });

    const governed = stigg.wrap(other, { stiggContext: { customerId: 'cust' } });
    // The gated surface still takes one.
    await governed.chat.completions.create({ model: 'gpt-5', stiggContext: { customerId: 'other' } });
    // @ts-expect-error an ungated method must not accept a context: it is never checked, and the
    // object would reach the vendor verbatim.
    await governed.sendMessage({ text: 'hi', stiggContext: { customerId: 'other' } });
  }

  it('matches what the runtime matcher requires, which is all three methods', () => {
    // The type overlay keys off `getHistory` for the same reason the matcher does - so a client
    // the types call governable is one `wrap` will actually accept.
    assert.equal(geminiChatRecipe.matches?.({ sendMessage() {}, sendMessageStream() {} }), false);
    assert.equal(geminiChatRecipe.matches?.({ sendMessage() {}, sendMessageStream() {}, getHistory: () => [] }), true);
  });
});

describe('estimateFromMaxOutputTokens', () => {
  it('reads the ceiling from where Gemini nests it, under `config`', () => {
    assert.equal(estimateFromMaxOutputTokens(100)({ config: { maxOutputTokens: 950 } }), 10);
  });

  it('asks for a single unit when the call set no ceiling', () => {
    assert.equal(estimateFromMaxOutputTokens(100)({}), 1);
    assert.equal(estimateFromMaxOutputTokens()({ config: {} }), 1);
  });
});
