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
  liveWallClockSeconds,
  type CountdownTimerState,
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
    pauseStartFull: '',
    pauses: [],
    flags: [],
  };
}

/**
 * An idle countdown state / 空闲的倒计时状态.
 * 与正计时同一套字段，只是多一个 `plan`：两边形状相同，界面才能共用同一套读数与圆环渲染。
 * Same fields as the count-up plus `plan`, so the UI can share one readout and one ring renderer.
 */
export function createIdleCountdownState(): CountdownTimerState {
  return {
    status: MANUAL_STATUS.IDLE,
    startTimestamp: null,
    startedAt: '',
    pausedMs: 0,
    pauseStartTimestamp: null,
    pauseStartFull: '',
    pauses: [],
    flags: [],
    plan: null,
  };
}

/** Build a fresh initial state. */
export function createInitialState(deps: ReducerDeps): TimerState {
  return {
    activeFilePath: null,
    files: new Map(),
    isIdle: false,

    //  The window is necessarily focused at load time — the plugin loads inside it
    isWindowFocused: true,
    manual: createIdleManualState(),
    countdown: createIdleCountdownState(),
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
    splitReading: false,
    sessionObject: null,
    activeSeconds: 0,
    unfocusedSeconds: 0,
    idleSeconds: 0,
    pausedSeconds: 0,
    pausedRanges: [],
    pauseStartTimestamp: null,
    lastTickTimestamp: null,
    discardedByUser: false,
    savedByUser: false,
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

        //  空闲不再直接丢弃：它继续走秒，只是记进 idle 通道。以前这里提前返回，那段时间既不算
        //  阅读也不算暂停，任何合计里都没有它 —— 设置里那句"无交互多少秒后暂停计时"读起来像是
        //  记了暂停，实际是凭空消失。
        //
        //  Idle is no longer discarded: the clock keeps going and the seconds land in the idle
        //  channel. This used to return early, leaving the stretch neither reading nor paused and
        //  absent from every total, while the setting's wording ("pause after N seconds") read as if
        //  it were recorded.
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

        //  一段只归一类：窗口失焦优先（那是更强的信号），其次是有焦点但空闲，最后才是专注
        //  One stretch, one channel: being out of the window wins (the stronger signal), then
        //  focused-but-idle, then active.
        const countsAsActive = focused || file.splitReading === true;
        const isIdle = state.isIdle && countsAsActive;

        let nextFile: TimerFileState;
        if (!countsAsActive) {
          nextFile = { ...file, unfocusedSeconds: file.unfocusedSeconds + gained };
        } else if (isIdle) {
          nextFile = { ...file, idleSeconds: (file.idleSeconds ?? 0) + gained };
        } else {
          nextFile = { ...file, activeSeconds: file.activeSeconds + gained };
        }

        newFiles.set(filePath, {
          ...nextFile,
          lastTickTimestamp: currentTime,

          //  Blur writes 'inactive' rather than 'tracking' so derived durations (which
          //  count only `tracking`) and the heatmap's three-way stats cannot mistake
          //  unfocused time for active time. Idle gets its own state for the same reason.
          sessionObject: {
            ...(file.sessionObject ?? {}),
            [timeStr]: !countsAsActive ? 'inactive' : isIdle ? 'idle' : 'tracking',
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
        const shouldSettle = !!file && file.status === STATUS.TRACKING && (!state.isIdle || !!file.splitReading && !state.isWindowFocused);

        if (!shouldSettle || !file || file.lastTickTimestamp === null) {
          return { ...state, isWindowFocused: focused };
        }

        const gap = currentTime - file.lastTickTimestamp;
        const limit = leavingFocused ? TICK_GAP_LIMIT_MS : UNFOCUSED_GAP_LIMIT_MS;
        const newFiles = new Map(state.files);

        if (gap > limit) {

          //  A gap beyond the limit means sleep: reset the baseline, settle nothing
          newFiles.set(activePath!, { ...file, lastTickTimestamp: currentTime });
        } else if (leavingFocused || file.splitReading) {

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
      case ActionTypes.SET_SPLIT_READING: {
        const { filePath, enabled } = action.payload;
        const file = state.files.get(filePath);
        if (filePath !== state.activeFilePath || !file || file.status === STATUS.IDLE || !!file.splitReading === enabled) return state;
        const now = deps.now();
        const gap = file.lastTickTimestamp === null ? 0 : now - file.lastTickTimestamp;
        const limit = state.isWindowFocused ? TICK_GAP_LIMIT_MS : UNFOCUSED_GAP_LIMIT_MS;
        const seconds = file.status === STATUS.TRACKING && (!state.isIdle || !state.isWindowFocused) && gap >= 0 && gap <= limit ? Math.round(gap / 1000) : 0;
        const reading = state.isWindowFocused || file.splitReading;
        const files = new Map(state.files);
        files.set(filePath, { ...file, splitReading: enabled,
          activeSeconds: file.activeSeconds + (reading ? seconds : 0),
          unfocusedSeconds: file.unfocusedSeconds + (reading ? 0 : seconds),
          lastTickTimestamp: now,
          sessionObject: { ...file.sessionObject, [deps.nowFull()]: file.status === STATUS.PAUSED ? 'pausing' : state.isWindowFocused || enabled ? 'tracking' : 'inactive' },
        });
        return { ...state, files };
      }
      case ActionTypes.UNBIND_FILE: {
        const fromPath = state.activeFilePath;
        if (fromPath === null) return state;

        const file = state.files.get(fromPath);
        if (!file || file.status === STATUS.IDLE) {
          return { ...state, activeFilePath: null };
        }

        const newFiles = new Map(state.files);
        newFiles.set(fromPath, { ...file, status: STATUS.IDLE, splitReading: false });
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
            pauseStartFull: '',
            pauses: [],

            //  Each run starts empty: the previous run's marks must not carry over
            flags: [],
          },
        };
      }

      case ActionTypes.MANUAL_RESTORE: {
        if (state.manual.status !== MANUAL_STATUS.IDLE) return state;
        const { startTimestamp, startedAt, pausedMs, pauses, flags } = action.payload;

        //  恢复成**暂停**：累计值等于快照那一刻，之后由用户自己按下继续
        //  Restored **paused**, holding exactly the elapsed value from the snapshot; the user
        //  presses resume when they are ready.
        return {
          ...state,
          manual: {
            status: MANUAL_STATUS.PAUSED,
            startTimestamp,
            startedAt,
            pausedMs,
            pauseStartTimestamp: deps.now(),
            pauseStartFull: deps.nowFull(),
            pauses: [...pauses],
            flags: [...flags],
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
            // 同时记下可读时间串：恢复时要用它拼出暂停区间的起点
            // The readable timestamp is kept alongside: resuming needs it to open the interval
            pauseStartFull: deps.nowFull(),
          },
        };
      }

      case ActionTypes.MANUAL_RESUME: {
        if (state.manual.status !== MANUAL_STATUS.PAUSED) return state;
        const currentTime = deps.now();
        const pausedAt = state.manual.pauseStartTimestamp;
        const pauseDuration = currentTime - (pausedAt ?? currentTime);
        const resumedAt = deps.nowFull();
        return {
          ...state,
          manual: {
            ...state.manual,
            status: MANUAL_STATUS.RUNNING,
            pausedMs: state.manual.pausedMs + Math.max(0, pauseDuration),
            pauseStartTimestamp: null,
            // 记下这一段暂停的起止，热力图才有位置可画；总毫秒数仍然照旧累加
            // The span is recorded so the heatmap has somewhere to draw it; the running total
            // still accumulates exactly as before.
            pauses:
              state.manual.pauseStartFull.length > 0
                ? [
                    ...state.manual.pauses,
                    { from: state.manual.pauseStartFull, to: resumedAt },
                  ]
                : state.manual.pauses,
            pauseStartFull: '',
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
      // countdown
      //
      //  与正计时同一套时间口径：全部由时间戳推导，不按 tick 累加。多出来的是 `plan` ——
      //  它在开始时被写进状态，之后只读，所以改设置动不了正在跑的这一次。
      //  The same timestamp-derived accounting as the count-up; the extra piece is `plan`, written
      //  once at start and read-only afterwards, so editing settings cannot alter a run in flight.
      //  ----------------------------------------------------------------------
      case ActionTypes.COUNTDOWN_START: {
        if (state.countdown.status !== MANUAL_STATUS.IDLE) return state;

        //  空方案没有可跑的东西，拒绝开始而不是留下一个永远完不成的计时
        //  An empty plan has nothing to run: refuse rather than leave an unfinishable timer
        if (action.payload.plan.phases.length === 0) return state;

        return {
          ...state,
          countdown: {
            ...createIdleCountdownState(),
            status: MANUAL_STATUS.RUNNING,
            startTimestamp: deps.now(),
            startedAt: deps.nowFull(),
            plan: action.payload.plan,
          },
        };
      }

      case ActionTypes.COUNTDOWN_RESTORE: {
        if (state.countdown.status !== MANUAL_STATUS.IDLE) return state;
        const { startTimestamp, startedAt, pausedMs, pauses, flags, plan } = action.payload;
        if (plan.phases.length === 0) return state;
        return {
          ...state,
          countdown: {
            status: MANUAL_STATUS.PAUSED,
            startTimestamp,
            startedAt,
            pausedMs,
            pauseStartTimestamp: deps.now(),
            pauseStartFull: deps.nowFull(),
            pauses: [...pauses],
            flags: [...flags],
            plan,
          },
        };
      }

      case ActionTypes.COUNTDOWN_PAUSE: {
        if (state.countdown.status !== MANUAL_STATUS.RUNNING) return state;
        return {
          ...state,
          countdown: {
            ...state.countdown,
            status: MANUAL_STATUS.PAUSED,
            pauseStartTimestamp: deps.now(),
            pauseStartFull: deps.nowFull(),
          },
        };
      }

      case ActionTypes.COUNTDOWN_RESUME: {
        if (state.countdown.status !== MANUAL_STATUS.PAUSED) return state;
        const currentTime = deps.now();
        const pausedAt = state.countdown.pauseStartTimestamp;
        const pauseDuration = currentTime - (pausedAt ?? currentTime);
        const resumedAt = deps.nowFull();
        return {
          ...state,
          countdown: {
            ...state.countdown,
            status: MANUAL_STATUS.RUNNING,
            pausedMs: state.countdown.pausedMs + Math.max(0, pauseDuration),
            pauseStartTimestamp: null,
            pauses:
              state.countdown.pauseStartFull.length > 0
                ? [
                    ...state.countdown.pauses,
                    { from: state.countdown.pauseStartFull, to: resumedAt },
                  ]
                : state.countdown.pauses,
            pauseStartFull: '',
          },
        };
      }

      case ActionTypes.COUNTDOWN_STOP: {
        if (state.countdown.status === MANUAL_STATUS.IDLE) return state;

        //  与正计时同理：调用方先读走时长与标记，再发这个动作
        //  Same as the count-up: the caller reads the duration and marks before dispatching this
        return { ...state, countdown: createIdleCountdownState() };
      }

      case ActionTypes.COUNTDOWN_FLAG: {
        if (state.countdown.status === MANUAL_STATUS.IDLE) return state;
        const { atSeconds, atTime, label, phase } = action.payload;
        return {
          ...state,
          countdown: {
            ...state.countdown,
            flags: [
              ...state.countdown.flags,
              {
                atSeconds: Math.max(0, Math.round(atSeconds)),
                atTime,
                label,
                phase: Math.max(1, Math.round(phase)),
              },
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
          return { ...state, files: newFiles };
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
          return { ...state, files: newFiles };
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
          if (oldFile) {
            newFiles.set(fromPath, { ...oldFile, status: oldFile.status === STATUS.TRACKING ? STATUS.IDLE : oldFile.status, splitReading: false });
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
            idleSeconds: 0,
            pausedSeconds: 0,
            lastTickTimestamp: autoStart ? deps.now() : null,
            pauseStartTimestamp: null,
            sessionObject: autoStart
              ? {
                  [deps.nowFull()]: state.isWindowFocused ? 'tracking' : 'inactive',
                }
              : null,
            pausedRanges: [],
            discardedByUser: false,
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
            splitReading: false,
            savedByUser: false,
            sessionStartTime: startTimeStr,
            lastTickTimestamp: deps.now(),
            discardedByUser: false,
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
          newFiles.set(filePath, { ...clearedFile(file), savedByUser: eventType !== 'auto-save' });
          // 没有闭合事件，统计会把被丢弃的短会话继续当作进行中。
          // Close rejected sessions so derived history cannot keep extrapolating them.
          return { ...state, files: newFiles, pendingWrites: [...state.pendingWrites,
            { type: 'timeline-discard', filePath, time: deps.nowFull() },
          ] };
        }

        const timeStr = deps.nowFull();
        const savedSession: SessionStateMap = {
          ...(file.sessionObject ?? {}),
          [timeStr]: 'saved',
        };

        newFiles.set(filePath, { ...clearedFile(file), savedByUser: eventType !== 'auto-save' });

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
              idleSeconds: file.idleSeconds ?? 0,

              totalSeconds: liveWallClockSeconds(file, deps.now()),
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
        newFiles.set(filePath, {
          ...clearedFile(file),

          //  显式丢弃：压制这一文件之后的自动开始，见 TimerFileState.discardedByUser
          //  An explicit discard suppresses auto-start for this file; see TimerFileState.discardedByUser
          discardedByUser: true,
        });

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
            idleSeconds: file.idleSeconds ?? 0,
            totalSeconds: liveWallClockSeconds(file, deps.now()),
          });

          // if tracking, open a fresh session
          const stillTracking = file.status === STATUS.TRACKING;
          const startTime = deps.nowFull();
          newFiles.set(filePath, {
            ...file,
            sessionStartTime: startTime,
            splitReading: false,
            activeSeconds: 0,
            unfocusedSeconds: 0,
            idleSeconds: 0,
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
