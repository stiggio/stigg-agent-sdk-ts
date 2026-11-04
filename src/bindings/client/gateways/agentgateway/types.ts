export type AgentgatewayRecipeOptions = {
  /**
   * How much to ask permission for before the call, in whatever unit `meter` bills.
   *
   * The default asks for 1 - "is there any budget left at all?" - and lets the ingest afterwards
   * settle the balance. No `unitsPer…` beside it, because there is nothing fractional to
   * denominate: the gateway is self-hosted and puts no price on any response, so a run here bills
   * token counters, which arrive whole.
   */
  estimate?: (params: any) => number;
  /**
   * Dimension the model that actually served is attributed to, so routing drift is visible in
   * Stigg. The gateway can rewrite the model a request named - an alias, a provider prefix, a
   * failover priority group - and the response body names the one that answered.
   */
  modelDimension?: string;
  /**
   * The gateway this recipe is for. agentgateway is self-hosted - a proxy in your own cluster - so
   * unlike a public gateway there is no fixed host to recognise. Give it the same base URL the
   * client was built with, and `matches` compares against exactly that. Without it the matcher
   * falls back to a guess on the hostname; see the recipe for what that guess claims.
   */
  baseUrl?: string;
};
