/**
 * What a Mistral response carries, typed structurally.
 *
 * No import from `@mistralai/mistralai` - `module-boundaries.test.ts` would fail on one, and the
 * package's whole claim is that importing a recipe pulls in no vendor SDK. These are the fields
 * the recipe reads and nothing more.
 */
import type { MistralLikeUsage } from '../../../shared/types';

/**
 * The buffered response, shared by every surface this recipe gates.
 *
 * `chat.complete`, `fim.complete` and `agents.complete` return three differently-named types in
 * the SDK - `ChatCompletionResponse`, `FIMCompletionResponse`, `ChatCompletionResponse` again -
 * and all three carry the same `usage: UsageInfo`. `chat.parse` is `Omit<ChatCompletionResponse,
 * 'choices'> & { choices? }`, so it keeps `usage` too. That was checked against the SDK's own
 * types rather than assumed, because one extractor across four surfaces is only safe if the
 * shapes really are one shape.
 */
export type MistralCompletionResponse = {
  id?: string;
  model?: string;
  usage?: MistralLikeUsage | null;
};

/**
 * One streamed event.
 *
 * The counters sit a level down, under `data` - all four streamed surfaces resolve to the same
 * `EventStream<CompletionEvent>`, and `CompletionEvent` is `{ data: CompletionChunk }`. Reading
 * `chunk.usage` instead of `chunk.data.usage` finds nothing and meters the call at zero, which is
 * why this is typed rather than reached for inline.
 */
export type MistralCompletionEvent = {
  data?: {
    id?: string;
    model?: string;
    usage?: MistralLikeUsage | null;
  } | null;
};
