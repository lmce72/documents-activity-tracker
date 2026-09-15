/**
 * 计时状态机 / The timer state machine
 *
 * 来源：vault 版 main.js 第 166-449 行的 `timerReducer`，B 版的 Redux 架构保留，
 * 本文件在其上做了四处改写（见下）。
 * Origin: vault main.js lines 166-449. The Redux architecture is kept; four changes:
 *
 *   1. **时间与日志注入**：原 reducer 内有 6 处环境依赖（Date.now()、nowFullStr()、
 *      nowStr()、console.warn/console.log），使其无法确定性测试。现改为依赖注入。
 *      Time and logging are injected, making the reducer deterministically testable.
 *
 *   2. **双秒数字段合并**：原实现同时维护 accumulatedSeconds（墙钟）与 activeSeconds
 *      （纯活跃），二者并非恒等。现合并为 activeSeconds + pausedSeconds，
 *      墙钟按需派生（wallClockSeconds）。语义等价，见 types.ts。
 *      The duplicated second-counters are merged into active + paused, with wall clock derived.
 *
 *   3. **跨日处理**：原 DAY_ROLLOVER 只有常量声明、reducer 无对应 case（跨日逻辑
 *      停留在旧版引擎里未迁移）。本次补上实现。
 *      DAY_ROLLOVER was declared but never implemented; now implemented.
 *
 *   4. **待写入队列的消费语义**：CLEAR_PENDING_WRITES（清空）改为 CONSUME_PENDING_WRITES
 *      （按条数消费队首），并新增 REQUEUE_PENDING_WRITES。这是消除 flushPendingWrites
 *      并发重复写入的关键，见 TimerService。
 *      The pending-write queue now supports count-based consumption plus requeue-on-failure.
 *
 * 本模块是第 0 层，只依赖 constants / types / time，不触碰 window/document/localStorage。
 * L0 module: depends only on constants, types and time; no window/document/localStorage.
 */

import { ActionTypes, STATUS, TICK_GAP_LIMIT_MS } from './constants';
import { nowFullStr, nowStr, todayStr } from './time';
import {
  wallClockSeconds,
  type SessionStateMap,
  type TimerAction,
  type TimerFileState,
  type TimerState,
} from './types';

/**
 * reducer 所需的全部环境能力 / Every ambient capability the reducer needs.
 * 生产环境用 SystemClock，测试用 FakeClock，从而可确定性重放。
 */
export interface ReducerDeps {
  /** 毫秒时间戳 / milliseconds since epoch */
  now(): number;
  /** "YYYY-MM-DD HH:mm" */
  nowMinute(): string;
  /** "YYYY-MM-DD HH:mm:ss" */
  nowFull(): string;
  /** "YYYY-MM-DD" */
  today(): string;
  log: {
    warn(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
  };
}

/** 默认依赖：直接使用系统时间与 console / Default deps backed by the system clock. */
export const systemDeps: ReducerDeps = {
  now: () => Date.now(),
  nowMinute: nowStr,
  nowFull: nowFullStr,
  today: todayStr,
  log: {
    warn: (message, ...args) => console.warn(message, ...args),
    info: (message, ...args) => console.log(message, ...args),
  },
};

/** 构造初始状态 / Build a fresh initial state. */
export function createInitialState(deps: ReducerDeps): TimerState {
  return {
    activeFilePath: null,
    files: new Map(),
    isPaused: false,
    isIdle: false,
    lastActivityTime: deps.now(),
    lastTickTime: null,
    lastCheckDay: deps.today(),
    pendingWrites: [],
  };
}

/** 把某个文件的会话计数清零 / Reset one file's session counters. */
function clearedFile(file: TimerFileState): TimerFileState {
  return {
    ...file,
    status: STATUS.IDLE,
    sessionObject: null,
    activeSeconds: 0,
    pausedSeconds: 0,
    pausedRanges: [],
    pauseStartTimestamp: null,
    lastTickTimestamp: null,
  };
}

/**
 * 创建 reducer / Create the reducer.
 *
 * 返回闭包而非直接导出函数，是为了把 `deps` 固化进来，同时保持 reducer 本身
 * 是纯函数（同样的 state + action + deps 必得同样的结果）。
 * Returns a closure so `deps` is captured while the reducer itself stays pure.
 */
export function createTimerReducer(deps: ReducerDeps) {
  return function timerReducer(state: TimerState, action: TimerAction): TimerState {
    switch (action.type) {
      // ----------------------------------------------------------------------
      // 每秒心跳 / The one-second tick
      // ----------------------------------------------------------------------
      case ActionTypes.TICK: {
        const { filePath } = action.payload;
        const file = state.files.get(filePath);

        // 防呆：文件不存在、非追踪态、全局暂停或空闲时不累加
        if (!file || file.status !== STATUS.TRACKING) return state;
        if (state.isPaused || state.isIdle) return state;

        const currentTime = deps.now();

        // 间隔检测：超过阈值的间隔说明系统休眠过，本 tick 丢弃以防错误累加
        // Gap check: a gap beyond the limit means the machine slept; drop this tick.
        const lastTick = file.lastTickTimestamp;
        if (lastTick && currentTime - lastTick > TICK_GAP_LIMIT_MS) {
          deps.log.warn(
            '[TimerReducer] Tick 间隔过长，丢弃 / tick gap too large, dropped:',
            (currentTime - lastTick) / 1000,
            '秒 / s',
          );
          const newFiles = new Map(state.files);
          newFiles.set(filePath, { ...file, lastTickTimestamp: currentTime });
          return { ...state, files: newFiles };
        }

        const newFiles = new Map(state.files);
        const timeStr = deps.nowFull();
        newFiles.set(filePath, {
          ...file,
          activeSeconds: file.activeSeconds + 1,
          lastTickTimestamp: currentTime,
          sessionObject: {
            ...(file.sessionObject ?? {}),
            [timeStr]: 'tracking',
          },
        });

        return { ...state, files: newFiles, lastTickTime: currentTime };
      }

      // ----------------------------------------------------------------------
      // 暂停 / 继续
      // ----------------------------------------------------------------------
      case ActionTypes.TOGGLE_PAUSE: {
        const { filePath } = action.payload;
        const file = state.files.get(filePath);
        if (!file) return state;

        const currentTime = deps.now();
        const newFiles = new Map(state.files);
        const timeStr = deps.nowFull();

        if (file.status === STATUS.TRACKING) {
          // 暂停：记下暂停起点，供恢复时结算与热力图渲染
          newFiles.set(filePath, {
            ...file,
            status: STATUS.PAUSED,
            pauseStartTimestamp: currentTime,
            sessionObject: { ...(file.sessionObject ?? {}), [timeStr]: 'pausing' },
          });
          return { ...state, files: newFiles, isPaused: true };
        }

        if (file.status === STATUS.PAUSED) {
          // 恢复：把这段暂停按秒取整计入 pausedSeconds。
          // 原实现把它加进 accumulatedSeconds；由于墙钟 = 活跃 + 暂停，
          // 这里改记 pausedSeconds 后 wallClockSeconds() 与原值完全一致。
          // Resume: bank the pause, rounded down to whole seconds. The original added it
          // to accumulatedSeconds; since wall = active + paused, wallClockSeconds() matches.
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

      // ----------------------------------------------------------------------
      // 切换文件
      // ----------------------------------------------------------------------
      case ActionTypes.SWITCH_FILE: {
        const { fromPath, toPath, autoStart } = action.payload;
        const newFiles = new Map(state.files);
        const newPendingWrites = [...state.pendingWrites];

        // 旧文件转为 IDLE（不结算，结算由调用方先调 saveSession 完成）
        // The old file goes IDLE; settlement is the caller's job via saveSession first.
        if (fromPath) {
          const oldFile = newFiles.get(fromPath);
          if (oldFile && oldFile.status === STATUS.TRACKING) {
            newFiles.set(fromPath, { ...oldFile, status: STATUS.IDLE });
          }
        }

        let newFile = newFiles.get(toPath);
        const needWriteStart = !newFile && autoStart;

        if (!newFile) {
          newFile = {
            filePath: toPath,
            status: autoStart ? STATUS.TRACKING : STATUS.IDLE,
            sessionStartTime: deps.nowMinute(),
            activeSeconds: 0,
            pausedSeconds: 0,
            lastTickTimestamp: autoStart ? deps.now() : null,
            pauseStartTimestamp: null,
            sessionObject: autoStart ? { [deps.nowFull()]: 'tracking' } : null,
            pausedRanges: [],
          };
        } else if (autoStart && newFile.status === STATUS.IDLE) {
          newFile = {
            ...newFile,
            status: STATUS.TRACKING,
            lastTickTimestamp: deps.now(),
          };
        }

        newFiles.set(toPath, newFile);

        if (needWriteStart) {
          newPendingWrites.push({
            type: 'timeline-start',
            filePath: toPath,
            time: newFile.sessionStartTime ?? deps.nowMinute(),
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

      // ----------------------------------------------------------------------
      // 保存会话
      // ----------------------------------------------------------------------
      case ActionTypes.SAVE_SESSION: {
        const { filePath, minReadSeconds } = action.payload;
        const file = state.files.get(filePath);
        if (!file) return state;

        const newFiles = new Map(state.files);

        // 阈值检查：活跃时长不足则直接丢弃，不写记录
        if (file.activeSeconds < minReadSeconds) {
          deps.log.info(
            '[TimerReducer] 会话时长不足，丢弃 / session below threshold, dropped:',
            file.activeSeconds,
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
              activeSeconds: file.activeSeconds,
              // 墙钟值，写入 timeline 事件的 duration 字段，语义与原 accumulatedSeconds 一致
              totalSeconds: wallClockSeconds(file),
            },
          ],
        };
      }

      // ----------------------------------------------------------------------
      // 丢弃会话
      // ----------------------------------------------------------------------
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
            { type: 'timeline-discard', filePath, time: deps.nowMinute() },
          ],
        };
      }

      // ----------------------------------------------------------------------
      // 跨日处理（原实现缺失 / previously unimplemented）
      // ----------------------------------------------------------------------
      case ActionTypes.DAY_ROLLOVER: {
        const today = deps.today();
        if (state.lastCheckDay === today) return state; // 幂等：同日重复触发无副作用

        const newFiles = new Map(state.files);
        const newPendingWrites = [...state.pendingWrites];
        let changed = false;

        for (const [filePath, file] of state.files) {
          // 只处理仍在进行中的会话 / only sessions still in progress
          if (!file.sessionObject || !file.sessionStartTime) continue;
          if (file.sessionStartTime.slice(0, 10) === today) continue;

          // 1) 闭合昨日会话 / close yesterday's session
          const closedSession: SessionStateMap = {
            ...file.sessionObject,
            [deps.nowFull()]: 'saved',
          };
          newPendingWrites.push({
            type: 'session',
            filePath,
            session: closedSession,
            activeSeconds: file.activeSeconds,
            totalSeconds: wallClockSeconds(file),
          });

          // 2) 若是追踪中，另开一个新会话 / if tracking, open a fresh session
          const stillTracking = file.status === STATUS.TRACKING;
          const startTime = deps.nowMinute();
          newFiles.set(filePath, {
            ...file,
            sessionStartTime: startTime,
            activeSeconds: 0,
            pausedSeconds: 0,
            pausedRanges: [],
            pauseStartTimestamp: null,
            lastTickTimestamp: stillTracking ? deps.now() : null,
            sessionObject: stillTracking ? { [deps.nowFull()]: 'tracking' } : null,
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
          // 没有任何跨日中的会话，仅推进日期标记
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

      // ----------------------------------------------------------------------
      // 用户活动与空闲
      // ----------------------------------------------------------------------
      case ActionTypes.USER_ACTIVITY: {
        return { ...state, lastActivityTime: deps.now(), isIdle: false };
      }

      case ActionTypes.SET_IDLE: {
        return { ...state, isIdle: true };
      }

      case ActionTypes.CLEAR_IDLE: {
        return { ...state, isIdle: false };
      }

      // ----------------------------------------------------------------------
      // 待写入队列 / pending-write queue
      // ----------------------------------------------------------------------
      case ActionTypes.CONSUME_PENDING_WRITES: {
        const { count } = action.payload;
        if (count <= 0 || state.pendingWrites.length === 0) return state;
        return { ...state, pendingWrites: state.pendingWrites.slice(count) };
      }

      case ActionTypes.REQUEUE_PENDING_WRITES: {
        const { writes } = action.payload;
        if (writes.length === 0) return state;
        // 写回队首，保证顺序与失败前一致 / requeue at the head to preserve ordering
        return { ...state, pendingWrites: [...writes, ...state.pendingWrites] };
      }

      // ----------------------------------------------------------------------
      // 从快照恢复单个文件
      // ----------------------------------------------------------------------
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

/** 生产环境使用的 reducer / The reducer used in production. */
export const timerReducer = createTimerReducer(systemDeps);
