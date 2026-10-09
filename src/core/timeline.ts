/**
 * Timeline-derived computations
 *
 * Origins:
 *
 * Changes:
 *      All turned into pure functions taking the timeline as a parameter.
 *      `buildFileRecords` takes `now` as a parameter for deterministic testing.
 *      `removeFileEvents` keeps the original's switch-aware reference check.
 *
 */

import { UNFOCUSED_ATTRIBUTION_CAP_SECONDS } from './constants';
import { calculateSessionDuration } from './session';
import { parseSessionStartTime, todayStr } from './time';
import type {
  FileRecord,
  SessionStateMap,
  TimelineEvent,
  TimerFileState,
} from './types';
import { eventFileRefs } from './migration';

/** Max credible unfinished session: 24h. */
export const MAX_SESSION_DURATION = 24 * 60 * 60;

/** Whether an event closes a session. */
function isSaveLike(event: TimelineEvent): boolean {
  return event.type === 'save' || event.type === 'auto-save';
}

/** A session's three-channel durations. */
export interface SessionDurations {
  /** in-window active seconds */
  activeSeconds: number;
  /** out-of-window seconds */
  unfocusedSeconds: number;
  /** paused seconds */
  pausedSeconds: number;
  /** an unclosed session older than 24h */
  abnormal: boolean;
}

function eventState(event: TimelineEvent): string | undefined {
  return (event as { state?: string }).state;
}

/**
 * Whether an event can start an attributed interval.
 */
function isAttributable(event: TimelineEvent): boolean {
  if (event.type === 'switch') return false;
  if (isSaveLike(event) || event.type === 'discard') return false;
  return eventState(event) !== undefined || event.type === 'blur' || event.type === 'focus';
}

/**
 * Attribute one session's durations from its event stream.
 *
 * This is the key handling for unfocused time and also fixes an existing defect: the old
 * implementation counted blur stretches as active, because a blur event carries the state
 * it had *before* blurring (`tracking` in real data) and `calculateSessionDuration` looks
 * only at states. Here the event type wins: an interval starting at a blur goes to
 * `unfocusedSeconds` regardless of its `state`, so old and new data agree.
 *
 *               the end to extrapolate to for an open session; null when closed
 * whether the session is still open
 */
export function computeSessionDurations(
  events: readonly TimelineEvent[],
  nowMs: number | null,
  isOpen: boolean,
): SessionDurations {
  const empty: SessionDurations = {
    activeSeconds: 0,
    unfocusedSeconds: 0,
    pausedSeconds: 0,
    abnormal: false,
  };
  if (events.length === 0) return empty;

  const boundaries = events.filter((e) => isAttributable(e) || isSaveLike(e) || e.type === 'discard');
  if (boundaries.length === 0) return empty;

  let activeSeconds = 0;
  let unfocusedSeconds = 0;
  let pausedSeconds = 0;
  let abnormal = false;

  for (let i = 0; i < boundaries.length; i++) {
    const current = boundaries[i]!;

    if (isSaveLike(current) || current.type === 'discard') continue;

    const startMs = parseSessionStartTime(current.time);
    if (!startMs) continue;

    let endMs: number | null = null;
    let extrapolated = false;
    const next = boundaries[i + 1];
    if (next) {
      endMs = parseSessionStartTime(next.time)?.getTime() ?? null;
    } else if (isOpen && nowMs !== null) {

      endMs = nowMs;
      extrapolated = true;
    }
    if (endMs === null) continue;

    const gap = (endMs - startMs.getTime()) / 1000;
    if (gap <= 0) continue;

    //  Only the extrapolated tail is guarded by the 24h rule. An interval bounded by two
    //  real events is measured evidence and must be kept even if the session never
    //  closed; zeroing the whole session would discard real readings.
    if (extrapolated && gap > MAX_SESSION_DURATION) {
      console.warn(
        '[RTT][timeline] 跳过异常未闭合会话 / skipping abnormal open session:',
        current.time,
      );
      abnormal = true;
      continue;
    }

    const state = eventState(current);

    if (current.type === 'blur' || state === 'inactive') {

      if (gap <= UNFOCUSED_ATTRIBUTION_CAP_SECONDS) unfocusedSeconds += gap;
      continue;
    }

    if (current.type === 'pause' || state === 'pausing') {
      pausedSeconds += gap;
    } else if (current.type === 'focus' || state === 'tracking') {
      activeSeconds += gap;
    }
  }

  return { activeSeconds, unfocusedSeconds, pausedSeconds, abnormal };
}

/**
 * Build the per-file view records in a single pass over the timeline.
 *
 * Single pass: split the event stream into sessions with `currentSession`, then
 * aggregate per file — O(events + sessions), independent of file count.
 *
 * current time for open sessions
 * today's date string
 */
export function buildFileRecords(
  timeline: readonly TimelineEvent[],
  nowMs: number,
  today: string = todayStr(),
): Record<string, FileRecord> {
  const fileRecords: Record<string, FileRecord> = {};
  if (timeline.length === 0) return fileRecords;

  interface OpenSession {
    filePath: string;
    events: TimelineEvent[];
  }
  const fileSessions: Record<string, OpenSession[]> = {};

  const closeSession = (session: OpenSession): void => {
    (fileSessions[session.filePath] ??= []).push(session);
  };

  let currentSession: OpenSession | null = null;

  for (const event of timeline) {
    const filePath =
      event.type === 'switch' ? event.to : (event as { file?: string }).file;
    if (!filePath) continue;

    if (event.type === 'start') {

      if (currentSession) closeSession(currentSession);
      currentSession = { filePath: event.file, events: [event] };
      continue;
    }

    if (!currentSession) continue;

    if (
      (event.type !== 'switch' && event.file === currentSession.filePath) ||
      (event.type === 'switch' && event.to === currentSession.filePath)
    ) {
      currentSession.events.push(event);
    }

    if (isSaveLike(event) || event.type === 'discard') {
      const belongsToCurrent =
        event.type === 'switch' ? false : event.file === currentSession.filePath;
      if (belongsToCurrent) {
        if (isSaveLike(event)) closeSession(currentSession);
        currentSession = null;
      }
    }
  }

  if (currentSession) closeSession(currentSession);

  for (const [filePath, sessions] of Object.entries(fileSessions)) {
    const readTimeLine: SessionStateMap[] = [];
    let totalReadTime = 0;
    let unfocusedReadTime = 0;
    let readTimeToday = 0;
    let lastReadAt = '';
    let hasAbnormalSession = false;

    for (const session of sessions) {
      if (session.events.length === 0) continue;

      const sessionObj: SessionStateMap = {};
      let isUnfinishedSession = true;

      for (const event of session.events) {
        const state = (event as { state?: string }).state;
        if (state) {
          sessionObj[event.time] = state as SessionStateMap[string];
        } else if (event.type === 'save' || event.type === 'auto-save') {
          sessionObj[event.time] = 'saved';
          isUnfinishedSession = false;
        } else if (event.type === 'discard') {

          //  The original wrote 'discarded' here, but this branch is unreachable: a session
          //  closed by discard is dropped wholesale and never enters readTimeLine, so the
          //  value is never read. 'saved' keeps it inside SessionState's domain.
          sessionObj[event.time] = 'saved';
          isUnfinishedSession = false;
        }
      }

      const keys = Object.keys(sessionObj);
      if (keys.length === 0) continue;

      readTimeLine.push(sessionObj);

      //  Three-channel attribution, event-type driven. This also replaces the old
      //  "extrapolate only for a lone start" special case: once the service logs
      //  blur/focus/pause/resume, an in-progress session is no longer a lone start and
      //  that special case would report 0 for it.
      const durations = computeSessionDurations(
        session.events,
        nowMs,
        isUnfinishedSession,
      );
      if (durations.abnormal) hasAbnormalSession = true;

      //  Total reading time = in-window + out-of-window
      const sessionDuration = durations.activeSeconds + durations.unfocusedSeconds;
      totalReadTime += sessionDuration;
      unfocusedReadTime += durations.unfocusedSeconds;

      const sorted = keys.slice().sort();
      const firstTime = sorted[0]!;
      if (firstTime.startsWith(today)) readTimeToday += sessionDuration;

      const lastTime = sorted[sorted.length - 1]!;
      if (lastTime > lastReadAt) lastReadAt = lastTime;
    }

    fileRecords[filePath] = {
      fileName: (filePath.split('/').pop() ?? filePath).replace(/\.md$/, ''),
      totalReadTime,
      unfocusedReadTime,
      readTimeToday,
      lastReadAt: lastReadAt.slice(0, 10),
      readTimeLine,
      hasAbnormalSession,
    };
  }

  return fileRecords;
}

/**
 * Recompute aggregates from a session list.
 */
export function recalcAggregates(
  readTimeLine: readonly SessionStateMap[],
  today: string = todayStr(),
): { totalReadTime: number; readTimeToday: number } {
  let totalReadTime = 0;
  let readTimeToday = 0;

  for (const session of readTimeLine) {
    const activeSec = calculateSessionDuration(session);
    totalReadTime += activeSec;

    const timestamps = Object.keys(session).sort();
    if (timestamps.length > 0 && timestamps[0]!.startsWith(today)) {
      readTimeToday += activeSec;
    }
  }

  return { totalReadTime, readTimeToday };
}

/**
 * Today's reading seconds for one file.
 *
 * Two parts — settled events today plus the in-progress session — both counted as
 * in-window + out-of-window, since unfocused time is reading time too.
 */
export function getTodaySeconds(
  timeline: readonly TimelineEvent[],
  file: TimerFileState | null | undefined,
  filePath: string,
  today: string = todayStr(),
): number {
  let total = 0;

  for (const event of timeline) {
    if (event.type === 'switch') continue;
    if (event.file !== filePath || !event.time.startsWith(today)) continue;
    if (isSaveLike(event)) {
      const e = event as { activeSeconds?: number; unfocusedSeconds?: number };
      total += (e.activeSeconds ?? 0) + (e.unfocusedSeconds ?? 0);
    }
  }

  if (file?.sessionStartTime?.startsWith(today)) {
    total += file.activeSeconds + file.unfocusedSeconds;
  }

  return total;
}

/**
 * Today's session count for one file.
 */
export function getTodaySessionCount(
  timeline: readonly TimelineEvent[],
  file: TimerFileState | null | undefined,
  filePath: string,
  today: string = todayStr(),
  statusTracking = 'tracking',
  statusPaused = 'paused',
): number {
  let count = 0;

  for (const event of timeline) {
    if (event.type === 'switch') continue;
    if (event.file !== filePath || !event.time.startsWith(today)) continue;
    if (isSaveLike(event)) count++;
  }

  if (file && (file.status === statusTracking || file.status === statusPaused)) {
    count++;
  }

  return count || 1;
}

/**
 * Vault-wide reading seconds today.
 * Same basis as getTodaySeconds: in-window + out-of-window.
 */
export function getAllTodaySeconds(
  timeline: readonly TimelineEvent[],
  files: Iterable<TimerFileState>,
  today: string = todayStr(),
): number {
  let total = 0;

  for (const event of timeline) {
    if (event.type === 'switch') continue;
    if (event.time.startsWith(today) && isSaveLike(event)) {
      const e = event as { activeSeconds?: number; unfocusedSeconds?: number };
      total += (e.activeSeconds ?? 0) + (e.unfocusedSeconds ?? 0);
    }
  }

  for (const file of files) {
    if (file.sessionStartTime?.startsWith(today)) {
      total += file.activeSeconds + file.unfocusedSeconds;
    }
  }

  return total;
}

/**
 * Remove every event referring to a file.
 *
 * Replaces the direct `_cache.timeline` assignment at ReadRecordsModal:4541.
 * The reference check must cover a switch event's from/to, or those become orphans.
 */
export function removeFileEvents(
  timeline: readonly TimelineEvent[],
  filePath: string,
): TimelineEvent[] {
  return timeline.filter((event) => !eventFileRefs(event).includes(filePath));
}

/**
 */
export function getFileEvents(
  timeline: readonly TimelineEvent[],
  filePath: string,
): TimelineEvent[] {
  return timeline.filter((event) => eventFileRefs(event).includes(filePath));
}

/**
 * Filter events into a time range (inclusive on both ends).
 */
export function getTimeRangeEvents(
  timeline: readonly TimelineEvent[],
  start: string,
  end: string,
): TimelineEvent[] {
  return timeline.filter((event) => event.time >= start && event.time <= end);
}
