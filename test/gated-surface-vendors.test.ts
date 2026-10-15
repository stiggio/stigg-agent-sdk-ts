/**
 * The overlay, asserted against the **real** vendor types rather than a stand-in.
 *
 * `gated-surface.test.ts` proves the path walk over a hand-written client, whose methods are
 * plain functions. The vendors' are not: Anthropic declares `messages.stream` generic and OpenAI
 * overloads `chat.completions.create` on `stream`, and those declarations are what the overlay
 * actually has to survive - a fake client cannot stand in for them.
 *
 * These assertions are compile-time. `tsc --noEmit` over this directory is what runs them; the
 * runtime cases only keep the file inside the suite.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import type { WrappedClient } from '../src/types';

declare const anthropic: WrappedClient<Anthropic>;
declare const openai: WrappedClient<OpenAI>;
declare const gemini: WrappedClient<GoogleGenAI>;

const ctx = { customerId: 'customer-acme' };

describe('the overlay survives the vendors own declarations', () => {
  it('accepts a context on every gated method of every shipped vendor', () => {
    void (() => {
      void anthropic.messages.create({ model: 'm', max_tokens: 1, messages: [], stiggContext: ctx });
      void anthropic.messages.stream({ model: 'm', max_tokens: 1, messages: [], stiggContext: ctx });
      void openai.chat.completions.create({ model: 'm', messages: [], stiggContext: ctx });
      void openai.responses.create({ model: 'm', stiggContext: ctx });
      void gemini.models.generateContent({ model: 'm', contents: 'hi', stiggContext: ctx });
      void gemini.models.generateContentStream({ model: 'm', contents: 'hi', stiggContext: ctx });
    });
    assert.ok(true);
  });

  it('catches a misspelled context field on every method it can', () => {
    void (() => {
      // @ts-expect-error `custmerId` is not a context field.
      void anthropic.messages.create({ model: 'm', max_tokens: 1, messages: [], stiggContext: { custmerId: 'x' } });
      // @ts-expect-error same, over an overloaded vendor signature.
      void openai.chat.completions.create({ model: 'm', messages: [], stiggContext: { custmerId: 'x' } });
      // @ts-expect-error and over the Responses surface.
      void openai.responses.create({ model: 'm', stiggContext: { custmerId: 'x' } });
      // @ts-expect-error and over both of Gemini's.
      void gemini.models.generateContent({ model: 'm', contents: 'hi', stiggContext: { custmerId: 'x' } });
      // @ts-expect-error and over the streaming one, which is a separate gated path.
      void gemini.models.generateContentStream({ model: 'm', contents: 'hi', stiggContext: { custmerId: 'x' } });
    });
    assert.ok(true);
  });

  it('does NOT catch it on `messages.stream`, which is why the runtime does', () => {
    void (() => {
      // No `@ts-expect-error` here, and that absence is the assertion: this line compiles.
      //
      // Anthropic declares `stream<Params extends MessageStreamParams>(body: Params, ...)`. A
      // generic parameter infers from the argument instead of checking it for excess properties,
      // so the vendor's own signature accepts any extra field. `WrappedClient` intersects the
      // overlay with the vendor type to keep the client assignable to what it wraps, and an
      // intersection of call signatures is an overload set resolved in order - so a context the
      // overlay rejects falls through to that signature and is taken.
      //
      // `assertKnownContext` in `core/context.ts` closes it at runtime, for every surface. If a
      // future TypeScript or a narrower vendor declaration makes this line an error, that is good
      // news and this case should become a `@ts-expect-error` - the runtime guard stays either
      // way, because it covers hand-written call sites too.
      void anthropic.messages.stream({ model: 'm', max_tokens: 1, messages: [], stiggContext: { custmerId: 'x' } });
    });
    assert.ok(true);
  });

  it('leaves a wrapped client assignable to the vendor type it wraps', () => {
    void (() => {
      // What the intersection with `T` buys, and the reason the compile-time gap above is
      // tolerated rather than fixed by dropping it: existing code typed against the vendor keeps
      // accepting a governed client.
      const asAnthropic: Anthropic = anthropic;
      const asOpenAI: OpenAI = openai;
      const asGemini: GoogleGenAI = gemini;
      void asAnthropic;
      void asOpenAI;
      void asGemini;
    });
    assert.ok(true);
  });

  it('refuses a context on a vendor method no recipe gates', () => {
    void (() => {
      // @ts-expect-error `files.create` is gated by no recipe: a context here would never be read.
      void openai.files.create({ file: 'f' as any, purpose: 'assistants', stiggContext: ctx });
    });
    assert.ok(true);
  });
});
