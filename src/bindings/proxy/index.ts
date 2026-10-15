/**
 * Ingest-only, by design.
 *
 * A gateway is out-of-process and sees requests, not runs: it cannot provision, cannot check
 * against run-scoped state, and cannot archive. What works is splitting the lifecycle across the
 * boundary - the application provisions and checks in-process, the attribution travels as
 * headers, and the gateway ingests against it. Governance never leaves the process.
 *
 * Both halves of that are methods, not free functions: `run.headers()` writes the attribution and
 * `stigg.ingestFromHeaders(...)` reads it back. This module is the header contract and the input
 * shape they agree on.
 */
export { GOVERNANCE_HEADERS, parseGovernanceHeaders } from './headers';
export type { GovernanceHeaders, ParsedGovernanceHeaders } from './headers';
export type * from './types';
/**
 * The proxy's one vendor-shaped decision, re-exported from where it is implemented so it sits
 * beside the call that takes it. A proxy has no response object to adapt - there is no recipe out
 * here - so naming the shape it observed is the whole of what it can say about the vendor.
 */
export type { ObservedVendor } from '../shared/token-usage';
