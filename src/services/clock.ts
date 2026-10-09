/**
 * Clock abstraction
 *
 * Rationale: the original reducer called Date.now() / nowFullStr() / nowStr() in six
 * places, making it untestable. Routing those through `Clock` lets production use
 * SystemClock and tests drive time deterministically.
 *
 * L2 module, though it has no side-effect dependencies of its own.
 */

import { nowFullStr, nowStr, todayStr } from '../core/time';
import { consoleLogger } from '../core/logger';
import type { Logger } from '../core/logger';
import type { ReducerDeps } from '../core/reducer';

//  The logger now lives in core/logger.ts; re-exported here so existing imports keep working.
export { consoleLogger, silentLogger } from '../core/logger';
export type { Logger } from '../core/logger';

/** A source of time. */
export interface Clock {
  /** milliseconds since epoch */
  now(): number;
  /** "YYYY-MM-DD HH:mm" */
  nowMinute(): string;
  /** "YYYY-MM-DD HH:mm:ss" */
  nowFull(): string;
  /** "YYYY-MM-DD" */
  today(): string;
}

/** The production clock, backed by the system time. */
export const systemClock: Clock = {
  now: () => Date.now(),
  nowMinute: nowStr,
  nowFull: nowFullStr,
  today: todayStr,
};

/** Build reducer deps from a clock and a logger. */
export function makeReducerDeps(
  clock: Clock = systemClock,
  log: Logger = consoleLogger,
): ReducerDeps {
  return {
    now: () => clock.now(),
    nowFull: () => clock.nowFull(),
    today: () => clock.today(),
    log,
  };
}
