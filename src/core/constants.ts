/**
 * 核心常量 / Core constants
 *
 * 来源：vault 版 main.js 第 133-158 行（STATUS / ActionTypes）与第 4952-4966 行
 * （DEFAULT_SETTINGS），另加本次重构引入的常量。
 * Origin: vault main.js lines 133-158 and 4952-4966, plus new constants introduced here.
 *
 * 本模块是第 0 层叶子 / L0 leaf module.
 */

/**
 * 文件状态枚举 / File status enum.
 * 与原实现完全一致，取值不可更改（会写入持久化数据）。
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
 * Action 类型 / Action types.
 *
 * 相比原实现删除了 4 个有声明无实现的死常量：
 *   START_SESSION / PAUSE_SESSION / RESUME_SESSION / UNBIND_FILE（引用数均为 0）
 * 并把 CLEAR_PENDING_WRITES 改名为 CONSUME_PENDING_WRITES（语义：按条数消费队首）。
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
} as const;

export type ActionType = (typeof ActionTypes)[keyof typeof ActionTypes];

/**
 * 当前数据格式版本 / Current data format version.
 * 只在迁移路径中读写，绝不在普通保存时写回（原实现把 version=2 硬编码在
 * saveTimeline 里，导致 v3 数据被降级标记、反复迁移）。
 * Only touched on the migration path — never written back on ordinary saves.
 */
export const DATA_VERSION = 3;

/** localStorage 崩溃恢复快照的键名 / Key for the crash-recovery snapshot. */
export const LS_SNAPSHOT_KEY = 'rtt_timer_state';

/**
 * tick 间隔上限（毫秒）/ Maximum tick gap in milliseconds.
 * 超过此值认为系统休眠过，本 tick 丢弃以防错误累加。
 * Gaps larger than this indicate a sleep; the tick is dropped to avoid bogus accumulation.
 */
export const TICK_GAP_LIMIT_MS = 5000;

/**
 * 会被持久化到 timeline 的事件类型 / Event types persisted into the timeline.
 *
 * 这是本次重构最关键的修正：原白名单为
 *   ['start','pause','resume','save','auto-save','discard']
 * 会把真实数据中 41 个事件（blur 19 + focus 14 + switch 8）静默丢弃。
 * 这里补全为九类，并使迁移变成非破坏性。
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
