import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildVisits } from '../src/core/activityVisits';
import { dayAccount } from '../src/core/account';
import { draftForSession, draftForVisit, editsOf, editedSession, parseRecordEdit } from '../src/core/recordEditing';
import { buildFileRecords, getFileEvents, getTimeRangeEvents, getTodaySeconds } from '../src/core/timeline';
import { silentLogger } from '../src/core/logger';
import type { CountdownSession, ManualSession, TimelineEvent, TimerFileState } from '../src/core/types';
import { SqliteStore } from '../src/data/SqliteStore';
import { VolatileHistoryStore } from '../src/data/VolatileHistoryStore';
import { RecordEditingService } from '../src/services/RecordEditingService';
import { MemoryAdapter } from './helpers/memory-adapter';

const dbPath = 'reading.sqlite';
const manual: ManualSession = { id: 'round', startTime: '2026-11-08 23:55:00', endTime: '2026-11-09 00:10:00',
  durationSeconds: 900, durationMs: 900000, note: 'original', flags: [], pauses: [] };
const events: TimelineEvent[] = [
  { type: 'start', time: '2026-11-09 08:00:00', file: 'a.md', state: 'tracking' },
  { type: 'switch', time: '2026-11-09 08:10:00', from: 'a.md', to: 'b.md' },
  { type: 'start', time: '2026-11-09 08:10:00', file: 'b.md', state: 'tracking' },
  { type: 'save', time: '2026-11-09 08:20:00', file: 'b.md', state: 'saved', activeSeconds: 600 },
];
const now = new Date(2026, 10, 9, 12).getTime();

function adapter(): MemoryAdapter {
  const bytes = readFileSync(path.join(import.meta.dir, '../node_modules/sql.js/dist/sql-wasm.wasm'));
  return new MemoryAdapter({ 'sql-wasm.wasm': bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
}

async function failureOf(action: () => Promise<void>): Promise<string> {
  try { await action(); } catch (error) { return error instanceof Error ? error.message : 'non-Error failure'; }
  throw new Error('Expected the operation to fail.');
}

describe('record editing contract', () => {
  it('derives cross-midnight net duration and flag counters from pauses', () => {
    const draft = draftForSession('manual', manual, 1);
    draft.pauses = [{ from: '2026-11-08 23:58:00', to: '2026-11-09 00:02:00' }];
    draft.flags = [{ atTime: '2026-11-09 00:00:00', label: 'during pause' }, { atTime: '2026-11-09 00:05:00', label: 'after' }];
    const result = editedSession(draft, manual);
    expect(result.durationMs).toBe(660000);
    expect(result.durationSeconds).toBe(660);
    expect(result.flags.map(flag => flag.atSeconds)).toEqual([180, 360]);
    expect(result.flags.map(flag => flag.atMs)).toEqual([180000, 360000]);
    expect(manual.pauses).toEqual([]);
  });

  it('rejects invalid dates, backwards extents, overlapping pauses and flags outside the round', () => {
    const draft = draftForSession('manual', manual, 1);
    expect(() => editedSession({ ...draft, startTime: '2026-02-30 00:00:00' }, manual)).toThrow('时间格式');
    expect(() => editedSession({ ...draft, endTime: draft.startTime }, manual)).toThrow('结束');
    expect(() => editedSession({ ...draft, pauses: [
      { from: '2026-11-09 00:00:00', to: '2026-11-09 00:03:00' },
      { from: '2026-11-09 00:02:00', to: '2026-11-09 00:04:00' },
    ] }, manual)).toThrow('重叠');
    expect(() => editedSession({ ...draft, flags: [{ atTime: '2026-11-09 00:11:00', label: '' }] }, manual)).toThrow('Flag');
  });

  it('edits a single target without moving switch boundaries or shortening its neighbour', async () => {
    const history = new VolatileHistoryStore(); history.appendEvents(events);
    const visit = buildVisits(history.getEvents(), '2026-11-09 08:00:00', '2026-11-09 08:20:00')[0];
    const draft = draftForVisit(visit, history.getRevision()); draft.endTime = '2026-11-09 08:15:00'; draft.note = 'corrected'; draft.disposition = 'reading';
    await new RecordEditingService(history).save(draft);
    expect([...history.getEvents()]).toEqual(events);
    const records = buildFileRecords(history.getEvents(), now, '2026-11-09');
    expect(records['a.md'].totalReadTime).toBe(900);
    expect(records['b.md'].totalReadTime).toBe(600);
    const visits = buildVisits(history.getEvents(), '2026-11-09 08:00:00', '2026-11-09 08:20:00');
    expect(visits.find(item => item.target === 'a.md')?.to).toBe('2026-11-09 08:15:00');
    expect(visits.find(item => item.target === 'b.md')?.from).toBe('2026-11-09 08:10:00');
    const repeated = draftForVisit(visits[0], history.getRevision());
    expect(repeated.spanId).toBe(draft.spanId);
    expect(repeated.originalTo).toBe('2026-11-09 08:10:00');
    expect(editsOf(getFileEvents(history.getEvents(), 'a.md'))).toHaveLength(1);
    expect(editsOf(getFileEvents(history.getEvents(), 'b.md'))).toHaveLength(0);
    expect(editsOf(getTimeRangeEvents(history.getEvents(), '2026-11-09 08:11:00', '2026-11-09 08:14:00'))).toHaveLength(1);
  });

  it('ignored correction removes just its target from visits, totals and the heatmap account', async () => {
    const history = new VolatileHistoryStore(); history.appendEvents(events);
    const draft = draftForVisit(buildVisits(history.getEvents(), '2026-11-09 08:00:00', '2026-11-09 08:20:00')[0], history.getRevision());
    draft.disposition = 'ignored';
    await new RecordEditingService(history).save(draft);
    expect(buildVisits(history.getEvents(), '2026-11-09 08:00:00', '2026-11-09 08:20:00').map(visit => visit.target)).toEqual(['b.md']);
    expect(buildFileRecords(history.getEvents(), now, '2026-11-09')['a.md'].totalReadTime).toBe(0);
    expect(dayAccount({ events: history.getEvents(), manual: [], countdown: [], day: '2026-11-09', nowMs: now,
      policy: { away: 'paused', idle: 'paused', pluginViews: true } }).reading).toBe(600);
    // 编辑列表保留忽略项，避免一次归类后无法恢复 / ignored items remain editable.
    const ignored = buildVisits(history.getEvents(), '2026-11-09 08:00:00', '2026-11-09 08:20:00', true).find(visit => visit.target === 'a.md');
    expect(ignored?.disposition).toBe('ignored');
    if (!ignored) throw new Error('Ignored interval missing from editor');
    const restore = draftForVisit(ignored, history.getRevision());
    restore.disposition = 'reading';
    await new RecordEditingService(history).save(restore);
    expect(buildFileRecords(history.getEvents(), now, '2026-11-09')['a.md'].totalReadTime).toBe(600);
  });

  it('rejects stale drafts and reports persistence failure while preserving the original', async () => {
    class FailedHistory extends VolatileHistoryStore {
      override async flushNow(): Promise<void> { throw new Error('disk unavailable'); }
    }
    const history = new FailedHistory(); history.appendManualSession(manual);
    const draft = draftForSession('manual', manual, history.getRevision()); draft.note = 'new';
    expect(await failureOf(() => new RecordEditingService(history).save(draft))).toContain('disk unavailable');
    expect(history.getManualSessions()[0].note).toBe('original');
    expect(history.getRecordEdits()).toEqual([]);
    expect(await failureOf(() => new RecordEditingService(history).save(draft))).toContain('disk unavailable');
  });

  it('permits unrelated new activity while rejecting a second edit to the same record', async () => {
    const history = new VolatileHistoryStore(); history.appendManualSession(manual);
    const draft = draftForSession('manual', history.getManualSessions()[0], history.getRevision()); draft.note = 'first edit';
    const stale = { ...draft, note: 'stale edit' };
    history.appendEvents(events);
    await new RecordEditingService(history).save(draft);
    expect(history.getManualSessions()[0].note).toBe('first edit');
    expect(await failureOf(() => new RecordEditingService(history).save(stale))).toContain('修改');
    const next = draftForSession('manual', history.getManualSessions()[0], history.getRevision()); next.note = 'second edit';
    history.appendCountdownSession({ ...manual, id: 'different source', mode: 'down', plannedSeconds: 900, completed: true, phases: [] });
    await new RecordEditingService(history).save(next);
    expect(history.getManualSessions()[0].note).toBe('second edit');
    expect(history.getRecordEdits()).toHaveLength(2);
  });

  it('multiple corrections subtract original extents before adding any replacement', async () => {
    const history = new VolatileHistoryStore(); history.appendEvents([
      ...events, { type: 'start', time: '2026-11-09 08:20:00', file: 'a.md', state: 'tracking' },
      { type: 'save', time: '2026-11-09 08:30:00', file: 'a.md', state: 'saved' },
    ]);
    const originals = buildVisits(history.getEvents(), '2026-11-09 08:00:00', '2026-11-09 08:30:00').filter(visit => visit.target === 'a.md');
    const first = draftForVisit(originals[0], history.getRevision()); first.startTime = '2026-11-09 08:15:00'; first.endTime = '2026-11-09 08:25:00'; first.disposition = 'reading';
    const second = draftForVisit(originals[1], history.getRevision()); second.startTime = '2026-11-09 08:25:00'; second.endTime = '2026-11-09 08:30:00'; second.disposition = 'reading';
    await new RecordEditingService(history).save(first);
    await new RecordEditingService(history).save(second);
    expect(buildFileRecords(history.getEvents(), now, '2026-11-09')['a.md'].totalReadTime).toBe(900);
    const visits = buildVisits(history.getEvents(), '2026-11-09 08:00:00', '2026-11-09 08:30:00').filter(visit => visit.target === 'a.md');
    expect(visits.map(visit => [visit.from, visit.to])).toEqual([
      ['2026-11-09 08:15:00', '2026-11-09 08:25:00'], ['2026-11-09 08:25:00', '2026-11-09 08:30:00'],
    ]);
  });

  it('keeps a midnight-spanning visit identity and full edit extent across clipped entry points', async () => {
    const history = new VolatileHistoryStore(); history.appendEvents([
      { type: 'start', time: '2026-11-08 23:50:00', file: 'view:rss-reader', activityTitle: 'Article', state: 'tracking' },
      { type: 'save', time: '2026-11-09 00:20:00', file: 'view:rss-reader', state: 'saved' },
    ]);
    const before = buildVisits(history.getEvents(), '2026-11-08 23:55:00', '2026-11-09 00:00:00')[0];
    const after = buildVisits(history.getEvents(), '2026-11-09 00:05:00', '2026-11-09 00:10:00')[0];
    expect(before.activeSeconds).toBe(300); expect(after.activeSeconds).toBe(300);
    const first = draftForVisit(before, history.getRevision());
    const otherEntry = draftForVisit(after, history.getRevision());
    expect(first.spanId).toBe(otherEntry.spanId);
    expect(first.sourceFingerprint).toBe(otherEntry.sourceFingerprint);
    expect(first.startTime).toBe('2026-11-08 23:50:00');
    expect(first.endTime).toBe('2026-11-09 00:20:00');
    first.startTime = '2026-11-08 23:58:00'; first.endTime = '2026-11-09 00:12:00'; first.disposition = 'reading';
    await new RecordEditingService(history).save(first);
    const narrowed = buildVisits(history.getEvents(), '2026-11-09 00:05:00', '2026-11-09 00:06:00')[0];
    const second = draftForVisit(narrowed, history.getRevision());
    expect(second.spanId).toBe(first.spanId);
    expect(second.originalFrom).toBe('2026-11-08 23:50:00');
    expect(second.originalTo).toBe('2026-11-09 00:20:00');
    expect(second.startTime).toBe('2026-11-08 23:58:00');
    expect(second.endTime).toBe('2026-11-09 00:12:00');
    second.endTime = '2026-11-09 00:15:00';
    await new RecordEditingService(history).save(second);
    expect(editsOf(history.getEvents())).toHaveLength(1);
    const visit = buildVisits(history.getEvents(), '2026-11-08 23:00:00', '2026-11-09 01:00:00')[0];
    expect(visit.from).toBe('2026-11-08 23:58:00');
    expect(visit.to).toBe('2026-11-09 00:15:00');
    expect(buildFileRecords(history.getEvents(), now, '2026-11-09')['view:rss-reader'].totalReadTime).toBe(1020);
    expect(buildFileRecords(history.getEvents(), now, '2026-11-09')['view:rss-reader'].readTimeToday).toBe(900);
  });

  it('updates the live card from corrected history and counts a new live round exactly once', async () => {
    const history = new VolatileHistoryStore(); history.appendEvents(events);
    const draft = draftForVisit(buildVisits(history.getEvents(), '2026-11-09 08:00:00', '2026-11-09 08:20:00')[0], history.getRevision());
    draft.endTime = '2026-11-09 08:05:00'; draft.disposition = 'reading';
    await new RecordEditingService(history).save(draft);
    expect(getTodaySeconds(history.getEvents(), null, 'a.md', '2026-11-09')).toBe(300);
    expect(history.getRecord('a.md')?.totalReadTime).toBe(300);
    history.appendEvents([{ type: 'start', time: '2026-11-09 10:00:00', file: 'a.md', state: 'tracking' }]);
    const live: TimerFileState = { filePath: 'a.md', status: 'tracking', sessionStartTime: '2026-11-09 10:00:00',
      activeSeconds: 5, pausedSeconds: 0, unfocusedSeconds: 0, lastTickTimestamp: new Date(2026, 10, 9, 10, 0, 5).getTime(),
      pauseStartTimestamp: null, sessionObject: { '2026-11-09 10:00:00': 'tracking' }, pausedRanges: [] };
    expect(getTodaySeconds(history.getEvents(), live, 'a.md', '2026-11-09')).toBe(305);
    history.deleteFileEvents('a.md');
    expect(buildFileRecords(history.getEvents(), now, '2026-11-09')['a.md']).toBeUndefined();
    expect(history.getRecord('a.md')).toBeNull();
  });

  it('keeps an open interval read-only until its real end is known', async () => {
    const history = new VolatileHistoryStore(); history.appendEvents([events[0]]);
    const visit = buildVisits(history.getEvents(), '2026-11-09 08:00:00', '2026-11-09 08:10:00')[0];
    const draft = draftForVisit(visit, history.getRevision()); draft.endTime = '2026-11-09 08:05:00';
    expect(await failureOf(() => new RecordEditingService(history).save(draft))).toContain('先停止');
    expect(history.getRecordEdits()).toEqual([]);
  });

  it('preserves legacy net duration and unchanged flag precision when only text changes', async () => {
    const legacy: ManualSession = { ...manual, startTime: '2026-11-09 08:00:00', endTime: '2026-11-09 09:00:00', durationMs: 600123,
      durationSeconds: 600, flags: [{ atTime: '2026-11-09 08:05:00', label: 'before', atSeconds: 120, atMs: 120456 }], pauses: [] };
    const history = new VolatileHistoryStore(); history.appendManualSession(legacy);
    const draft = draftForSession('manual', history.getManualSessions()[0], history.getRevision()); draft.note = 'note only'; draft.flags[0].label = 'renamed';
    await new RecordEditingService(history).save(draft);
    const saved = history.getManualSessions()[0];
    expect(saved.durationMs).toBe(600123); expect(saved.durationSeconds).toBe(600);
    expect(saved.flags[0].atMs).toBe(120456); expect(saved.flags[0].atSeconds).toBe(120);
    const add = draftForSession('manual', saved, history.getRevision()); add.flags.push({ atTime: '2026-11-09 08:06:00', label: 'unknown net position' });
    expect(await failureOf(() => new RecordEditingService(history).save(add))).toContain('缺少完整暂停');
    const repair = draftForSession('manual', saved, history.getRevision()); repair.endTime = '2026-11-09 08:10:00';
    await new RecordEditingService(history).save(repair);
    expect(history.getManualSessions()[0].durationMs).toBe(600000);
  });

  it('saves on a mobile runtime without randomUUID and preserves subsecond sessions', async () => {
    const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const history = new VolatileHistoryStore();
      const precise = { ...manual, startTime: '2026-11-09 08:00:00', endTime: '2026-11-09 08:00:02', durationMs: 1999, durationSeconds: 1 };
      history.appendManualSession(precise);
      const draft = draftForSession('manual', history.getManualSessions()[0], history.getRevision()); draft.note = 'mobile save';
      await new RecordEditingService(history).save(draft);
      expect(history.getManualSessions()[0].durationMs).toBe(1999);
      expect(history.getRecordEdits()[0].editId.startsWith('edit-')).toBe(true);
    } finally {
      if (original) Object.defineProperty(crypto, 'randomUUID', original);
      else Reflect.deleteProperty(crypto, 'randomUUID');
    }
  });

  it('preserves all automatic channels for clipped-entry note edits and requires explicit attribution for changed bounds', async () => {
    const history = new VolatileHistoryStore(); history.appendEvents([
      { type: 'start', time: '2026-11-09 08:00:00', file: 'view:reader', state: 'tracking' },
      { type: 'pause', time: '2026-11-09 08:01:00', file: 'view:reader', state: 'pausing' },
      { type: 'resume', time: '2026-11-09 08:02:00', file: 'view:reader', state: 'tracking' },
      { type: 'blur', time: '2026-11-09 08:03:00', file: 'view:reader', unfocusedDisposition: 'ignored' },
      { type: 'focus', time: '2026-11-09 08:05:00', file: 'view:reader', state: 'tracking' },
      { type: 'idle', time: '2026-11-09 08:06:00', file: 'view:reader', state: 'idle' },
      { type: 'idle-end', time: '2026-11-09 08:08:00', file: 'view:reader', state: 'tracking' },
      { type: 'save', time: '2026-11-09 08:10:00', file: 'view:reader', state: 'saved' },
    ]);
    const account = (): ReturnType<typeof dayAccount> => dayAccount({ events: history.getEvents(), manual: [], countdown: [], day: '2026-11-09', nowMs: now,
      policy: { away: 'paused', idle: 'ignored', pluginViews: true } });
    const before = account();
    const timeline = buildFileRecords(history.getEvents(), now, '2026-11-09')['view:reader'].readTimeLine;
    const clipped = buildVisits(history.getEvents(), '2026-11-09 08:02:30', '2026-11-09 08:02:45')[0];
    const draft = draftForVisit(clipped, history.getRevision()); expect(draft.disposition).toBe('preserve'); draft.note = 'notes only';
    await new RecordEditingService(history).save(draft);
    expect(account()).toEqual(before);
    expect(buildFileRecords(history.getEvents(), now, '2026-11-09')['view:reader'].readTimeLine).toEqual(timeline);
    const edited = buildVisits(history.getEvents(), '2026-11-09 08:02:30', '2026-11-09 08:02:45')[0];
    expect(edited.note).toBe('notes only');
    const changed = draftForVisit(edited, history.getRevision()); changed.endTime = '2026-11-09 08:12:00';
    expect(await failureOf(() => new RecordEditingService(history).save(changed))).toContain('选择计入');
    changed.disposition = 'reading';
    await new RecordEditingService(history).save(changed);
    expect(account().reading).toBe(720);
    expect(account().paused).toBe(0);
  });
});

describe('SQLite correction persistence', () => {
  it('persists same-ID session edits, invalidates revisions and retains source and countdown fields', async () => {
    const disk = adapter(); const store = new SqliteStore(disk, dbPath, silentLogger); await store.init();
    const countdown: CountdownSession = { ...manual, id: 'countdown', mode: 'down', plannedSeconds: 900, completed: true, phases: [{ kind: 'focus', seconds: 900 }] };
    store.appendCountdownSession(countdown); store.appendManualSession(manual);
    const revision = store.getRevision();
    const draft = draftForSession('countdown', countdown, revision); draft.note = 'edited countdown'; draft.endTime = '2026-11-09 00:05:00';
    await new RecordEditingService(store).save(draft);
    expect(store.getRevision()).toBeGreaterThan(revision);
    expect(store.getCountdownSessions()[0].durationSeconds).toBe(600);
    expect(store.getCountdownSessions()[0].mode).toBe('down');
    expect(store.getManualSessions()[0].note).toBe('original');
    await store.close();
    const reopened = new SqliteStore(disk, dbPath, silentLogger); await reopened.init();
    expect(reopened.getCountdownSessions()[0].note).toBe('edited countdown');
    expect(reopened.getRecordEdits()).toHaveLength(1);
    expect(() => parseRecordEdit('{"kind":"manual"}')).toThrow();
    await reopened.close();
  });

  it('merges old snapshots without reviving original values, and transfers manual pauses', async () => {
    const disk = adapter(); const first = new SqliteStore(disk, dbPath, silentLogger); await first.init();
    first.appendManualSession({ ...manual, pauses: [{ from: '2026-11-08 23:58:00', to: '2026-11-09 00:02:00' }] });
    await first.flushNow({ force: true });
    const originalSnapshot = await disk.readBinary(dbPath);
    const second = new SqliteStore(disk, dbPath, silentLogger); await second.init();
    const draft = draftForSession('manual', first.getManualSessions()[0], first.getRevision()); draft.note = 'new value';
    await new RecordEditingService(first).save(draft);
    second.appendManualSession({ ...manual, id: 'other' }); await second.flushNow({ force: true });
    expect(second.getManualSessions().find(session => session.id === 'round')?.note).toBe('new value');
    disk.seedBinary(dbPath, originalSnapshot);
    first.appendEvents(events); await first.flushNow({ force: true });
    expect(first.getManualSessions().find(session => session.id === 'round')?.note).toBe('new value');
    // 新轮次从另一端合并时，暂停必须随之保留 / pauses survive insertion from another snapshot.
    first.appendManualSession({ ...manual, id: 'new-paused', pauses: [{ from: '2026-11-08 23:58:00', to: '2026-11-09 00:02:00' }] });
    await first.flushNow({ force: true });
    second.appendEvents([{ type: 'start', time: '2026-11-09 09:00:00', file: 'new.md', state: 'tracking' }]);
    await second.flushNow({ force: true });
    expect(second.getManualSessions().find(session => session.id === 'new-paused')?.pauses).toHaveLength(1);
    await first.close(); await second.close();
  });

  it('throws a real SQLite write failure and keeps the original effective record', async () => {
    class FailingAdapter extends MemoryAdapter {
      failWrites = false;
      override async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
        if (this.failWrites) throw new Error('storage full');
        await super.writeBinary(path, data);
      }
    }
    const seed = adapter();
    const disk = new FailingAdapter({ 'sql-wasm.wasm': await seed.readPluginBinary('sql-wasm.wasm') });
    const store = new SqliteStore(disk, dbPath, silentLogger); await store.init();
    store.appendManualSession(manual); await store.flushNow({ force: true });
    const draft = draftForSession('manual', manual, store.getRevision()); draft.note = 'should not save'; disk.failWrites = true;
    expect(await failureOf(() => new RecordEditingService(store).save(draft))).toContain('storage full');
    expect(store.getManualSessions()[0].note).toBe('original');
    expect(store.getRecordEdits()).toEqual([]);
    disk.failWrites = false; await store.close();
  });
});
