/**
 * What an Ollama response carries, typed structurally.
 *
 * No import from `ollama` - `module-boundaries.test.ts` would fail on one.
 */
import type { OllamaLikeUsage } from '../../../shared/types';

/**
 * A completed `chat` or `generate` response, or the final chunk of a streamed one.
 *
 * The counters are flat on the root - there is no `usage` object to reach into - and every one of
 * them is optional here, against the vendor's own `.d.ts`, which declares them required. The
 * server marks the whole `Metrics` struct `omitempty`, so an intermediate chunk carries none of
 * them and the declared type is wrong about it. See `OllamaLikeUsage`.
 *
 * `done` is what distinguishes a final chunk from an intermediate one, and is likewise optional
 * on the wire. The response also carries `message`, `response`, `context` and a set of
 * nanosecond durations; none is read here, and `message` in particular must never reach `raw` -
 * it holds the model's reply text, and `raw` becomes event dimensions.
 */
export type OllamaResponse = OllamaLikeUsage & {
  model?: string;
  done?: boolean;
  done_reason?: string;
};
