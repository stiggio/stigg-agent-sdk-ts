/**
 * Wrapping a stream so it can be metered, which every vendor needs and none of them differ on.
 *
 * What they *do* differ on is where the usage is: Anthropic accumulates it across two event types,
 * Chat Completions puts it on the last chunk, the Responses API nests it under a completion event,
 * and a gateway adds a cost and the model that served. So the mechanism is shared and the reading
 * stays with the recipe that knows the shape.
 *
 * Two properties this owes every recipe, both of which it once got wrong:
 *
 *  - **One completed stream meters once.** `onComplete` fires on the first ending and never
 *    again, however many times the object is iterated.
 *  - **Every way out of the stream is metered.** `for await` is the usual one, but an async
 *    generator - which is exactly what Gemini's `generateContentStream` resolves to - also
 *    exposes `next()` as public API, and a caller driving it by hand used to be metered at
 *    nothing at all.
 */
export function meterStream(stream: any, collect: (chunk: any) => void, onComplete: () => void): void {
  if (!stream) return;
  // Captured before anything is patched, so the patched methods below can drive the vendor's own
  // iterator without re-entering themselves. A bare generator's `[Symbol.asyncIterator]()`
  // returns *itself*, so without this the loop would call whatever `next` currently holds - by
  // then the patched one - and either recurse or count every chunk twice.
  const iterate =
    typeof stream[Symbol.asyncIterator] === 'function' ? stream[Symbol.asyncIterator].bind(stream) : undefined;
  const advance = typeof stream.next === 'function' ? stream.next.bind(stream) : undefined;
  // The vendor stream classes - Anthropic's and OpenAI's both - keep an `iterator` *factory* on
  // the instance, and everything else goes through it: `[Symbol.asyncIterator]()` returns
  // `this.iterator()`, and so does `tee()`. Patching the async iterator alone therefore leaves
  // `tee()` reading the raw source, which is how a teed stream was charged by the vendor and
  // metered at nothing here.
  const makeIterator = typeof stream.iterator === 'function' ? stream.iterator.bind(stream) : undefined;
  // Closing by hand ends a stream as surely as running it out, so these are captured too - and
  // for the same reason: `source()` drives them, and binding them after the patch would have it
  // calling itself.
  const closers = (['return', 'throw'] as const)
    .map((key) => ({ key, original: typeof stream[key] === 'function' ? stream[key].bind(stream) : undefined }))
    .filter((entry): entry is { key: 'return' | 'throw'; original: (...args: any[]) => any } => !!entry.original);
  if (!iterate && !advance && !makeIterator) return;

  /** Fires once. A stream iterated twice is still one completed stream, and one measurement. */
  let completed = false;
  const finish = (): void => {
    if (completed) return;
    completed = true;
    onComplete();
  };

  // Reading a chunk is instrumentation: a vendor that changes shape must not break the loop the
  // caller is standing in. The recipe reports what it could not read.
  const observe = (value: unknown): void => {
    try {
      collect(value);
    } catch {
      // Deliberately swallowed - `onComplete` still runs, and meters whatever was collected.
    }
  };

  /**
   * The vendor's own iterator, resolved once and shared by both patched paths - so a caller that
   * takes a few chunks by hand and then falls into a `for await` keeps reading one stream rather
   * than opening a second.
   *
   * Lazy on purpose: for the vendors whose `[Symbol.asyncIterator]()` builds a reader, calling it
   * eagerly would open a connection for a stream the caller may never consume.
   */
  let inner: { next: (...args: any[]) => Promise<any>; return?: () => Promise<any> } | undefined;
  /** Whether reading ever began. Closing a stream nobody read meters nothing, not a zero. */
  const started = () => inner !== undefined;
  const source = () => {
    if (!inner) {
      const it = iterate ? iterate() : stream;
      inner =
        // A generator hands back itself, and its `next` is patched below - so drive the original.
        it === stream
          ? { next: advance!, return: closers.find((entry) => entry.key === 'return')?.original }
          : { next: it.next.bind(it), return: typeof it.return === 'function' ? it.return.bind(it) : undefined };
    }
    return inner;
  };

  if (advance) {
    // The hand-driven path. Public API on any generator, and metered at nothing until now.
    stream.next = async (...args: any[]) => {
      try {
        const result = await source().next(...args);
        if (result?.done) finish();
        else observe(result?.value);
        return result;
      } catch (err) {
        // The stream ended, badly - but what it produced before it failed was still produced,
        // and still cost the customer. `for await` meters that through its own `finally`; this
        // path had no equivalent and dropped the whole measurement on the floor.
        finish();
        throw err;
      }
    };
  }

  // `return()` and `throw()` are how a hand-driven consumer stops early, and either one is the
  // end of the stream. Without this the usage read up to that point was never reported.
  for (const { key, original } of closers) {
    stream[key] = async (...args: any[]) => {
      try {
        return await original(...args);
      } finally {
        if (started()) finish();
      }
    };
  }

  /**
   * One pass over an iterator, metering as it goes. Shared by both entry points below so that the
   * accounting is written once: whichever door the caller came through, the usage is read the same
   * way and `finish()` fires on the same terms.
   */
  async function* metered(it: { next: (...args: any[]) => Promise<any>; return?: () => Promise<any> }) {
    // Whether the source ran itself out, as opposed to the consumer walking away from it. Only
    // the second case owes it a `return()` - see the `finally`.
    let exhausted = false;
    try {
      while (true) {
        const { value, done } = await it.next();
        if (done) {
          exhausted = true;
          return;
        }
        observe(value);
        yield value;
      }
    } finally {
      // Closes the vendor's stream when the consumer broke out early, which is what `for await`
      // did on the way out. Without it an abandoned stream holds its connection open.
      //
      // Only then, though. The iteration protocol closes an iterator on *abrupt* completion and
      // deliberately not when it ran itself out, so a source that already finished is never
      // asked to close - driving `next()` by hand means saying that explicitly rather than
      // inheriting it. Calling `return()` on a spent iterator is a no-op for a plain generator,
      // but a vendor is free to implement it as "abort the request", and aborting a stream that
      // has already delivered its last chunk is a cancellation nobody asked for.
      if (!exhausted) {
        try {
          await it.return?.();
        } catch {
          // A source that objects to being closed must not mask the caller's own exit path.
        }
      }
      // Meter what was actually produced, even if the consumer broke out of the loop early.
      finish();
    }
  }

  if (makeIterator) {
    // The factory, not the async iterator: `tee()` calls this directly and never touches
    // `[Symbol.asyncIterator]`, and the vendor's own `[Symbol.asyncIterator]` calls it too - so
    // one patch here meters every exit, and patching both would count each chunk twice.
    stream.iterator = function meteredIterator() {
      return metered(makeIterator());
    };
  } else if (iterate) {
    stream[Symbol.asyncIterator] = function meteredAsyncIterator() {
      return metered(source());
    };
  }
}
