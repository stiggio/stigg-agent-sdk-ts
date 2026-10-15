/**
 * What a streamed Anthropic call is metered as.
 *
 * Arithmetic over a *sequence*, not over one response shape - `metrics-contract.test.ts` already
 * covers what a single usage block reads as. Anthropic restates its counters cumulatively rather
 * than incrementing them, so what a stream is worth depends on the order its events arrive in and
 * on which of them restate what. The fixtures are therefore the event order Anthropic sends.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anthropicRecipe } from '../src/bindings/client/providers/anthropic/anthropic-recipe';
import type { Measurement, TokenUsage } from '../src/types';

/** The gated method, which is the only one that attaches to a stream. */
const messagesCreate = anthropicRecipe.methods[0];

/**
 * Runs a stream through the recipe and returns what it metered.
 *
 * `stopAfter` breaks out of the loop early, the way a user pressing "stop" does - the consumer
 * abandons the iterator and the `finally` still has to report what was stated by then.
 */
async function meter(
  events: unknown[],
  { stopAfter }: { stopAfter?: number } = {},
): Promise<Measurement & { seen: unknown[] }> {
  const measured: (TokenUsage | Measurement)[] = [];
  const stream: any = {
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) yield event;
    },
  };
  messagesCreate.attachStream?.(stream, (measurement) => measured.push(measurement));

  // Collected rather than discarded: metering wraps the iterator in place, so what the consumer
  // receives is as much a part of the contract as what Stigg is told.
  const seen: unknown[] = [];
  for await (const event of stream) {
    seen.push(event);
    if (stopAfter !== undefined && seen.length >= stopAfter) break;
  }

  // One completed response emits exactly one measurement - the contract `attachStream` is
  // documented with, and the thing a per-event `ingest` would quietly break.
  assert.equal(measured.length, 1, 'a stream should meter exactly once');
  return { ...(measured[0] as Measurement), seen };
}

/** The sequence Anthropic sends today: the delta restates the input counts it did not change. */
const cumulativeStream = [
  { type: 'message_start', message: { usage: { input_tokens: 819, output_tokens: 1 } } },
  { type: 'content_block_start' },
  { type: 'content_block_delta' },
  { type: 'content_block_stop' },
  { type: 'message_delta', usage: { input_tokens: 819, output_tokens: 46 } },
  { type: 'message_stop' },
];

describe('a streamed Anthropic call meters what the stream stated', () => {
  it('does not add the delta to the start - the delta is a restatement, not an increment', async () => {
    const { metrics, usage, seen } = await meter(cumulativeStream);

    // Metering is transparent: the consumer gets every event, unchanged and in order.
    assert.deepEqual(seen, cumulativeStream);

    // Summing the two events instead would report 1,638.
    assert.equal(metrics?.input_tokens, 819);
    assert.equal(usage?.input, 819);
    // The output count is the delta's, which is the only event that states a final one.
    assert.equal(metrics?.output_tokens, 46);
    assert.equal(usage?.output, 46);
    // And the computed total is over the restated counters, not the summed ones.
    assert.equal(metrics?.total_tokens, 865);
    assert.equal(usage?.total, 865);
  });

  it('keeps a counter only `message_start` stated, for a delta that carries fewer', async () => {
    // Older API versions send `output_tokens` alone on the delta. Replacing the block wholesale
    // would be the opposite billing error - the input counts would vanish.
    const { metrics, usage } = await meter([
      { type: 'message_start', message: { usage: { input_tokens: 819, output_tokens: 1 } } },
      { type: 'message_delta', usage: { output_tokens: 46 } },
      { type: 'message_stop' },
    ]);

    assert.equal(metrics?.input_tokens, 819);
    assert.equal(usage?.input, 819);
    assert.equal(metrics?.output_tokens, 46);
  });

  it('restates the cache counters too, which are cumulative on the same event', async () => {
    const { metrics, usage } = await meter([
      {
        type: 'message_start',
        message: { usage: { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 2048 } },
      },
      {
        type: 'message_delta',
        usage: { input_tokens: 9, output_tokens: 46, cache_read_input_tokens: 2048 },
      },
      { type: 'message_stop' },
    ]);

    // The counter customers watch hardest, and the one a doubling is most expensive on.
    assert.equal(metrics?.cache_read_input_tokens, 2048);
    assert.equal(usage?.cacheRead, 2048);
    assert.equal(usage?.total, 9 + 46 + 2048);
  });

  it('ignores a malformed counter rather than erasing what an earlier event stated', async () => {
    // From #235, which found this independently: a counter that restates another has to be
    // checked before it is trusted. `null` means "not this event"; a negative or non-numeric one
    // is not a count at all, and either would read back as zero if it were allowed to replace.
    const { metrics, usage } = await meter([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 819,
            output_tokens: 3,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 200,
          },
        },
      },
      {
        type: 'message_delta',
        usage: {
          input_tokens: null,
          output_tokens: 54,
          cache_read_input_tokens: -1,
          cache_creation_input_tokens: '200',
        },
      },
      { type: 'message_stop' },
    ]);

    assert.equal(usage?.input, 819, 'null means "not this event"');
    assert.equal(usage?.cacheRead, 500, 'a negative count does not erase the one message_start stated');
    assert.equal(usage?.cacheCreate, 200, 'nor does a count that is not a number');
    assert.equal(metrics?.output_tokens, 54, 'and a real restatement still replaces');
    assert.equal(metrics?.total_tokens, 1573);
  });

  it('ignores a null counter rather than erasing what an earlier event stated', async () => {
    // `null` is how this wire says "not on this event". Letting it through as a value would zero
    // a count that `message_start` did state.
    const { metrics } = await meter([
      { type: 'message_start', message: { usage: { input_tokens: 819, cache_read_input_tokens: 64 } } },
      { type: 'message_delta', usage: { input_tokens: null, output_tokens: 46, cache_read_input_tokens: null } },
      { type: 'message_stop' },
    ]);

    assert.equal(metrics?.input_tokens, 819);
    assert.equal(metrics?.cache_read_input_tokens, 64);
  });

  it('meters what was stated when the consumer stops reading early', async () => {
    // A user pressing "stop". The input counts arrived on `message_start`, so they are billable
    // and are billed.
    const { metrics, usage } = await meter(cumulativeStream, { stopAfter: 2 });

    assert.equal(metrics?.input_tokens, 819);
    assert.equal(usage?.input, 819);
  });
});

/**
 * A stream the consumer walked away from.
 *
 * Anthropic states the final output count on `message_delta`, which arrives just before
 * `message_stop` ends the stream, so a reply stopped halfway never reaches it and never states
 * one. The customer read the text it did generate and
 * Anthropic billed for generating it, so reporting the placeholder `output_tokens: 1` that
 * `message_start` carries is a hole rather than a conservative answer - and a free-output path
 * that takes no malice to find, since "stop generating" is a button in every chat UI.
 *
 * So the text is counted as it passes and estimated when nothing else will say. The estimate is
 * marked, and a run that would rather bill nothing than bill an estimate can see the mark.
 */
describe('a streamed reply the consumer stopped', () => {
  /** Four characters to a token, which is what the recipe estimates at. */
  const textDelta = (text: string) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } });

  const stopped = [
    { type: 'message_start', message: { usage: { input_tokens: 819, output_tokens: 1 } } },
    { type: 'content_block_start' },
    textDelta('a'.repeat(200)),
    textDelta('b'.repeat(200)),
    // No `message_delta` and no `message_stop`: the consumer broke out before either.
  ];

  it('estimates the output it generated instead of reporting the placeholder 1', async () => {
    const { metrics, usage, estimated } = await meter(stopped);

    assert.equal(estimated, true, 'the measurement says the count is the SDK own estimate');
    assert.equal(metrics?.output_tokens, 100, '400 characters at four to a token');
    assert.equal(usage?.output, 100);
    // The input counts are the vendor's own and are untouched by any of this.
    assert.equal(metrics?.input_tokens, 819);
    assert.equal(metrics?.total_tokens, 919);
  });

  it('counts reasoning and tool arguments too, which the vendor also bills as output', async () => {
    const { metrics } = await meter([
      { type: 'message_start', message: { usage: { input_tokens: 9, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x'.repeat(40) } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'y'.repeat(40) } },
      // Carries a signature over reasoning already counted, not anything newly generated.
      { type: 'content_block_delta', delta: { type: 'signature_delta' } },
    ]);

    assert.equal(metrics?.output_tokens, 20, '80 generated characters, and the signature is not one');
  });

  it('leaves a completed stream alone - the vendor stated a count, so nothing is estimated', async () => {
    const { metrics, estimated } = await meter([
      { type: 'message_start', message: { usage: { input_tokens: 819, output_tokens: 1 } } },
      textDelta('z'.repeat(4000)),
      { type: 'message_delta', usage: { input_tokens: 819, output_tokens: 46 } },
      { type: 'message_stop' },
    ]);

    // 4,000 characters would estimate to 1,000. The vendor said 46, and the vendor wins.
    assert.equal(metrics?.output_tokens, 46);
    assert.equal(estimated, undefined, 'nothing was estimated, so nothing claims to be');
  });

  it('estimates nothing for a stream that produced no text', async () => {
    // Stopped before the model generated anything. There is nothing to estimate from, and the
    // placeholder is left exactly as the vendor stated it.
    const { metrics, estimated } = await meter([
      { type: 'message_start', message: { usage: { input_tokens: 819, output_tokens: 1 } } },
      { type: 'content_block_start' },
    ]);

    assert.equal(estimated, undefined);
    assert.equal(metrics?.output_tokens, 1);
  });

  it('is visible to a mapper, so a run can refuse to bill an estimate', async () => {
    // The mark rides the measurement rather than a dimension precisely so this is possible: the
    // run's `usageMapper` sees it and decides. Billing an estimate is the default, not the rule.
    const measurement = await meter(stopped);
    const conservative = (m: typeof measurement) => (m.estimated ? {} : (m.metrics ?? {}));

    assert.deepEqual(conservative(measurement), {});
  });

  it('meters nothing for a stream that stated no usage at all', async () => {
    // Absent rather than zero, like every other metric here: a zero is something somebody then
    // has to interpret, and a feature reported at zero is not the same as one not reported.
    const { metrics, usage } = await meter([{ type: 'content_block_delta' }, { type: 'message_stop' }]);

    assert.deepEqual(metrics, {});
    assert.equal(usage?.total, undefined);
  });
});
