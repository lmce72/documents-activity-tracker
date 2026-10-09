/**
 * Reading-record timeline layout
 *
 * Turns a file's `readTimeLine` (per-session "time → state" maps) into the rows and
 * segments a heatmap needs, plus per-day and per-week totals. Pure and DOM-free, so the
 * tricky parts — hour-boundary splitting, midnight clipping, channel attribution — are
 * pinned down by tests.
 *
 * Difference from `manualTimeline`:
 *   A manual session carries its own start/end and net duration; a reading record only has
 *   discrete state timestamps, so intervals are formed by adjacent pairs and each state
 *   maps to its own channel.
 *
 */

import { UNFOCUSED_ATTRIBUTION_CAP_SECONDS } from './constants';
import type { SessionStateMap } from './types';

/** minutes in a day. */
export const MINUTES_PER_DAY = 24 * 60;

/** which channel an interval belongs to. */
export type RecordChannel = 'in-window' | 'out-of-window' | 'paused';

/** One segment on the heatmap. */
export interface RecordSegment {
  channel: RecordChannel;

  startMinute: number;

  durationMinutes: number;
  /** whether an hour boundary or midnight clipped it */
  clipped: boolean;
  /** the owning session's start time */
  sessionStart: string;
}

export interface RecordHourRow {
  /** 0–23 */
  hour: number;
  segments: RecordSegment[];
  /** total minutes inside this hour */
  totalMinutes: number;
}

/** a parsed timestamp. */
interface ParsedTime {
  /** day index since the epoch */
  dayIndex: number;
  /** minutes into that day */
  minutes: number;
}

/** parse into absolute minutes. */
function parseAbsolute(time: string): ParsedTime | null {
  const match = time.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;

  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6] ?? '0');
  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  //  Built in local time, so a UTC offset cannot shift a stretch onto the previous day
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  const dayIndex = Math.floor(date.getTime() / 86_400_000);
  return { dayIndex, minutes: hours * 60 + minutes + seconds / 60 };
}

/** absolute minutes since the epoch. */
function absoluteOf(parsed: ParsedTime): number {
  return parsed.dayIndex * MINUTES_PER_DAY + parsed.minutes;
}

/**
 * to absolute minutes since the epoch.
 * Used by the overview panel to place document and manual intervals on one number line.
 */
export function toAbsoluteMinutes(time: string): number | null {
  const parsed = parseAbsolute(time);
  return parsed ? absoluteOf(parsed) : null;
}

/** one interval on the number line. */
export interface AbsoluteInterval {
  startAbs: number;
  endAbs: number;
  channel: RecordChannel;
}

/**
 * every interval on a file's timeline.
 *
 * Whether paused stretches count is the caller's call: reading-time totals exclude them,
 * while the overview's union asks "was this stretch occupied at all" — the user is still
 * there while paused, so it counts.
 */
export function collectRecordIntervals(
  readTimeLine: readonly SessionStateMap[],
  options: { includePaused?: boolean } = {},
): AbsoluteInterval[] {
  const { includePaused = true } = options;
  const out: AbsoluteInterval[] = [];

  for (const session of readTimeLine) {
    for (const interval of sessionIntervals(session)) {
      if (!includePaused && interval.channel === 'paused') continue;
      out.push(interval);
    }
  }

  return out;
}

/** state to channel; terminal 'saved' yields null. */
function channelOf(state: string | undefined): RecordChannel | null {
  if (state === 'tracking') return 'in-window';
  if (state === 'inactive') return 'out-of-window';
  if (state === 'pausing') return 'paused';
  return null;
}

/**
 * expand a session map into intervals.
 *
 * Adjacent timestamps bound one interval whose channel comes from the *earlier* timestamp:
 * state holds across the interval and changes at the next timestamp. The last timestamp is
 * the closing event (`saved`) and contributes no interval.
 */
function sessionIntervals(
  session: SessionStateMap,
): Array<{ startAbs: number; endAbs: number; channel: RecordChannel; sessionStart: string }> {
  const times = Object.keys(session).sort();
  const out: Array<{
    startAbs: number;
    endAbs: number;
    channel: RecordChannel;
    sessionStart: string;
  }> = [];
  if (times.length < 2) return out;

  const sessionStart = times[0]!;

  for (let i = 0; i < times.length - 1; i++) {
    const channel = channelOf(session[times[i]!]);
    if (!channel) continue;

    const from = parseAbsolute(times[i]!);
    const to = parseAbsolute(times[i + 1]!);
    if (!from || !to) continue;

    const startAbs = absoluteOf(from);
    const endAbs = absoluteOf(to);
    if (endAbs <= startAbs) continue;

    //  Same yardstick as computeSessionDurations: an out-of-window stretch past the
    //  attribution cap means the user left, and is drawn nowhere.
    if (channel === 'out-of-window' && (endAbs - startAbs) * 60 > UNFOCUSED_ATTRIBUTION_CAP_SECONDS) {
      continue;
    }

    out.push({ startAbs, endAbs, channel, sessionStart });
  }

  return out;
}

/**
 * Build one file's heatmap rows for one day.
 *
 * the file's per-session state maps
 * @param day          "YYYY-MM-DD"
 */
export function buildRecordDayRows(
  readTimeLine: readonly SessionStateMap[],
  day: string,
): RecordHourRow[] {
  const rows: RecordHourRow[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    segments: [],
    totalMinutes: 0,
  }));

  const dayStart = parseAbsolute(`${day} 00:00`);
  if (!dayStart) return rows;
  const dayStartAbs = absoluteOf(dayStart);
  const dayEndAbs = dayStartAbs + MINUTES_PER_DAY;

  for (const session of readTimeLine) {
    for (const interval of sessionIntervals(session)) {

      //  Clip to this day: an interval crossing midnight is drawn in both, each its own part
      const startAbs = Math.max(interval.startAbs, dayStartAbs);
      const endAbs = Math.min(interval.endAbs, dayEndAbs);
      if (endAbs <= startAbs) continue;

      let cursor = startAbs;
      while (cursor < endAbs) {
        const minuteIntoDay = cursor - dayStartAbs;
        const hour = Math.min(23, Math.floor(minuteIntoDay / 60));
        const hourEndAbs = dayStartAbs + (hour + 1) * 60;
        const sliceEnd = Math.min(endAbs, hourEndAbs);

        const startMinute = cursor - (dayStartAbs + hour * 60);
        const durationMinutes = sliceEnd - cursor;

        rows[hour]!.segments.push({
          channel: interval.channel,
          startMinute,

          durationMinutes: Math.max(1 / 60, durationMinutes),
          clipped: durationMinutes < endAbs - startAbs - 1e-9 || sliceEnd < hourEndAbs,
          sessionStart: interval.sessionStart,
        });
        rows[hour]!.totalMinutes += durationMinutes;

        cursor = sliceEnd;
      }
    }
  }

  return rows;
}

/**
 * every document's heatmap rows for one day, merged into one chart.
 *
 * The sidebar's document panel shows how long documents were read *that day*, not one
 * file — mirroring the manual panel (all sessions that day) and the overview (their union),
 * so the three panels are the same shape at three scopes.
 *
 * Only one file is tracked at a time, so segments from different files cannot truly overlap;
 * bucketing them by hour is enough.
 */
export function buildDocumentDayRows(
  readTimeLines: Iterable<readonly SessionStateMap[]>,
  day: string,
): RecordHourRow[] {
  const rows: RecordHourRow[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    segments: [],
    totalMinutes: 0,
  }));

  for (const readTimeLine of readTimeLines) {
    for (const source of buildRecordDayRows(readTimeLine, day)) {
      if (source.segments.length === 0) continue;
      rows[source.hour]!.segments.push(...source.segments);
      rows[source.hour]!.totalMinutes += source.totalMinutes;
    }
  }

  //  Sorted by start minute so segments stack in a stable order rather than appearing to jump
  for (const row of rows) {
    row.segments.sort((a, b) => a.startMinute - b.startMinute);
  }

  return rows;
}

/**
 * one file's net reading seconds on a day.
 * Same basis as the list: in-window plus out-of-window, pauses excluded.
 */
export function recordDaySeconds(
  readTimeLine: readonly SessionStateMap[],
  day: string,
): number {
  let minutes = 0;
  for (const row of buildRecordDayRows(readTimeLine, day)) {
    for (const segment of row.segments) {
      if (segment.channel === 'paused') continue;
      minutes += segment.durationMinutes;
    }
  }
  return Math.round(minutes * 60);
}

/** the three-channel split of a day's reading seconds. */
export function recordDayChannels(
  readTimeLine: readonly SessionStateMap[],
  day: string,
): { inWindow: number; outOfWindow: number; paused: number } {
  let inWindow = 0;
  let outOfWindow = 0;
  let paused = 0;

  for (const row of buildRecordDayRows(readTimeLine, day)) {
    for (const segment of row.segments) {
      if (segment.channel === 'in-window') inWindow += segment.durationMinutes;
      else if (segment.channel === 'out-of-window') outOfWindow += segment.durationMinutes;
      else paused += segment.durationMinutes;
    }
  }

  return {
    inWindow: Math.round(inWindow * 60),
    outOfWindow: Math.round(outOfWindow * 60),
    paused: Math.round(paused * 60),
  };
}

export function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  if (isNaN(date.getTime())) return day;

  //  getDay(): 0 = Sunday; the week starts on Monday
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** whether `candidate` falls in `day`'s week. */
export function isInWeekOf(candidate: string, day: string): boolean {
  const start = weekStart(day);
  const startDate = new Date(`${start}T00:00:00`);
  if (isNaN(startDate.getTime())) return false;
  startDate.setDate(startDate.getDate() + 7);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const end = `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}`;
  return candidate >= start && candidate < end;
}
