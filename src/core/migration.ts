/**
 * Data migration v2 -> v3
 *
 * Origin: vault main.js lines 1154-1217.
 *
 * The original was lossy; this is the highest-priority fix in the refactor.
 *
 * Two problems with the original:
 *
 *      The whitelist dropped 41 of 138 real events (blur/focus/switch).
 *
 *      The `.map()` kept only six fields, losing switch's from/to and blur/focus's reason,
 *      while inventing a meaningless `file` field on switch events.
 *
 * Now non-destructive: every event and every original field is preserved, only shapes
 * are normalised, and the input is not mutated (a new object is returned).
 *
 * The original called `new Notice(...)` here, leaking UI into core; it now returns a report.
 *
 */

import { DATA_VERSION, TIMELINE_PERSISTED_TYPES } from './constants';
import type {
  HistoryCache,
  MigrationReport,
  RecordEntry,
  TimelineEvent,
} from './types';

/** The result of a migration. */
export interface MigrationResult {
  cache: HistoryCache;
  report: MigrationReport;
}

/**
 * Whether the payload is already at the target version.
 */
export function isCurrentVersion(cache: HistoryCache, target: number = DATA_VERSION): boolean {
  return cache.version === target;
}

/**
 * Normalise one record entry.
 *
 * Keeps only the statistic fields. Removing derived fields is safe because
 * readTimeLine is re-derivable from the timeline, and the original engine's silent
 * flush path never wrote it.
 *
 * `unfocusedReadTime` is a statistic field added by this refactor and must be
 * preserved too, or every migration would erase it. Absent in older data -> 0.
 */
function normalizeRecord(filePath: string, record: unknown): RecordEntry {
  const r = (record ?? {}) as Record<string, unknown>;
  return {
    fileName:
      typeof r.fileName === 'string' && r.fileName.length > 0
        ? r.fileName
        : (filePath.split('/').pop() ?? filePath),
    totalReadTime: typeof r.totalReadTime === 'number' ? r.totalReadTime : 0,
    lastReadAt: typeof r.lastReadAt === 'string' ? r.lastReadAt : '',
    unfocusedReadTime:
      typeof r.unfocusedReadTime === 'number' ? r.unfocusedReadTime : 0,
  };
}

/**
 * Normalise one timeline event.
 *
 * Keeps every original field. Notably does NOT invent a `file` field on switch events
 * as the original did; downstream code uses `eventFileRefs()` instead.
 */
function normalizeEvent(event: unknown): TimelineEvent | null {
  const e = (event ?? {}) as Record<string, unknown>;

  if (typeof e.time !== 'string' || e.time.length === 0) return null;
  if (typeof e.type !== 'string' || e.type.length === 0) return null;

  return { ...e } as unknown as TimelineEvent;
}

/**
 * Every file path an event refers to.
 *
 * Plain events use `file`; switch events use `from` / `to`.
 */
export function eventFileRefs(event: TimelineEvent): string[] {
  const refs: string[] = [];
  if (event.type === 'switch') {
    const e = event as { from?: unknown; to?: unknown };
    if (typeof e.from === 'string') refs.push(e.from);
    if (typeof e.to === 'string') refs.push(e.to);
    return refs;
  }
  const file = (event as { file?: unknown }).file;
  if (typeof file === 'string') refs.push(file);
  return refs;
}

/**
 * Migrate v2 data to the current version.
 *
 * non-destructive and idempotent:
 *
 * the raw on-disk payload
 */
export function migrateV2ToV3(raw: Partial<HistoryCache> | null | undefined): MigrationResult {
  const source = raw ?? {};
  const fromVersion = typeof source.version === 'number' ? source.version : 2;

  //  ---- records ----
  const recordsIn = source.records ?? {};
  const recordsOut: Record<string, RecordEntry> = {};
  for (const [filePath, record] of Object.entries(recordsIn)) {
    recordsOut[filePath] = normalizeRecord(filePath, record);
  }

  //  ---- timeline ----
  const timelineIn = Array.isArray(source.timeline) ? source.timeline : [];
  const timelineOut: TimelineEvent[] = [];
  const unknownEventTypes = new Set<string>();
  let droppedMalformed = 0;

  for (const event of timelineIn) {
    const normalized = normalizeEvent(event);
    if (!normalized) {
      droppedMalformed++;
      continue;
    }

    //  Unknown types are kept, only reported — dropping would repeat the original's data loss
    if (!(TIMELINE_PERSISTED_TYPES as readonly string[]).includes(normalized.type)) {
      unknownEventTypes.add(normalized.type);
    }
    timelineOut.push(normalized);
  }

  const cache: HistoryCache = {
    ...source,
    version: DATA_VERSION,
    records: recordsOut,
    timeline: timelineOut,
  };

  const report: MigrationReport = {
    migrated: fromVersion !== DATA_VERSION,
    fromVersion,
    toVersion: DATA_VERSION,
    recordsBefore: Object.keys(recordsIn).length,
    recordsAfter: Object.keys(recordsOut).length,
    timelineBefore: timelineIn.length,
    timelineAfter: timelineOut.length,
    droppedMalformed,
    unknownEventTypes: [...unknownEventTypes].sort(),
  };

  return { cache, report };
}
