/**
 * The fetch binding: the client binding's gate and meter, for a call made with plain HTTP.
 *
 * A gateway is often called with no SDK at all - a service posts JSON to `/v1/chat/completions`
 * and reads the reply - and `wrap` has nothing to hold on to there. The proxy binding does not
 * help either: it ingests what a proxy *you* operate observed, and a third-party gateway never
 * calls Stigg. So this wraps the one object such a caller does hold, its `fetch`.
 *
 * Nothing about reading a response is new here. A request is matched to a recipe method by its
 * path - `/chat/completions` is `chat.completions.create` on every OpenAI-wire SDK, `/messages`
 * is Anthropic's `messages.create` - and from then on it is that method's call: the same
 * `estimate`, the same `extractUsage` on a JSON reply, the same `attachStream` on an SSE one, and
 * the same event name. A recipe is written once and governs both ways of reaching its vendor.
 *
 * Three things differ from a wrapped client, all because a `fetch` is a lower-level door:
 *
 *  - **Only routes the recipe declares are governed.** Anything else - another host, `GET
 *    /models`, embeddings - passes through untouched. A `fetch` reaches more than one endpoint,
 *    and refusing or metering a call nothing describes would be guessing.
 *  - **A stream is metered as the caller reads it.** The body is observed in place, not teed, so
 *    nothing is buffered on the caller's behalf - and, as with an SDK stream, a body nobody reads
 *    to the end meters what was read.
 *  - **A streamed reply comes back as a new `Response`** around the observed body, carrying the
 *    original status and headers. `url` and `redirected` are not carried, because a constructed
 *    `Response` cannot have them.
 */
import { AccessDeniedError } from '../../errors';
import { isEnforced, noCustomer, overrideContext, type ResolvedContext } from '../../core/context';
import type { GovernanceSession } from '../../core/session';
import { toMeasurement, type Measurement, type TokenUsage } from '../../types';
import { pathOf, withinBaseUrl } from '../shared/base-url';
import { eventNameFor, type ClientRecipe, type MethodRecipe } from '../client/core/types';
import { modelOf, requestedUnits } from '../client/core/wrap-client';
import type { FetchLike, GovernedRequestInit } from './types';

/**
 * Where each SDK method posts. The same on every vendor that speaks the wire - which is why a
 * gateway can be OpenAI-compatible at all - so it lives here once rather than on every recipe.
 */
const ROUTES: Record<string, string> = {
  'chat.completions.create': '/chat/completions',
  'responses.create': '/responses',
  'messages.create': '/messages',
};

type Route = { suffix: string; method: MethodRecipe; eventName: string };

export function wrapFetch(
  fetchFn: FetchLike,
  recipe: ClientRecipe,
  baseUrl: string,
  session: GovernanceSession,
  base: ResolvedContext,
): (input: string | URL | Request, init?: GovernedRequestInit) => Promise<Response> {
  const routes: Route[] = recipe.methods.flatMap((method) => {
    const suffix = ROUTES[method.path.join('.')];
    return suffix ? [{ suffix, method, eventName: eventNameFor(recipe, method) }] : [];
  });
  // The same refusal `wrap` makes for a recipe that gates nothing on the client it was handed: a
  // fetch that looks governed and meters nothing is worse than an error now.
  if (routes.length === 0) {
    throw new Error(
      `The ${recipe.vendor} recipe gates ${recipe.methods.map((m) => m.path.join('.')).join(', ')}, and none of ` +
        `those has an HTTP route this binding knows (${Object.values(ROUTES).join(', ')}). Nothing would be ` +
        'checked or metered, so this is refused rather than handed back looking governed.',
    );
  }
  // A relative or malformed one matches nothing, so every request would pass through ungoverned.
  if (!URL.canParse(baseUrl)) throw new Error(`wrapFetch needs an absolute base URL, got "${baseUrl}".`);

  return async function governedFetch(input, init) {
    // Taken off before anything else sees the request, governed or not - `fetch` ignores an
    // unknown field today, but it is not this binding's to forward.
    let requestInit: RequestInit | undefined = init;
    let override: StiggContextOverride;
    // Presence, not value: an explicit `stiggContext: undefined` is still not the wire's.
    if (init && 'stiggContext' in init) {
      const { stiggContext, ...rest } = init;
      requestInit = rest;
      override = stiggContext;
    }

    const route = routeOf(input, requestInit, baseUrl, routes);
    if (!route) return fetchFn(input, requestInit);

    const params = await paramsOf(input, requestInit);
    if (route.method.passthrough?.(params, undefined)) return fetchFn(input, requestInit);

    const defaults: ResolvedContext = base.eventName ? base : { ...base, eventName: { name: route.eventName } };
    // Presence, as `wrap` tests it: a `null` override is validated and refused, not ignored.
    const context = override !== undefined ? overrideContext(defaults, override) : defaults;
    if (!context.customerId) throw noCustomer();

    if (isEnforced(context)) {
      const decision = await session.check(context, requestedUnits(route.method.estimate ?? (() => 1), params));
      if (!decision.hasAccess) throw new AccessDeniedError(decision);
    }

    const startedAt = Date.now();
    const response = await fetchFn(input, requestInit);
    // An error body carries no usage, and the gateway billed nothing for a refusal of its own.
    if (!response.ok) return response;

    let data: unknown;
    let served: string | undefined;
    const ingest = (measured: TokenUsage | Measurement) => {
      const measurement = toMeasurement(measured);
      // What an AUDR record names and the measurement does not, as `wrap` adds it: the reply's
      // model before the request's, since the gateway can serve another.
      const traced: ResolvedContext = {
        ...context,
        audr: { provider: recipe.vendor, model: modelOf(served, data, params), startedAt },
      };
      void session.ingestMeasurement(traced, measurement);
      if (measurement.incomplete) session.failedToMeasure(context, new Error(measurement.incomplete));
    };

    try {
      if (isEventStream(response))
        return meteredStream(
          response,
          route.method,
          ingest,
          (err) => session.failedToMeasure(context, err),
          // The model that served, from the first event that names it - a Chat Completions chunk,
          // Anthropic's `message_start`, a Responses event - so a stream's record matches a reply's.
          (event: any) => (served ??= modelOf(event, event?.message, event?.response)),
        );

      // A copy, read here, so the caller gets a body nobody has touched. Awaited rather than left
      // running, so the ingest is in flight - and `flush()` waits for it - by the time the caller
      // has the response.
      data = await response.clone().json();
      const measured = route.method.extractUsage?.(data, response);
      if (measured) ingest(measured);
    } catch (err) {
      // The gateway already answered. A reply this cannot read is a metering failure, not the
      // caller's - turning it into a rejection would fail a request that worked. A parse error
      // quotes the body it choked on, so it is replaced rather than handed to the logger.
      session.failedToMeasure(
        context,
        err instanceof SyntaxError
          ? new Error('The gateway’s reply was not JSON, so its usage could not be read.')
          : err,
      );
    }
    return response;
  };
}

type StiggContextOverride = GovernedRequestInit['stiggContext'];

/** The route a request takes, or undefined for one this binding leaves alone. */
function routeOf(
  input: string | URL | Request,
  init: RequestInit | undefined,
  baseUrl: string,
  routes: Route[],
): Route | undefined {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!withinBaseUrl(baseUrl, url)) return undefined;
  const method = (
    init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
  ).toUpperCase();
  if (method !== 'POST') return undefined;
  // Read from the base URL down, so `/messages` is the gateway's own route and not the tail of
  // `/v1/threads/{id}/messages` (OpenAI Assistants), and `/messages/count_tokens` - free, and not
  // generation - is not one either. An optional `/v1`, for a base URL given without it.
  const path = pathOf(url).slice(pathOf(baseUrl).length);
  return routes.find((route) => path === route.suffix || path === `/v1${route.suffix}`);
}

/**
 * The request's JSON, which is what a recipe's `estimate` and `passthrough` read - the same object
 * an SDK method would have been handed. An empty object for a body that is not JSON text (a stream,
 * form data, text that does not parse), so an estimate like `(p) => p.max_tokens` falls back to
 * its default instead of throwing - and failing a request before it is sent.
 */
async function paramsOf(input: string | URL | Request, init: RequestInit | undefined): Promise<any> {
  let text: string | undefined;
  const body = init?.body;
  if (typeof body === 'string') text = body;
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body))
    text = new TextDecoder().decode(body as ArrayBuffer);
  // A Blob is immutable, so reading it here leaves the body `fetch` sends untouched.
  else if (body instanceof Blob) text = await body.text();
  else if (body == null && input instanceof Request) text = await input.clone().text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

const isEventStream = (response: Response): boolean =>
  // Media types are case-insensitive, and a JSON parse of a live stream would wait for it to end.
  (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream') && response.body !== null;

/**
 * The reply, with its body observed in place.
 *
 * The recipe's stream reader is written against an async iterable of parsed events - what an SDK
 * stream yields - so this parses the SSE as the caller reads it and feeds a channel the reader is
 * attached to. Every recipe's existing reader works unchanged: Anthropic accumulating across two
 * event types, Chat Completions reading the last chunk, Responses its completion event.
 */
function meteredStream(
  response: Response,
  method: MethodRecipe,
  ingest: (measured: TokenUsage | Measurement) => void,
  failed: (err: unknown) => void,
  seen: (event: unknown) => void,
): Response {
  const events = channel();
  if (!method.attachStream) return response;
  method.attachStream(events, ingest, response);
  // Drives the iterator the recipe patched, which is what runs its accounting. Started by the
  // first event rather than up front, because the recipe reads a started stream that closes as a
  // zero - and a body cancelled before anything was read measured nothing, not nothing used.
  let consumed: Promise<void> | undefined;
  const consume = () =>
    (consumed ??= (async () => {
      try {
        for await (const _event of events) void _event;
      } catch (err) {
        failed(err);
      }
    })());

  const body = observeSse(
    response.body!,
    (event) => {
      seen(event);
      events.push(event);
      void consume();
    },
    () => {
      events.close();
      return consumed;
    },
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** A one-reader queue: pushed to as the body is read, drained by the recipe's stream reader. */
function channel() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push: (event: unknown) => {
      queue.push(event);
      wake?.();
    },
    close: () => {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) {
          yield queue.shift();
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    },
  };
}

/**
 * Passes the bytes through unchanged and hands each complete SSE event's `data` to `onEvent`,
 * parsed. `[DONE]` and anything that is not JSON are skipped - they carry no usage. `onEnd` fires
 * once, however the body ends: run out, errored, or cancelled by the caller - and what it returns
 * is awaited before the caller sees that end, so the final ingest is pending, and `flush()` waits
 * for it, by the time `response.text()` resolves or rejects, or `cancel()` returns.
 */
function observeSse(
  source: ReadableStream<Uint8Array>,
  onEvent: (event: unknown) => void,
  onEnd: () => Promise<void> | undefined,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const reader = source.getReader();
  let buffer = '';
  let ended = false;
  const end = () => {
    if (ended) return undefined;
    ended = true;
    return onEnd();
  };
  const emit = (block: string) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data === '[DONE]') return;
    try {
      onEvent(JSON.parse(data));
    } catch {
      // Not an event this binding can read; the caller still gets the bytes.
    }
  };
  const drain = (final: boolean) => {
    // A `\r` at the very end may be the first half of a `\r\n` split across two reads, and
    // normalising it early would turn that one line break into an event boundary.
    buffer = buffer.replace(final ? /\r\n?/g : /\r\n|\r(?=[\s\S])/g, '\n');
    let at: number;
    while ((at = buffer.indexOf('\n\n')) !== -1) {
      emit(buffer.slice(0, at));
      buffer = buffer.slice(at + 2);
    }
    if (final && buffer.trim()) {
      emit(buffer);
      buffer = '';
    }
  };

  // A high-water mark of zero, so the source is read only when the caller asks: nothing is metered
  // ahead of what the caller has, and a cancel stops at what was handed over.
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            drain(true);
            await end();
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          drain(false);
          controller.enqueue(value);
        } catch (err) {
          // Awaited, as on a body that ran out, so what was read is pending before the caller hears.
          await end();
          controller.error(err);
        }
      },
      async cancel(reason) {
        const ended = end();
        await reader.cancel(reason);
        await ended;
      },
    },
    { highWaterMark: 0 },
  );
}
