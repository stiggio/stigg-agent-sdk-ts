/**
 * The Databricks recipes, and the two facts that shape them.
 *
 * **The request does not say what model is being used.** A serving endpoint is addressed by a name
 * the customer chose, so the response's `model` field is often the only thing in the exchange that
 * says what answered. These pin that it reaches `dimensions`.
 *
 * **Two payers share one wire.** Foundation Model API traffic is billed by Databricks in DBUs; an
 * external-model endpoint is billed by whatever provider's key it carries. Nothing on the client
 * distinguishes them, so the split is the caller naming a recipe - and these pin that the two
 * report identically apart from the vendor name, because a divergence would be a claim about a
 * difference the response does not contain.
 *
 * And the thing neither does: state a price. There is no `cost` metric on either, because there is
 * no number on any Databricks response to put in one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  databricksExternalRecipe,
  databricksRecipe,
} from '../src/bindings/client/gateways/databricks/databricks-recipe';
import { openAIRecipe } from '../src/bindings/client/providers/openai/openai-recipe';
import type { Measurement, Metrics } from '../src/types';
import type { MeteredResponse } from '../src/bindings/client/core/types';

/** The full Foundation Model API block: OpenAI's three, Anthropic's cache pair, and reasoning. */
const USAGE = {
  prompt_tokens: 120,
  completion_tokens: 48,
  total_tokens: 168,
  reasoning_tokens: 16,
  cache_read_input_tokens: 32,
  cache_creation_input_tokens: 8,
};

const withHeaders = (values: Record<string, string>) =>
  ({ headers: { get: (name: string) => values[name.toLowerCase()] ?? null } }) as MeteredResponse;

/** A client pointed at a workspace, which is all `matches` has to go on. */
const clientAt = (baseURL: string) => ({
  baseURL,
  chat: { completions: { create: async () => ({}) } },
});

const chatOf = (recipe: ReturnType<typeof databricksRecipe>) =>
  recipe.methods.find((method) => method.path.join('.') === 'chat.completions.create')!;

const measure = (recipe: ReturnType<typeof databricksRecipe>, result: any, response?: MeteredResponse) =>
  chatOf(recipe).extractUsage?.(result, response) as Measurement | undefined;

describe('what a Databricks response reports', () => {
  it('reports all six counters under Databricks’ own names', () => {
    const measured = measure(databricksRecipe(), { usage: USAGE, model: 'databricks-claude-sonnet-4-6' });
    assert.deepEqual(Object.keys((measured as { metrics: Metrics }).metrics).sort(), [
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
      'completion_tokens',
      'prompt_tokens',
      'reasoning_tokens',
      'total_tokens',
    ]);
  });

  it('reads the stated total rather than adding the parts up', () => {
    // The counters may or may not overlap - Databricks documents neither direction - so a computed
    // total could double-count. The stated one is right whichever way the overlap runs.
    const measured = measure(databricksRecipe(), { usage: USAGE });
    assert.equal((measured as { usage: { total?: number } }).usage.total, 168);
    assert.notEqual(168, USAGE.prompt_tokens + USAGE.completion_tokens + USAGE.cache_read_input_tokens);
  });

  it('does not subtract the cache reads from the input count', () => {
    // Databricks spells the pair with Anthropic's names, whose counters sit beside the input
    // count rather than inside it. `fromOpenAIUsage` subtracts its own because OpenAI documents
    // the overlap; nothing here documents one, so nothing is subtracted.
    const measured = measure(databricksRecipe(), { usage: USAGE });
    assert.equal((measured as { usage: { input: number } }).usage.input, 120);
  });

  it('skips a counter the endpoint did not report rather than sending a zero', () => {
    // The external-model route carries only the OpenAI three; the FMAPI extensions are absent,
    // and absent is not zero.
    const measured = measure(databricksExternalRecipe(), {
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    assert.deepEqual(Object.keys((measured as { metrics: Metrics }).metrics).sort(), [
      'completion_tokens',
      'prompt_tokens',
      'total_tokens',
    ]);
  });

  it('reports nothing at all for a response that carried no usage', () => {
    assert.equal(measure(databricksRecipe(), { model: 'databricks-dbrx-instruct' }), undefined);
  });
});

describe('attributing what actually answered', () => {
  it('puts the served model on the ingest, because the request named only an endpoint', () => {
    const measured = measure(databricksRecipe(), { usage: USAGE, model: 'databricks-claude-sonnet-4-6' });
    assert.deepEqual((measured as { dimensions?: Record<string, string> }).dimensions, {
      model: 'databricks-claude-sonnet-4-6',
    });
  });

  it('takes the dimension name the caller chose', () => {
    const measured = measure(databricksRecipe({ modelDimension: 'servedModel' }), { usage: USAGE, model: 'dbrx' });
    assert.deepEqual((measured as { dimensions?: Record<string, string> }).dimensions, { servedModel: 'dbrx' });
  });

  it('reads served-model-name out of the body, where the official client puts it', () => {
    const measured = measure(databricksRecipe(), {
      usage: USAGE,
      model: 'databricks-claude-sonnet-4-6',
      'served-model-name': 'claude-variant-b',
    });
    assert.deepEqual((measured as { dimensions?: Record<string, string> }).dimensions, {
      model: 'databricks-claude-sonnet-4-6',
      served_model_name: 'claude-variant-b',
    });
  });

  it('reads served-model-name out of a header too, where the REST reference puts it', () => {
    const measured = measure(
      databricksRecipe(),
      { usage: USAGE, model: 'databricks-claude-sonnet-4-6' },
      withHeaders({ 'served-model-name': 'claude-variant-b' }),
    );
    assert.equal(
      (measured as { dimensions?: Record<string, string> }).dimensions?.served_model_name,
      'claude-variant-b',
    );
  });

  it('omits the served entity when it merely repeats the model', () => {
    // A traffic split is the only thing it adds over `model`, and most endpoints are not split.
    const measured = measure(databricksRecipe(), { usage: USAGE, model: 'dbrx', 'served-model-name': 'dbrx' });
    assert.deepEqual((measured as { dimensions?: Record<string, string> }).dimensions, { model: 'dbrx' });
  });

  it('keys idempotency on the completion id, which a replay carries again', () => {
    const measured = measure(databricksRecipe(), { usage: USAGE, id: 'chatcmpl-db-77' });
    assert.equal((measured as { idempotencyKey?: string }).idempotencyKey, 'chatcmpl-db-77');
  });
});

describe('recognising a workspace', () => {
  const matches = (url: string, baseUrl?: string) => databricksRecipe({ baseUrl }).matches!(clientAt(url));

  it('claims the three public workspace families on a serving path', () => {
    assert.equal(matches('https://dbc-123.cloud.databricks.com/serving-endpoints'), true);
    assert.equal(matches('https://adb-1666506161514800.0.azuredatabricks.net/serving-endpoints'), true);
    assert.equal(matches('https://8757561887652360.0.gcp.databricks.com/serving-endpoints'), true);
  });

  it('claims the newer Unity Gateway path as well', () => {
    assert.equal(matches('https://dbc-123.cloud.databricks.com/ai-gateway/mlflow/v1'), true);
  });

  it('declines a Databricks host that is not a serving endpoint', () => {
    // The host families are every Databricks API there is, and most of them are not inference.
    assert.equal(matches('https://dbc-123.cloud.databricks.com/api/2.0/clusters'), false);
  });

  it('declines a lookalike domain, which is the whole reason the check is on the host', () => {
    // `endsWith` without the dot would claim both of these, and they are somebody else's.
    assert.equal(matches('https://cloud.databricks.com.attacker.net/serving-endpoints'), false);
    assert.equal(matches('https://notdatabricks.com/serving-endpoints'), false);
  });

  it('declines an unrelated endpoint that merely exposes the same path', () => {
    assert.equal(matches('https://api.acme.com/serving-endpoints'), false);
  });

  it('takes a PrivateLink workspace by base URL, which no guess could reach', () => {
    const privateLink = 'https://databricks.internal.acme.net/serving-endpoints';
    assert.equal(matches(privateLink), false, 'a private hostname is in none of the public families');
    assert.equal(matches(privateLink, privateLink), true);
  });

  it('does not let a configured base URL claim a sibling path', () => {
    // `.../v1` must not claim `.../v10`: a different deployment with a different price list.
    assert.equal(
      matches('https://host.acme.net/serving-endpoints/v10', 'https://host.acme.net/serving-endpoints/v1'),
      false,
    );
  });

  it('declines a client with no base URL to read', () => {
    assert.equal(databricksRecipe().matches!({ chat: { completions: { create: async () => ({}) } } }), false);
  });
});

describe('two recipes, two payers, one wire', () => {
  it('declares no cost on either, because no response carries one', () => {
    assert.equal(databricksRecipe().metrics.includes('cost' as never), false);
    assert.equal(databricksExternalRecipe().metrics.includes('cost' as never), false);
  });

  it('meters identically and differs only in who is billed', () => {
    const hosted = measure(databricksRecipe(), { usage: USAGE, model: 'm' });
    const external = measure(databricksExternalRecipe(), { usage: USAGE, model: 'm' });
    assert.deepEqual(external, hosted, 'the response is the same response; only the vendor name differs');
    assert.equal(databricksRecipe().vendor, 'databricks');
    assert.equal(databricksExternalRecipe().vendor, 'databricks-external');
  });

  it('covers both OpenAI surfaces, so neither is left ungated', () => {
    // This recipe is matched ahead of `openAIRecipe`, so a surface it failed to declare would be
    // ungated rather than metered by something else. Still an exhaustive comparison against that
    // recipe's own list - the first-party client's `query` is this recipe's own surface and has no
    // counterpart there, so it is excluded by name rather than by loosening the assertion.
    assert.deepEqual(
      databricksRecipe()
        .methods.map((method) => method.path.join('.'))
        .filter((path) => path !== 'query'),
      openAIRecipe.methods.map((method) => method.path.join('.')),
    );
  });

  it('declares the first-party surface on both recipes, and only once each', () => {
    for (const recipe of [databricksRecipe(), databricksExternalRecipe()]) {
      const paths = recipe.methods.map((method) => method.path.join('.'));
      assert.equal(paths.filter((path) => path === 'query').length, 1);
      assert.equal(new Set(paths).size, paths.length, 'a duplicated path would double-meter a call');
    }
  });
});

describe('a streamed turn', () => {
  /** Usage on the final chunk, which is what `stream_options: {include_usage: true}` buys. */
  const stream = (chunks: any[]) => ({
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  });

  /**
   * Metering patches the iterator in place, so the object handed to `attachStream` is the one that
   * has to be iterated - a second copy would be an unmetered stream and would report nothing.
   */
  const drain = async (recipe: ReturnType<typeof databricksRecipe>, chunks: any[]) => {
    const seen: Measurement[] = [];
    const iterable: any = stream(chunks);
    chatOf(recipe).attachStream?.(iterable, (m) => seen.push(m as Measurement));
    for await (const chunk of iterable) void chunk;
    return seen;
  };

  it('meters the counters from the final chunk and attributes the model', async () => {
    const seen = await drain(databricksRecipe(), [
      { id: 'chatcmpl-db-1', model: 'databricks-dbrx-instruct', choices: [{ delta: { content: 'hi' } }] },
      { id: 'chatcmpl-db-1', model: 'databricks-dbrx-instruct', choices: [{ delta: {} }], usage: USAGE },
    ]);
    assert.equal(seen.length, 1);
    const [measured] = seen;
    assert.equal(measured!.metrics?.total_tokens, 168);
    assert.deepEqual(measured!.dimensions, { model: 'databricks-dbrx-instruct' });
    assert.equal(measured!.idempotencyKey, 'chatcmpl-db-1');
  });

  it('reports nothing when the caller never asked for usage', async () => {
    // `stream_options.include_usage` defaults off, and a stream that states nothing must meter
    // nothing rather than a row of zeroes.
    const seen = await drain(databricksRecipe(), [
      { id: 'chatcmpl-db-2', model: 'dbrx', choices: [{ delta: { content: 'hi' } }] },
    ]);
    assert.deepEqual(seen, []);
  });
});

/**
 * The first-party client - `@databricks/sdk-modelservingquery`, whose whole surface is `query`.
 *
 * A second surface on the SAME recipe rather than a recipe of its own, because one Databricks
 * account is billed whichever client the application imported. Three things make it awkward and
 * each has a case below: it camelCases the wire, its `created` is a `bigint` that `JSON.stringify`
 * refuses, and `query` is a verb half the ecosystem already owns.
 */
describe('the first-party client, on the same recipe', () => {
  const queryOf = (recipe: ReturnType<typeof databricksRecipe>) =>
    recipe.methods.find((method) => method.path.join('.') === 'query')!;

  const queryMeasure = (recipe: ReturnType<typeof databricksRecipe>, result: any) =>
    queryOf(recipe).extractUsage?.(result) as Measurement | undefined;

  /** What `ModelServingQueryClient.query` actually resolves to, counters and all. */
  const QUERY_RESPONSE = {
    id: 'chatcmpl-dbx-1',
    object: 'chat.completion',
    model: 'databricks-claude-sonnet-4-6',
    // The field that makes a pass-through impossible. Verified against the SDK, whose zod schema
    // transforms the wire's number with `BigInt(v)`.
    created: 1761000000n,
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finishReason: 'stop' }],
    usage: { promptTokens: 120, completionTokens: 48, totalTokens: 168 },
  };

  it('reports the wire’s snake_case names, not the client’s camelCase', () => {
    // The whole reason this surface needed a rename map. Reported verbatim, one account would
    // produce `promptTokens` here and `prompt_tokens` through an `OpenAI` client pointed at the
    // same workspace - two feature ids for one bill, decided by an import.
    const measured = queryMeasure(databricksRecipe(), QUERY_RESPONSE);
    assert.deepEqual((measured as { metrics: Metrics }).metrics, {
      prompt_tokens: 120,
      completion_tokens: 48,
      total_tokens: 168,
    });
  });

  it('reports exactly what the OpenAI route reports for the same call', () => {
    // Stated as an equality rather than two separate expectations, because "both surfaces agree"
    // is the property, and it is the one a meter depends on.
    const native = queryMeasure(databricksRecipe(), QUERY_RESPONSE);
    const wire = measure(databricksRecipe(), {
      usage: { prompt_tokens: 120, completion_tokens: 48, total_tokens: 168 },
      model: 'databricks-claude-sonnet-4-6',
    });
    assert.deepEqual((native as { metrics: Metrics }).metrics, (wire as { metrics: Metrics }).metrics);
  });

  it('ingests cleanly even though the response carries a BigInt', () => {
    // `JSON.stringify({ created: 1n })` throws outright - "Do not know how to serialize a BigInt".
    // So the guard is not that `created` is merely absent from `raw`, it is that everything the
    // measurement carries survives serialisation, which is what the ingest will do to it.
    const measured = queryMeasure(databricksRecipe(), QUERY_RESPONSE) as Measurement;
    assert.doesNotThrow(() => JSON.stringify(measured));
    assert.equal(JSON.stringify(measured).includes('1761000000'), false, 'the bigint reached the ingest');
    // Projected counters only - never the response, which also holds the model's own reply text.
    assert.deepEqual(measured.raw, { prompt_tokens: 120, completion_tokens: 48, total_tokens: 168 });
  });

  it('proves the fixture really would throw, so the case above is not vacuous', () => {
    assert.throws(() => JSON.stringify(QUERY_RESPONSE), /BigInt/);
  });

  it('attributes the served model and which workload ran', () => {
    const measured = queryMeasure(databricksRecipe(), {
      ...QUERY_RESPONSE,
      servedModelName: 'prod-chat-v3',
    }) as Measurement;
    assert.deepEqual(measured.dimensions, {
      model: 'databricks-claude-sonnet-4-6',
      served_model_name: 'prod-chat-v3',
      // One method serves chat, completions, embeddings and predictions, so the event name cannot
      // say which ran. This dimension is the only thing that can.
      response_object: 'chat.completion',
    });
    assert.equal(measured.idempotencyKey, 'chatcmpl-dbx-1');
  });

  it('separates an embeddings call from a chat one, which the event name cannot', () => {
    const measured = queryMeasure(databricksRecipe(), {
      object: 'list',
      data: [{ embedding: [0.1], index: 0 }],
      usage: { promptTokens: 9, totalTokens: 9 },
    }) as Measurement;
    assert.equal(measured.dimensions?.response_object, 'list');
    // Absent, not zero: an embeddings call generates nothing, so there is no completion count.
    assert.deepEqual(measured.metrics, { prompt_tokens: 9, total_tokens: 9 });
  });

  it('reports nothing for a prediction endpoint, which carries no usage at all', () => {
    assert.equal(queryMeasure(databricksRecipe(), { predictions: [[0.9, 0.1]] }), undefined);
  });

  it('has no streamed form, because the client has none', () => {
    // `query` resolves to a parsed body and its schema would reject an SSE stream. Declaring an
    // `attachStream` here would promise a path that cannot be reached.
    assert.equal(queryOf(databricksRecipe()).attachStream, undefined);
  });

  it('carries the surface onto the external route too', () => {
    // An external-model endpoint is queried with the same client; `ExternalModelUsageElement` is
    // named for exactly that traffic. Holding the surface back would leave it ungoverned.
    assert.deepEqual(
      (queryMeasure(databricksExternalRecipe(), QUERY_RESPONSE) as { metrics: Metrics }).metrics,
      (queryMeasure(databricksRecipe(), QUERY_RESPONSE) as { metrics: Metrics }).metrics,
    );
  });
});

describe('recognising the first-party client', () => {
  const matches = (client: unknown) => databricksRecipe().matches!(client);

  /** The client as it actually is at runtime - verified by constructing a real one. */
  const queryClient = () => ({
    query: async () => ({}),
    options: {},
    logger: {},
    userAgent:
      'sdk-js-core/0.51.1 node/22.23.2 os/darwin sdk-js-modelservingquery/0.25.0 sdk-js-auth/0.52.0 auth/default',
    // Memoised lazily and genuinely undefined until the first request, which is why the matcher
    // cannot key on it: a freshly constructed client would not match.
    config: undefined,
  });

  it('claims it on its method and its user agent together', () => {
    assert.equal(matches(queryClient()), true);
  });

  it('refuses a bare query client, which is every database driver there is', () => {
    // The case the whole guard exists for. `query` alone would meter a Postgres call as
    // `databricks.query`.
    assert.equal(matches({ query: async () => ({ rows: [], rowCount: 0 }) }), false);
  });

  it('refuses another vendor’s client that happens to advertise a user agent', () => {
    assert.equal(matches({ query: async () => ({}), userAgent: 'node-postgres/8.11.3' }), false);
  });

  it('refuses the marker without a callable query, which is not a client', () => {
    assert.equal(matches({ userAgent: 'sdk-js-modelservingquery/0.25.0' }), false);
    assert.equal(matches({ query: 'not-a-function', userAgent: 'sdk-js-modelservingquery/0.25.0' }), false);
  });

  it('claims it with no base URL anywhere, since its host sits in a private field', () => {
    // Deliberately different evidence from the OpenAI route. Databricks resolves the host from
    // `~/.databrickscfg` or `DATABRICKS_HOST`, so there is frequently no URL to compare against -
    // and a `baseUrl` given for the other surface must not gate this one.
    assert.equal(
      databricksRecipe({ baseUrl: 'https://other.cloud.databricks.com/serving-endpoints' }).matches!(queryClient()),
      true,
    );
  });

  it('still matches the OpenAI route, so the second surface took nothing away', () => {
    assert.equal(matches(clientAt('https://dbc-1234.cloud.databricks.com/serving-endpoints')), true);
  });
});

describe('each OpenAI surface reads the names that surface actually sends', () => {
  const surface = (path: string) => databricksRecipe().methods.find((m) => m.path.join('.') === path)!;

  it('reads a Responses body, whose counters are not the chat ones', () => {
    // Chat sends `prompt_tokens`/`completion_tokens`; Responses sends `input_tokens`/
    // `output_tokens`. One shared key list left a Responses call reporting its total and nothing
    // else - a number with no breakdown under it, which prices wrongly rather than visibly.
    const measured: any = surface('responses.create').extractUsage?.({
      usage: { input_tokens: 70, output_tokens: 30, total_tokens: 100 },
      model: 'databricks-gpt-oss',
    });
    assert.equal(measured?.metrics?.input_tokens, 70);
    assert.equal(measured?.metrics?.output_tokens, 30);
    assert.equal(measured?.metrics?.total_tokens, 100);
  });

  it('still reads a chat body under the chat names', () => {
    const measured: any = surface('chat.completions.create').extractUsage?.({
      usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100 },
      model: 'databricks-claude-sonnet-4-6',
    });
    assert.equal(measured?.metrics?.prompt_tokens, 70);
    assert.equal(measured?.metrics?.completion_tokens, 30);
  });

  it('declares both spellings, because one recipe serves both surfaces', () => {
    const names = [...databricksRecipe().metrics];
    for (const n of ['prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens', 'total_tokens']) {
      assert.ok(names.includes(n as never), `${n} missing from declared metrics`);
    }
  });
});

describe('the neutral usage digest, across both surfaces', () => {
  const surface = (path: string) => databricksRecipe().methods.find((m) => m.path.join('.') === path)!;

  it('reads a Responses body into input/output, not zeroes', () => {
    // `normalizedMetrics` and every custom TokenUsage mapper read this digest rather than the
    // vendor-named metrics, so a reader that knew only the chat spellings reported a real call
    // as zero through both of them.
    const measured: any = surface('responses.create').extractUsage?.({
      usage: { input_tokens: 70, output_tokens: 30, total_tokens: 100 },
    });
    assert.equal(measured.usage.input, 70);
    assert.equal(measured.usage.output, 30);
    assert.equal(measured.usage.total, 100);
  });

  it('still reads a chat body, and the two spellings cannot double-count', () => {
    const measured: any = surface('chat.completions.create').extractUsage?.({
      usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100 },
    });
    assert.equal(measured.usage.input, 70);
    assert.equal(measured.usage.output, 30);
  });
});

describe('streamed attribution, on both OpenAI surfaces', () => {
  const surface = (path: string) => databricksRecipe().methods.find((m) => m.path.join('.') === path)!;
  const drive = async (path: string, chunks: any[]) => {
    const seen: any[] = [];
    const iterable: any = {
      [Symbol.asyncIterator]: async function* () {
        for (const c of chunks) yield c;
      },
    };
    surface(path).attachStream?.(iterable, (m) => seen.push(m));
    for await (const c of iterable) void c;
    return seen;
  };

  it('keeps the model and id a streamed Responses turn nests under `response`', async () => {
    // `{ response: { id, model, usage } }` on the completion event. Read at the chunk root these
    // are all undefined, so the turn loses its served-model dimension and falls back to a
    // generated idempotency key - a retry then looks like a new call.
    const seen = await drive('responses.create', [
      { type: 'response.output_text.delta', delta: 'hi' },
      {
        type: 'response.completed',
        response: {
          id: 'resp-1',
          model: 'databricks-gpt-oss',
          usage: { input_tokens: 70, output_tokens: 30, total_tokens: 100 },
        },
      },
    ]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].metrics.total_tokens, 100);
    assert.equal(seen[0].dimensions.model, 'databricks-gpt-oss');
    assert.equal(seen[0].idempotencyKey, 'resp-1');
  });

  it('still reads a streamed chat turn from the chunk root', async () => {
    const seen = await drive('chat.completions.create', [
      { id: 'chat-1', model: 'databricks-claude-sonnet-4-6', choices: [{ delta: { content: 'hi' } }] },
      {
        id: 'chat-1',
        model: 'databricks-claude-sonnet-4-6',
        choices: [],
        usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100 },
      },
    ]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].dimensions.model, 'databricks-claude-sonnet-4-6');
    assert.equal(seen[0].idempotencyKey, 'chat-1');
  });
});
