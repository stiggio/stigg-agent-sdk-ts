/** What this binding accepts: the run's context, plus what only the request itself can say. */
import type { IngestContext } from '../../types';

export type ProxyIngestInput = IngestContext & {
  /** Whatever the vendor reported; the shape is recognised on the way in. */
  usage: unknown;
  /** The gateway's own request id is the natural key - it is stable across its retries. */
  idempotencyKey: string;
};
