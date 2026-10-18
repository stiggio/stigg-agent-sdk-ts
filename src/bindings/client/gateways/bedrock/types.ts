export type BedrockRecipeOptions = {
  /**
   * How much to ask permission for before the call.
   *
   * The default asks for 1 - "is there any budget left at all?" - and lets the ingest afterwards
   * settle the balance, which leaves a gap of about one call's worth of tokens. A run that wants
   * that gap closed knows something this recipe cannot: `inferenceConfig.maxTokens` is the only
   * ceiling Bedrock is given, and whether it is worth asking for depends on how a budget is
   * denominated. Reading it is one line - `(command) => command?.input?.inferenceConfig?.maxTokens
   * ?? 1` - and it is the caller's line to write.
   */
  estimate?: (command: any) => number;
};
