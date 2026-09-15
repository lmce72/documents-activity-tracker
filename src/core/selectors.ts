/**
 * 状态选择器（纯函数）/ Pure state selectors
 *
 * 来源：vault 版 HeaderWidget 内的 8 个私有方法（3139-3239），本次抽为纯函数，
 * 使 UI 无需再通过 `this.service.dataStore._cache` 穿透取数。
 * Origin: the 8 private methods inside vault HeaderWidget (3139-3239), extracted into
 * pure functions so the UI no longer reaches through `_cache`.
 *
 * 依赖 timeline 的选择器（今日时长、轮数、全库今日）在 core/timeline.ts，
 * 因为它们需要 timeline 作为参数，不属于「纯状态」。
 * Timeline-dependent selectors live in core/timeline.ts since they need the timeline.
 *
 * 本模块是第 0 层，只依赖 constants / types。
 */

import { STATUS } from './constants';
import type { TimerFileState, TimerState } from './types';

/** 取单个文件的计时状态 / The timer state for one file, or null. */
export function selectFileState(
  state: TimerState,
  filePath: string,
): TimerFileState | null {
  return state.files.get(filePath) ?? null;
}

/**
 * 当前会话已计时秒数 / Seconds elapsed in the current session.
 *
 * ⚠️ 原实现返回 `accumulatedSeconds`（墙钟，含暂停），而「今日累计」返回的是
 * `activeSeconds`（纯活跃），导致计时器主体与今日累计对不上 —— 这是既有的显示
 * 不一致缺陷。本次统一使用 activeSeconds。
 *
 * The original returned `accumulatedSeconds` (wall clock, incl. pauses) while the
 * "today" figure used `activeSeconds`, so the two disagreed on screen. Unified here.
 */
export function selectCurrentSeconds(state: TimerState, filePath: string): number {
  const file = selectFileState(state, filePath);
  return file ? file.activeSeconds : 0;
}

/** 会话开始时间字符串 / The session start timestamp. */
export function selectSessionStartTime(state: TimerState, filePath: string): string {
  const file = selectFileState(state, filePath);
  return file?.sessionStartTime ?? '';
}

/**
 * 是否正在计时 / Whether the timer is actively running.
 * 追踪态 + 未全局暂停 + 未空闲。
 */
export function selectIsRunning(state: TimerState, filePath: string): boolean {
  const file = selectFileState(state, filePath);
  return (
    !!file && file.status === STATUS.TRACKING && !state.isPaused && !state.isIdle
  );
}

/** 是否处于暂停态 / Whether this file's timer is paused. */
export function selectIsPaused(state: TimerState, filePath: string): boolean {
  const file = selectFileState(state, filePath);
  return !!file && file.status === STATUS.PAUSED;
}

/** 该文件是否处于某种「进行中」状态 / Whether the file has a session in progress. */
export function selectHasActiveSession(state: TimerState, filePath: string): boolean {
  const file = selectFileState(state, filePath);
  return (
    !!file && (file.status === STATUS.TRACKING || file.status === STATUS.PAUSED)
  );
}
