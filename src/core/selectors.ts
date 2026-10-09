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
  return (
    !!file && file.status === STATUS.TRACKING && !state.isPaused && !state.isIdle
  );
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
export function selectReadingSeconds(state: TimerState, filePath: string): number {
  const file = selectFileState(state, filePath);
  return file ? file.activeSeconds + file.unfocusedSeconds : 0;
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
  const { status, startTimestamp, pausedMs, pauseStartTimestamp } = state.manual;
  if (status === MANUAL_STATUS.IDLE || startTimestamp === null) return 0;

  const ongoingPause =
    status === MANUAL_STATUS.PAUSED ? Math.max(0, nowMs - (pauseStartTimestamp ?? nowMs)) : 0;

  return Math.max(0, Math.floor((nowMs - startTimestamp - pausedMs - ongoingPause) / 1000));
}

export function selectManualIsRunning(state: TimerState): boolean {
  return state.manual.status === MANUAL_STATUS.RUNNING;
}

/** Whether the manual timer is paused. */
export function selectManualIsPaused(state: TimerState): boolean {
  return state.manual.status === MANUAL_STATUS.PAUSED;
}

export function selectManualIsIdle(state: TimerState): boolean {
  return state.manual.status === MANUAL_STATUS.IDLE;
}
