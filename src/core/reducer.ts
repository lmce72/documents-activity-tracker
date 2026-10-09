/**
 * The timer state machine
 *
 * Origin: vault main.js lines 166-449. The Redux architecture is kept; four changes:
 *
 *      Time and logging are injected, making the reducer deterministically testable.
 *
 *      The duplicated second-counters are merged into active + paused, with wall clock derived.
 *
 *      DAY_ROLLOVER was declared but never implemented; now implemented.
 *
 *      The pending-write queue now supports count-based consumption plus requeue-on-failure.
 *
 * Note: every timestamp is second-precision (`nowFull`), taken once at session start and
 * shared by the state and the event log. Minute precision would inflate derived durations
 * by up to 59s per session.
 *
 * L0 module: depends only on constants, types and time; no window/document/localStorage.
 */

import {
  ActionTypes,
  MANUAL_STATUS,
  STATUS,
  TICK_GAP_LIMIT_MS,
  UNFOCUSED_GAP_LIMIT_MS,
} from './constants';
import { nowFullStr, todayStr } from './time';
import {
  readingSeconds,
  wallClockSeconds,
  type ManualTimerState,
  type SessionStateMap,
  type TimerAction,
  type TimerFileState,
  type TimerState,
} from './types';

/**
 * Every ambient capability the reducer needs.
 */
export interface ReducerDeps {
  /** milliseconds since epoch */
  now(): number;
  /** "YYYY-MM-DD HH:mm:ss" */
  nowFull(): string;
  /** "YYYY-MM-DD" */
  today(): string;
  log: {
    warn(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
  };
}

/** Default deps backed by the system clock. */
export const systemDeps: ReducerDeps = {
  now: () => Date.now(),
  nowFull: nowFullStr,
  today: todayStr,
  log: {
    warn: (message, ...args) => console.warn(message, ...args),
    info: (message, ...args) => console.log(message, ...args),
  },
};

/**
 * Milliseconds of gap to whole seconds.
 *
 * A non-zero gap banks at least 1s (a throttled tick may be a few hundred ms short and
 * would round to zero), but a zero gap must bank nothing — otherwise every channel
 * switch would invent a second.
 */
function gapToSeconds(gapMs: number): number {
  if (gapMs <= 0) return 0;
  return Math.max(1, Math.round(gapMs / 1000));
}

/**
 * Reset the active file's tick baseline.
 *
 * Used when counting resumes after idle. Without it, the first tick afterwards would
 * bank the whole idle stretch as a gap; the gap-integrating unfocused channel is
 * especially prone to this, silently turning idle time into reading time.
 */
function refreshTickBaseline(state: TimerState, now: number): TimerState {
  const path = state.activeFilePath;
  if (!path) return state;

  const file = state.files.get(path);
  if (!file || file.status !== STATUS.TRACKING || file.lastTickTimestamp === null) {
    return state;
  }

  const newFiles = new Map(state.files);
  newFiles.set(path, { ...file, lastTickTimestamp: now });
  return { ...state, files: newFiles };
}

/** An idle manual-timer state. */
export function createIdleManualState(): ManualTimerState {
  return {
    status: MANUAL_STATUS.IDLE,
    startTimestamp: null,
    startedAt: '',
    pausedMs: 0,
    pauseStartTimestamp: null,
    flags: [],
  };
}

/** Build a fresh initial state. */
export function createInitialState(deps: ReducerDeps): TimerState {
  return {
    activeFilePath: null,
    files: new Map(),
    isPaused: false,
    isIdle: false,

    //  The window is necessarily focused at load time — the plugin loads inside it
    isWindowFocused: true,
    manual: createIdleManualState(),
    lastActivityTime: deps.now(),
    lastTickTime: null,
    lastCheckDay: deps.today(),
    pendingWrites: [],
  };
}

/** Reset one file's session counters. */
function clearedFile(file: TimerFileState): TimerFileState {
  return {
    ...file,
    status: STATUS.IDLE,
    sessionObject: null,
    activeSeconds: 0,
    unfocusedSeconds: 0,
    pausedSeconds: 0,
    pausedRanges: [],
    pauseStartTimestamp: null,
    lastTickTimestamp: null,
  };
}

/**
 * Create the reducer.
 *
 * Returns a closure so `deps` is captured while the reducer itself stays pure.
 */
export function createTimerReducer(deps: ReducerDeps) {
  return function timerReducer(state: TimerState, action: TimerAction): TimerState {
    switch (action.type) {
      //  ----------------------------------------------------------------------
      // The one-second tick
      //

      //
      //    focused   -> activeSeconds,   1s per tick, 5s guard (unchanged)
      //    unfocused -> unfocusedSeconds, actual gap, 90s guard (throttling-aware)
      //  ----------------------------------------------------------------------
      case ActionTypes.TICK: {
        const { filePath } = action.payload;
        const file = state.files.get(filePath);

        if (!file || file.status !== STATUS.TRACKING) return state;
        if (state.isPaused || state.isIdle) return state;

        const currentTime = deps.now();
        const lastTick = file.lastTickTimestamp;
        const gap = lastTick === null ? 0 : currentTime - lastTick;
        const focused = state.isWindowFocused;
        const limit = focused ? TICK_GAP_LIMIT_MS : UNFOCUSED_GAP_LIMIT_MS;

        //  Gap check: a gap beyond the limit means the machine slept; drop this tick.
        if (lastTick !== null && gap > limit) {
          deps.log.warn(
            focused
              ? '[TimerReducer] Tick 间隔过长，丢弃 / tick gap too large, dropped:'
              : '[TimerReducer] 失焦 Tick 间隔过长（疑似休眠），丢弃 / unfocused tick gap too large, dropped:',
            gap / 1000,
            '秒 / s',
          );
          const newFiles = new Map(state.files);
          newFiles.set(filePath, { ...file, lastTickTimestamp: currentTime });
          return { ...state, files: newFiles };
        }

        const newFiles = new Map(state.files);
        const timeStr = deps.nowFull();

        //  The unfocused channel settles the actual gap: a throttled tick stands for a
        //  whole minute, so 1s/tick would under-count badly. The first tick has no gap to
        //  measure and starts at 1s, mirroring the focused channel.
        const gained = focused ? 1 : lastTick === null ? 1 : gapToSeconds(gap);

        const nextFile: TimerFileState = focused
          ? { ...file, activeSeconds: file.activeSeconds + gained }
          : { ...file, unfocusedSeconds: file.unfocusedSeconds + gained };

        newFiles.set(filePath, {
          ...nextFile,
          lastTickTimestamp: currentTime,

          //  Blur writes 'inactive' rather than 'tracking' so derived durations (which
          //  count only `tracking`) and the heatmap's three-way stats cannot mistake
          //  unfocused time for active time.
          sessionObject: {
            ...(file.sessionObject ?? {}),
            [timeStr]: focused ? 'tracking' : 'inactive',
          },
        });

        return { ...state, files: newFiles, lastTickTime: currentTime };
      }

      //  ----------------------------------------------------------------------
      // window focus change
      //

      //
      //  Settles the elapsed time into the channel being left before switching, so the
      //  minute represented by a throttled tick is not lost at the transition.
      //  ----------------------------------------------------------------------
      case ActionTypes.SET_WINDOW_FOCUS: {
        const { focused } = action.payload;
        if (state.isWindowFocused === focused) return state;

        const leavingFocused = state.isWindowFocused;
        const currentTime = deps.now();
        const activePath = state.activeFilePath;
        const file = activePath ? state.files.get(activePath) : undefined;

        //  Only a running, unpaused, non-idle session has a gap worth settling
        const shouldSettle =
          !!file && file.status === STATUS.TRACKING && !state.isPaused && !state.isIdle;

        if (!shouldSettle || !file || file.lastTickTimestamp === null) {
          return { ...state, isWindowFocused: focused };
        }

        const gap = currentTime - file.lastTickTimestamp;
        const limit = leavingFocused ? TICK_GAP_LIMIT_MS : UNFOCUSED_GAP_LIMIT_MS;
        const newFiles = new Map(state.files);

        if (gap > limit) {

          //  A gap beyond the limit means sleep: reset the baseline, settle nothing
          newFiles.set(activePath!, { ...file, lastTickTimestamp: currentTime });
        } else if (leavingFocused) {

          //  The focused channel ticks reliably at 1Hz, so rounding is enough
          newFiles.set(activePath!, {
            ...file,
            activeSeconds: file.activeSeconds + Math.round(gap / 1000),
            lastTickTimestamp: currentTime,
          });
        } else {

          //  The unfocused channel banks the whole throttled stretch
          newFiles.set(activePath!, {
            ...file,
            unfocusedSeconds: file.unfocusedSeconds + gapToSeconds(gap),
            lastTickTimestamp: currentTime,
          });
        }

        return { ...state, files: newFiles, isWindowFocused: focused };
      }

      //  ----------------------------------------------------------------------
      // unbind the active file
      //

      //
      //  Semantics: nothing trackable is open any more. Status goes IDLE and
      //  activeFilePath is cleared; whether the session becomes a record is the caller's
      //  call, since only it knows whether to write save or auto-save.
      //  ----------------------------------------------------------------------
      case ActionTypes.UNBIND_FILE: {
        const fromPath = state.activeFilePath;
        if (fromPath === null) return state;

        const file = state.files.get(fromPath);
        if (!file || file.status === STATUS.IDLE) {
          return { ...state, activeFilePath: null };
        }

        const newFiles = new Map(state.files);
        newFiles.set(fromPath, { ...file, status: STATUS.IDLE });
        return { ...state, activeFilePath: null, files: newFiles };
      }

      //  ----------------------------------------------------------------------
      // manual timer
      //

      //
      //  Independent of document tracking: touches only the `manual` sub-state. Elapsed
      //  time is derived from startTimestamp + pausedMs rather than counted per tick, so
      //  window throttling cannot skew it.
      //  ----------------------------------------------------------------------
      case ActionTypes.MANUAL_START: {
        if (state.manual.status !== MANUAL_STATUS.IDLE) return state;
        return {
          ...state,
          manual: {
            status: MANUAL_STATUS.RUNNING,
            startTimestamp: deps.now(),
            startedAt: deps.nowFull(),
            pausedMs: 0,
            pauseStartTimestamp: null,

            //  Each run starts empty: the previous run's marks must not carry over
            flags: [],
          },
        };
      }

      case ActionTypes.MANUAL_PAUSE: {
        if (state.manual.status !== MANUAL_STATUS.RUNNING) return state;
        return {
          ...state,
          manual: {
            ...state.manual,
            status: MANUAL_STATUS.PAUSED,
            pauseStartTimestamp: deps.now(),
          },
        };
      }

      case ActionTypes.MANUAL_RESUME: {
        if (state.manual.status !== MANUAL_STATUS.PAUSED) return state;
        const currentTime = deps.now();
        const pauseDuration = currentTime - (state.manual.pauseStartTimestamp ?? currentTime);
        return {
          ...state,
          manual: {
            ...state.manual,
            status: MANUAL_STATUS.RUNNING,
            pausedMs: state.manual.pausedMs + Math.max(0, pauseDuration),
            pauseStartTimestamp: null,
          },
        };
      }

      case ActionTypes.MANUAL_STOP: {
        if (state.manual.status === MANUAL_STATUS.IDLE) return state;

        //  Only resets the sub-state: the caller reads the net duration via
        //  selectManualElapsedSeconds before dispatching, since persisting waits for the
        //  user to fill in the note.
        return { ...state, manual: createIdleManualState() };
      }

      case ActionTypes.MANUAL_FLAG: {

        //  Only a run in progress can carry a mark; an idle state has nothing to attach to
        if (state.manual.status === MANUAL_STATUS.IDLE) return state;
        const { atSeconds, atTime, label } = action.payload;
        return {
          ...state,
          manual: {
            ...state.manual,
            flags: [
              ...state.manual.flags,
              { atSeconds: Math.max(0, Math.round(atSeconds)), atTime, label },
            ],
          },
        };
      }

      //  ----------------------------------------------------------------------

      //  ----------------------------------------------------------------------
      case ActionTypes.TOGGLE_PAUSE: {
        const { filePath } = action.payload;
        const file = state.files.get(filePath);
        if (!file) return state;

        const currentTime = deps.now();
        const newFiles = new Map(state.files);
        const timeStr = deps.nowFull();

        if (file.status === STATUS.TRACKING) {

          newFiles.set(filePath, {
            ...file,
            status: STATUS.PAUSED,
            pauseStartTimestamp: currentTime,
            sessionObject: { ...(file.sessionObject ?? {}), [timeStr]: 'pausing' },
          });
          return { ...state, files: newFiles, isPaused: true };
        }

        if (file.status === STATUS.PAUSED) {

          //  Resume: bank the pause, rounded down to whole seconds. The original added it
          //  to accumulatedSeconds; since wall = active + paused, wallClockSeconds() matches.
          const pauseDuration = currentTime - (file.pauseStartTimestamp ?? currentTime);
          newFiles.set(filePath, {
            ...file,
            status: STATUS.TRACKING,
            pausedSeconds: file.pausedSeconds + Math.floor(pauseDuration / 1000),
            pauseStartTimestamp: null,
            pausedRanges: [...file.pausedRanges, [file.pauseStartTimestamp, currentTime]],
            sessionObject: { ...(file.sessionObject ?? {}), [timeStr]: 'tracking' },
            lastTickTimestamp: currentTime,
          });
          return { ...state, files: newFiles, isPaused: false };
        }

        return state;
      }

      //  ----------------------------------------------------------------------

      //  ----------------------------------------------------------------------
      case ActionTypes.SWITCH_FILE: {
        const { fromPath, toPath, autoStart } = action.payload;
        const newFiles = new Map(state.files);
        const newPendingWrites = [...state.pendingWrites];

        //  The old file goes IDLE; settlement is the caller's job via saveSession first.
        //

        //  `fromPath !== toPath` is load-bearing: switching to the file already being tracked
        //  would otherwise flip it to IDLE first, and the IDLE→TRACKING branch right below
        //  would then treat it as a brand-new session and reset its counters.
        if (fromPath && fromPath !== toPath) {
          const oldFile = newFiles.get(fromPath);
          if (oldFile && oldFile.status === STATUS.TRACKING) {
            newFiles.set(fromPath, { ...oldFile, status: STATUS.IDLE });
          }
        }

        //

        //
        //  The session start is fixed once, here: the state's sessionStartTime and the start
        //  event in the log must be the same instant, to the second. The original wrote
        //  sessionStartTime at minute precision while every other event carried seconds, so
        //  gap-based attribution started from :00 and invented up to 59s per session
        //  (measured: a 4s session derived as 62s, shown as "1 minute").
        const startTimeStr = deps.nowFull();

        let newFile = newFiles.get(toPath);
        let needWriteStart = !newFile && autoStart;

        if (!newFile) {
          newFile = {
            filePath: toPath,
            status: autoStart ? STATUS.TRACKING : STATUS.IDLE,
            sessionStartTime: startTimeStr,
            activeSeconds: 0,
            unfocusedSeconds: 0,
            pausedSeconds: 0,
            lastTickTimestamp: autoStart ? deps.now() : null,
            pauseStartTimestamp: null,
            sessionObject: autoStart
              ? {
                  [deps.nowFull()]: state.isWindowFocused ? 'tracking' : 'inactive',
                }
              : null,
            pausedRanges: [],
          };
        } else if (autoStart && newFile.status === STATUS.IDLE) {

          //
          //  IDLE -> TRACKING begins a new session and must emit a start event. The original
          //  wrote none here (to suppress duplicated starts), which left sessions with no
          //  start in the stream — and since buildFileRecords splits sessions on `start`,
          //  every event of such a session was dropped from the derived view.
          needWriteStart = true;
          newFile = {
            ...newFile,
            status: STATUS.TRACKING,
            sessionStartTime: startTimeStr,
            lastTickTimestamp: deps.now(),
            sessionObject: {
              [deps.nowFull()]: state.isWindowFocused ? 'tracking' : 'inactive',
            },
          };
        }

        newFiles.set(toPath, newFile);

        if (needWriteStart) {
          newPendingWrites.push({
            type: 'timeline-start',
            filePath: toPath,
            time: startTimeStr,
            state: 'tracking',
          });
        }

        return {
          ...state,
          activeFilePath: toPath,
          files: newFiles,
          pendingWrites: newPendingWrites,
        };
      }

      //  ----------------------------------------------------------------------

      //  ----------------------------------------------------------------------
      case ActionTypes.SAVE_SESSION: {
        const { filePath, minReadSeconds, eventType } = action.payload;
        const file = state.files.get(filePath);
        if (!file) return state;

        const newFiles = new Map(state.files);

        //  Threshold uses readingSeconds (in-window + out-of-window): unfocused time is
        //  reading time too.
        const reading = readingSeconds(file);
        if (reading < minReadSeconds) {
          deps.log.info(
            '[TimerReducer] 会话时长不足，丢弃 / session below threshold, dropped:',
            reading,
          );
          newFiles.set(filePath, clearedFile(file));
          return { ...state, files: newFiles };
        }

        const timeStr = deps.nowFull();
        const savedSession: SessionStateMap = {
          ...(file.sessionObject ?? {}),
          [timeStr]: 'saved',
        };

        newFiles.set(filePath, clearedFile(file));

        return {
          ...state,
          files: newFiles,
          pendingWrites: [
            ...state.pendingWrites,
            {
              type: 'session',
              filePath,
              session: savedSession,

              eventType: eventType ?? 'save',
              activeSeconds: file.activeSeconds,
              unfocusedSeconds: file.unfocusedSeconds,

              totalSeconds: wallClockSeconds(file),
            },
          ],
        };
      }

      //  ----------------------------------------------------------------------

      //  ----------------------------------------------------------------------
      case ActionTypes.DISCARD_SESSION: {
        const { filePath } = action.payload;
        const file = state.files.get(filePath);
        if (!file) return state;

        const newFiles = new Map(state.files);
        newFiles.set(filePath, clearedFile(file));

        return {
          ...state,
          files: newFiles,
          pendingWrites: [
            ...state.pendingWrites,
            { type: 'timeline-discard', filePath, time: deps.nowFull() },
          ],
        };
      }

      //  ----------------------------------------------------------------------

      //  ----------------------------------------------------------------------
      case ActionTypes.DAY_ROLLOVER: {
        const today = deps.today();
        if (state.lastCheckDay === today) return state;

        const newFiles = new Map(state.files);
        const newPendingWrites = [...state.pendingWrites];
        let changed = false;

        for (const [filePath, file] of state.files) {
          // only sessions still in progress
          if (!file.sessionObject || !file.sessionStartTime) continue;
          if (file.sessionStartTime.slice(0, 10) === today) continue;

          // close yesterday's session
          const closedSession: SessionStateMap = {
            ...file.sessionObject,
            [deps.nowFull()]: 'saved',
          };
          newPendingWrites.push({
            type: 'session',
            filePath,
            session: closedSession,

            //  Day rollover is automatic, so it writes auto-save
            eventType: 'auto-save',
            activeSeconds: file.activeSeconds,
            unfocusedSeconds: file.unfocusedSeconds,
            totalSeconds: wallClockSeconds(file),
          });

          // if tracking, open a fresh session
          const stillTracking = file.status === STATUS.TRACKING;
          const startTime = deps.nowFull();
          newFiles.set(filePath, {
            ...file,
            sessionStartTime: startTime,
            activeSeconds: 0,
            unfocusedSeconds: 0,
            pausedSeconds: 0,
            pausedRanges: [],
            pauseStartTimestamp: null,
            lastTickTimestamp: stillTracking ? deps.now() : null,
            sessionObject: stillTracking
              ? {
                  [deps.nowFull()]: state.isWindowFocused ? 'tracking' : 'inactive',
                }
              : null,
          });

          if (stillTracking) {
            newPendingWrites.push({
              type: 'timeline-start',
              filePath,
              time: startTime,
              state: 'tracking',
            });
          }
          changed = true;
        }

        if (!changed) {

          return { ...state, lastCheckDay: today };
        }

        deps.log.info('[TimerReducer] 跨日重置 / day rollover applied:', today);
        return {
          ...state,
          files: newFiles,
          pendingWrites: newPendingWrites,
          lastCheckDay: today,
        };
      }

      //  ----------------------------------------------------------------------

      //  ----------------------------------------------------------------------
      case ActionTypes.USER_ACTIVITY: {
        const currentTime = deps.now();
        const next: TimerState = {
          ...state,
          lastActivityTime: currentTime,
          isIdle: false,
        };

        //  Reset the baseline only when leaving idle: USER_ACTIVITY fires on every mouse
        //  move, and resetting unconditionally would make the baseline meaningless.
        return state.isIdle ? refreshTickBaseline(next, currentTime) : next;
      }

      case ActionTypes.SET_IDLE: {
        if (state.isIdle) return state;
        return { ...state, isIdle: true };
      }

      case ActionTypes.CLEAR_IDLE: {
        if (!state.isIdle) return { ...state, isIdle: false };
        return refreshTickBaseline({ ...state, isIdle: false }, deps.now());
      }

      //  ----------------------------------------------------------------------
      // pending-write queue
      //  ----------------------------------------------------------------------
      case ActionTypes.CONSUME_PENDING_WRITES: {
        const { count } = action.payload;
        if (count <= 0 || state.pendingWrites.length === 0) return state;
        return { ...state, pendingWrites: state.pendingWrites.slice(count) };
      }

      case ActionTypes.REQUEUE_PENDING_WRITES: {
        const { writes } = action.payload;
        if (writes.length === 0) return state;
        // requeue at the head to preserve ordering
        return { ...state, pendingWrites: [...writes, ...state.pendingWrites] };
      }

      //  ----------------------------------------------------------------------

      //  ----------------------------------------------------------------------
      case ActionTypes.RESTORE_FILE: {
        const { filePath, fileState } = action.payload;
        const newFiles = new Map(state.files);
        newFiles.set(filePath, fileState);
        return { ...state, files: newFiles };
      }

      default:
        return state;
    }
  };
}

/** The reducer used in production. */
export const timerReducer = createTimerReducer(systemDeps);
