/**
 * Running an application's own callbacks, where their failure must not become the caller's.
 *
 * Hooks are instrumentation. One that throws has told us something went wrong with the watching,
 * not with the work - so it cannot be allowed to fail a decision, flip a delivered ingest, or
 * escape a promise the contract says never rejects. It cannot be ignored either, which is what a
 * bare `try {} catch {}` amounts to.
 *
 * Shared, because every path that calls one has to get this right the same way, and the ones that
 * reimplemented it are exactly the ones that got it wrong.
 */

/** Whether a callback typed `=> void` actually handed back something to wait on. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function';
}

/**
 * Invokes a callback and routes its failure to `onFailure`, synchronous or not.
 *
 * The types say `void`, but nothing stops an application writing `async onIngest` - and a
 * rejection there would otherwise surface as an unhandled one, which on Node's default takes the
 * process down over instrumentation.
 */
export function safely(invoke: () => unknown, onFailure: (err: unknown) => void): void {
  // The reporter is the application's code too - an `onError` that throws, a logger that throws
  // while saying so. Losing the report is the last acceptable failure here; letting it escape
  // would fail the work the callback was only watching.
  const report = (err: unknown) => {
    try {
      onFailure(err);
    } catch {
      // Nowhere left to report to.
    }
  };
  try {
    const returned = invoke();
    if (isThenable(returned)) void Promise.resolve(returned).catch(report);
  } catch (err) {
    report(err);
  }
}
