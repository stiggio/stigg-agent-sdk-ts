/**
 * What a wrapped call reports as, once a run ingests through the event API.
 *
 * The event name is not an internal label: a Stigg raw-events meter filters on it, so it is part
 * of what this package publishes and someone has to configure a meter to match. These pin the
 * names, and the two things that make them usable - that one client's two APIs stay apart, and
 * that the vendor's own usage block rides along for a meter to read.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anthropicRecipe } from '../src/bindings/client/providers/anthropic/anthropic-recipe';
import { geminiChatRecipe, geminiRecipe } from '../src/bindings/client/providers/gemini/gemini-recipe';
import { groqRecipe } from '../src/bindings/client/providers/groq/groq-recipe';
import { mistralRecipe } from '../src/bindings/client/providers/mistral/mistral-recipe';
import { ollamaRecipe } from '../src/bindings/client/providers/ollama/ollama-recipe';
import { openAIRecipe } from '../src/bindings/client/providers/openai/openai-recipe';
import { openrouterRecipe } from '../src/bindings/client/gateways/openrouter/openrouter-recipe';
import { litellmRecipe } from '../src/bindings/client/gateways/litellm/litellm-recipe';
import {
  databricksRecipe,
  databricksExternalRecipe,
} from '../src/bindings/client/gateways/databricks/databricks-recipe';
import { cloudflareRecipe } from '../src/bindings/client/gateways/cloudflare/cloudflare-recipe';
import { bedrockRecipe } from '../src/bindings/client/gateways/bedrock/bedrock-recipe';
import { typesafeRecipe } from '../src/bindings/client/providers/typesafe/typesafe-recipe';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eventNameFor } from '../src/bindings/client/core/types';
import { wrapClient } from '../src/bindings/client/core/wrap-client';
import { newRun } from './session-harness';
import { FakeEngine } from './fake-engine';
import { vendorMetrics } from '../src/types';
import type { ClientRecipe } from '../src/bindings/client/core/types';
import type { EngineReportParams } from '../src/engine/engine';

/** Every name this package ships. Changing one means every meter filtering on it stops matching. */
const PUBLISHED = [
  ['anthropic', anthropicRecipe, ['anthropic.messages.create']],
  ['openai', openAIRecipe, ['openai.chat.completions.create', 'openai.responses.create']],
  [
    'openrouter',
    openrouterRecipe(),
    [
      'openrouter.chat.completions.create',
      'openrouter.responses.create',
      // The same gateway reached through its own SDK, which names its methods differently. Four
      // names rather than two, because a meter filtering on one must not catch the other.
      'openrouter.chat.send',
      'openrouter.responses.send',
    ],
  ],
  ['litellm', litellmRecipe(), ['litellm.chat.completions.create', 'litellm.responses.create']],
  // Two vendors over one wire. The names are the only durable record of which route the caller
  // asserted an endpoint serves, so a meter filtering on one must not catch the other.
  // `query` leads because it is first in `methods`, and this assertion is order-sensitive. It is
  // the first-party client's one method, and it is the SAME vendor as the OpenAI-wire names below:
  // one Databricks account is billed whichever client the application imported, so the wire shows
  // up in the event name rather than in a second vendor.
  [
    'databricks',
    databricksRecipe(),
    ['databricks.query', 'databricks.chat.completions.create', 'databricks.responses.create'],
  ],
  [
    'databricks-external',
    databricksExternalRecipe(),
    [
      // The external route is reachable by the first-party client too - `ExternalModelUsageElement`
      // is literally named for it - so the surface comes along rather than being held back.
      'databricks-external.query',
      'databricks-external.chat.completions.create',
      'databricks-external.responses.create',
    ],
  ],
  [
    'mistral',
    mistralRecipe,
    [
      'mistral.chat.complete',
      'mistral.chat.stream',
      'mistral.chat.parse',
      'mistral.chat.parseStream',
      'mistral.fim.complete',
      'mistral.fim.stream',
      'mistral.agents.complete',
      'mistral.agents.stream',
    ],
  ],
  ['groq', groqRecipe, ['groq.chat.completions.create']],
  ['ollama', ollamaRecipe, ['ollama.chat', 'ollama.generate']],
  // One name for one method, because Bedrock's client has one method - the operation is the
  // argument, not the path, so there is nothing finer for a meter to filter on here.
  ['bedrock', bedrockRecipe(), ['bedrock.send']],
  // One provider reached two ways - one Cloudflare account is billed whichever client is held, and
  // the wire is already visible in the name.
  [
    'cloudflare',
    cloudflareRecipe(),
    [
      // Both wires AI Gateway forwards, plus Workers AI's own two routes. A surface left out here
      // is ungated, not metered elsewhere: this recipe is matched ahead of the ones that would
      // otherwise have claimed the client.
      'cloudflare.chat.completions.create',
      'cloudflare.responses.create',
      'cloudflare.messages.create',
      'cloudflare.ai.run',
    ],
  ],
  ['gemini', geminiRecipe, ['gemini.models.generateContent', 'gemini.models.generateContentStream']],
  ['gemini (chats)', geminiChatRecipe, ['gemini.chats.sendMessage', 'gemini.chats.sendMessageStream']],
] as const;

describe('the names a meter has to filter on', () => {
  for (const [vendor, recipe, expected] of PUBLISHED) {
    it(`names ${vendor}'s calls after the calls themselves`, () => {
      const names = (recipe as ClientRecipe).methods.map((method) => eventNameFor(recipe as ClientRecipe, method));
      assert.deepEqual(names, [...expected]);
    });
  }

  it('keeps one client’s two APIs apart, so a meter can meter one of them', () => {
    const names = openAIRecipe.methods.map((method) => eventNameFor(openAIRecipe, method));
    assert.equal(new Set(names).size, names.length);
  });
});

describe('what a gated call actually reports', () => {
  const recipe: ClientRecipe = {
    vendor: 'anthropic',
    metrics: ['input_tokens'],
    methods: [
      {
        path: ['messages', 'create'],
        extractUsage: (result: any) => ({
          metrics: { input_tokens: result.usage.input_tokens },
          raw: result.usage,
        }),
      },
    ],
  };

  const gated = () => {
    const engine = new FakeEngine({ usageLimit: 100 });
    const sent: EngineReportParams[] = [];
    const report = engine.report.bind(engine);
    engine.report = (customerId, params) => {
      sent.push(params);
      return report(customerId, params);
    };
    const run = newRun({
      engine,
      dimensions: { agentId: 'agent-1' },
      usageMapper: vendorMetrics,
      ingestMode: 'async',
      checkErrorAction: 'deny',
    });
    const client = {
      messages: {
        create: async () => ({ usage: { input_tokens: 12, service_tier: 'standard' } }),
      },
    };
    return { run, sent, client: wrapClient(client, recipe, run.session, run.context) };
  };

  it('carries the vendor’s own usage block, so a meter can read what the recipe did not name', async () => {
    const { run, sent, client } = gated();
    await client.messages.create();
    await run.drain();

    // `service_tier` is not a metric and never will be - it is not a number. As a dimension it is
    // something a meter can filter on, which is the difference between the two namespaces.
    assert.deepEqual(sent[0].raw, { 'raw.input_tokens': 12, 'raw.service_tier': 'standard' });
  });
});

describe('the README is the contract, so it cannot drift from the code', () => {
  it('documents exactly the event names the recipes derive', async () => {
    // The reference, which is where the event-name table lives. The README is the front page.
    const readme = await readFile(join(__dirname, '..', 'docs', 'guide.md'), 'utf8');
    // Every backticked name in the file that is shaped like one of ours, wherever it is written -
    // the table, the meter example, a paragraph. A name is only useful if every mention is right.
    const documented = [
      ...readme.matchAll(
        /`((?:anthropic|openai|openrouter|litellm|typesafe|gemini|mistral|ollama|groq|bedrock|databricks-external|databricks|cloudflare)\.[a-zA-Z.]+)`/g,
      ),
    ].map((match) => match[1]);
    const derived = [...PUBLISHED, ['typesafe', typesafeRecipe, ['typesafe.systemOne']] as const].flatMap(
      ([, recipe]) => (recipe as ClientRecipe).methods.map((method) => eventNameFor(recipe as ClientRecipe, method)),
    );

    // A rename that misses the README turns every meter filtering on the old name into a silent
    // no-op, and nothing in the running system can notice. So it fails here instead.
    assert.deepEqual(
      [...new Set(documented)].sort(),
      [...new Set(derived)].sort(),
      'the event table and the recipes disagree about what this package reports',
    );
  });
});
