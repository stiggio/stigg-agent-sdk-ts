/**
 * The Amazon Bedrock gateway helper - the gateway that states no price.
 *
 * Bedrock is a gateway in the sense that matters here: one API in front of many vendors' models,
 * so an application calls Anthropic, Nova, Llama and Mistral through one client and one request
 * shape. What it does not do is the thing the other two helpers in this directory are built
 * around - it never tells you what a call cost. The money is in the AWS bill, reconciled later and
 * nowhere on the response.
 *
 * So this example meters **tokens**, and `billedMetrics` is where that shows. Everything else in
 * the shared script is unchanged, which is the point worth taking from running all three: the
 * governance wiring does not care what a gateway reports, only that the recipe can read it.
 *
 * Two more differences, both of them facts about Bedrock rather than gaps here:
 *
 *   - **No routing drift.** Bedrock does not choose for you. You name a model id and that model
 *     answers, so the "served model" line below always matches what was requested - unlike
 *     OpenRouter, where a fallback list means the two can differ and the difference is COGS.
 *   - **No proxy half.** The header path forwards the OpenAI wire format; Bedrock speaks SigV4 and
 *     Converse. `createProxyClient` is therefore absent and the script says why.
 *
 * Credentials come from the usual AWS chain - environment, shared profile, SSO, web identity,
 * container and instance roles - so there is no key to put in `.env` at all. The example asks that
 * chain whether it can authenticate and runs against the offline mock when it cannot;
 * `AGENT_SDK_OFFLINE=1` forces the mock either way.
 *
 * Run:  yarn example-gateway-bedrock
 */
import '../shared/load-env';
import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { bedrockRecipe } from '../../src';
import { startGateway } from './core/gateway';
import type { CostReading, GatewayVendor } from './core/vendor';

/** What Bedrock reports, which is tokens and no price. */
type BedrockUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
};

const MODEL = process.env.AGENT_SDK_BEDROCK_MODEL ?? 'anthropic.claude-sonnet-4-5-20250929-v1:0';
const REGION = process.env.AGENT_SDK_BEDROCK_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

const n = (value: number | undefined): number => (typeof value === 'number' ? value : 0);

/**
 * Bedrock's counters in the neutral shape the shared script prints.
 *
 * `cached` is printed beside `prompt` the way it is for the other two, but it means something
 * slightly different here and the difference is worth knowing: AWS states that `inputTokens`
 * *excludes* cache reads, where OpenAI's `prompt_tokens` includes them. So these two add up;
 * over there they overlap.
 */
const readTokens = (usage: BedrockUsage | undefined): CostReading['tokens'] =>
  usage
    ? {
        prompt: n(usage.inputTokens),
        cached: n(usage.cacheReadInputTokens),
        completion: n(usage.outputTokens),
        // Bedrock reports no reasoning split of its own; the model's thinking tokens are counted
        // inside `outputTokens` rather than beside them.
        reasoning: 0,
      }
    : undefined;

export const bedrockGateway: GatewayVendor<BedrockRuntimeClient> = {
  label: 'Bedrock',
  agentSuffix: 'gateway-bedrock',
  model: MODEL,
  // Empty on purpose: there is no one variable to read. AWS authenticates through a chain, and
  // `hasCredentials` below asks that chain instead of guessing at its inputs.
  keyVars: [],

  /**
   * Resolved rather than guessed at, because resolving is what the real call does - see
   * `GatewayVendor.hasCredentials` for why an env var cannot answer this for AWS.
   */
  hasCredentials: async () => {
    const probe = new BedrockRuntimeClient({ region: REGION });
    try {
      const resolved = await probe.config.credentials();
      return !!resolved?.accessKeyId;
    } catch {
      // The chain refusing is the whole answer: nothing here can authenticate, so use the mock.
      return false;
    } finally {
      probe.destroy();
    }
  },
  // Regional, so there is no single host. Built from the region the same way the AWS SDK would.
  baseUrl: `https://bedrock-runtime.${REGION}.amazonaws.com`,
  // Bedrock addresses the model in the path, so the mock needs no vendor prefix to tell it apart.
  mockBaseUrl: (base) => base,

  createClient: ({ baseUrl }) => {
    const offline = !baseUrl.includes('amazonaws.com');
    return new BedrockRuntimeClient({
      region: REGION,
      // Only when standing in for the service. Against the real endpoint this is left alone so
      // the SDK resolves it, which is what picks up FIPS, dualstack and private endpoints.
      ...(offline
        ? {
            endpoint: baseUrl,
            // The mock serves HTTP/1.1, and this client defaults to HTTP/2 because that is what
            // bidirectional event streaming needs. Response-only streaming - which is all
            // ConverseStream is - works over HTTP/1.1, so the offline run swaps the handler
            // rather than the mock growing an h2c server for one vendor.
            requestHandler: new NodeHttpHandler(),
            // Signing still happens; the mock does not check it, but the request is built the way
            // a real one is rather than taking a different path through the SDK.
            credentials: { accessKeyId: 'offline-mock', secretAccessKey: 'offline-mock' },
          }
        : {}),
    });
  },

  // No `createProxyClient`: see the note at the top of this file.

  recipe: () => bedrockRecipe(),

  /**
   * Tokens, because there is nothing else. The other two helpers bill `cost`; this one cannot, and
   * a budget denominated in a metric the recipe never reports would meter every call at nothing.
   *
   * `totalTokens` is Bedrock's own figure for the call. On a cached call the cache counters sit
   * outside it - they are reported too, and a run that wants to charge for them can weight them
   * here, which is safe precisely because Bedrock's counters do not overlap.
   */
  billedMetrics: { totalTokens: 1 },

  async turn(client, { prompt, stream }) {
    const request = {
      modelId: MODEL,
      messages: [{ role: 'user' as const, content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 300 },
    };

    if (!stream) {
      const result = await client.send(new ConverseCommand(request));
      const text = result.output?.message?.content?.map((block) => block.text ?? '').join('') ?? '';
      console.log(text || '(no content)');
      return {
        // Nothing to put here. The field is optional for exactly this case, and the script prints
        // "(not reported)" rather than a zero that would read like a free call.
        servedModel: MODEL,
        idempotencyKey: result.$metadata.requestId ?? '',
        tokens: readTokens(result.usage),
      };
    }

    // The envelope, not the stream: AWS returns `{ stream, $metadata }`, so what gets iterated -
    // and what the recipe meters - is the property rather than the response.
    const result = await client.send(new ConverseStreamCommand(request));
    let usage: BedrockUsage | undefined;
    for await (const event of result.stream ?? []) {
      const delta = event.contentBlockDelta?.delta?.text;
      if (delta) process.stdout.write(delta);
      // Usage arrives once, in its own event at the end of the stream.
      if (event.metadata?.usage) usage = event.metadata.usage;
    }
    process.stdout.write('\n');
    return { servedModel: MODEL, idempotencyKey: result.$metadata.requestId ?? '', tokens: readTokens(usage) };
  },

  /**
   * Tokens, not micro-credits, so this is sized in a different unit from its neighbours: a few
   * hundred tokens a call against the mock, so this is a budget for a handful of them and the
   * denial at the end arrives for the same reason theirs does.
   */
  budget: 2_000,
};

startGateway(bedrockGateway);
