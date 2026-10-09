/**
 *
 * Purpose: the degradation path when SQLite is unavailable — e.g. the user copied only
 * `main.js` without `sql-wasm.wasm`, or the wasm failed to load in some mobile WebView.
 *
 * Why not let `SqliteStore` limp along: its reads throw when uninitialised — deliberately,
 * so empty data is never mistaken for lost data. An explicit stand-in keeps "no
 * persistence" visible at the assembly layer, which can then warn the user.
 *
 * Semantics mirror `SqliteStore` so the two are interchangeable, and the test double
 * extends this class so the two cannot drift apart.
 *
 */

import { removeFileEvents as removeFileEventsPure } from '../core/timeline';
import type { ManualSession, RecordEntry, TimelineEvent } from '../core/types';
import type { HistoryStore } from './historyStore';

export class VolatileHistoryStore implements HistoryStore {
  protected events: TimelineEvent[] = [];
  protected records = new Map<string, RecordEntry>();
  protected manual: ManualSession[] = [];

  isReady(): boolean {
    return true;
  }

  getEvents(): TimelineEvent[] {
    return [...this.events];
  }

  appendEvents(events: readonly TimelineEvent[]): void {
    this.events.push(...events);
  }

  replaceEvents(events: readonly TimelineEvent[]): void {
    this.events = [...events];
  }

  /**
   * Delete a file's events and drop its materialised record too.
   *
   * Deleting only the events leaves an orphan record row and `getRecord()` keeps reporting
   * a file that no longer exists — handled identically to `SqliteStore`.
   */
  deleteFileEvents(filePath: string): number {
    const before = this.events.length;
    this.events = removeFileEventsPure(this.events, filePath);
    this.records.delete(filePath);
    return before - this.events.length;
  }

  getRecords(): Record<string, RecordEntry> {
    return Object.fromEntries(this.records);
  }

  getRecord(filePath: string): RecordEntry | null {
    return this.records.get(filePath) ?? null;
  }

  applySessionSave(
    filePath: string,
    data: { activeSeconds: number; unfocusedSeconds: number; lastReadAt: string },
  ): void {
    const existing = this.records.get(filePath);
    const base: RecordEntry = existing ?? {
      fileName: filePath.split('/').pop() ?? filePath,
      totalReadTime: 0,
      unfocusedReadTime: 0,
      lastReadAt: '',
    };
    this.records.set(filePath, {
      ...base,
      totalReadTime: base.totalReadTime + data.activeSeconds + data.unfocusedSeconds,
      unfocusedReadTime: (base.unfocusedReadTime ?? 0) + data.unfocusedSeconds,
      lastReadAt: data.lastReadAt,
    });
  }

  upsertRecord(filePath: string, data: Partial<RecordEntry>): void {
    const existing = this.records.get(filePath);
    this.records.set(filePath, {
      fileName: data.fileName ?? existing?.fileName ?? filePath.split('/').pop() ?? filePath,
      totalReadTime: data.totalReadTime ?? existing?.totalReadTime ?? 0,
      unfocusedReadTime: data.unfocusedReadTime ?? existing?.unfocusedReadTime ?? 0,
      lastReadAt: data.lastReadAt ?? existing?.lastReadAt ?? '',
    });
  }

  deleteRecord(filePath: string): void {
    this.records.delete(filePath);
  }

  getManualSessions(): ManualSession[] {
    return [...this.manual];
  }

  getManualSessionsInRange(start: string, end: string): ManualSession[] {
    return this.manual.filter((s) => s.startTime >= start && s.startTime <= end);
  }

  appendManualSession(session: ManualSession): void {
    this.manual.push(session);
  }

  deleteManualSession(id: string): void {
    this.manual = this.manual.filter((s) => s.id !== id);
  }

  clearAll(): void {
    this.events = [];
    this.records.clear();
  }

  /** nothing to flush without a disk. */
  async flushNow(): Promise<void> {

    //  Intentionally empty: callers cannot tell from here whether anything was written, so
    //  the assembly layer tracks "volatile mode" and tells the user.
  }
}
