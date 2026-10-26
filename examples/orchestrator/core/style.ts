/**
 * Terminal styling for the orchestrator examples: colours, agent tags, and indentation by depth.
 *
 * Colour on a terminal; `styleText` falls back to plain text when the output is piped or under
 * `NO_COLOR`, so what a script or a test reads is the same words.
 */
import { styleText } from 'node:util';

type Style = Parameters<typeof styleText>[0];
export const paint = (style: Style, text: string): string => styleText(style, text);

/** Trace indentation: a subagent runs inside the lead's turn, so it sits below it. */
export const LEAD_DEPTH = 1;
export const SUBAGENT_DEPTH = LEAD_DEPTH + 4;

/** One colour per agent; customer-level steps are grey. */
export const AGENT_STYLES: Record<string, Extract<Style, string>> = {
  lead: 'cyan',
  researcher: 'magenta',
  writer: 'yellow',
  generalist: 'green',
};

export const tag = (agent: string | undefined): string =>
  paint([AGENT_STYLES[agent ?? ''] ?? 'gray', 'bold'], `[${agent ?? 'customer'}]`);

const depthOf = (agent: string | undefined) => (agent === 'lead' || !agent ? LEAD_DEPTH : SUBAGENT_DEPTH);

/** A line under the trace of the agent it is about. */
export const logAs = (agent: string | undefined, line: string): void =>
  console.log(`${'  '.repeat(depthOf(agent))}${tag(agent)} ${line}`);

/** One line of anything, short enough to read in a log. */
export const preview = (value: unknown, max = 90): string => {
  const text = (typeof value === 'string' ? value : JSON.stringify(value)).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** The lines every agent's trace is made of, the same in both examples. */
export const logStart = (agent: string, input: unknown): void =>
  logAs(agent, `${paint('bold', 'start')} - ${paint('italic', preview(input))}`);

export const logDone = (agent: string, detail: string): void =>
  logAs(agent, `${paint('bold', 'done')} - ${paint('dim', detail)}`);

export const logToolCall = (agent: string, name: string, args: unknown): void =>
  logAs(agent, `  ${paint('blue', 'calls')} ${paint(['blue', 'bold'], name)}${paint('dim', `(${preview(args, 60)})`)}`);

export const logToolResult = (agent: string, name: string, detail: string): void =>
  logAs(agent, `  ${paint('blue', name)} ${paint('dim', detail)}`);

/** The guard rail stopping a tool - `name` left out when it stops them all. */
export const logBlocked = (agent: string, name: string | undefined, why: string): void =>
  logAs(
    agent,
    `  ${paint(['yellow', 'bold'], 'BLOCKED')} ${name ? `${paint('bold', name)} - ` : ''}${paint('yellow', why)}`,
  );

/** Stigg refusing a tool. */
export const logRefused = (agent: string, name: string, decision: { reason?: string; deniedBy?: string }): void =>
  logAs(
    agent,
    `  ${paint(['red', 'bold'], 'REFUSED')} ${paint('bold', name)} - ` +
      paint('red', `${decision.reason ?? 'denied'} by ${decision.deniedBy ?? 'policy'}`),
  );
