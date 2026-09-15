/**
 * 测试用可控时钟与日志器 / Controllable clock and logger for tests
 *
 * 放在 tests/ 而非 src/：FakeClock 与捕获式日志器只服务于测试，不应进入插件产物。
 * Kept under tests/ so they never ship inside the plugin bundle.
 */

import type { Clock, Logger } from '../../src/services/clock';
import { makeReducerDeps } from '../../src/services/clock';
import type { ReducerDeps } from '../../src/core/reducer';

const pad = (n: number): string => String(n).padStart(2, '0');

/** 按本地时间格式化一个毫秒时间戳 / Format an epoch-ms value as local time. */
function parts(ms: number): {
  minute: string;
  full: string;
  day: string;
} {
  const d = new Date(ms);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const hms = `${hm}:${pad(d.getSeconds())}`;
  return { minute: `${day} ${hm}`, full: `${day} ${hms}`, day };
}

/**
 * 可任意拨动的时钟 / A clock that can be set and advanced at will.
 * 初始时间固定为 2026-09-15 10:00:00 本地时间，保证测试可复现。
 */
export class FakeClock implements Clock {
  private ms: number;

  constructor(startLocal = '2026-09-15T10:00:00') {
    this.ms = new Date(startLocal).getTime();
  }

  now(): number {
    return this.ms;
  }

  nowMinute(): string {
    return parts(this.ms).minute;
  }

  nowFull(): string {
    return parts(this.ms).full;
  }

  today(): string {
    return parts(this.ms).day;
  }

  /** 前进若干毫秒 / Advance by milliseconds. */
  advance(ms: number): void {
    this.ms += ms;
  }

  /** 前进若干秒 / Advance by seconds. */
  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1000);
  }

  /** 跳到某个本地时间 / Jump to a local timestamp. */
  setLocal(local: string): void {
    this.ms = new Date(local).getTime();
  }
}

/** 捕获日志的日志器 / A logger that records everything it receives. */
export class CapturingLogger implements Logger {
  readonly warnings: string[] = [];
  readonly infos: string[] = [];

  warn(message: string, ...args: unknown[]): void {
    this.warnings.push([message, ...args.map(String)].join(' '));
  }

  info(message: string, ...args: unknown[]): void {
    this.infos.push([message, ...args.map(String)].join(' '));
  }

  /** 断言用：日志里是否出现过某关键词 / whether any message contains a keyword */
  hasWarning(keyword: string): boolean {
    return this.warnings.some((w) => w.includes(keyword));
  }
}

/** 组装 reducer 依赖 / Build reducer deps for tests. */
export function testDeps(
  clock: FakeClock,
  logger: CapturingLogger = new CapturingLogger(),
): { deps: ReducerDeps; clock: FakeClock; logger: CapturingLogger } {
  return { deps: makeReducerDeps(clock, logger), clock, logger };
}
