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

import { buildFileRecords, removeFileEvents as removeFileEventsPure } from '../core/timeline';
import type {
  CountdownSession,
  ManualSession,
  RecordEntry,
  TimelineEvent,
} from '../core/types';
import type { HistoryStore } from './historyStore';
import { assertEditCurrent, eventHistory, sessionFingerprint, sessionsWithEdits, visitSourceFingerprint } from '../core/recordEditing';
import type { EventHistory, RecordEdit } from '../core/recordEditing';
import { buildVisits } from '../core/activityVisits';

export class VolatileHistoryStore implements HistoryStore {
  protected events: TimelineEvent[] = [];
  protected records = new Map<string, RecordEntry>();
  protected manual: ManualSession[] = [];
  protected countdown: CountdownSession[] = [];
  protected revision = 0;
  protected edits: RecordEdit[] = [];

  isReady(): boolean {
    return true;
  }

  getRevision(): number {
    return this.revision;
  }

  getEvents(): EventHistory {
    return eventHistory(this.events, this.edits);
  }

  getRecordEdits(): RecordEdit[] {
    return structuredClone(this.edits);
  }

  async commitRecordEdit(edit: RecordEdit): Promise<void> {
    let sourceFingerprint: string | undefined;
    if (edit.kind === 'manual' || edit.kind === 'countdown') {
      const session = (edit.kind === 'manual' ? this.getManualSessions() : this.getCountdownSessions()).find(saved => saved.id === edit.session.id);
      sourceFingerprint = session ? sessionFingerprint(session) : undefined;
    } else {
      const visit = buildVisits(this.events, edit.visit.originalFrom, edit.visit.originalTo, true).find(saved => saved.target === edit.visit.target);
      sourceFingerprint = visit ? visitSourceFingerprint(this.events, edit.visit.target, edit.visit.originalFrom, edit.visit.originalTo) : undefined;
    }
    assertEditCurrent(edit, this.edits, sourceFingerprint);
    this.edits.push(structuredClone(edit));
    this.revision++;
    try {
      await this.flushNow();
    } catch (error) {
      this.edits = this.edits.filter(saved => saved.editId !== edit.editId);
      this.revision++;
      throw error instanceof Error ? error : new Error('保存记录失败。');
    }
  }

  appendEvents(events: readonly TimelineEvent[]): void {
    if (events.length === 0) return;
    this.events.push(...events);
    this.revision++;
  }

  replaceEvents(events: readonly TimelineEvent[]): void {
    this.events = [...events];
    this.revision++;
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
    this.edits = this.edits.filter(edit => (edit.kind !== 'document' && edit.kind !== 'view') || edit.visit.target !== filePath);
    this.revision++;
    return before - this.events.length;
  }

  getRecords(): Record<string, RecordEntry> {
    const out = Object.fromEntries(this.records);
    const targets = new Set(this.edits.flatMap(edit => edit.kind === 'document' || edit.kind === 'view' ? [edit.visit.target] : []));
    if (targets.size > 0) {
      const records = buildFileRecords(this.getEvents(), Date.now());
      for (const target of targets) {
        const record = records[target];
        if (record) out[target] = { fileName: record.fileName, totalReadTime: record.totalReadTime, unfocusedReadTime: record.unfocusedReadTime, lastReadAt: record.lastReadAt };
      }
    }
    return out;
  }

  getRecord(filePath: string): RecordEntry | null {
    if (this.edits.some(edit => (edit.kind === 'document' || edit.kind === 'view') && edit.visit.target === filePath)) return this.getRecords()[filePath] ?? null;
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
    return sessionsWithEdits('manual', this.manual, this.edits);
  }

  getManualSessionsInRange(start: string, end: string): ManualSession[] {
    return this.getManualSessions().filter((s) => s.startTime >= start && s.startTime <= end);
  }

  appendManualSession(session: ManualSession): void {
    this.manual = [...this.manual.filter(saved => saved.id !== session.id), session];
    this.revision++;
  }

  deleteManualSession(id: string): void {
    this.manual = this.manual.filter((s) => s.id !== id);
    this.revision++;
  }

  updateManualSessionNote(id: string, note: string): boolean {
    const index = this.manual.findIndex((session) => session.id === id);
    if (index < 0) return false;
    this.manual[index] = { ...this.manual[index]!, note };
    this.revision++;
    return true;
  }

  getCountdownSessions(): CountdownSession[] {
    return sessionsWithEdits('countdown', this.countdown, this.edits);
  }

  getCountdownSessionsInRange(start: string, end: string): CountdownSession[] {
    return this.getCountdownSessions().filter((s) => s.startTime >= start && s.startTime <= end);
  }

  appendCountdownSession(session: CountdownSession): void {
    this.countdown = [...this.countdown.filter(saved => saved.id !== session.id), session];
    this.revision++;
  }

  deleteCountdownSession(id: string): void {
    this.countdown = this.countdown.filter((s) => s.id !== id);
    this.revision++;
  }

  clearAll(): void {
    this.events = [];
    this.records.clear();
    this.edits = this.edits.filter(edit => edit.kind === 'manual' || edit.kind === 'countdown');
    this.revision++;
  }

  /** nothing to flush without a disk. */
  async flushNow(): Promise<void> {

    //  Intentionally empty: callers cannot tell from here whether anything was written, so
    //  the assembly layer tracks "volatile mode" and tells the user.
  }
}
