/**
 *
 * Origin: the 8 private methods inside vault HeaderWidget (3139-3239), extracted into
 * pure functions so the UI no longer reaches through `_cache`.
 *
 * Timeline-dependent selectors live in core/timeline.ts since they need the timeline.
 *
 */

import { MANUAL_STATUS, STATUS } from './constants';
import type { TimerFileState, TimerState } from './types';

/** The timer state for one file, or null. */
export function selectFileState(
  state: TimerState,
  filePath: string,
): TimerFileState | null {
  return state.files.get(filePath) ?? null;
}

/**
 * Seconds elapsed in the current session.
 *
 * The original returned `accumulatedSeconds` (wall clock, incl. pauses) while the
 * "today" figure used `activeSeconds`, so the two disagreed on screen. Unified here.
 */
export function selectCurrentSeconds(state: TimerState, filePath: string): number {
  const file = selectFileState(state, filePath);
  return file ? file.activeSeconds : 0;
}

/** The session start timestamp. */
export function selectSessionStartTime(state: TimerState, filePath: string): string {
  const file = selectFileState(state, filePath);
  return file?.sessionStartTime ?? '';
}

/**
 * Whether the timer is actively running.
 */
export function selectIsRunning(state: TimerState, filePath: string): boolean {
  const file = selectFileState(state, filePath);
  return !!file && file.status === STATUS.TRACKING
    && (!state.isIdle || !!file.splitReading && !state.isWindowFocused)
    && (state.isWindowFocused || !!file.splitReading);
}

/** 文档显示状态：失焦优先，保留原会话状态以便聚焦后继续。 */
export function selectDocumentDisplayState(
  state: TimerState,
): 'running' | 'paused' | 'idle' | 'unfocused' {
  const file = state.activeFilePath ? state.files.get(state.activeFilePath) : undefined;
  if (state.activeFilePath && !state.isWindowFocused && !file?.splitReading) return 'unfocused';
  if (file?.status === STATUS.PAUSED || (file?.status === STATUS.TRACKING && state.isIdle && state.isWindowFocused)) return 'paused';
  if (file?.status === STATUS.TRACKING) return 'running';
  return 'idle';
}

/** Whether this file's timer is paused. */
export function selectIsPaused(state: TimerState, filePath: string): boolean {
  const file = selectFileState(state, filePath);
  return !!file && file.status === STATUS.PAUSED;
}

/** Whether the file has a session in progress. */
export function selectHasActiveSession(state: TimerState, filePath: string): boolean {
  const file = selectFileState(state, filePath);
  return (
    !!file && (file.status === STATUS.TRACKING || file.status === STATUS.PAUSED)
  );
}

/**
 * Out-of-window seconds of the current session.
 * Shown beside the in-window figure in the widget and the sidebar.
 */
export function selectUnfocusedSeconds(state: TimerState, filePath: string): number {
  const file = selectFileState(state, filePath);
  return file ? file.unfocusedSeconds : 0;
}

/**
 * Reading seconds = in-window + out-of-window.
 *
 * This is what the timer body shows: blur no longer stops counting, so a session
 * includes its unfocused part. Use selectUnfocusedSeconds for the split.
 */
export function selectReadingSeconds(
  state: TimerState,
  filePath: string,
  /** Whether out-of-window seconds count toward reading; see `countsUnfocusedAsReading`. */
  countUnfocused = true,
): number {
  const file = selectFileState(state, filePath);
  if (!file) return 0;
  return file.activeSeconds + (countUnfocused ? file.unfocusedSeconds : 0);
}

//  ============================================================================
// Manual timer
//  ============================================================================

/**
 * Net seconds elapsed on the manual timer.
 *
 * Derived purely from timestamps — no ticks involved, so window throttling or a fresh
 * start cannot skew it. While paused it returns a frozen value, including the pause in
 * progress.
 *
 */
export function selectManualElapsedSeconds(state: TimerState, nowMs: number): number {
  return Math.floor(selectManualElapsedMs(state, nowMs) / 1000);
}

/**
 * 正计时的净毫秒 / the count-up's net milliseconds.
 *
 * 毫秒是这套计时天然的精度（时间戳本来就是 ms），秒只是它的投影 —— 所以这里不做任何舍入，
 * 要按秒读的地方自己 floor。
 * Milliseconds are this timer's native resolution (the timestamps already are), and a second is just
 * a projection of it — so nothing is rounded here; whoever wants seconds floors it themselves.
 */
export function selectManualElapsedMs(state: TimerState, nowMs: number): number {
  const { status, startTimestamp, pausedMs, pauseStartTimestamp } = state.manual;
  if (status === MANUAL_STATUS.IDLE || startTimestamp === null) return 0;

  const ongoingPause =
    status === MANUAL_STATUS.PAUSED ? Math.max(0, nowMs - (pauseStartTimestamp ?? nowMs)) : 0;

  return Math.max(0, nowMs - startTimestamp - pausedMs - ongoingPause);
}

export function selectManualIsRunning(state: TimerState): boolean {
  return state.manual.status === MANUAL_STATUS.RUNNING;
}

/** Whether the manual timer is paused. */
export function selectManualIsPaused(state: TimerState): boolean {
  return state.manual.status === MANUAL_STATUS.PAUSED;
}

/**
 * 正在跑的那一轮属于哪条通道 / which channel the running session is in.
 *
 * 与 reducer 的 TICK 同一套判定：失焦优先、其次空闲、最后专注。两处必须同答，否则面板上的"现在"
 * 与保存后的账本会差一段。
 * The same precedence the reducer's TICK uses: away wins, then idle, then active. The two must
 * answer alike, or "now" on the panel and the settled account will differ by one stretch.
 */
export function selectLiveSessionState(
  state: TimerState,
  file: TimerFileState,
): 'tracking' | 'pausing' | 'inactive' | 'idle' {
  if (file.status === STATUS.PAUSED) return 'pausing';
  if (!state.isWindowFocused && file.splitReading !== true) return 'inactive';
  if (state.isIdle) return 'idle';
  return 'tracking';
}

export function selectManualIsIdle(state: TimerState): boolean {
  return state.manual.status === MANUAL_STATUS.IDLE;
}

//  ============================================================================
// Countdown timer
//  ============================================================================

/**
 * Net seconds elapsed on the countdown / 倒计时已过的净秒数.
 *
 * 与正计时同一条公式（暂停不计），位置由 `locatePhase` 在已过秒数上推导 —— 段边界不是另一份
 * 状态，因此不会和计时器走散。
 * The same formula as the count-up (pauses excluded); the position is derived from those seconds by
 * `locatePhase`, so a phase boundary is not second state that can drift out of step.
 */
export function selectCountdownElapsedSeconds(state: TimerState, nowMs: number): number {
  return Math.floor(selectCountdownElapsedMs(state, nowMs) / 1000);
}

/** 倒计时的净毫秒，与正计时同一精度 / the countdown's net milliseconds, same resolution. */
export function selectCountdownElapsedMs(state: TimerState, nowMs: number): number {
  const { status, startTimestamp, pausedMs, pauseStartTimestamp } = state.countdown;
  if (status === MANUAL_STATUS.IDLE || startTimestamp === null) return 0;

  const ongoingPause =
    status === MANUAL_STATUS.PAUSED ? Math.max(0, nowMs - (pauseStartTimestamp ?? nowMs)) : 0;

  return Math.max(0, nowMs - startTimestamp - pausedMs - ongoingPause);
}

export function selectCountdownIsIdle(state: TimerState): boolean {
  return state.countdown.status === MANUAL_STATUS.IDLE;
}
