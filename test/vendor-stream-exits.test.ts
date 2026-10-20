/**
 * Every exit from a *real* vendor stream is metered, through the *real* recipe.
 *
 * Two things conspired to hide a hole here. The other stream tests build the iterable by hand - an
 * object carrying `[Symbol.asyncIterator]` - which is enough for the arithmetic but has no `tee()`
 * to get wrong. And the vendor classes have more than one door out: both Anthropic's `Stream` and
 * OpenAI's keep an `iterator` factory on the instance, `[Symbol.asyncIterator]()` returns
 * `this.iterator()`, and `tee()` calls `this.iterator()` directly. Patching the async iterator
 * metered `for await` and missed `tee()` - the vendor charged and the budget never moved.
 *
 * So these go through `attachStream` on the recipes themselves, not through the shared helper.
 * Anthropic is the reason that distinction matters: it is the one provider that does not use
 * `meterStream` at all, and a test written against the helper passes while the path a caller
 * actually takes stays broken.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Stream as AnthropicStream } from '@anthropic-ai/sdk/core/streaming';
import { Stream as OpenAIStream } from 'openai/core/streaming';
import { anthropicRecipe } from '../src/bindings/client/providers/anthropic/anthropic-recipe';
import { openAIRecipe } from '../src/bindings/client/providers/openai/openai-recipe';
import type { Measurement } from '../src/types';

type Vendor = {
  name: string;
  /** The stream a caller is handed, carrying events that state 7 output tokens. */
  stream: () => any;
  /** The recipe method that attaches metering to it. */
  attach: (stream: any, ingest: (m: Measurement) => void) => void;
  outputTokens: number;
};

const ANTHROPIC_EVENTS = [
  { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_delta', delta: { text: 'hello' } },
  { type: 'message_delta', usage: { output_tokens: 7 } },
];

const OPENAI_CHUNKS = [
  { choices: [{ delta: { content: 'hel' } }] },
  { choices: [{ delta: { content: 'lo' } }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 } },
];

function streamOf(Ctor: any, events: unknown[], ctorArgs: unknown[]): any {
  return new Ctor(
    async function* () {
      for (const event of events) yield event;
    },
    ...ctorArgs,
  );
}

const vendors: Vendor[] = [
  {
    name: 'Anthropic',
    stream: () => streamOf(AnthropicStream, ANTHROPIC_EVENTS, [new AbortController(), undefined]),
    attach: (stream, ingest) => anthropicRecipe.methods[0]!.attachStream?.(stream, ingest),
    outputTokens: 7,
  },
  {
    name: 'OpenAI',
    stream: () => streamOf(OpenAIStream, OPENAI_CHUNKS, [new AbortController()]),
    attach: (stream, ingest) => {
      const method = openAIRecipe.methods.find((m) => !!m.attachStream);
      method!.attachStream?.(stream, ingest);
    },
    outputTokens: 7,
  },
];

for (const vendor of vendors) {
  describe(`${vendor.name}: every exit from the vendor's own stream`, () => {
    /** Attaches metering and hands back the stream plus the ledger it reports into. */
    const metered = () => {
      const reported: Measurement[] = [];
      const stream = vendor.stream();
      vendor.attach(stream, (m) => reported.push(m));
      return { stream, reported };
    };

    const output = (m: Measurement | undefined) =>
      (m?.metrics as Record<string, number> | undefined)?.output_tokens ??
      (m?.metrics as Record<string, number> | undefined)?.completion_tokens;

    it('meters a plain `for await`', async () => {
      const run = metered();
      for await (const _ of run.stream) void _;

      assert.equal(run.reported.length, 1, 'one completed stream meters once');
      assert.equal(output(run.reported[0]), vendor.outputTokens, 'and states what the stream said');
    });

    it('meters a stream split with `tee()` - the vendor charges, so the budget must move', async () => {
      const run = metered();
      const [left, right] = run.stream.tee();

      const fromLeft: unknown[] = [];
      for await (const chunk of left) fromLeft.push(chunk);
      const fromRight: unknown[] = [];
      for await (const chunk of right) fromRight.push(chunk);

      assert.equal(fromLeft.length, fromRight.length, 'both branches read the whole stream');
      assert.ok(fromLeft.length > 0, 'and it was not empty');
      assert.equal(run.reported.length, 1, 'two branches are still one stream, and one measurement');
      assert.equal(output(run.reported[0]), vendor.outputTokens, 'metered as what the stream said, not an estimate');
    });

    it('meters a stream abandoned part-way', async () => {
      const run = metered();
      for await (const _ of run.stream) {
        void _;
        break;
      }

      assert.equal(run.reported.length, 1, 'what was produced before the break still cost the customer');
    });
  });
}
