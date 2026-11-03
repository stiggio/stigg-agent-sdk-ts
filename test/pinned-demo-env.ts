/**
 * The environment the example tests run their example under: offline, with every demo fixture
 * pinned to the template's defaults.
 *
 * Set here rather than read from `examples/demo.env`, which is the developer's own file and is free
 * to name another customer, a real currency, or no team at all - an assertion on `credits=1` or on
 * a team's refusal must not depend on whose machine runs it. dotenv never overwrites a variable
 * that is already set, so these win over the file.
 */
export const EXAMPLE_ENV = {
  // Plain text, whoever runs the test. The example colours its output when the terminal supports
  // it, and `nx` sets FORCE_COLOR for every task it runs - so under CI the assertions below would
  // be matching words split by escape codes.
  FORCE_COLOR: '0',
  NO_COLOR: '1',
  AGENT_SDK_OFFLINE: '1',
  AGENT_SDK_DEMO_CUSTOMER_ID: 'customer-acme',
  AGENT_SDK_DEMO_TEAM_ID: 'team-research',
  AGENT_SDK_DEMO_AGENT_ID: 'agent-support-bot',
  AGENT_SDK_DEMO_ENTITY_TYPE_ID: 'agent',
  AGENT_SDK_DEMO_ATTRIBUTION_KEY: 'agentId',
  AGENT_SDK_DEMO_CURRENCY_ID: 'credits',
  AGENT_SDK_DEMO_FEATURE_ID: '',
  AGENT_SDK_DEMO_EVENT_NAME: '',
  AGENT_SDK_DEMO_MOCK_GOVERNANCE_FAIL: '',
} as const;
