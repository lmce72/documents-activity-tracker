/**
 * SQLite schema and row mapping
 *
 * Design notes:
 *
 *      Events carry both flattened columns (for indexing/aggregation) and a `raw` JSON
 *      copy of the original object; reads trust `raw`, so the round trip is lossless.
 *      The migration layer promises to keep every original field, and storage must not
 *      be the place that drops it.
 *
 *      The per-second session map (`readTimeLine`) is not stored: it is derivable from
 *      the event stream by core/timeline.ts. Only events and statistics are persisted.
 *
 *      The records table is a materialised statistic, not the source of truth. Its totals
 *      come from the live counter at save time (matching the old applySessionSave),
 *      while derived views are recomputed from events. Two independent figures on
 *      purpose, so they can be cross-checked.
 *
 */

import type {
  CountdownMode,
  CountdownPhase,
  CountdownSession,
  ManualFlag,
  ManualPause,
  ManualSession,
  RecordEntry,
  TimelineEvent,
} from '../../core/types';

/**
 * schema version, kept in the meta table.
 * 1 → 2: manual_sessions gains the `flags` column for manual-timer marks.
 * 2 → 3: manual_sessions gains `pauses`; 3 → 4 adds the separate `countdown_sessions` table;
 * 4 → 5 adds `duration_ms` to both, because the arithmetic is millisecond-based and a whole-second
 * column would throw the fraction away at save time.
 */
export const SQLITE_SCHEMA_VERSION = 5;

/** the meta key holding the schema version. */
export const META_SCHEMA_VERSION = 'schema_version';

/**
 */
export const SQL_CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  time              TEXT    NOT NULL,
  type              TEXT    NOT NULL,
  file              TEXT,
  from_path         TEXT,
  to_path           TEXT,
  state             TEXT,
  reason            TEXT,
  duration          REAL,
  active_seconds    REAL,
  unfocused_seconds REAL,
  raw               TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_time ON events(time);
CREATE INDEX IF NOT EXISTS idx_events_file ON events(file);
CREATE INDEX IF NOT EXISTS idx_events_from ON events(from_path);
CREATE INDEX IF NOT EXISTS idx_events_to   ON events(to_path);

CREATE TABLE IF NOT EXISTS records (
  file_path            TEXT PRIMARY KEY,
  file_name            TEXT NOT NULL,
  total_read_time      REAL NOT NULL DEFAULT 0,
  unfocused_read_time  REAL NOT NULL DEFAULT 0,
  last_read_at         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS manual_sessions (
  id               TEXT PRIMARY KEY,
  start_time       TEXT NOT NULL,
  end_time         TEXT NOT NULL,
  duration_seconds REAL NOT NULL,
  duration_ms      REAL NOT NULL DEFAULT 0,
  note             TEXT NOT NULL DEFAULT '',
  flags            TEXT NOT NULL DEFAULT '[]',
  pauses           TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_manual_start ON manual_sessions(start_time);

--  倒计时自成一表 / the countdown keeps its own table.
--
--  与 manual_sessions 分表的理由不是性能，而是隔离：正计时的总计、热力图与记录列表只查
--  manual_sessions，倒计时的任何一条都进不去，反之亦然。
--  The reason is isolation, not speed: the count-up's totals, heatmap and list query only
--  manual_sessions, so no countdown row can leak in — or the other way round.
CREATE TABLE IF NOT EXISTS countdown_sessions (
  id               TEXT PRIMARY KEY,
  mode             TEXT NOT NULL,
  start_time       TEXT NOT NULL,
  end_time         TEXT NOT NULL,
  planned_seconds  REAL NOT NULL DEFAULT 0,
  duration_seconds REAL NOT NULL,
  duration_ms      REAL NOT NULL DEFAULT 0,
  completed        INTEGER NOT NULL DEFAULT 0,
  note             TEXT NOT NULL DEFAULT '',
  flags            TEXT NOT NULL DEFAULT '[]',
  pauses           TEXT NOT NULL DEFAULT '[]',
  phases           TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_countdown_start ON countdown_sessions(start_time);
`;

/**
 * add the `flags` column.
 *
 * This is required and the DDL above cannot replace it: `CREATE TABLE IF NOT EXISTS`
 * does nothing to an existing table and never adds a column, so a v1 database would keep
 * the old shape and every insert carrying `flags` would fail with "no such column".
 */
/** v2 -> v3: the `pauses` column. Same reasoning as v1 -> v2: `CREATE TABLE IF NOT EXISTS`
 *  never adds a column, so an existing table needs the explicit ALTER. */
export const SQL_MIGRATE_V2_TO_V3 =
  "ALTER TABLE manual_sessions ADD COLUMN pauses TEXT NOT NULL DEFAULT '[]';";

/** v4 -> v5: 毫秒列 / the millisecond columns. */
export const SQL_MIGRATE_V4_TO_V5_MANUAL =
  'ALTER TABLE manual_sessions ADD COLUMN duration_ms REAL NOT NULL DEFAULT 0;';
export const SQL_MIGRATE_V4_TO_V5_COUNTDOWN =
  'ALTER TABLE countdown_sessions ADD COLUMN duration_ms REAL NOT NULL DEFAULT 0;';

export const SQL_MIGRATE_V1_TO_V2 =
  "ALTER TABLE manual_sessions ADD COLUMN flags TEXT NOT NULL DEFAULT '[]';";

/** A row of the events table. */
export interface EventRow {
  time: string;
  type: string;
  file: string | null;
  from_path: string | null;
  to_path: string | null;
  state: string | null;
  reason: string | null;
  duration: number | null;
  active_seconds: number | null;
  unfocused_seconds: number | null;
  raw: string;
}

/** A row of the records table. */
export interface RecordRow {
  file_path: string;
  file_name: string;
  total_read_time: number;
  unfocused_read_time: number;
  last_read_at: string;
}

/** A row of the manual_sessions table. */
export interface ManualSessionRow {
  id: string;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  /** millisecond figure; absent in rows written before v5 */
  duration_ms?: number;
  note: string;
  /** the marks, as JSON text */
  flags?: string;
  /** the pauses, as JSON text */
  pauses?: string;
}

/** A row of the countdown_sessions table. */
export interface CountdownSessionRow {
  id: string;
  mode: string;
  start_time: string;
  end_time: string;
  planned_seconds: number;
  duration_seconds: number;
  /** millisecond figure; absent in rows written before v5 */
  duration_ms?: number;
  /** SQLite has no boolean: 0/1 */
  completed: number;
  note: string;
  flags?: string;
  pauses?: string;
  phases?: string;
}

/** Read an optional numeric field off an event. */
function numField(event: TimelineEvent, key: string): number | null {
  const value = (event as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read an optional string field off an event. */
function strField(event: TimelineEvent, key: string): string | null {
  const value = (event as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Event to row.
 * `raw` holds the whole original object; the columns are a projection of it.
 */
export function eventToRow(event: TimelineEvent): EventRow {
  return {
    time: event.time,
    type: event.type,
    file: strField(event, 'file'),
    from_path: strField(event, 'from'),
    to_path: strField(event, 'to'),
    state: strField(event, 'state'),
    reason: strField(event, 'reason'),
    duration: numField(event, 'duration'),
    active_seconds: numField(event, 'activeSeconds'),
    unfocused_seconds: numField(event, 'unfocusedSeconds'),
    raw: JSON.stringify(event),
  };
}

/**
 * Row to event.
 *
 * Reconstructed from `raw`, so switch's from/to and blur/focus's reason survive, as does
 * anything added later. If `raw` is corrupt, a minimal event is rebuilt from the columns
 * rather than dropping the row.
 */
export function rowToEvent(row: EventRow): TimelineEvent {
  try {
    const parsed = JSON.parse(row.raw) as TimelineEvent;
    if (parsed && typeof parsed === 'object' && typeof parsed.time === 'string') {
      return parsed;
    }
  } catch (error) {
    console.warn('[RTT][sqlite] 事件 raw 解析失败，退回列拼装 / bad raw, rebuilding:', error);
  }

  const rebuilt: Record<string, unknown> = { time: row.time, type: row.type };
  if (row.file !== null) rebuilt.file = row.file;
  if (row.from_path !== null) rebuilt.from = row.from_path;
  if (row.to_path !== null) rebuilt.to = row.to_path;
  if (row.state !== null) rebuilt.state = row.state;
  if (row.reason !== null) rebuilt.reason = row.reason;
  if (row.duration !== null) rebuilt.duration = row.duration;
  if (row.active_seconds !== null) rebuilt.activeSeconds = row.active_seconds;
  if (row.unfocused_seconds !== null) rebuilt.unfocusedSeconds = row.unfocused_seconds;
  return rebuilt as unknown as TimelineEvent;
}

/** Record entry to row. */
export function recordToRow(filePath: string, record: RecordEntry): RecordRow {
  return {
    file_path: filePath,
    file_name: record.fileName,
    total_read_time: record.totalReadTime ?? 0,
    unfocused_read_time: record.unfocusedReadTime ?? 0,
    last_read_at: record.lastReadAt ?? '',
  };
}

/** Row to a [path, entry] pair. */
export function rowToRecord(row: RecordRow): [string, RecordEntry] {
  return [
    row.file_path,
    {
      fileName: row.file_name,
      totalReadTime: row.total_read_time,
      unfocusedReadTime: row.unfocused_read_time,
      lastReadAt: row.last_read_at,
    },
  ];
}

/** Manual session to row. */
export function manualSessionToRow(session: ManualSession): ManualSessionRow {
  return {
    id: session.id,
    start_time: session.startTime,
    end_time: session.endTime,
    duration_seconds: session.durationSeconds,
    duration_ms: session.durationMs ?? session.durationSeconds * 1000,
    note: session.note ?? '',
    flags: JSON.stringify(session.flags ?? []),
    pauses: JSON.stringify(session.pauses ?? []),
  };
}

/**
 * Parse the marks column.
 *
 * A v1 database has no such column and the JSON could be corrupt, so this always degrades
 * to an empty array: failing to read one session's marks must not break the whole list.
 */
function parseArray<T>(
  raw: string | undefined | null,
  isItem: (item: T) => boolean,
): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is T => !!item && typeof item === 'object' && isItem(item as T),
    );
  } catch {
    return [];
  }
}

/** Row to a manual session. */
export function rowToManualSession(row: ManualSessionRow): ManualSession {
  return {
    id: row.id,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSeconds: row.duration_seconds,
    durationMs: typeof row.duration_ms === 'number' && row.duration_ms > 0
      ? row.duration_ms
      : row.duration_seconds * 1000,
    note: row.note,
    flags: parseArray<ManualFlag>(row.flags, (item) => typeof item.atSeconds === 'number'),
    pauses: parseArray<ManualPause>(row.pauses, (item) => typeof item.from === 'string'),
  };
}

/** Countdown session to row. */
export function countdownSessionToRow(session: CountdownSession): CountdownSessionRow {
  return {
    id: session.id,
    mode: session.mode,
    start_time: session.startTime,
    end_time: session.endTime,
    planned_seconds: session.plannedSeconds ?? 0,
    duration_seconds: session.durationSeconds,
    duration_ms: session.durationMs ?? session.durationSeconds * 1000,
    completed: session.completed ? 1 : 0,
    note: session.note ?? '',
    flags: JSON.stringify(session.flags ?? []),
    pauses: JSON.stringify(session.pauses ?? []),
    phases: JSON.stringify(session.phases ?? []),
  };
}

/** 一段方案的自检 / a phase must be a known kind with a positive length. */
function isPhase(item: CountdownPhase): boolean {
  return (
    typeof item.seconds === 'number' &&
    Number.isFinite(item.seconds) &&
    (item.kind === 'focus' || item.kind === 'break' || item.kind === 'segment')
  );
}

/**
 * Row to a countdown session.
 *
 * 一个坏掉的分段不该让整条记录消失：`phases` 读不出来时留空数组，其余字段照常还原 ——
 * 时长和备注才是这条记录的主干。
 * A corrupt phase list must not make the whole record vanish: `phases` degrades to an empty array
 * while the rest is restored as usual, since duration and note are what the record is really about.
 */
export function rowToCountdownSession(row: CountdownSessionRow): CountdownSession {
  const mode: CountdownMode =
    row.mode === 'pomodoro' || row.mode === 'interval' ? row.mode : 'down';
  return {
    id: row.id,
    mode,
    startTime: row.start_time,
    endTime: row.end_time,
    plannedSeconds: row.planned_seconds ?? 0,
    durationSeconds: row.duration_seconds,
    durationMs: typeof row.duration_ms === 'number' && row.duration_ms > 0
      ? row.duration_ms
      : row.duration_seconds * 1000,
    completed: row.completed === 1,
    note: row.note,
    flags: parseArray<ManualFlag>(row.flags, (item) => typeof item.atSeconds === 'number'),
    pauses: parseArray<ManualPause>(row.pauses, (item) => typeof item.from === 'string'),
    phases: parseArray<CountdownPhase>(row.phases, isPhase),
  };
}
