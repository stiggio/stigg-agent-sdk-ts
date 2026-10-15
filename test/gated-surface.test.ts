/**
 * The overlay types `stiggContext` onto the methods the recipes actually gate - and onto nothing
 * else. Both halves matter: a method that cannot carry a context is unusable, and a method that
 * can carry one it will never honour is worse, because the call looks governed and is not.
 *
 * These assertions are compile-time. `tsc --noEmit` over this directory is what runs them; the
 * runtime case below only keeps the file inside the suite.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WrappedClient, PathsOf } from '../src/types';

type Params = { model: string };

/** A client shaped like the vendors, plus the ungated neighbours that share a method name. */
type FakeVendor = {
  messages: {
    create(params: Params): Promise<string>;
    stream(params: Params): string;
  };
  chat: { completions: { create(params: Params): Promise<string> } };
  responses: { create(params: Params): Promise<string> };
  // Named `create`, gated by no recipe: the case the path walk exists to exclude.
  files: { create(params: { file: string }): Promise<string> };
  batches: { create(params: { id: string }): Promise<string> };
};

declare const client: WrappedClient<FakeVendor>;
const ctx = { customerId: 'customer-acme' };

describe('the gated surface types the methods the recipes gate', () => {
  it('accepts a context on every gated path', () => {
    void (() => {
      void client.messages.create({ model: 'm', stiggContext: ctx });
      // Not in any recipe's `methods`, but it reaches the wire through the gated `create`.
      void client.messages.stream({ model: 'm', stiggContext: ctx });
      void client.chat.completions.create({ model: 'm', stiggContext: ctx });
      void client.responses.create({ model: 'm', stiggContext: ctx });
    });
    assert.ok(true);
  });

  it('refuses a context on a method sharing a gated name', () => {
    void (() => {
      // @ts-expect-error `files.create` is gated by no recipe: a context here would be forwarded
      // to the vendor as an unknown field, and the call would never be checked.
      void client.files.create({ file: 'f', stiggContext: ctx });
      // @ts-expect-error same for `batches.create`.
      void client.batches.create({ id: 'b', stiggContext: ctx });
    });
    assert.ok(true);
  });

  it('leaves an ungated method otherwise untouched', () => {
    void (() => {
      void client.files.create({ file: 'f' });
      void client.batches.create({ id: 'b' });
    });
    assert.ok(true);
  });
});

/**
 * A custom recipe gates paths the shipped list has never heard of, so the overlay follows the
 * recipe `wrap` was handed rather than the built-in union. The fallback is what keeps that honest:
 * a recipe whose paths widened to `string[]` carries nothing to narrow to, and gets the shipped
 * paths rather than a guess - so naming a recipe can only ever add precision.
 */
const custom = {
  vendor: 'imaginary',
  metrics: ['tokens'],
  methods: [{ path: ['conversations', 'reply'] as const }],
};

/** The same recipe written without `as const`, so its paths widen to `string[]`. */
const widened = { vendor: 'v', metrics: ['tokens'], methods: [{ path: ['conversations', 'reply'] }] };

type CustomClient = {
  conversations: { reply(params: { topic: string }): Promise<string> };
  // Named like a shipped path, and gated by this recipe no more than any other method is.
  chat: { completions: { create(params: { model: string }): Promise<string> } };
};

declare const customClient: WrappedClient<CustomClient, { customerId: string }, PathsOf<typeof custom>>;
declare const fallbackClient: WrappedClient<CustomClient, { customerId: string }, PathsOf<typeof widened>>;

describe('a custom recipe brings its own gated paths', () => {
  it('accepts a context on the path the recipe declares', () => {
    void (() => void customClient.conversations.reply({ topic: 't', stiggContext: ctx }));
    // The type above is read off this value, so the two cannot drift: what the recipe gates at
    // runtime is the same path the overlay types.
    assert.deepEqual([...custom.methods[0].path], ['conversations', 'reply']);
  });

  it('refuses one on a method it does not gate, however it is named', () => {
    void (() => {
      // @ts-expect-error this recipe gates `conversations.reply` and nothing else.
      void customClient.chat.completions.create({ model: 'm', stiggContext: ctx });
    });
    assert.ok(true);
  });

  it('falls back to the shipped paths when a recipe declares no literal ones', () => {
    // Nothing to narrow to, so the built-in union stands rather than a guess that gates nothing.
    void (() => void fallbackClient.chat.completions.create({ model: 'm', stiggContext: ctx }));
    // Same paths, written without `as const` - so there is nothing for the overlay to narrow to.
    assert.deepEqual(widened.methods[0].path, ['conversations', 'reply']);
  });
});
