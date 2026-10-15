/**
 * Consuming an OpenAI-shaped stream, which three of these examples do identically.
 *
 * They differ in the request they send - a fallback list here, a header to read there - and not at
 * all in how the reply comes back. Parsing it three times is how one of them quietly stops
 * printing something the others print, so it is parsed once.
 */
import type OpenAI from 'openai';

/** What a streamed turn produced, once the consumer has drained it. */
export type StreamedTurn<TUsage = OpenAI.CompletionUsage> = {
  text: string;
  usage?: TUsage;
  /** What actually served. A gateway is free to resolve a model group to something else. */
  servedModel?: string;
  /** Absent when the model stopped of its own accord, which is the uninteresting case. */
  stopReason?: string;
};

export async function consumeStream<TUsage = OpenAI.CompletionUsage>(
  stream: AsyncIterable<any>,
): Promise<StreamedTurn<TUsage>> {
  const turn: StreamedTurn<TUsage> = { text: '' };
  let finishReason: string | undefined;

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      turn.text += delta;
      process.stdout.write(delta);
    }
    if (chunk.model) turn.servedModel = chunk.model;
    if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    // Usage arrives once, on the last chunk - the recipe meters when the stream ends.
    // Groq is the exception worth handling here rather than in a fourth copy of this loop: its
    // chunks carry no top-level `usage` at all, and the counters ride `x_groq` instead. Absent
    // for every other vendor, so the fallback changes nothing for them.
    if (chunk.usage) turn.usage = chunk.usage as TUsage;
    else if (chunk.x_groq?.usage) turn.usage = chunk.x_groq.usage as TUsage;
  }

  turn.stopReason = finishReason === 'stop' ? undefined : finishReason;
  return turn;
}
