/**
 * The smallest logger the SDK can depend on. Structural, so any console-shaped object - or a
 * pino/winston child - satisfies it without an adapter.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const noop = () => undefined;

/** What `logger: 'none'` resolves to, for a process that wants the SDK silent. */
export const noopLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

export const consoleLogger: Logger = {
  debug: (message, ...args) => console.debug(message, ...args),
  info: (message, ...args) => console.log(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  error: (message, ...args) => console.error(message, ...args),
};

/** Prefixes every line, so example output shows which subsystem spoke. */
export const prefixed = (logger: Logger, prefix: string): Logger => ({
  debug: (message, ...args) => logger.debug(`${prefix} ${message}`, ...args),
  info: (message, ...args) => logger.info(`${prefix} ${message}`, ...args),
  warn: (message, ...args) => logger.warn(`${prefix} ${message}`, ...args),
  error: (message, ...args) => logger.error(`${prefix} ${message}`, ...args),
});
