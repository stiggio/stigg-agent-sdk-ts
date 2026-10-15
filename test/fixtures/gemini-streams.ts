/**
 * Real Gemini streams, recorded off the wire rather than written by hand.
 *
 * Both were captured from `models.generateContentStream` against the Developer API
 * (`gemini-3.8-flash`, October 2026) by logging `{ responseId, usageMetadata }` for every chunk
 * that carried usage. Only the chunks without usage are dropped; nothing else is edited.
 *
 * They exist because the two claims this recipe rests on were otherwise only ever checked against
 * a mock this repository writes itself, which is a test of the mock. What the wire actually says:
 *
 *  - `usageMetadata` repeats on every chunk and is cumulative **within** a round, so the last
 *    block of a round is the whole of it.
 *  - `responseId` is shared by the chunks of one round and changes at the next, which is what
 *    makes a round boundary exact.
 *  - `promptTokenCount` is **not** fixed within a round - see 92 -> 138 inside the second round
 *    below. An earlier version of this recipe treated that as a boundary and over-billed.
 */

export type RecordedChunk = { responseId: string; usageMetadata: Record<string, unknown> };

/**
 * A thinking model, no tools: one round, five chunks.
 *
 * `thoughtsTokenCount` is 157 on every chunk including the last, which is the point - if thinking
 * tokens were reported only on earlier chunks, taking the last block would bill them at nothing.
 */
export const THINKING_STREAM: RecordedChunk[] = [
  {
    responseId: 'FKnLapmOG6P5',
    usageMetadata: { promptTokenCount: 19, candidatesTokenCount: 14, thoughtsTokenCount: 157, totalTokenCount: 190 },
  },
  {
    responseId: 'FKnLapmOG6P5',
    usageMetadata: { promptTokenCount: 19, candidatesTokenCount: 40, thoughtsTokenCount: 157, totalTokenCount: 216 },
  },
  {
    responseId: 'FKnLapmOG6P5',
    usageMetadata: { promptTokenCount: 19, candidatesTokenCount: 68, thoughtsTokenCount: 157, totalTokenCount: 244 },
  },
  {
    responseId: 'FKnLapmOG6P5',
    usageMetadata: { promptTokenCount: 19, candidatesTokenCount: 75, thoughtsTokenCount: 157, totalTokenCount: 251 },
  },
  {
    responseId: 'FKnLapmOG6P5',
    usageMetadata: { promptTokenCount: 19, candidatesTokenCount: 75, thoughtsTokenCount: 157, totalTokenCount: 251 },
  },
];

/** What Google charged for it: the single round's final block. */
export const THINKING_TOTAL = 251;

/**
 * Automatic function calling with one callable tool: two rounds through one generator.
 *
 * `promptTokensDetails` is kept as it arrived - the recipe names none of it, and a fixture that
 * tidied the response would stop being a recording.
 */
export const AFC_STREAM: RecordedChunk[] = [
  {
    responseId: '_ajLaubrI5CO28oPwbHquAY',
    usageMetadata: {
      promptTokenCount: 59,
      candidatesTokenCount: 17,
      totalTokenCount: 122,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 59 }],
      thoughtsTokenCount: 46,
      serviceTier: 'standard',
    },
  },
  {
    responseId: '_ajLaubrI5CO28oPwbHquAY',
    usageMetadata: {
      promptTokenCount: 59,
      candidatesTokenCount: 17,
      totalTokenCount: 122,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 59 }],
      thoughtsTokenCount: 46,
      serviceTier: 'standard',
    },
  },
  {
    responseId: '_6jLauu7J6zxnsEP1fNB',
    usageMetadata: {
      promptTokenCount: 92,
      candidatesTokenCount: 13,
      totalTokenCount: 124,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 92 }],
      thoughtsTokenCount: 19,
      serviceTier: 'standard',
    },
  },
  {
    responseId: '_6jLauu7J6zxnsEP1fNB',
    usageMetadata: {
      promptTokenCount: 138,
      candidatesTokenCount: 13,
      totalTokenCount: 170,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 138 }],
      thoughtsTokenCount: 19,
      serviceTier: 'standard',
    },
  },
];

/** What Google charged: each round's final block, summed. 122 + 170. */
export const AFC_TOTAL = 292;
/** What the two wrong readings give, kept so the tests can state what they are avoiding. */
export const AFC_LAST_BLOCK_ONLY = 170;
export const AFC_EVERY_CHUNK_SUMMED = 538;
