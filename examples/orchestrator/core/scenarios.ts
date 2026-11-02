/**
 * The scenarios the orchestrator examples run, as data. Each framework's example builds one with
 * its own code - its own agents, prompts and refusal handling - so two examples of one scenario
 * differ only where their frameworks do, and govern the same agents with the same budgets.
 */
import type { ChatCast } from './chat';

/**
 * Handoff: a top agent passes each request down a chain - a researcher with a paid search, then a
 * writer. When Stigg refuses the researcher, the generalist takes its place, answering without
 * search, so the turn degrades instead of failing. Per-entity usage is whole units, so each call
 * is at least a credit: the researcher runs dry on the fourth request offline.
 */
export const HANDOFF = {
  budgets: { top: 100, researcher: 10, writer: 20, generalist: 20 },
  /** The agent whose search is a paid tool, priced per result. */
  searcher: 'researcher',
  /** Who takes over when Stigg refuses an agent. */
  fallback: { researcher: 'generalist' } as Record<string, string>,
};

/** The handoff scenario's cast, under the name the framework gives its top agent. */
export function handoffCast(
  top: string,
  chat: { parent: string; description: string; agentIdPrefix?: string },
): ChatCast {
  const { top: topBudget, ...budgets } = HANDOFF.budgets;
  return {
    agents: {
      [top]: { budget: topBudget },
      ...Object.fromEntries(Object.entries(budgets).map(([agent, budget]) => [agent, { budget }])),
    },
    searcher: HANDOFF.searcher,
    ...chat,
  };
}

/**
 * Model fallback: one assistant on an expensive model with a small budget, and a cheap model with a
 * large one. When Stigg refuses the expensive model, the cheap one answers in the same request; the
 * next request tries the expensive one first again, so a top-up or a new period brings it back.
 * Offline, the expensive model runs dry within a few requests.
 */
export const MODEL_FALLBACK = {
  /** A credit buys the expensive model a hundred tokens. */
  expensive: { budget: 4, tokensPerCredit: 100 },
  /** And the cheap one two thousand. */
  cheap: { budget: 50, tokensPerCredit: 2_000 },
  instruction: 'You are a helpful assistant. Answer briefly and clearly.',
};
