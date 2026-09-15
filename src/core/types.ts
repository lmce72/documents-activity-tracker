/**
 * 核心类型定义 / Core type definitions
 *
 * 来源：vault 版 main.js 中散落的 JSDoc 与隐式结构，本次统一为强类型。
 * Origin: previously implicit/JSDoc shapes scattered across vault main.js,
 * now consolidated into explicit types.
 *
 * 本模块只依赖 constants，属第 0 层 / L0 module; depends only on constants.
 */

import type { FileStatus, ActionType } from './constants';

// ============================================================================
// 设置 / Settings
// ============================================================================

/** 设置项 / Plugin settings (13 fields, unchanged from the original). */
export interface PluginSettings {
  /** 'blacklist' | 'whitelist' */
  filterMode: string;
  /** 逗号/换行分隔，支持路径前缀与正则 / comma or newline separated */
  filterPatterns: string;
  idleTimeoutEnabled: boolean;
  idleTimeout: number;
  /** 起步阈值（秒），低于此值不写入记录 / min session seconds */
  minReadSeconds: number;
  /** 'compact' | 'precise' */
  timeDisplayMode: string;
  /** 'always' | 'start-only' | 'return-only' | 'manual' */
  autoStartMode: string;
  useIconize: boolean;
  dataFilePath: string;
  /** 'idle' | 'always' | 'never' */
  todayTotalDisplay: string;
  /** 遗留项：只写不读，本次重构刻意保留原样 / legacy, intentionally untouched */
  autoSaveEnabled: boolean;
  /** 遗留项：只写不读 / legacy, intentionally untouched */
  autoSaveInterval: number;
  /** 'focus' | 'visibility'，遗留项：只写不读 / legacy, intentionally untouched */
  trackingMode: string;
}

// ============================================================================
// 会话与记录 / Sessions & records
// ============================================================================

/** sessionObject 的状态取值 / State values stored in a sessionObject. */
export type SessionState = 'tracking' | 'pausing' | 'saved';

/**
 * 会话时间轴对象 / Session timeline object.
 * 形如 { 'YYYY-MM-DD HH:mm:ss': 'tracking' | 'pausing' | 'saved' }
 */
export type SessionStateMap = Record<string, SessionState>;

/** 暂停区间 [开始毫秒, 结束毫秒] / A paused range as [startMs, endMs]. */
export type PausedRange = [number | null, number];

/** 单个文件的计时状态 / Per-file timer state. */
export interface TimerFileState {
  filePath: string;
  status: FileStatus;
  sessionStartTime: string | null;

  /**
   * 唯一真相：纯活跃秒数 / single source of truth: pure active seconds.
   * 原先另有一个 `accumulatedSeconds`（墙钟，含暂停）与之并存，二者并非恒等，
   * 本次合并为 `activeSeconds` + `pausedSeconds`，墙钟按需派生（见下）。
   * The original kept an additional `accumulatedSeconds` (wall clock, incl. pauses);
   * the two were not identical. Merged here into active + paused, with wall clock derived.
   */
  activeSeconds: number;

  /**
   * 唯一真相：累计暂停秒数 / single source of truth: accumulated paused seconds.
   * 复现原实现的取整方式：每次「恢复」时一次性累加 floor(暂停时长/1000)。
   * Reproduces the original rounding: floor(pauseDuration / 1000) added once on resume.
   */
  pausedSeconds: number;

  lastTickTimestamp: number | null;
  pauseStartTimestamp: number | null;
  sessionObject: SessionStateMap | null;
  pausedRanges: PausedRange[];
}

/**
 * 墙钟时长派生 / Derive wall-clock seconds.
 * 等价于原 `accumulatedSeconds` 的语义（活跃 + 暂停）。
 * Equivalent to the original `accumulatedSeconds` semantics.
 */
export function wallClockSeconds(file: TimerFileState): number {
  return file.activeSeconds + file.pausedSeconds;
}

// ============================================================================
// 待写入队列 / Pending writes
// ============================================================================

/** 新会话开始 / A new session started. */
export interface TimelineStartWrite {
  type: 'timeline-start';
  filePath: string;
  time: string;
  state: string;
}

/** 会话被丢弃 / A session was discarded. */
export interface TimelineDiscardWrite {
  type: 'timeline-discard';
  filePath: string;
  time: string;
}

/** 会话已保存 / A session was saved. */
export interface SessionWrite {
  type: 'session';
  filePath: string;
  session: SessionStateMap;
  /** 活跃秒数，累加进 records / active seconds, added to records */
  activeSeconds: number;
  /** 墙钟秒数，写入 timeline 事件的 duration / wall clock, written as event.duration */
  totalSeconds: number;
}

export type PendingWrite = TimelineStartWrite | TimelineDiscardWrite | SessionWrite;

// ============================================================================
// 全局计时状态 / Global timer state
// ============================================================================

/** reducer 管理的唯一状态树 / The single state tree managed by the reducer. */
export interface TimerState {
  activeFilePath: string | null;
  files: Map<string, TimerFileState>;
  isPaused: boolean;
  isIdle: boolean;
  lastActivityTime: number;
  lastTickTime: number | null;
  /** 用于跨日检测 / used for day-rollover detection */
  lastCheckDay: string;
  pendingWrites: PendingWrite[];
}

// ============================================================================
// Action
// ============================================================================

/**
 * 注意：原实现的 TICK / TOGGLE_PAUSE 载荷里带 `currentTime`，由 TimerService 用
 * Date.now() 填入；而 reducer 内部另有若干处直接调 Date.now()。两套时间来源并存
 * 使 reducer 无法确定性重放。本次统一为只从注入的 clock 取时间，载荷不再携带
 * currentTime —— 这是内部契约调整，不改变行为（TimerService 原本就传 Date.now()）。
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
 * 全部 Action 的判别联合 / Discriminated union of every action.
 *
 * 相比原实现：删除了 4 个有声明无实现的死常量（START_SESSION / PAUSE_SESSION /
 * RESUME_SESSION / UNBIND_FILE）；`CLEAR_PENDING_WRITES` 改为语义更准确的
 * `CONSUME_PENDING_WRITES`（按条数消费队首，用于消除并发重复写入）；
 * 新增 `REQUEUE_PENDING_WRITES`（落盘失败时把事件写回队首，不再静默丢数据）。
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
      payload: { filePath: string; minReadSeconds: number };
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
    };

// ============================================================================
// 持久化数据结构 / Persisted data shapes
// ============================================================================

/** 单条文件记录 / A per-file record entry. */
export interface RecordEntry {
  fileName: string;
  totalReadTime: number;
  lastReadAt: string;
}

/** timeline 事件类型 / Timeline event types. */
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
 * 挂载在单个文件上的事件 / Events that hang off a single file.
 * 字段组合取自真实数据实测结果。
 * Field combinations taken from the measured real data.
 */
export interface FileTimelineEvent {
  time: string;
  type: 'start' | 'pause' | 'resume' | 'save' | 'auto-save' | 'blur' | 'focus';
  file: string;
  state?: string;
  /** blur/focus 事件的成因 / cause for blur/focus events */
  reason?: string;
  /** save/auto-save 事件的墙钟秒数 / wall-clock seconds on save events */
  duration?: number;
  activeSeconds?: number;
}

/** 会话被丢弃 / A discarded session (no `state` field in real data). */
export interface DiscardTimelineEvent {
  time: string;
  type: 'discard';
  file: string;
  state?: string;
}

/** 文件切换，用 from/to 而非 file / A file switch, keyed by from/to rather than file. */
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
 * 派生出的文件视图模型 / Derived per-file view model.
 *
 * 由 timeline 现算，不落盘（持久化的 records 只有三个统计字段）。
 * Computed from the timeline on demand; never persisted (records holds only 3 fields).
 */
export interface FileRecord {
  fileName: string;
  totalReadTime: number;
  readTimeToday: number;
  lastReadAt: string;
  /** 旧格式的会话时间轴，供 HeatmapView / TimelineView 渲染 / legacy per-session maps */
  readTimeLine: SessionStateMap[];
  /** 是否存在异常未闭合会话（超过 24 小时）/ any unfinished session older than 24h */
  hasAbnormalSession: boolean;
}

/** 自定义数据文件的整体结构 / The whole on-disk data file. */
export interface HistoryCache {
  version?: number;
  records: Record<string, RecordEntry>;
  timeline: TimelineEvent[];
  settings?: Partial<PluginSettings>;
}

/** 迁移报告，取代原先直接 new Notice 的 UI 泄漏 / replaces the original Notice side effect. */
export interface MigrationReport {
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
  recordsBefore: number;
  recordsAfter: number;
  timelineBefore: number;
  timelineAfter: number;
  /** 因缺少 time 字段而丢弃的事件数 / events dropped for lacking a usable `time` */
  droppedMalformed: number;
  /** 出现但不在已知类型表里的事件类型（保留不丢，仅供诊断） */
  unknownEventTypes: string[];
}
