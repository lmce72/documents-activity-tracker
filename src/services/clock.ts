/**
 * 时钟抽象 / Clock abstraction
 *
 * 引入原因：原 reducer 内部直接调用 Date.now() / nowFullStr() / nowStr() 共 6 处，
 * 使它无法被确定性测试。把这些环境依赖收敛到 `Clock` 后：
 *   - 生产环境注入 SystemClock
 *   - 测试注入 FakeClock（见 tests/helpers/fake-clock.ts），可任意拨动时间
 * 于是「跟踪 10 秒 → 暂停 30 秒 → 恢复 10 秒」这类时序行为可以被精确断言。
 *
 * Rationale: the original reducer called Date.now() / nowFullStr() / nowStr() in six
 * places, making it untestable. Routing those through `Clock` lets production use
 * SystemClock and tests drive time deterministically.
 *
 * 本模块属第 2 层（services），但本身无副作用依赖，可被 core 的类型引用。
 * L2 module, though it has no side-effect dependencies of its own.
 */

import { nowFullStr, nowStr, todayStr } from '../core/time';
import type { ReducerDeps } from '../core/reducer';

/** 时间来源 / A source of time. */
export interface Clock {
  /** 毫秒时间戳 / milliseconds since epoch */
  now(): number;
  /** "YYYY-MM-DD HH:mm" */
  nowMinute(): string;
  /** "YYYY-MM-DD HH:mm:ss" */
  nowFull(): string;
  /** "YYYY-MM-DD" */
  today(): string;
}

/** 生产用时钟：读系统时间 / The production clock, backed by the system time. */
export const systemClock: Clock = {
  now: () => Date.now(),
  nowMinute: nowStr,
  nowFull: nowFullStr,
  today: todayStr,
};

/** 可注入日志器 / An injectable logger. */
export interface Logger {
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
}

/** 默认日志器 / The default logger, writing to the console. */
export const consoleLogger: Logger = {
  warn: (message, ...args) => console.warn(message, ...args),
  info: (message, ...args) => console.log(message, ...args),
};

/** 由时钟与日志器组装 reducer 依赖 / Build reducer deps from a clock and a logger. */
export function makeReducerDeps(
  clock: Clock = systemClock,
  log: Logger = consoleLogger,
): ReducerDeps {
  return {
    now: () => clock.now(),
    nowMinute: () => clock.nowMinute(),
    nowFull: () => clock.nowFull(),
    today: () => clock.today(),
    log,
  };
}
