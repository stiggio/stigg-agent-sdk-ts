export type CloudflareRecipeOptions = {
  /**
   * How much to ask permission for before the call, in whatever unit `meter` bills.
   *
   * The default asks for 1 - "is there any budget left at all?" - and lets the ingest afterwards
   * settle the balance. No `unitsPer…` beside it, because there is nothing fractional to
   * denominate: Cloudflare publishes no price on any response, on either route, so a run here
   * bills token counters, which arrive whole.
   *
   * Worth knowing that a cache hit passes the gate and then meters nothing. That is the right way
   * round - whether a call will hit the gateway's cache cannot be known before it is made, and a
   * free call should not be billed afterwards.
   */
  estimate?: (params: any) => number;
  /**
   * Dimension the model that actually served is attributed to.
   *
   * Which model that is depends on the route. Workers AI does not route, so what was asked for is
   * what ran - and `ai.run` takes the model as its first *argument* and echoes nothing back, so a
   * turn made that way carries no model dimension at all. Through AI Gateway it really can differ:
   * Auto Router picks from a candidate pool and names its choice in `cf-aig-routed-model`, and a
   * fallback chain can serve from a different provider entirely.
   */
  modelDimension?: string;
  /**
   * The Cloudflare endpoint, when it is not one of the two public ones.
   *
   * Workers AI is served from `api.cloudflare.com` and AI Gateway from
   * `gateway.ai.cloudflare.com/v1/<account>/<gateway>/<provider>`; the matcher recognises both
   * without being told. The case that needs this is a **custom domain**: a gateway served from
   * `ai.example.com` has the account and gateway ids stripped out of the path, so nothing in the
   * URL identifies Cloudflare at all.
   */
  baseUrl?: string;
};
