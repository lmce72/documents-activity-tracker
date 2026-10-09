/**
 * Crash-recovery snapshot
 *
 * `ReadTimeTrackerPlugin._saveTimerStateToLocalStorage/_loadTimerStateFromLocalStorage`
 * Origin: vault main.js TimerStore.serialize/deserialize and the plugin's two
 * localStorage helpers.
 *
 * Merge with the old engine's mechanism:
 *   The project-directory version had a second mechanism under the key `__rttBackup`.
 *   Only this one is kept, under a single key.
 *
 * The snapshot is deliberately narrow: it omits pendingWrites, since unflushed writes
 * are not trustworthy after a crash and replaying them would double-count.
 *
 */

import { LS_SNAPSHOT_KEY } from '../core/constants';
import { createIdleManualState } from '../core/reducer';
import type { TimerFileState, TimerState } from '../core/types';

/** The on-disk snapshot shape. */
export interface SnapshotPayload {
  activeFilePath: string | null;
  /** the Map serialised as entry pairs */
  files: Array<[string, TimerFileState]>;
  isPaused: boolean;
  lastCheckDay: string;
}

/** minimal localStorage abstraction. */
export interface SnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** the real localStorage, or null. */
function defaultStorage(): SnapshotStorage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch (error) {

    //  Accessing localStorage throws in some privacy modes
    console.warn('[RTT][snapshot] localStorage 不可用 / unavailable:', error);
  }
  return null;
}

/** Serialise state into a snapshot payload. */
export function serializeState(state: TimerState): SnapshotPayload {
  return {
    activeFilePath: state.activeFilePath,
    files: Array.from(state.files.entries()),
    isPaused: state.isPaused,
    lastCheckDay: state.lastCheckDay,
  };
}

/**
 * Restore state from a snapshot payload.
 *
 * Tolerant of corrupt or older payloads: missing `pausedSeconds` defaults to 0 (the
 * field is new in this refactor) and malformed file entries are skipped.
 *
 * current time, injected for testability
 */
export function deserializeState(
  payload: unknown,
  now: number,
  today: string,
): TimerState | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Partial<SnapshotPayload>;

  const files = new Map<string, TimerFileState>();
  if (Array.isArray(p.files)) {
    for (const entry of p.files) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, value] = entry as [unknown, unknown];
      if (typeof key !== 'string' || !value || typeof value !== 'object') continue;

      const v = value as Partial<TimerFileState>;
      files.set(key, {
        filePath: typeof v.filePath === 'string' ? v.filePath : key,
        status: (v.status ?? 'idle') as TimerFileState['status'],
        sessionStartTime: v.sessionStartTime ?? null,
        activeSeconds: typeof v.activeSeconds === 'number' ? v.activeSeconds : 0,
        // absent in older snapshots
        unfocusedSeconds: typeof v.unfocusedSeconds === 'number' ? v.unfocusedSeconds : 0,
        pausedSeconds: typeof v.pausedSeconds === 'number' ? v.pausedSeconds : 0,

        //  Timestamps must not survive a crash, or the first tick would be dropped
        lastTickTimestamp: null,
        pauseStartTimestamp: null,
        sessionObject: v.sessionObject ?? null,
        pausedRanges: Array.isArray(v.pausedRanges) ? v.pausedRanges : [],
      });
    }
  }

  return {
    activeFilePath: typeof p.activeFilePath === 'string' ? p.activeFilePath : null,
    files,
    isPaused: p.isPaused === true,
    isIdle: false,

    //  The snapshot carries no window focus; the service corrects it right after load
    isWindowFocused: true,

    //  The manual timer is deliberately not restored: a manual session is started and
    //  ended explicitly by the user, and silently resuming one after a crash would
    //  fabricate a multi-hour record. Better to let the user start it again.
    manual: createIdleManualState(),
    lastActivityTime: now,
    lastTickTime: null,
    lastCheckDay: typeof p.lastCheckDay === 'string' ? p.lastCheckDay : today,
    pendingWrites: [],
  };
}

export function saveSnapshot(
  state: TimerState,
  storage: SnapshotStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LS_SNAPSHOT_KEY, JSON.stringify(serializeState(state)));
    return true;
  } catch (error) {
    console.warn('[RTT][snapshot] 保存失败 / save failed:', error);
    return false;
  }
}

/** Read and restore a snapshot. */
export function loadSnapshot(
  now: number,
  today: string,
  storage: SnapshotStorage | null = defaultStorage(),
): TimerState | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LS_SNAPSHOT_KEY);
    if (!raw) return null;
    return deserializeState(JSON.parse(raw), now, today);
  } catch (error) {
    console.warn('[RTT][snapshot] 恢复失败 / restore failed:', error);
    return null;
  }
}

/** Clear the snapshot. */
export function clearSnapshot(
  storage: SnapshotStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(LS_SNAPSHOT_KEY);
  } catch (error) {
    console.warn('[RTT][snapshot] 清除失败 / clear failed:', error);
  }
}
