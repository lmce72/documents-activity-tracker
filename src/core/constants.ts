/**
 * Core constants
 *
 * Origin: vault main.js lines 133-158 and 4952-4966, plus new constants introduced here.
 *
 * L0 leaf module.
 */

/**
 * File status enum.
 * Identical to the original; values must not change as they are persisted.
 */
export const STATUS = {
  IDLE: 'idle',
  TRACKING: 'tracking',
  PAUSED: 'paused',
  SAVED: 'saved',
  DISCARDED: 'discarded',
} as const;

export type FileStatus = (typeof STATUS)[keyof typeof STATUS];

/**
 * Action types.
 *
 * Removed 4 declared-but-never-implemented constants (all had zero references) and
 * renamed CLEAR_PENDING_WRITES to CONSUME_PENDING_WRITES.
 */
export const ActionTypes = {
  TICK: 'TICK',
  TOGGLE_PAUSE: 'TOGGLE_PAUSE',
  SWITCH_FILE: 'SWITCH_FILE',
  SAVE_SESSION: 'SAVE_SESSION',
  DISCARD_SESSION: 'DISCARD_SESSION',
  USER_ACTIVITY: 'USER_ACTIVITY',
  SET_IDLE: 'SET_IDLE',
  CLEAR_IDLE: 'CLEAR_IDLE',
  DAY_ROLLOVER: 'DAY_ROLLOVER',
  RESTORE_FILE: 'RESTORE_FILE',
  CONSUME_PENDING_WRITES: 'CONSUME_PENDING_WRITES',
  REQUEUE_PENDING_WRITES: 'REQUEUE_PENDING_WRITES',

  SET_WINDOW_FOCUS: 'SET_WINDOW_FOCUS',
  /**
   *
   * The original had no action for "nothing trackable is open": one version forced
   * activeFilePath to null, the other did nothing and left the timer bound to a closed file.
   */
  UNBIND_FILE: 'UNBIND_FILE',

  MANUAL_START: 'MANUAL_START',
  MANUAL_PAUSE: 'MANUAL_PAUSE',
  MANUAL_RESUME: 'MANUAL_RESUME',
  MANUAL_STOP: 'MANUAL_STOP',
  /** place a mark during manual timing */
  MANUAL_FLAG: 'MANUAL_FLAG',
} as const;

export type ActionType = (typeof ActionTypes)[keyof typeof ActionTypes];

/**
 * Current data format version.
 * Only touched on the migration path — never written back on ordinary saves.
 */
export const DATA_VERSION = 3;

/** Key for the crash-recovery snapshot. */
export const LS_SNAPSHOT_KEY = 'rtt_timer_state';

/**
 * Gaps larger than this indicate a sleep; the tick is dropped to avoid bogus accumulation.
 */
export const TICK_GAP_LIMIT_MS = 5000;

/**
 * Maximum tick gap for the unfocused channel — deliberately different from the focused one.
 *
 * Chromium throttles timers in hidden windows down to once per minute after five
 * minutes. Reusing the 5s guard would discard nearly every unfocused tick and record
 * nothing. 90s sits above the throttle interval (60s) and far below a real sleep jump,
 * so sparse ticks settle correctly while sleep jumps are still dropped.
 *
 * Note: the unfocused channel accumulates the *actual* gap, not 1s per tick, because a
 * throttled tick represents a whole minute.
 */
export const UNFOCUSED_GAP_LIMIT_MS = 90_000;

/**
 *
 * Only used when deriving unfocused time from the event stream. Live accumulation is
 * already guarded by UNFOCUSED_GAP_LIMIT_MS; the derived path has no tick evidence, so
 * a stretch beyond 4h is treated as absence (overnight, idle machine) and not counted.
 */
export const UNFOCUSED_ATTRIBUTION_CAP_SECONDS = 4 * 60 * 60;

/**
 * Manual timer status.
 * Unrelated to the document-tracking `STATUS`: the manual timer binds to no file.
 */
export const MANUAL_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
} as const;

export type ManualStatus = (typeof MANUAL_STATUS)[keyof typeof MANUAL_STATUS];

/**
 * Event types persisted into the timeline.
 *
 *   ['start','pause','resume','save','auto-save','discard']
 *
 * The most important fix in this refactor: the original whitelist silently dropped
 * 41 real events (blur 19 + focus 14 + switch 8). Completed to nine types so the
 * migration becomes non-destructive.
 */
export const TIMELINE_PERSISTED_TYPES = [
  'start',
  'pause',
  'resume',
  'save',
  'auto-save',
  'discard',
  'blur',
  'focus',
  'switch',
] as const;
