/**
 * Manual-timer timeline layout
 *
 * Turns a day's manual sessions into the rows and segments the heatmap needs. Pure and
 * DOM-free, so the tricky parts — splitting at hour boundaries, clipping at midnight,
 * rounding second precision — are pinned down by tests.
 *
 * The layout follows the existing heatmap: one row per hour, a 60-minute track inside it,
 * and segment left/width as a fraction of those 60 minutes.
 *
 */

import type { ManualSession } from './types';

/** minutes in a day. */
export const MINUTES_PER_DAY = 24 * 60;

/** One segment on the heatmap. */
export interface ManualSegment {
  session: ManualSession;

  startMinute: number;

  durationMinutes: number;
  /** whether this is the session's first slice */
  isFirstSlice: boolean;
  /** whether an hour boundary or midnight clipped it */
  clipped: boolean;
}

export interface ManualHourRow {
  /** 0–23 */
  hour: number;
  segments: ManualSegment[];
  /** total minutes inside this hour */
  totalMinutes: number;
}

function minutesIntoDay(time: string): number | null {
  const match = time.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6] ?? '0');
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes + seconds / 60;
}

/** the date part of a timestamp. */
function dayOf(time: string): string {
  return time.slice(0, 10);
}

/**
 * Build the heatmap rows for one day.
 *
 * @param day      "YYYY-MM-DD"
 */
export function buildManualDayRows(
  sessions: readonly ManualSession[],
  day: string,
): ManualHourRow[] {
  const rows: ManualHourRow[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    segments: [],
    totalMinutes: 0,
  }));

  for (const session of sessions) {
    const startMin = minutesIntoDay(session.startTime);
    if (startMin === null) continue;

    //  Only sessions on this day are drawn; one crossing midnight is clipped at 24:00
    //  rather than smeared across two days, which would invent time that never existed.
    if (dayOf(session.startTime) !== day) continue;

    const rawEnd = minutesIntoDay(session.endTime);
    const endMin = Math.min(
      rawEnd === null || rawEnd < startMin ? startMin + session.durationSeconds / 60 : rawEnd,
      MINUTES_PER_DAY,
    );
    if (endMin <= startMin) continue;

    let cursor = startMin;
    let isFirstSlice = true;

    while (cursor < endMin) {
      const hour = Math.min(23, Math.floor(cursor / 60));
      const hourEnd = (hour + 1) * 60;
      const sliceEnd = Math.min(endMin, hourEnd);

      const startMinute = cursor - hour * 60;
      const durationMinutes = sliceEnd - cursor;

      rows[hour]!.segments.push({
        session,
        startMinute,

        durationMinutes: Math.max(1 / 60, durationMinutes),
        isFirstSlice,

        //  "Clipped" means this slice is shorter than the whole session, so the renderer
        //  drops the rounded ends and the session reads as one continuous block. Merely
        //  starting at :30 is not clipping.
        clipped: durationMinutes < endMin - startMin - 1e-9,
      });
      rows[hour]!.totalMinutes += durationMinutes;

      isFirstSlice = false;
      cursor = sliceEnd;
    }
  }

  return rows;
}

/**
 */
export function manualDayTotalSeconds(
  sessions: readonly ManualSession[],
  day: string,
): number {
  return sessions
    .filter((session) => dayOf(session.startTime) === day)
    .reduce((total, session) => total + session.durationSeconds, 0);
}

export function manualSessionsOfDay(
  sessions: readonly ManualSession[],
  day: string,
): ManualSession[] {
  return sessions
    .filter((session) => dayOf(session.startTime) === day)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** Shift a "YYYY-MM-DD" by N days. */
export function shiftDay(day: string, deltaDays: number): string {
  const date = new Date(`${day}T00:00:00`);
  if (isNaN(date.getTime())) return day;
  date.setDate(date.getDate() + deltaDays);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
