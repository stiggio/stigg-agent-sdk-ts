/**
 * Offline stand-in for the vendor APIs, so every example runs with no API keys at all.
 *
 * It speaks the real wire formats - Anthropic's Messages API, OpenRouter's OpenAI-compatible
 * chat completions, and LiteLLM's - so the vendor SDKs parse genuine responses and every field
 * the examples read (`usage`, `model`, `cost`, tool calls) is populated for real. Only the prose
 * is canned. That keeps the measurement, cost-truth and value-unit seams honest.
 *
 * The LiteLLM half reproduces one constraint exactly, because an example that faked it would be
 * making the opposite point: the cost rides in a response header, so it is present on a
 * non-streaming reply and absent from a streamed one. Headers precede the body, and the proxy
 * does not know the price until the body is finished.
 *
 * Bedrock is the one that costs real work to fake. Its streaming responses are not SSE but AWS's
 * binary event-stream framing - length prefixes, typed headers and two CRC32s per message - and
 * the SDK validates all of it. Writing it out properly is the only way the AWS client parses this
 * at all, and it is what makes the Bedrock example's streamed turn a genuine exercise of the
 * recipe rather than a hand-rolled object shaped like one.
 *
 * Examples start this automatically when the matching API key is missing. Nothing here is
 * part of the pattern being demonstrated - it is scaffolding so the demo runs anywhere.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { crc32 } from 'node:zlib';
import type { AddressInfo } from 'node:net';

export type MockServer = { baseUrl: string; close: () => Promise<void> };

const OFFLINE_NOTICE =
  'running against the built-in offline mock (see examples/mock-server.ts).\n' +
  'Responses are canned; token counts, costs and model routing are simulated.\n';

const ANTHROPIC_TEXT =
  'This is an automatic response from the built-in offline mock standing in for the Anthropic ' +
  'Messages API. No network call was made and no tokens were billed.';

const GEMINI_TEXT =
  'This is an automatic response from the built-in offline mock standing in for the Gemini ' +
  'generateContent API. No network call was made and no tokens were billed.';

const OPENROUTER_TEXT =
  'This is an automatic response from the built-in offline mock standing in for the OpenRouter ' +
  'gateway. No network call was made and no credits were spent.';

const GROQ_TEXT =
  'This is an automatic response from the built-in offline mock standing in for the Groq ' +
  'chat completions API. No network call was made and no tokens were billed.';

const MISTRAL_TEXT =
  'This is an automatic response from the built-in offline mock standing in for the Mistral ' +
  'chat completions API. No network call was made and no tokens were billed.';

const OLLAMA_TEXT =
  'This is an automatic response from the built-in offline mock standing in for a local Ollama ' +
  'server. No model was loaded and nothing was generated.';

const newResponseId = () => `mock${Math.random().toString(16).slice(2, 10)}`;

/** Rough token estimate so the numbers move with the payload instead of being frozen. */
const estimateTokens = (value: unknown) => Math.max(8, Math.ceil(JSON.stringify(value ?? '').length / 4));

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function openSse(res: ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...headers,
  });
}

// ----------------------------------------------------------------------------------------
// Anthropic Messages API
// ----------------------------------------------------------------------------------------

/**
 * The first tool on offer that this turn has not called yet, or none once each has been.
 *
 * One per turn, in the order offered - so an agent holding a single tool calls it once and then
 * answers, and an orchestrator holding several subagents as tools delegates to each in turn,
 * which is the only way a lead agent reaches more than one of them with no model behind it.
 *
 * A turn starts at the latest message the user typed, so a chat delegates again on every new
 * request rather than once per conversation. Tool results also arrive as `user` messages - those
 * are the turn continuing, not a new one.
 */
function nextToolToCall(body: any): any {
  if (!body.tools?.length) return undefined;
  const messages: any[] = body.messages ?? [];
  const isToolResult = (message: any) =>
    Array.isArray(message.content) && message.content.some((block: any) => block?.type === 'tool_result');
  let turnStart = messages.length - 1;
  while (turnStart > 0 && (messages[turnStart].role !== 'user' || isToolResult(messages[turnStart]))) turnStart -= 1;
  const called = new Set<string>();
  for (const message of messages.slice(turnStart)) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) if (block?.type === 'tool_use') called.add(block.name);
  }
  return body.tools.find((tool: any) => !called.has(tool.name));
}

/**
 * Arguments a tool will accept: canned text for each string field it declares. A tool declaring
 * none gets the first two numbers in the conversation, so a calculator's result looks sensible.
 */
function toolInput(tool: any, messages: unknown): Record<string, unknown> {
  const strings = Object.entries(tool.input_schema?.properties ?? {})
    .filter(([, schema]: [string, any]) => schema?.type === 'string')
    .map(([name]) => [name, `mock ${name} for ${tool.name}`]);
  return strings.length ? Object.fromEntries(strings) : numbersIn(messages);
}

function anthropicMessage(body: any) {
  const inputTokens = estimateTokens(body.messages);
  const tool = nextToolToCall(body);
  const content = tool
    ? [
        {
          type: 'tool_use',
          id: `toolu_mock${Math.random().toString(16).slice(2, 10)}`,
          name: tool.name,
          input: toolInput(tool, body.messages),
        },
      ]
    : [{ type: 'text', text: ANTHROPIC_TEXT }];

  return {
    id: `msg_mock${Math.random().toString(16).slice(2, 10)}`,
    type: 'message',
    role: 'assistant',
    model: body.model ?? 'claude-opus-5',
    content,
    stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: estimateTokens(content),
      cache_read_input_tokens: Math.floor(inputTokens / 4),
      cache_creation_input_tokens: 0,
    },
  };
}

function numbersIn(messages: unknown): Record<string, number> {
  const found = (JSON.stringify(messages ?? '').match(/\d+/g) ?? []).map(Number);
  return { a: found[0] ?? 2, b: found[1] ?? 3 };
}

function streamAnthropic(res: ServerResponse, message: ReturnType<typeof anthropicMessage>): void {
  openSse(res);
  const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  event('message_start', {
    type: 'message_start',
    message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } },
  });

  message.content.forEach((block: any, index: number) => {
    if (block.type === 'text') {
      event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const word of block.text.split(' ')) {
        event('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: `${word} ` },
        });
      }
    } else {
      event('content_block_start', { type: 'content_block_start', index, content_block: { ...block, input: {} } });
      event('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    }
    event('content_block_stop', { type: 'content_block_stop', index });
  });

  event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens },
  });
  event('message_stop', { type: 'message_stop' });
  res.end();
}

// ----------------------------------------------------------------------------------------
// Gemini - generateContent / streamGenerateContent
// ----------------------------------------------------------------------------------------

/**
 * Gemini's `usageMetadata`, with both of its overlaps reproduced rather than flattened away.
 *
 * `cachedContentTokenCount` is counted INSIDE `promptTokenCount`, while `thoughtsTokenCount` sits
 * beside `candidatesTokenCount` rather than within it - and `totalTokenCount` is the vendor's own
 * sum of prompt + candidates + thoughts. A mock that reported four tidy disjoint numbers would
 * make the example prove nothing: the arithmetic the recipe exists to get right would be absent
 * from the fixture it is read against.
 */
function geminiUsage(body: any, text: string) {
  const promptTokenCount = estimateTokens(body.contents);
  const candidatesTokenCount = estimateTokens(text);
  const thoughtsTokenCount = Math.floor(candidatesTokenCount / 5);
  return {
    promptTokenCount,
    candidatesTokenCount,
    cachedContentTokenCount: Math.floor(promptTokenCount / 4),
    thoughtsTokenCount,
    totalTokenCount: promptTokenCount + candidatesTokenCount + thoughtsTokenCount,
  };
}

const geminiResponse = (body: any, model: string, text: string, finished = true, responseId = newResponseId()) => ({
  candidates: [
    {
      content: { parts: [{ text }], role: 'model' },
      ...(finished ? { finishReason: 'STOP' } : {}),
      index: 0,
    },
  ],
  usageMetadata: geminiUsage(body, text),
  modelVersion: model,
  responseId,
});

/**
 * Streams the reply the way Gemini does: `usageMetadata` on **every** chunk, carrying running
 * totals rather than deltas.
 *
 * This is the detail worth reproducing exactly. The counts a consumer must bill are the last
 * ones, not the sum of all of them - a meter that adds these up charges a long answer several
 * times over, and against a mock that reported usage once at the end the bug would never appear.
 */
function streamGemini(res: ServerResponse, body: any, model: string): void {
  openSse(res);
  const words = GEMINI_TEXT.split(' ');
  // One id for the whole stream. Every chunk of a round carries the same `responseId` on the
  // wire, and a recipe reads the change as the boundary between automatic-function-calling
  // rounds - so a mock minting a fresh one per chunk would describe a stream that cannot exist
  // and would teach the binding to meter it wrongly.
  const responseId = newResponseId();
  let sent = '';
  words.forEach((word, index) => {
    const piece = index === words.length - 1 ? word : `${word} `;
    sent += piece;
    // The usage block describes everything produced so far, which is what makes it cumulative.
    const chunk = geminiResponse(body, model, piece, index === words.length - 1, responseId);
    res.write(`data: ${JSON.stringify({ ...chunk, usageMetadata: geminiUsage(body, sent) })}\n\n`);
  });
  res.end();
}

// ----------------------------------------------------------------------------------------
// OpenRouter (OpenAI-compatible) chat completions
// ----------------------------------------------------------------------------------------

function openRouterUsage(body: any) {
  const promptTokens = estimateTokens(body.messages);
  const completionTokens = estimateTokens(OPENROUTER_TEXT);
  // OpenRouter bills in credits and reports what it actually charged.
  const cost = Number(((promptTokens * 5 + completionTokens * 25) / 1_000_000).toFixed(7));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    cost,
    // The whole breakdown, not just the headline: the first-party SDK validates its responses
    // against the published schema and rejects the call outright when a required field is
    // missing, so a half-filled `cost_details` here would fail a request the real gateway serves.
    cost_details: {
      upstream_inference_cost: Number((cost * 0.9).toFixed(7)),
      upstream_inference_prompt_cost: Number(((promptTokens * 5) / 1_000_000).toFixed(7)),
      upstream_inference_completions_cost: Number(((completionTokens * 25) / 1_000_000).toFixed(7)),
    },
    prompt_tokens_details: { cached_tokens: Math.floor(promptTokens / 3), cache_write_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: Math.floor(completionTokens / 8) },
  };
}

function streamOpenRouter(res: ServerResponse, body: any, served: string): void {
  openSse(res);
  const id = `gen-mock${Math.random().toString(16).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  for (const word of OPENROUTER_TEXT.split(' ')) {
    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model: served,
      choices: [{ index: 0, delta: { content: `${word} ` }, finish_reason: null }],
    });
  }
  // Usage arrives once, on the last chunk - same as the real gateway.
  send({
    id,
    object: 'chat.completion.chunk',
    created,
    model: served,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: openRouterUsage(body),
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

// ----------------------------------------------------------------------------------------
// Bedrock (Converse, and AWS event-stream framing for the streamed half)
// ----------------------------------------------------------------------------------------

const BEDROCK_TEXT =
  'This is an automatic response from the built-in offline mock standing in for Amazon Bedrock. ' +
  'No network call was made and no tokens were billed.';

/**
 * Bedrock's usage block. Note what is not in it: a price.
 *
 * Bedrock reports tokens and leaves the money to the AWS bill, which is the single biggest
 * difference between it and the other two gateways here - so the mock must not invent one.
 *
 * The counters are disjoint, the way AWS defines them: `inputTokens` excludes whatever was read
 * from or written to the cache, rather than including it the way OpenAI's `prompt_tokens` does.
 */
function bedrockUsage(body: any) {
  const text = (body?.messages ?? []).flatMap((m: any) => (m?.content ?? []).map((c: any) => c?.text ?? '')).join(' ');
  const cacheRead = Math.floor(estimateTokens(text) / 3);
  const inputTokens = Math.max(1, estimateTokens(text) - cacheRead);
  const outputTokens = estimateTokens(BEDROCK_TEXT);
  return {
    inputTokens,
    outputTokens,
    // AWS documents this as the input and output of the call; the cache counters sit outside it.
    totalTokens: inputTokens + outputTokens,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: 0,
  };
}

/**
 * One AWS event-stream message: an 8-byte prelude, its CRC, the headers, the payload, and a CRC
 * over all of it. The SDK checks both CRCs and rejects the stream if either is wrong, so this is
 * the real encoding rather than a shape that resembles it.
 */
function awsEventFrame(eventType: string, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  // `name-length, name, type(7 = string), value-length, value` - the only header type used here.
  const header = (name: string, value: string): Buffer => {
    const n = Buffer.from(name, 'utf8');
    const v = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(v.length);
    return Buffer.concat([Buffer.from([n.length]), n, Buffer.from([7]), length, v]);
  };
  const headers = Buffer.concat([
    header(':message-type', 'event'),
    header(':event-type', eventType),
    header(':content-type', 'application/json'),
  ]);
  // 16 = the two 4-byte lengths, the prelude CRC and the message CRC.
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(16 + headers.length + body.length, 0);
  prelude.writeUInt32BE(headers.length, 4);
  const preludeCrc = Buffer.alloc(4);
  preludeCrc.writeUInt32BE(crc32(prelude) >>> 0);
  const message = Buffer.concat([prelude, preludeCrc, headers, body]);
  const messageCrc = Buffer.alloc(4);
  messageCrc.writeUInt32BE(crc32(message) >>> 0);
  return Buffer.concat([message, messageCrc]);
}

/** AWS's own id for a call, which is what the recipe deduplicates the SDK's retries by. */
const bedrockRequestId = (): string => `mock-${Math.random().toString(16).slice(2, 10)}-bedrock`;

function streamBedrock(res: ServerResponse, body: any): void {
  res.writeHead(200, {
    'content-type': 'application/vnd.amazon.eventstream',
    // Sent because the SDK lifts it into `$metadata.requestId`, which is the measurement's
    // idempotency key - without it the example would silently exercise the fallback instead.
    'x-amzn-requestid': bedrockRequestId(),
  });
  res.write(awsEventFrame('messageStart', { role: 'assistant' }));
  for (const word of BEDROCK_TEXT.split(' ')) {
    res.write(awsEventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: `${word} ` } }));
  }
  res.write(awsEventFrame('contentBlockStop', { contentBlockIndex: 0 }));
  res.write(awsEventFrame('messageStop', { stopReason: 'end_turn' }));
  // Usage arrives last, in its own event - which is why the recipe can only meter a streamed
  // Converse once the stream has been run to the end.
  res.write(awsEventFrame('metadata', { usage: bedrockUsage(body), metrics: { latencyMs: 12 } }));
  res.end();
}

// ----------------------------------------------------------------------------------------
// LiteLLM proxy (OpenAI-compatible, cost in the headers)
// ----------------------------------------------------------------------------------------

const LITELLM_TEXT =
  'This is an automatic response from the built-in offline mock standing in for a LiteLLM ' +
  'proxy. No network call was made and no money was spent.';

/** LiteLLM returns the OpenAI usage object unchanged - note there is no `cost` field in here. */
function liteLLMUsage(body: any) {
  const promptTokens = estimateTokens(body.messages);
  const completionTokens = estimateTokens(LITELLM_TEXT);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: Math.floor(promptTokens / 3) },
    completion_tokens_details: { reasoning_tokens: Math.floor(completionTokens / 8) },
  };
}

/** What the proxy priced the call at, in USD. Same scale as the OpenRouter mock's credits. */
const liteLLMCost = (usage: { prompt_tokens: number; completion_tokens: number }): number =>
  Number(((usage.prompt_tokens * 5 + usage.completion_tokens * 25) / 1_000_000).toFixed(7));

/**
 * A model group resolves to a concrete deployment, so what served is pinned where what was asked
 * for was not. That difference is the routing drift the examples flag.
 */
const liteLLMDeployment = (requested: string): string =>
  requested.includes('-2025-') ? requested : `${requested}-2025-08-07`;

/** Present on every LiteLLM reply. The cost is NOT here - it cannot be, on a stream. */
function liteLLMHeaders(body: any, callId: string): Record<string, string> {
  return {
    'x-litellm-call-id': callId,
    'x-litellm-model-id': `deployment-${callId.slice(-8)}`,
    'x-litellm-model-group': String(body.model ?? 'gpt-5'),
  };
}

function streamLiteLLM(res: ServerResponse, body: any, served: string, callId: string): void {
  // No cost header on this path, and that is the real behaviour rather than a shortcut: the
  // headers are already on the wire before the first token exists, so the price is not known yet.
  openSse(res, liteLLMHeaders(body, callId));
  const created = Math.floor(Date.now() / 1000);
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  for (const word of LITELLM_TEXT.split(' ')) {
    send({
      id: callId,
      object: 'chat.completion.chunk',
      created,
      model: served,
      choices: [{ index: 0, delta: { content: `${word} ` }, finish_reason: null }],
    });
  }
  // Tokens do survive a stream: LiteLLM honours stream_options.include_usage and sends them last.
  send({
    id: callId,
    object: 'chat.completion.chunk',
    created,
    model: served,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: liteLLMUsage(body),
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

// ----------------------------------------------------------------------------------------
// Cloudflare Workers AI - its own result shape, and no price anywhere in it
// ----------------------------------------------------------------------------------------

const WORKERS_AI_TEXT =
  'This is an automatic response from the built-in offline mock standing in for Cloudflare ' +
  'Workers AI. No network call was made and no money was spent.';

/**
 * What `ai.run` resolves to for a text-generation model: `{ response, usage? }`.
 *
 * Not an OpenAI chat completion - there are no `choices` here, and no `model` echoed back, which
 * is exactly why the recipe attributes no model on this surface. A mock that returned an OpenAI
 * body would let a recipe reading `result.choices` pass here and find nothing in production.
 *
 * The three counters only. No neuron count and no cost, because Cloudflare publishes neither.
 */
function workersAiResult(body: any) {
  const promptTokens = estimateTokens(body.messages);
  const completionTokens = estimateTokens(WORKERS_AI_TEXT);
  return {
    response: WORKERS_AI_TEXT,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// ----------------------------------------------------------------------------------------

// ----------------------------------------------------------------------------------------
// Databricks - the OpenAI wire, two vendors' counter names, and no price anywhere
// ----------------------------------------------------------------------------------------

const DATABRICKS_TEXT =
  'This is an automatic response from the built-in offline mock standing in for a Databricks ' +
  'serving endpoint. No network call was made and no money was spent.';

/**
 * Databricks' usage block, with the awkward parts kept.
 *
 * Two of them matter. The cache counters are flat and spelled with *Anthropic's* names, not nested
 * under `prompt_tokens_details` where an OpenAI-shaped reader looks - a mock that tidied that up
 * would let a recipe reading the wrong paths pass here and meter every real call at nothing. And
 * `reasoning_tokens` is flat too, rather than inside `completion_tokens_details`.
 */
function databricksUsage(body: any) {
  const promptTokens = estimateTokens(body.messages);
  const completionTokens = estimateTokens(DATABRICKS_TEXT);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    reasoning_tokens: Math.floor(completionTokens / 8),
    cache_read_input_tokens: Math.floor(promptTokens / 3),
    cache_creation_input_tokens: Math.floor(promptTokens / 8),
  };
}

/**
 * The endpoint name in, the model that served out.
 *
 * The whole point of the Databricks binding: a request names an endpoint, and only the response
 * says what answered. An endpoint called `prod-chat` resolving to a Claude model is exactly the
 * case the recipe's served-model dimension exists for, so the mock reproduces it rather than
 * echoing the request back.
 */
const databricksServed = (endpoint: string): string =>
  endpoint.startsWith('databricks-') ? endpoint : 'databricks-claude-sonnet-4-6';

/** Present on every reply. Note there is no cost header here - Databricks publishes none at all. */
const databricksHeaders = (served: string): Record<string, string> => ({
  'served-model-name': `${served}-1`,
});

/**
 * The route `@databricks/sdk-modelservingquery` builds: `/api/serving-endpoints/<name>/invocations`.
 *
 * **Served in snake_case, and that is the whole reason this route is written out rather than
 * pointed at the chat handler above.** The first-party client is generated, and its zod schema
 * reads `prompt_tokens` off the wire and *transforms* it to `promptTokens` before the caller sees
 * it. A mock that served the camelCase the client hands over would parse to all-undefined, meter
 * the call at nothing, and pass - which is the Mistral `finishReason` trap exactly.
 *
 * Same reason `served-model-name` is spelled with hyphens: that is the wire field, and the schema
 * renames it to `servedModelName`. And `created` is sent as a plain number, which the schema turns
 * into a `BigInt` - the value the recipe must keep out of the ingest.
 *
 * Three counters, not six. `ExternalModelUsageElement` has no field for the cache pair or for
 * `reasoning_tokens`, so sending them would be serving a response this client cannot represent.
 */
function databricksInvocations(res: ServerResponse, body: any, endpoint: string, callId: string): void {
  const served = databricksServed(endpoint);
  const promptTokens = estimateTokens(body.messages);
  const completionTokens = estimateTokens(DATABRICKS_TEXT);
  sendJson(
    res,
    {
      id: callId,
      object: 'chat.completion',
      // A number on the wire. The client's schema is what makes it a BigInt.
      created: Math.floor(Date.now() / 1000),
      model: served,
      choices: [{ index: 0, finishReason: 'stop', message: { role: 'assistant', content: DATABRICKS_TEXT } }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      // The traffic-split entity, under the hyphenated name the wire uses.
      'served-model-name': `${served}-1`,
    },
    databricksHeaders(served),
  );
}

function streamDatabricks(res: ServerResponse, body: any, served: string, callId: string): void {
  openSse(res, databricksHeaders(served));
  const created = Math.floor(Date.now() / 1000);
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  for (const word of DATABRICKS_TEXT.split(' ')) {
    send({
      id: callId,
      object: 'chat.completion.chunk',
      created,
      model: served,
      choices: [{ index: 0, delta: { content: `${word} ` }, finish_reason: null }],
    });
  }
  // Only when the caller asked. `stream_options.include_usage` defaults off on Databricks, and a
  // mock that sent the counters regardless would hide a recipe that forgot to request them.
  const last: Record<string, unknown> = {
    id: callId,
    object: 'chat.completion.chunk',
    created,
    model: served,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  };
  if (body.stream_options?.include_usage) last.usage = databricksUsage(body);
  send(last);
  res.write('data: [DONE]\n\n');
  res.end();
}

// ----------------------------------------------------------------------------------------

/**
 * Starts the mock when there is no API key, or when AGENT_SDK_OFFLINE is set (which forces it
 * even if a key exists - handy when the key is valid but the account has no credits).
// ----------------------------------------------------------------------------------------
// Groq - the OpenAI wire format, with the counters somewhere else
// ----------------------------------------------------------------------------------------

/** Groq reports the OpenAI three plus its own timings, which are floats and are not metrics. */
function groqUsage(body: any) {
  const prompt = estimateTokens(body.messages);
  const completion = estimateTokens(GROQ_TEXT);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    queue_time: 0.0192,
    prompt_time: 0.0041,
    completion_time: 0.0873,
    total_time: 0.0914,
  };
}

/**
 * Reproduces the one thing about Groq that a faked response would hide: a streamed chunk carries
 * **no** top-level `usage`, and the totals arrive under `x_groq` on the final chunk instead.
 *
 * An example reading `chunk.usage` sees nothing here, which is exactly what used to happen in the
 * recipe - so this is what makes the binding's fallback worth anything.
 */
function streamGroq(res: ServerResponse, body: any, model: string): void {
  openSse(res);
  const id = `chatcmpl-${newResponseId()}`;
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  const words = GROQ_TEXT.split(' ');
  words.forEach((word, index) => {
    const delta = index === 0 ? word : ` ${word}`;
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: delta } }] })}\n\n`);
  });
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  // The counters, where Groq actually puts them on a stream.
  res.write(`data: ${JSON.stringify({ ...base, choices: [], x_groq: { id, usage: groqUsage(body) } })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// ----------------------------------------------------------------------------------------
// Mistral - snake_case on the wire, which its generated SDK renames on the way in
// ----------------------------------------------------------------------------------------

/**
 * The wire really is snake_case; `promptTokens` is the SDK's own renaming of it.
 *
 * Sending camelCase here would make the example agree with a recipe that read the wrong names, so
 * the mock speaks what the API speaks and lets the client do the renaming it really does.
 */
function mistralUsage(body: any) {
  const prompt = estimateTokens(body.messages ?? body.prompt);
  const completion = estimateTokens(MISTRAL_TEXT);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

const mistralResponse = (body: any, model: string, text: string) => ({
  id: `cmpl-${newResponseId()}`,
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
  usage: mistralUsage(body),
});

/** Usage on the terminating chunk, as Mistral sends it. */
function streamMistral(res: ServerResponse, body: any, model: string): void {
  openSse(res);
  const base = {
    id: `cmpl-${newResponseId()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const words = MISTRAL_TEXT.split(' ');
  words.forEach((word, index) => {
    const delta = index === 0 ? word : ` ${word}`;
    // `finish_reason` is required-but-nullable in Mistral's own schema, so the wire sends an
    // explicit null on every intermediate chunk. Omitting it makes the generated client reject
    // the whole stream - which is the sort of thing only a real client catches.
    res.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      })}\n\n`,
    );
  });
  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: mistralUsage(body),
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

// ----------------------------------------------------------------------------------------
// Ollama - newline-delimited JSON, counters flat on the final object
// ----------------------------------------------------------------------------------------

/**
 * Ollama's counters, flat on the response rather than inside a `usage` object - and **absent**
 * from every chunk but the last, which is the behaviour the binding has to survive.
 */
function ollamaCounters(body: any) {
  const prompt = estimateTokens(body.messages ?? body.prompt);
  const completion = estimateTokens(OLLAMA_TEXT);
  return {
    total_duration: 1_234_567_890,
    load_duration: 12_345_678,
    prompt_eval_count: prompt,
    prompt_eval_duration: 98_765_432,
    eval_count: completion,
    eval_duration: 456_789_012,
  };
}

/** `/api/chat` and `/api/generate` differ only in where the text sits on the object. */
const ollamaBody = (generate: boolean, text: string) =>
  generate ? { response: text } : { message: { role: 'assistant', content: text } };

function sendOllama(res: ServerResponse, body: any, model: string, generate: boolean): void {
  sendJson(res, {
    model,
    created_at: new Date().toISOString(),
    ...ollamaBody(generate, OLLAMA_TEXT),
    done: true,
    done_reason: 'stop',
    ...ollamaCounters(body),
  });
}

/**
 * NDJSON, not SSE - one JSON object per line, and no `[DONE]` sentinel: the final object is
 * marked `done: true` and is the only one carrying counters.
 */
function streamOllama(res: ServerResponse, body: any, model: string, generate: boolean): void {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
  const words = OLLAMA_TEXT.split(' ');
  words.forEach((word, index) => {
    const delta = index === 0 ? word : ` ${word}`;
    // No counters on an intermediate chunk at all - the server omits them rather than zeroing.
    res.write(
      `${JSON.stringify({
        model,
        created_at: new Date().toISOString(),
        ...ollamaBody(generate, delta),
        done: false,
      })}\n`,
    );
  });
  res.write(
    `${JSON.stringify({
      model,
      created_at: new Date().toISOString(),
      ...ollamaBody(generate, ''),
      done: true,
      done_reason: 'stop',
      ...ollamaCounters(body),
    })}\n`,
  );
  res.end();
}

/**
 * Returns undefined when the example should talk to the real vendor. Prints the banner itself.
 */
export async function maybeStartMockServer(apiKey: string | undefined): Promise<MockServer | undefined> {
  const forced = ['1', 'true', 'yes'].includes((process.env.AGENT_SDK_OFFLINE ?? '').toLowerCase());
  if (apiKey && !forced) return undefined;
  const mock = await startMockServer();
  console.log(`${forced ? 'AGENT_SDK_OFFLINE is set' : 'No API key found'} - ${OFFLINE_NOTICE}`);
  return mock;
}

/** Starts the mock on an ephemeral port. Remember to `close()` it so the process can exit. */
export async function startMockServer(): Promise<MockServer> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const url = req.url ?? '';

      if (url.endsWith('/v1/messages')) {
        const message = anthropicMessage(body);
        if (body.stream) streamAnthropic(res, message);
        else sendJson(res, message);
        return;
      }

      // Ollama speaks its own paths and its own framing: NDJSON, counters flat on the last line.
      if (url.endsWith('/api/chat') || url.endsWith('/api/generate')) {
        const generate = url.endsWith('/api/generate');
        const model = String(body.model ?? 'llama3.3');
        if (body.stream) streamOllama(res, body, model, generate);
        else sendOllama(res, body, model, generate);
        return;
      }

      // Groq, Mistral and both gateways all end in /chat/completions, so the prefix separates
      // them. Each is matched before the catch-all below, which serves the OpenRouter shape.
      if (url.includes('/groq/') && url.endsWith('/chat/completions')) {
        const model = String(body.model ?? 'llama-3.3-70b-versatile');
        if (body.stream) streamGroq(res, body, model);
        else sendJson(res, { ...mistralResponse(body, model, GROQ_TEXT), usage: groqUsage(body) });
        return;
      }

      if (url.includes('/mistral/') && url.endsWith('/chat/completions')) {
        const model = String(body.model ?? 'mistral-small-latest');
        if (body.stream) streamMistral(res, body, model);
        else sendJson(res, mistralResponse(body, model, MISTRAL_TEXT));
        return;
      }

      // Bedrock addresses the model in the path and the operation in the suffix, so neither of
      // the chat routes below can be confused with it.
      if (url.includes('/model/') && (url.endsWith('/converse') || url.endsWith('/converse-stream'))) {
        if (url.endsWith('/converse-stream')) {
          streamBedrock(res, body);
        } else {
          sendJson(
            res,
            {
              output: { message: { role: 'assistant', content: [{ text: BEDROCK_TEXT }] } },
              stopReason: 'end_turn',
              usage: bedrockUsage(body),
              metrics: { latencyMs: 12 },
            },
            { 'x-amzn-requestid': bedrockRequestId() },
          );
        }
        return;
      }

      // `POST /accounts/<id>/ai/run/<model>`, and the Cloudflare SDK wraps every reply in its own
      // `{ result, success, errors, messages }` envelope - which it then unwraps for the caller.
      if (url.includes('/cloudflare/') && url.includes('/ai/run/')) {
        sendJson(res, { result: workersAiResult(body), success: true, errors: [], messages: [] });
        return;
      }

      // Databricks' own client, which has its own path entirely: it posts to
      // `/api/serving-endpoints/<endpoint>/invocations` rather than to the OpenAI chat route.
      // The endpoint name is in the PATH here, not in the body - there is no `model` field on a
      // `QueryEndpointRequest` at all, which is why it is read back out of the URL.
      if (url.includes('/api/serving-endpoints/') && url.endsWith('/invocations')) {
        const endpoint = decodeURIComponent(url.split('/api/serving-endpoints/')[1]!.replace(/\/invocations$/, ''));
        databricksInvocations(res, body, endpoint, `chatcmpl-dbmock${Math.random().toString(16).slice(2, 8)}`);
        return;
      }

      // Ahead of the generic /chat/completions catch-all, like every other prefixed route here.
      if (url.includes('/databricks/') && url.endsWith('/chat/completions')) {
        const callId = `chatcmpl-dbmock${Math.random().toString(16).slice(2, 8)}`;
        const served = databricksServed(String(body.model ?? 'prod-chat'));
        if (body.stream) {
          streamDatabricks(res, body, served, callId);
        } else {
          sendJson(
            res,
            {
              id: callId,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: served,
              choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: DATABRICKS_TEXT } }],
              usage: databricksUsage(body),
            },
            databricksHeaders(served),
          );
        }
        return;
      }

      // Both gateways end in /chat/completions, so the prefix is what separates them.
      if (url.includes('/litellm/') && url.endsWith('/chat/completions')) {
        const callId = `chatcmpl-mock${Math.random().toString(16).slice(2, 10)}`;
        const served = liteLLMDeployment(String(body.model ?? 'gpt-5'));
        if (body.stream) {
          streamLiteLLM(res, body, served, callId);
        } else {
          const usage = liteLLMUsage(body);
          sendJson(
            res,
            {
              id: callId,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: served,
              choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: LITELLM_TEXT } }],
              usage,
            },
            // The one number the body never carries.
            { ...liteLLMHeaders(body, callId), 'x-litellm-response-cost': String(liteLLMCost(usage)) },
          );
        }
        return;
      }

      // `/v1beta/models/<model>:generateContent` and its `:streamGenerateContent` twin. The
      // model rides in the path rather than the body, so it is read back out of the URL.
      if (url.includes(':generateContent') || url.includes(':streamGenerateContent')) {
        const model = url.match(/models\/([^:?]+)/)?.[1] ?? 'gemini-3.8-flash';
        if (url.includes(':streamGenerateContent')) streamGemini(res, body, model);
        else sendJson(res, geminiResponse(body, model, GEMINI_TEXT));
        return;
      }

      if (url.endsWith('/chat/completions')) {
        // Serve the first fallback slug rather than the requested model, so the example's
        // routing-drift check has something real to report.
        const served: string = body.models?.[0] ?? body.model ?? 'anthropic/claude-opus-5';
        if (body.stream) {
          streamOpenRouter(res, body, served);
        } else {
          sendJson(res, {
            id: `gen-mock${Math.random().toString(16).slice(2, 10)}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: served,
            provider: 'offline-mock',
            // Declared `string | null` and required, so an absent one fails the SDK's own parse.
            system_fingerprint: null,
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: OPENROUTER_TEXT } }],
            usage: openRouterUsage(body),
          });
        }
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `mock has no route for ${url}` } }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
