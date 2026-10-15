/**
 * The examples' half of the Stigg mock: when to start one, and saying so on the way.
 *
 * The server itself lives in `testing/`, because the test suite drives the same one - there is
 * only ever one stand-in for the Stigg API, so an example and a test cannot disagree about what
 * the API does.
 */
import { startMockStiggServer, type MockStiggServer } from '../../testing/mock-stigg-server';

export type { MockStiggServer } from '../../testing/mock-stigg-server';

/** Starts the mock when there is no key to reach a real Stigg with; otherwise stays out of the way. */
export async function maybeStartMockStiggServer(offline: boolean): Promise<MockStiggServer | undefined> {
  if (!offline) return undefined;
  const mock = await startMockStiggServer();
  console.log(`No Stigg key - using the built-in Stigg mock at ${mock.baseUrl} (see testing/mock-stigg-server.ts).`);
  return mock;
}

export { startMockStiggServer };
