import { isPluginViewKey } from './activePath';
import { formatLocalFull, parseSessionStartTime } from './time';
import type { TargetVisit } from './activityVisits';
import type { AttributionPolicy, CountdownSession, FileRecord, ManualFlag, ManualPause, ManualSession, SessionStateMap, TimelineEvent } from './types';

interface SessionEditFields {
  id: string;
  baseRevision: number;
  baseEditVersion?: number;
  sourceFingerprint?: string;
  startTime: string;
  endTime: string;
  note: string;
  pauses: ManualPause[];
  flags: Array<{ atTime: string; label: string; phase?: number }>;
}
export type SessionEditDraft = SessionEditFields & ({ kind: 'manual' } | { kind: 'countdown' });

interface VisitEditFields {
  target: string;
  spanId: string;
  baseRevision: number;
  baseEditVersion?: number;
  sourceFingerprint?: string;
  /** 首次编辑的原时段不可变 / immutable original extent. */
  originalFrom: string;
  originalTo: string;
  startTime: string;
  endTime: string;
  disposition: AttributionPolicy | 'preserve';
  note: string;
  activityTitle?: string;
  open?: boolean;
}
export type VisitEditDraft = VisitEditFields & ({ kind: 'document' } | { kind: 'view' });

export type RecordEditDraft = SessionEditDraft | VisitEditDraft;

/** 追加保存更正，不改原始事件或轮次 / immutable correction, leaving source rows intact. */
export type RecordEdit = {
  editId: string;
  recordKey: string;
  version: number;
  updatedAt: string;
  sourceFingerprint?: string;
} & ({ kind: 'manual'; session: ManualSession } | { kind: 'countdown'; session: CountdownSession } | { kind: 'document' | 'view'; visit: VisitEditDraft });

export type VisitRecordEdit = Extract<RecordEdit, { kind: 'document' | 'view' }>;

/** 原事件仍可按数组读取，派生器额外读取更正 / source events plus explicit read-model metadata. */
export interface EventHistory extends Array<TimelineEvent> {
  readonly recordEdits?: readonly VisitRecordEdit[];
}

export function editsOf(events: readonly TimelineEvent[]): readonly VisitRecordEdit[] {
  return (events as Readonly<EventHistory>).recordEdits ?? [];
}

export function eventHistory(events: readonly TimelineEvent[], edits: readonly RecordEdit[]): EventHistory {
  return Object.defineProperty([...events], 'recordEdits', { value: latestRecordEdits(edits).filter((edit): edit is VisitRecordEdit => edit.kind === 'document' || edit.kind === 'view'), enumerable: false });
}

export function visitSpanId(target: string, from: string, to: string): string {
  return JSON.stringify([target, from, to]);
}

export function draftForSession(kind: 'manual' | 'countdown', session: ManualSession, revision: number): SessionEditDraft {
  return { kind, id: session.id, baseRevision: revision, startTime: session.startTime, endTime: session.endTime,
    baseEditVersion: sessionEditVersion(session), sourceFingerprint: sessionFingerprint(session),
    note: session.note, pauses: session.pauses.map(pause => ({ ...pause })),
    flags: session.flags.map(flag => ({ atTime: flag.atTime, label: flag.label, phase: flag.phase })) };
}

export function draftForVisit(visit: TargetVisit, revision: number): VisitEditDraft {
  const originalFrom = visit.originalFrom ?? visit.from;
  const originalTo = visit.originalTo ?? visit.to;
  return { kind: isPluginViewKey(visit.target) ? 'view' : 'document', target: visit.target,
    spanId: visitSpanId(visit.target, originalFrom, originalTo), baseRevision: revision,
    originalFrom, originalTo, startTime: visit.editStartTime ?? originalFrom, endTime: visit.editEndTime ?? originalTo,
    baseEditVersion: visit.editVersion ?? 0, sourceFingerprint: visit.sourceFingerprint ?? visitFingerprint(visit),
    disposition: visit.disposition ?? 'preserve',
    note: visit.note ?? '', activityTitle: visit.title, open: visit.isOpen };
}

export function sessionFingerprint(session: ManualSession): string {
  return JSON.stringify({ id: session.id, startTime: session.startTime, endTime: session.endTime, durationSeconds: session.durationSeconds,
    durationMs: session.durationMs ?? session.durationSeconds * 1000, note: session.note, pauses: session.pauses, flags: session.flags });
}

function sessionEditVersion(session: ManualSession): number {
  return 'recordEditVersion' in session && typeof session.recordEditVersion === 'number' ? session.recordEditVersion : 0;
}

export function visitFingerprint(visit: TargetVisit): string {
  return JSON.stringify([visit.target, visit.from, visit.to, visit.title ?? '', visit.activeSeconds, visit.unfocusedSeconds, visit.pausedSeconds]);
}

const visitSourceIndexes = new WeakMap<readonly TimelineEvent[], Map<string, TimelineEvent[]>>();

export function visitSourceFingerprint(events: readonly TimelineEvent[], target: string, from: string, to: string): string {
  let index = visitSourceIndexes.get(events);
  if (!index) {
    index = new Map();
    for (const event of events) {
      const targets = event.type === 'switch' ? new Set([event.from, event.to]) : [event.file];
      for (const key of targets) {
        const existing = index.get(key);
        if (existing) existing.push(event);
        else index.set(key, [event]);
      }
    }
    visitSourceIndexes.set(events, index);
  }
  return JSON.stringify([target, from, to, (index.get(target) ?? []).filter(event => event.time >= from && event.time <= to)]);
}

export function recordKeyOf(draft: RecordEditDraft): string {
  return draft.kind === 'manual' || draft.kind === 'countdown' ? `${draft.kind}:${draft.id}` : `${draft.kind}:${draft.spanId}`;
}

export function latestRecordEdits(edits: readonly RecordEdit[]): RecordEdit[] {
  const latest = new Map<string, RecordEdit>();
  for (const edit of edits) {
    const previous = latest.get(edit.recordKey);
    if (!previous || edit.version > previous.version || (edit.version === previous.version && `${edit.updatedAt}|${edit.editId}` > `${previous.updatedAt}|${previous.editId}`)) latest.set(edit.recordKey, edit);
  }
  return [...latest.values()];
}

export function assertEditCurrent(edit: RecordEdit, edits: readonly RecordEdit[], sourceFingerprint: string | undefined): void {
  const previous = latestRecordEdits(edits).find(saved => saved.recordKey === edit.recordKey);
  if ((previous?.version ?? 0) !== edit.version - 1 || (edit.sourceFingerprint !== undefined && edit.sourceFingerprint !== sourceFingerprint)) throw new Error('这条记录已发生变化，请重新打开后编辑。');
}

export function sessionsWithEdits<T extends ManualSession>(kind: 'manual' | 'countdown', sessions: readonly T[], edits: readonly RecordEdit[]): T[] {
  const latest = new Map(latestRecordEdits(edits).filter(edit => edit.kind === kind).map(edit => [edit.recordKey, edit]));
  return sessions.map(session => {
    const edit = latest.get(`${kind}:${session.id}`);
    const result = edit && (edit.kind === 'manual' || edit.kind === 'countdown') ? { ...session, ...edit.session } : { ...session };
    return Object.defineProperty(result, 'recordEditVersion', { value: edit?.version ?? 0, enumerable: false });
  }).sort((a, b) => a.startTime.localeCompare(b.startTime));
}

export function timestampMs(value: string): number {
  const date = parseSessionStartTime(value);
  if (!date || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value) || formatLocalFull(date).slice(0, value.length) !== value.replace('T', ' ')) throw new Error('时间格式无效，请使用 YYYY-MM-DD HH:mm:ss。');
  return date.getTime();
}

/** 一处校验并重算净时长与 Flag 累计 / validate once and derive every net counter. */
export function editedSession(draft: SessionEditDraft, original: ManualSession): ManualSession {
  const start = timestampMs(draft.startTime);
  const end = timestampMs(draft.endTime);
  if (end <= start) throw new Error('结束时间必须晚于开始时间。');
  const pauses = draft.pauses.map(pause => ({ ...pause, start: timestampMs(pause.from), end: timestampMs(pause.to) })).sort((a, b) => a.start - b.start);
  let cursor = start;
  for (const pause of pauses) {
    if (pause.start < start || pause.end > end || pause.end <= pause.start || pause.start < cursor) throw new Error('暂停时段必须位于本轮内，且不能重叠。');
    cursor = pause.end;
  }
  const netAt = (at: number): number => at - start - pauses.reduce((sum, pause) => sum + Math.max(0, Math.min(at, pause.end) - pause.start), 0);
  const originalPauses = original.pauses.map(pause => [timestampMs(pause.from), timestampMs(pause.to)]).sort((a, b) => a[0] - b[0]);
  const sameStructure = start === timestampMs(original.startTime) && end === timestampMs(original.endTime)
    && pauses.length === originalPauses.length && pauses.every((pause, index) => pause.start === originalPauses[index][0] && pause.end === originalPauses[index][1]);
  const storedDurationMs = original.durationMs ?? original.durationSeconds * 1000;
  const durationMs = sameStructure ? storedDurationMs : netAt(end);
  const incompleteLegacy = sameStructure && Math.abs(storedDurationMs - netAt(end)) > 1000;
  const flags: ManualFlag[] = draft.flags.map(flag => ({ ...flag, time: timestampMs(flag.atTime) })).sort((a, b) => a.time - b.time).map(flag => {
    if (flag.time < start || flag.time > end) throw new Error('Flag 必须位于本轮时间范围内。');
    const previous = original.flags.find(saved => timestampMs(saved.atTime) === flag.time && saved.phase === flag.phase);
    if (sameStructure && previous) return { ...previous, atTime: flag.atTime, label: flag.label.trim(), phase: flag.phase };
    if (incompleteLegacy) throw new Error('旧记录缺少完整暂停时段，无法确定新 Flag 的累计时间；请先补齐暂停或修正起止时间。');
    const atMs = Math.min(durationMs, netAt(flag.time));
    return { atTime: flag.atTime, label: flag.label.trim(), phase: flag.phase, atMs, atSeconds: Math.floor(atMs / 1000) };
  });
  return { ...original, startTime: draft.startTime, endTime: draft.endTime, note: draft.note.trim(), durationMs,
    durationSeconds: sameStructure ? original.durationSeconds : Math.floor(durationMs / 1000), pauses: pauses.map(pause => ({ from: pause.from, to: pause.to })), flags };
}

export function validateVisitDraft(draft: VisitEditDraft): void {
  if (timestampMs(draft.endTime) <= timestampMs(draft.startTime) || timestampMs(draft.originalTo) <= timestampMs(draft.originalFrom)) throw new Error('结束时间必须晚于开始时间。');
  if (!draft.target || draft.spanId !== visitSpanId(draft.target, draft.originalFrom, draft.originalTo)) throw new Error('原始记录标识不匹配，请重新打开记录。');
  if ((draft.kind === 'view') !== isPluginViewKey(draft.target)) throw new Error('记录来源类型不匹配。');
  if (!['preserve', 'reading', 'paused', 'ignored'].includes(draft.disposition)) throw new Error('时段归类无效。');
  if (draft.disposition === 'preserve' && (timestampMs(draft.startTime) !== timestampMs(draft.originalFrom) || timestampMs(draft.endTime) !== timestampMs(draft.originalTo))) throw new Error('修改起止时间后，请选择计入阅读、暂停或不计时。');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSession(value: unknown): value is ManualSession {
  if (!isObject(value)) return false;
  return typeof value.id === 'string' && typeof value.startTime === 'string' && typeof value.endTime === 'string'
    && typeof value.durationSeconds === 'number' && Number.isFinite(value.durationSeconds) && typeof value.note === 'string'
    && (value.durationMs === undefined || (typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)))
    && Array.isArray(value.pauses) && value.pauses.every(pause => isObject(pause) && typeof pause.from === 'string' && typeof pause.to === 'string')
    && Array.isArray(value.flags) && value.flags.every(flag => isObject(flag) && typeof flag.atTime === 'string' && typeof flag.label === 'string' && typeof flag.atSeconds === 'number' && Number.isFinite(flag.atSeconds));
}

/** 外部 JSON 先收窄再读取，不让坏更正静默覆盖历史 / narrow external correction payloads before use. */
export function parseRecordEdit(payload: string): RecordEdit {
  const value: unknown = JSON.parse(payload);
  if (!isObject(value) || typeof value.editId !== 'string' || typeof value.recordKey !== 'string' || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.updatedAt !== 'string') throw new Error('记录更正数据无效。');
  if (value.sourceFingerprint !== undefined && typeof value.sourceFingerprint !== 'string') throw new Error('记录更正指纹无效。');
  const metadata = { editId: value.editId, recordKey: value.recordKey, version: value.version, updatedAt: value.updatedAt, sourceFingerprint: value.sourceFingerprint };
  if (value.kind === 'manual' && isSession(value.session)) return { ...metadata, kind: 'manual', session: value.session };
  if (value.kind === 'countdown' && isSession(value.session) && isObject(value.session)
    && ['down', 'pomodoro', 'interval'].includes(typeof value.session.mode === 'string' ? value.session.mode : '')
    && typeof value.session.plannedSeconds === 'number' && typeof value.session.completed === 'boolean' && Array.isArray(value.session.phases)) {
    const session = value.session;
    if ((session.mode === 'down' || session.mode === 'pomodoro' || session.mode === 'interval') && typeof session.plannedSeconds === 'number' && typeof session.completed === 'boolean' && Array.isArray(session.phases)) {
      const phases = session.phases;
      if (phases.every((phase: unknown) => isObject(phase) && typeof phase.seconds === 'number' && (phase.kind === 'focus' || phase.kind === 'break' || phase.kind === 'segment'))) {
        // 会话基础字段已校验，倒计时附加字段逐一复制 / copy narrowed countdown fields explicitly.
        return { ...metadata, kind: 'countdown', session: { ...session, mode: session.mode, plannedSeconds: session.plannedSeconds,
          completed: session.completed, phases: phases.map((phase: unknown) => {
            if (!isObject(phase) || typeof phase.seconds !== 'number' || (phase.kind !== 'focus' && phase.kind !== 'break' && phase.kind !== 'segment')) throw new Error('倒计时更正阶段无效。');
            return { kind: phase.kind, seconds: phase.seconds };
          }) } };
      }
    }
  }
  if ((value.kind === 'document' || value.kind === 'view') && isObject(value.visit)) {
    const visit = value.visit;
    if (visit.kind === value.kind && typeof visit.target === 'string' && typeof visit.spanId === 'string' && typeof visit.baseRevision === 'number'
      && typeof visit.originalFrom === 'string' && typeof visit.originalTo === 'string' && typeof visit.startTime === 'string' && typeof visit.endTime === 'string'
      && typeof visit.note === 'string' && (visit.disposition === 'preserve' || visit.disposition === 'reading' || visit.disposition === 'paused' || visit.disposition === 'ignored')
      && (visit.activityTitle === undefined || typeof visit.activityTitle === 'string')) {
      const draft: VisitEditDraft = { kind: value.kind, target: visit.target, spanId: visit.spanId, baseRevision: visit.baseRevision,
        baseEditVersion: typeof visit.baseEditVersion === 'number' ? visit.baseEditVersion : undefined,
        sourceFingerprint: typeof visit.sourceFingerprint === 'string' ? visit.sourceFingerprint : undefined,
        originalFrom: visit.originalFrom, originalTo: visit.originalTo, startTime: visit.startTime, endTime: visit.endTime,
        note: visit.note, disposition: visit.disposition, activityTitle: visit.activityTitle };
      validateVisitDraft(draft);
      return { ...metadata, kind: value.kind, visit: draft };
    }
  }
  throw new Error('记录更正内容无效。');
}

/** 保留更正元数据的筛选，用于按目标/日期读取 / filtering without losing correction metadata. */
export function filterEventHistory(events: readonly TimelineEvent[], predicate: (event: TimelineEvent) => boolean, editPredicate: (edit: VisitRecordEdit) => boolean = () => true): EventHistory {
  return Object.defineProperty(events.filter(predicate), 'recordEdits', { value: editsOf(events).filter(editPredicate), enumerable: false });
}

export function applyVisitEdits(visits: readonly TargetVisit[], events: readonly TimelineEvent[], from: string, to: string, includeIgnored = false): TargetVisit[] {
  let result = [...visits];
  for (const edit of editsOf(events)) {
    const draft = edit.visit;
    if (draft.disposition === 'preserve') continue;
    result = result.flatMap(visit => {
      if (visit.target !== draft.target || visit.to <= draft.originalFrom || visit.from >= draft.originalTo) return [visit];
      const parts = [{ from: visit.from, to: visit.to < draft.originalFrom ? visit.to : draft.originalFrom },
        { from: visit.from > draft.originalTo ? visit.from : draft.originalTo, to: visit.to }].filter(part => part.to > part.from);
      const extent = timestampMs(visit.to) - timestampMs(visit.from);
      return parts.map(part => {
        const ratio = (timestampMs(part.to) - timestampMs(part.from)) / extent;
        return { ...visit, ...part, activeSeconds: visit.activeSeconds * ratio, unfocusedSeconds: visit.unfocusedSeconds * ratio, pausedSeconds: visit.pausedSeconds * ratio };
      });
    });
  }
  // 所有原时段剪除后才放回替代段，避免更正之间互相剪掉 / replacements cannot erase one another.
  for (const edit of editsOf(events)) {
    const draft = edit.visit;
    if (draft.disposition === 'preserve') {
      result = result.map(visit => visit.target === draft.target && (visit.originalFrom ?? visit.from) === draft.originalFrom && (visit.originalTo ?? visit.to) === draft.originalTo
        ? { ...visit, note: draft.note, disposition: 'preserve', editVersion: edit.version, sourceFingerprint: draft.sourceFingerprint,
          editStartTime: draft.startTime, editEndTime: draft.endTime } : visit);
      continue;
    }
    const start = draft.startTime > from ? draft.startTime : from;
    const end = draft.endTime < to ? draft.endTime : to;
    if (end > start && (draft.disposition !== 'ignored' || includeIgnored)) {
      const seconds = (timestampMs(end) - timestampMs(start)) / 1000;
      result.push({ target: draft.target, title: draft.activityTitle, from: start, to: end,
        originalFrom: draft.originalFrom, originalTo: draft.originalTo, disposition: draft.disposition, note: draft.note,
        editVersion: edit.version, sourceFingerprint: draft.sourceFingerprint,
        editStartTime: draft.startTime, editEndTime: draft.endTime,
        activeSeconds: draft.disposition === 'reading' ? seconds : 0, pausedSeconds: draft.disposition === 'paused' ? seconds : 0,
        unfocusedSeconds: 0, nextTarget: null });
    }
  }
  return result.sort((a, b) => a.from.localeCompare(b.from));
}

/** 对单个目标剪除原时段，添加独立替代时段，不移动 switch / replace only the edited target's extent. */
export function applyFileRecordEdits(records: Record<string, FileRecord>, events: readonly TimelineEvent[], today: string, options: { countUnfocused?: boolean; countPluginViews?: boolean }, nowMs: number): Record<string, FileRecord> {
  for (const edit of editsOf(events)) {
    const draft = edit.visit;
    if (draft.disposition === 'preserve') continue;
    const record = records[draft.target] ??= { fileName: draft.activityTitle || draft.target.split('/').pop() || draft.target,
      totalReadTime: 0, unfocusedReadTime: 0, unfocusedReadTimeToday: 0, readTimeToday: 0,
      lastReadAt: '', readTimeLine: [], hasAbnormalSession: false };
    const timelines: SessionStateMap[] = [];
    for (const session of record.readTimeLine) {
      const times = Object.keys(session).sort();
      for (let index = 0; index < times.length - 1; index++) {
        const start = times[index];
        const end = times[index + 1];
        const state = session[start];
        if (start >= draft.originalTo || end <= draft.originalFrom) timelines.push({ [start]: state, [end]: 'saved' });
        else {
          if (start < draft.originalFrom) timelines.push({ [start]: state, [draft.originalFrom]: 'saved' });
          if (end > draft.originalTo) timelines.push({ [draft.originalTo]: state, [end]: 'saved' });
        }
      }
      // 真实正在运行的尾部交给 account 的 live 状态 / preserve genuine live tails.
      const last = times[times.length - 1];
      if (last && session[last] !== 'saved') timelines.push({ [last]: session[last] });
    }
    record.readTimeLine = timelines;
  }
  for (const edit of editsOf(events)) {
    const draft = edit.visit;
    if (draft.disposition === 'preserve') continue;
    const record = records[draft.target];
    record.readTimeLine.push({ [draft.startTime]: draft.disposition === 'reading' ? 'tracking' : draft.disposition === 'paused' ? 'pausing' : 'ignored', [draft.endTime]: 'saved' });
    const recordTimes = record.readTimeLine.flatMap(session => Object.keys(session)).sort();
    record.lastReadAt = recordTimes[recordTimes.length - 1]?.slice(0, 10) ?? '';
    if (draft.activityTitle) record.fileName = draft.activityTitle;
  }
  const targets = new Set(editsOf(events).filter(edit => edit.visit.disposition !== 'preserve').map(edit => edit.visit.target));
  const dayStart = timestampMs(`${today} 00:00:00`);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  for (const target of targets) {
    const record = records[target];
    if (!record) continue;
    let reading = 0; let away = 0; let todayReading = 0; let todayAway = 0;
    for (const session of record.readTimeLine) {
      const times = Object.keys(session).sort();
      const last = times[times.length - 1];
      const lastMs = last ? parseSessionStartTime(last)?.getTime() : undefined;
      if (last && session[last] !== 'saved' && lastMs !== undefined && nowMs > lastMs && nowMs - lastMs <= 24 * 60 * 60 * 1000) times.push(formatLocalFull(new Date(nowMs)));
      for (let index = 0; index < times.length - 1; index++) {
        const start = parseSessionStartTime(times[index])?.getTime(); const end = parseSessionStartTime(times[index + 1])?.getTime();
        if (start === undefined || end === undefined) continue;
        const seconds = Math.max(0, end - start) / 1000;
        const daySeconds = Math.max(0, Math.min(end, dayEnd.getTime()) - Math.max(start, dayStart)) / 1000;
        const state = session[times[index]];
        if (state === 'inactive') { away += seconds; todayAway += daySeconds; }
        if (state === 'tracking' || (state === 'inactive' && options.countUnfocused !== false)) { reading += seconds; todayReading += daySeconds; }
      }
    }
    const include = options.countPluginViews !== false || !isPluginViewKey(target);
    record.totalReadTime = include ? reading : 0;
    record.readTimeToday = include ? todayReading : 0;
    record.unfocusedReadTime = away;
    record.unfocusedReadTimeToday = todayAway;
  }
  return records;
}
