/**
 * The gateway binding is generic on purpose: a gateway sees HTTP requests, not SDK calls, so
 * there is nothing vendor-specific to adapt. What travels is attribution.
 */
export { GOVERNANCE_HEADERS, parseGovernanceHeaders } from '../../headers';
export type { GovernanceHeaders, ParsedGovernanceHeaders } from '../../headers';

// Attribution to send with a request is `run.headers()` on the handle itself - the run owns the
// three values, so a free function here could only copy them back out of it.
