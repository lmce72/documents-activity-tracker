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
