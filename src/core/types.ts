/**
 * Core type definitions
 *
 * Origin: previously implicit/JSDoc shapes scattered across vault main.js,
 * now consolidated into explicit types.
 *
 * L0 module; depends only on constants.
 */

import type { FileStatus, ActionType, ManualStatus } from './constants';

//  ============================================================================
// Settings
//  ============================================================================

/**
 * Plugin settings.
 *
 * The first 13 fields are identical to the original (including 3 write-only legacy
 * fields); the last 2 are the new feature toggles. Defaults live in defaults.ts.
 */
export interface PluginSettings {
  /** 'blacklist' | 'whitelist' */
  filterMode: string;
  /** comma or newline separated */
  filterPatterns: string;
  idleTimeoutEnabled: boolean;
  idleTimeout: number;
  /** min session seconds */
  minReadSeconds: number;
  /** 'compact' | 'precise' */
  timeDisplayMode: string;
  /** 'always' | 'start-only' | 'return-only' | 'manual' */
  autoStartMode: string;
  useIconize: boolean;
  dataFilePath: string;
  /** 'idle' | 'always' | 'never' */
  todayTotalDisplay: string;
  /** legacy, intentionally untouched */
  autoSaveEnabled: boolean;
  /** legacy, intentionally untouched */
  autoSaveInterval: number;
  /** legacy, intentionally untouched */
  trackingMode: string;

  //  --------------------------------------------------------------------------
  // New in this refactor
  //  --------------------------------------------------------------------------

  /**
   * Document tracking toggle: no timer service, no in-note widget, no document
   * section in the sidebar. Manual timing is unaffected.
   */
  documentTrackingEnabled: boolean;

  /**
   * Manual-timer toggle: hides its UI, ribbon icon and service; document tracking
   * is unaffected.
   */
  manualTimerEnabled: boolean;

  /**
   * Whether the manual stopwatch shows seconds. On by default; when off it reads to the
   * minute only, for long focus sessions where a ticking second is a distraction.
   */
  manualShowSeconds: boolean;

  /**
   *
   * Whether document activity is still recorded while manual timing runs. On by default.
   * When off, the heartbeat and file switches stop producing events, so nothing lands in
   * any document's reading record — the two are separate ledgers and the user may want
   * only the manual one. The document panel reads 0s meanwhile, because nothing is being
   * recorded.
   */
  manualRecordDocActivity: boolean;
}

//  ============================================================================
// Sessions & records
//  ============================================================================

/**
 * State values stored in a sessionObject.
 *
 * `inactive` is new: written while the window is unfocused. It keeps blur stretches out
 * of the active total, since `calculateSessionDuration` only counts `tracking` — which
 * fixes the original's bug of counting blur stretches as active time.
 */
export type SessionState = 'tracking' | 'pausing' | 'saved' | 'inactive';

/**
 * Session timeline object.
 */
export type SessionStateMap = Record<string, SessionState>;

/** A paused range as [startMs, endMs]. */
export type PausedRange = [number | null, number];

/** Per-file timer state. */
export interface TimerFileState {
  filePath: string;
  status: FileStatus;
  sessionStartTime: string | null;

  /**
   * single source of truth: pure active seconds.
   * The original kept an additional `accumulatedSeconds` (wall clock, incl. pauses);
   * the two were not identical. Merged here into active + paused, with wall clock derived.
   */
  activeSeconds: number;

  /**
   * single source of truth: accumulated paused seconds.
   * Reproduces the original rounding: floor(pauseDuration / 1000) added once on resume.
   */
  pausedSeconds: number;

  /**
   *
   * Behaviour change: the old implementation stopped counting on window blur and lost
   * that time entirely. Blur now keeps counting, banked here rather than in
   * `activeSeconds`, so in-window and out-of-window time stay separable.
   */
  unfocusedSeconds: number;

  lastTickTimestamp: number | null;
  pauseStartTimestamp: number | null;
  sessionObject: SessionStateMap | null;
  pausedRanges: PausedRange[];
}

/**
 * Derive reading seconds.
 * In-window plus out-of-window: both are real reading time, so both count.
 */
export function readingSeconds(file: TimerFileState): number {
  return file.activeSeconds + file.unfocusedSeconds;
}

/**
 * Derive wall-clock seconds.
 *
 * Extended by this refactor: unfocused time is part of the session's wall clock, so
 * wall = in-window + unfocused + paused. It differs from the original
 * `accumulatedSeconds` only by the unfocused part, which the original never recorded —
 * for pre-existing data `unfocusedSeconds` is 0 and the value is unchanged.
 */
export function wallClockSeconds(file: TimerFileState): number {
  return file.activeSeconds + file.unfocusedSeconds + file.pausedSeconds;
}

//  ============================================================================
// Manual timer
//  ============================================================================

/**
 * Manual-timer state.
 *
 * Independent of document tracking: bound to no file, not part of `activeFilePath`, and
 * unaffected by the document filter rules. It only answers "since when have I been
 * focusing on something, and for how long".
 */
export interface ManualTimerState {
  status: ManualStatus;
  /** start timestamp in ms, null when idle */
  startTimestamp: number | null;
  /** local full timestamp string for persistence */
  startedAt: string;
  /**
   * accumulated paused milliseconds.
   * Milliseconds rather than seconds so repeated short pauses do not lose precision.
   */
  pausedMs: number;
  /** start of the current pause, null when not paused */
  pauseStartTimestamp: number | null;
  /**
   * marks placed during this run.
   * Saved with the session on stop; `MANUAL_START` clears it, so each run starts empty.
   */
  flags: ManualFlag[];
}

/**
 * One mark placed during manual timing.
 *
 * A mark records the net seconds (pauses excluded) since the run began, at the instant it
 * was placed — not a wall-clock time. The session is measured in net seconds, and a
 * wall-clock mark would drift out of step with it.
 */
export interface ManualFlag {
  /** net seconds since the run began */
  atSeconds: number;
  /** when it was placed, local full timestamp */
  atTime: string;
  /** optional label, may be empty */
  label: string;
}

/**
 * A completed manual session.
 * The unit of persistence; `note` is what the user fills in after stopping.
 */
export interface ManualSession {
  id: string;

  startTime: string;
  endTime: string;

  durationSeconds: number;
  /** what the user wrote, may be empty */
  note: string;

  flags: ManualFlag[];
}

//  ============================================================================
// Pending writes
//  ============================================================================

/** A new session started. */
export interface TimelineStartWrite {
  type: 'timeline-start';
  filePath: string;
  time: string;
  state: string;
}

/** A session was discarded. */
export interface TimelineDiscardWrite {
  type: 'timeline-discard';
  filePath: string;
  time: string;
}

/** A session was saved. */
export interface SessionWrite {
  type: 'session';
  filePath: string;
  session: SessionStateMap;
  /**
   * which event type to write on flush.
   *
   * `save` is an explicit user save; `auto-save` is an automatic close (tab switch or
   * close, day rollover, startup recovery). Real data contains both (5 save / 23
   * auto-save), and the heatmap renders them differently, so the caller states it rather
   * than leaving the service to guess.
   */
  eventType: 'save' | 'auto-save';
  /** in-window seconds, added to records */
  activeSeconds: number;
  /** out-of-window seconds, accumulated separately */
  unfocusedSeconds: number;
  /** wall clock, written as event.duration */
  totalSeconds: number;
}

export type PendingWrite = TimelineStartWrite | TimelineDiscardWrite | SessionWrite;

//  ============================================================================
// Global timer state
//  ============================================================================

/**
 * The single state tree managed by the reducer.
 *
 * Document tracking and the manual timer share this tree but are data-independent: no
 * field references the other, and the manual timer never touches activeFilePath. One
 * tree means one persistence and subscription path; the service layer stays split.
 */
export interface TimerState {
  activeFilePath: string | null;
  files: Map<string, TimerFileState>;
  isPaused: boolean;
  isIdle: boolean;
  /**
   * whether the Obsidian window is focused.
   * Counting does not stop on blur — it flows into `unfocusedSeconds`. Starts focused.
   */
  isWindowFocused: boolean;
  /** manual-timer state, unrelated to files */
  manual: ManualTimerState;
  lastActivityTime: number;
  lastTickTime: number | null;
  /** used for day-rollover detection */
  lastCheckDay: string;
  pendingWrites: PendingWrite[];
}

//  ============================================================================
//  Action
//  ============================================================================

/**
 *
 * Note: the original carried `currentTime` in TICK / TOGGLE_PAUSE payloads while also
 * calling Date.now() directly inside the reducer, which made deterministic replay
 * impossible. Time now comes solely from the injected clock; payloads no longer carry
 * it. Internal contract change only — the observable behaviour is unchanged.
 */
export interface TogglePausePayload {
  filePath: string;
}
export interface TickPayload {
  filePath: string;
}

/**
 * Discriminated union of every action.
 *
 * PAUSE_SESSION /
 *
 * Versus the original: dropped 4 declared-but-unimplemented constants; renamed
 * CLEAR_PENDING_WRITES to CONSUME_PENDING_WRITES (consume N from the head, which is
 * what removes the concurrent double-write); added REQUEUE_PENDING_WRITES so a failed
 * flush no longer silently drops events.
 */
export type TimerAction =
  | { type: Extract<ActionType, 'TICK'>; payload: TickPayload }
  | { type: Extract<ActionType, 'TOGGLE_PAUSE'>; payload: TogglePausePayload }
  | {
      type: Extract<ActionType, 'SWITCH_FILE'>;
      payload: { fromPath: string | null; toPath: string; autoStart: boolean };
    }
  | {
      type: Extract<ActionType, 'SAVE_SESSION'>;
      payload: {
        filePath: string;
        minReadSeconds: number;

        eventType?: 'save' | 'auto-save';
      };
    }
  | { type: Extract<ActionType, 'DISCARD_SESSION'>; payload: { filePath: string } }
  | { type: Extract<ActionType, 'USER_ACTIVITY'> }
  | { type: Extract<ActionType, 'SET_IDLE'> }
  | { type: Extract<ActionType, 'CLEAR_IDLE'> }
  | {
      type: Extract<ActionType, 'DAY_ROLLOVER'>;
      payload: { filePath: string | null };
    }
  | {
      type: Extract<ActionType, 'RESTORE_FILE'>;
      payload: { filePath: string; fileState: TimerFileState };
    }
  | {
      type: Extract<ActionType, 'CONSUME_PENDING_WRITES'>;
      payload: { count: number };
    }
  | {
      type: Extract<ActionType, 'REQUEUE_PENDING_WRITES'>;
      payload: { writes: PendingWrite[] };
    }
  //  --------------------------------------------------------------------------
  // New in this refactor
  //  --------------------------------------------------------------------------
  | {
      type: Extract<ActionType, 'SET_WINDOW_FOCUS'>;
      payload: { focused: boolean };
    }
  | { type: Extract<ActionType, 'UNBIND_FILE'> }
  | { type: Extract<ActionType, 'MANUAL_START'> }
  | { type: Extract<ActionType, 'MANUAL_PAUSE'> }
  | { type: Extract<ActionType, 'MANUAL_RESUME'> }
  | { type: Extract<ActionType, 'MANUAL_STOP'> }
  | {
      type: Extract<ActionType, 'MANUAL_FLAG'>;
      payload: { atSeconds: number; atTime: string; label: string };
    };

//  ============================================================================
// Persisted data shapes
//  ============================================================================

/** A per-file record entry. */
export interface RecordEntry {
  fileName: string;
  /** total reading time = in-window + out-of-window */
  totalReadTime: number;
  lastReadAt: string;
  /**
   * Optional: records written before this refactor lack it; read as 0.
   */
  unfocusedReadTime?: number;
}

/** Timeline event types. */
export type TimelineEventType =
  | 'start'
  | 'pause'
  | 'resume'
  | 'save'
  | 'auto-save'
  | 'discard'
  | 'blur'
  | 'focus'
  | 'switch';

/**
 * Events that hang off a single file.
 * Field combinations taken from the measured real data.
 */
export interface FileTimelineEvent {
  time: string;
  type: 'start' | 'pause' | 'resume' | 'save' | 'auto-save' | 'blur' | 'focus';
  file: string;
  state?: string;
  /** cause for blur/focus events */
  reason?: string;
  /** wall-clock seconds on save events */
  duration?: number;
  /** in-window seconds on save events */
  activeSeconds?: number;

  unfocusedSeconds?: number;
}

/** A discarded session (no `state` field in real data). */
export interface DiscardTimelineEvent {
  time: string;
  type: 'discard';
  file: string;
  state?: string;
}

/** A file switch, keyed by from/to rather than file. */
export interface SwitchTimelineEvent {
  time: string;
  type: 'switch';
  from: string;
  to: string;
  fromState?: string;
  toState?: string;
}

export type TimelineEvent =
  | FileTimelineEvent
  | DiscardTimelineEvent
  | SwitchTimelineEvent;

/**
 * Derived per-file view model.
 *
 * Computed from the timeline on demand; never persisted (records holds only 3 fields).
 */
export interface FileRecord {
  fileName: string;
  /** total reading time = in-window + out-of-window */
  totalReadTime: number;
  /** out-of-window part, shown separately */
  unfocusedReadTime: number;
  readTimeToday: number;
  lastReadAt: string;

  readTimeLine: SessionStateMap[];

  hasAbnormalSession: boolean;
}

/** The whole on-disk data file. */
export interface HistoryCache {
  version?: number;
  records: Record<string, RecordEntry>;
  timeline: TimelineEvent[];
  settings?: Partial<PluginSettings>;
}

/** replaces the original Notice side effect. */
export interface MigrationReport {
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
  recordsBefore: number;
  recordsAfter: number;
  timelineBefore: number;
  timelineAfter: number;
  /** events dropped for lacking a usable `time` */
  droppedMalformed: number;

  unknownEventTypes: string[];
}
