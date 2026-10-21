/**
 * 未保存计时的临时快照 / a temporary snapshot of unsaved timers
 *
 * 正计时与倒计时只活在内存里：插件重载、Obsidian 崩溃或退出，那一轮就没了。文档追踪能靠事件流
 * 还原，这两个不能 —— 它们没有事件流，只有一个"已经跑了多久"的活状态。
 *
 * The count-up and countdown exist only in memory. A plugin reload, a crash or a quit takes the run
 * with it. Document tracking can be rebuilt from its event stream; these two cannot — they have no
 * events, only a live "how long have I been running".
 *
 * 所以每秒把「开始时间 + 净已计时」写进 localStorage。恢复时**不**把应用关着的那段时间算进去，
 * 否则"恢复"就会凭空造出一段没发生过的专注：恢复出来的状态是暂停的，累计值等于快照那一刻。
 *
 * So "started at + net elapsed" goes into localStorage. Restoring deliberately does **not** count the
 * time the app was closed — that would invent focus that never happened. A restored run comes back
 * paused, holding exactly the elapsed value from the snapshot.
 *
 * localStorage 而不是 vault 文件：这是本机的一次性残留，不该被同步到别的设备，也不该写脏数据文件。
 * localStorage rather than a vault file: this is a local remnant, not something to sync to another
 * device or to dirty the data file with.
 */

import type { CountdownPlan, ManualFlag, ManualPause } from '../core/types';

/** 存储键 / the storage key. */
export const LIVE_SNAPSHOT_KEY = 'rtt_live_timer_snapshot';

/** 结构版本；读不懂的版本一律当作没有 / version; an unreadable one is treated as absent. */
export const LIVE_SNAPSHOT_VERSION = 1;

/** 一条计时在快照里的样子 / one timer in the snapshot. */
export interface LiveTimerEntry {
  /** 开始时刻（本地全时间串）/ when the run began */
  startedAt: string;
  /** 快照那一刻的净已计时（毫秒，暂停已扣除）/ net elapsed at snapshot time, pauses excluded */
  elapsedMs: number;
  /** 已累计的暂停毫秒 / accumulated pause milliseconds */
  pausedMs: number;
  pauses: ManualPause[];
  flags: ManualFlag[];
  /** 快照时是否在跑（恢复时一律变成暂停）/ whether it was running; restoring always pauses */
  running: boolean;
}

/** 倒计时多一份方案 / the countdown carries its plan too. */
export interface LiveCountdownEntry extends LiveTimerEntry {
  plan: CountdownPlan;
}

/** 整个快照 / the whole snapshot. */
export interface LiveSnapshot {
  version: number;
  /** 写入时刻 / when it was written */
  savedAt: number;
  manual?: LiveTimerEntry;
  countdown?: LiveCountdownEntry;
}

/** 存储接口，测试可注入 / the storage interface, injectable for tests. */
export interface SnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): SnapshotStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch (error) {

    //  隐私模式或策略禁用：快照没了是小事，抛异常把整个插件带崩才是大事
    //  Private mode or a policy block: losing the snapshot is minor, throwing and taking the
    //  plugin down is not.
    console.warn('[RTT][snapshot] localStorage 不可用 / unavailable:', error);
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toPauses(value: unknown): ManualPause[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is ManualPause =>
      isObject(item) && typeof item.from === 'string' && typeof item.to === 'string',
  );
}

function toFlags(value: unknown): ManualFlag[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is ManualFlag => isObject(item) && typeof item.atSeconds === 'number',
  );
}

function toEntry(value: unknown): LiveTimerEntry | null {
  if (!isObject(value)) return null;
  if (typeof value.startedAt !== 'string') return null;
  if (typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs)) return null;
  return {
    startedAt: value.startedAt,
    elapsedMs: Math.max(0, value.elapsedMs),
    pausedMs: typeof value.pausedMs === 'number' ? Math.max(0, value.pausedMs) : 0,
    pauses: toPauses(value.pauses),
    flags: toFlags(value.flags),
    running: value.running === true,
  };
}

function toPlan(value: unknown): CountdownPlan | null {
  if (!isObject(value) || !Array.isArray(value.phases)) return null;
  const phases = value.phases.filter(
    (phase): phase is CountdownPlan['phases'][number] =>
      isObject(phase) &&
      typeof phase.seconds === 'number' &&
      (phase.kind === 'focus' || phase.kind === 'break' || phase.kind === 'segment'),
  );
  if (phases.length === 0) return null;
  const mode = value.mode === 'pomodoro' || value.mode === 'interval' ? value.mode : 'down';
  return { mode, phases };
}

/** 读快照；没有、读不懂、版本不对都返回 null / read it; absent, corrupt or wrong version = null. */
export function readLiveSnapshot(storage?: SnapshotStorage | null): LiveSnapshot | null {
  const store = storage ?? defaultStorage();
  if (!store) return null;

  try {
    const raw = store.getItem(LIVE_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed) || parsed.version !== LIVE_SNAPSHOT_VERSION) return null;

    const manual = toEntry(parsed.manual);
    const countdownRaw = parsed.countdown;
    const countdownEntry = toEntry(countdownRaw);
    const plan = isObject(countdownRaw) ? toPlan(countdownRaw.plan) : null;
    const countdown: LiveCountdownEntry | null =
      countdownEntry && plan ? { ...countdownEntry, plan } : null;

    if (!manual && !countdown) return null;
    return {
      version: LIVE_SNAPSHOT_VERSION,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      ...(manual ? { manual } : {}),
      ...(countdown ? { countdown } : {}),
    };
  } catch (error) {
    console.warn('[RTT][snapshot] 读取失败 / read failed:', error);
    return null;
  }
}

/** 写快照；传 null 清掉 / write it, or clear it with null. */
export function writeLiveSnapshot(
  snapshot: LiveSnapshot | null,
  storage?: SnapshotStorage | null,
): void {
  const store = storage ?? defaultStorage();
  if (!store) return;

  try {
    if (!snapshot || (!snapshot.manual && !snapshot.countdown)) {
      store.removeItem(LIVE_SNAPSHOT_KEY);
      return;
    }
    store.setItem(LIVE_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn('[RTT][snapshot] 写入失败 / write failed:', error);
  }
}
