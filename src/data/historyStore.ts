/**
 * The history repository interface
 *
 * Services depend on this interface rather than on `SqliteStore` so they can be tested
 * outside Obsidian (with an in-memory implementation, no wasm) and so a future change of
 * storage implementation does not reach the service layer.
 *
 * The shape mirrors `SqliteStore` method for method.
 *
 */

import type {
  CountdownSession,
  ManualSession,
  RecordEntry,
  TimelineEvent,
} from '../core/types';

export interface HistoryStore {
  /** whether the store is ready */
  isReady(): boolean;

  /**
   * 内容版本号 / a revision counter for the stored content.
   *
   * 每次追加、替换或删除事件都加一。视图用它判断"这份派生结果还能不能用"，而不是每次都把全部
   * 事件重新推导一遍 —— 真实库在 1.4 万条事件时，一次全量重建要几十毫秒，每秒做一次就是持续掉帧。
   *
   * Incremented on every append, replace or delete. Views use it to decide whether a derived result is
   * still valid instead of re-deriving the whole log — at 14k events a full rebuild costs tens of
   * milliseconds, and doing that every second is continuous frame loss.
   */
  getRevision(): number;

  // events ----
  getEvents(): TimelineEvent[];
  appendEvents(events: readonly TimelineEvent[]): void;
  replaceEvents(events: readonly TimelineEvent[]): void;
  deleteFileEvents(filePath: string): number;

  // per-file statistics ----
  getRecords(): Record<string, RecordEntry>;
  getRecord(filePath: string): RecordEntry | null;
  applySessionSave(
    filePath: string,
    data: { activeSeconds: number; unfocusedSeconds: number; lastReadAt: string },
  ): void;
  upsertRecord(filePath: string, data: Partial<RecordEntry>): void;
  deleteRecord(filePath: string): void;

  // manual sessions ----
  getManualSessions(): ManualSession[];
  getManualSessionsInRange(start: string, end: string): ManualSession[];
  appendManualSession(session: ManualSession): void;
  deleteManualSession(id: string): void;

  //  倒计时是另一本账 / the countdown is a separate ledger
  getCountdownSessions(): CountdownSession[];
  getCountdownSessionsInRange(start: string, end: string): CountdownSession[];
  appendCountdownSession(session: CountdownSession): void;
  deleteCountdownSession(id: string): void;

  /** clear document data only */
  clearAll(): void;

  /**
   * flush to disk / 落盘
   *
   * `force` 绕过落盘闸门：退出、手动保存、首次建库这些时刻必须写进 vault 文件。
   * `force` bypasses the flush gate: quitting, the manual save and creating a new database must
   * reach the vault file.
   */
  flushNow(options?: { force?: boolean; trigger?: 'session-end' | 'interval' | 'quit' }): Promise<void>;
}
