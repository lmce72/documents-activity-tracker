/**
 * Logger abstraction
 *
 * Split out of `services/clock.ts`: the data layer needs logging too, and letting data
 * depend on services would invert the layering. Living in core keeps every dependency
 * pointing downward and keeps a single definition.
 *
 * Console output goes through an injected logger whose sink is decided at assembly time,
 * so modules stay quiet by default.
 *
 * L0 leaf module.
 */

/** An injectable logger. */
export interface Logger {
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
}

/** The default logger, writing to the console. */
export const consoleLogger: Logger = {
  warn: (message, ...args) => console.warn(message, ...args),
  info: (message, ...args) => console.log(message, ...args),
};

/**
 * A logger that discards everything.
 * For a logging-disabled assembly, so call sites never need `if (enabled)`.
 */
export const silentLogger: Logger = {
  warn: () => {},
  info: () => {},
};
