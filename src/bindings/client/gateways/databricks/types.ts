export type DatabricksRecipeOptions = {
  /**
   * How much to ask permission for before the call, in whatever unit `meter` bills.
   *
   * The default asks for 1 - "is there any budget left at all?" - and lets the ingest afterwards
   * settle the balance. There is no `unitsPer…` beside it because there is nothing fractional to
   * denominate: Databricks states no price on any response, so a run here bills token counters,
   * which arrive as whole numbers already.
   */
  estimate?: (params: any) => number;
  /**
   * Dimension the model that actually served is attributed to.
   *
   * Worth more here than at most gateways. The request names a serving *endpoint*, which on the
   * classic route is a string the customer chose and which need not resemble any model id - so
   * the response's `model` field is frequently the only thing in the whole exchange that says
   * what answered.
   */
  modelDimension?: string;
  /**
   * The workspace this recipe is for, as a base URL.
   *
   * A Databricks workspace hostname is customer-specific - `<workspace>.cloud.databricks.com`,
   * `adb-<id>.<n>.azuredatabricks.net`, `<id>.<n>.gcp.databricks.com`, or whatever a PrivateLink
   * or custom-DNS deployment resolves to. The matcher recognises the three public families and
   * the two serving paths without being told; a deployment on a private hostname is invisible to
   * that guess and needs this. Give it the same base URL the client was built with.
   */
  baseUrl?: string;
};
