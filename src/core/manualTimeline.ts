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

import type { ManualFlag, ManualSession } from './types';

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

/** 热力图上的一段暂停 / one pause on the heatmap. */
export interface ManualPauseSegment {
  session: ManualSession;
  /** 该段在所属小时内的起始分钟 / start minute within its hour */
  startMinute: number;
  /** 该段在所属小时内的长度（分钟）/ length within its hour */
  durationMinutes: number;
  /** 是否被小时边界或午夜截断 / clipped by an hour boundary or midnight */
  clipped: boolean;
}

/** 热力图上的一枚标记 / one flag mark on the heatmap. */
export interface ManualFlagMark {
  /** 当天已过的分钟数 / minutes into the day */
  atMinute: number;
  /** 第几枚（从 1 起）/ 1-based index within its run */
  index: number;
  /** 这一枚自己的时长（秒）/ this mark's own duration */
  intervalSeconds: number;
  session: ManualSession;
}

export interface ManualHourRow {
  /** 0–23 */
  hour: number;
  segments: ManualSegment[];
  /** 该小时内的暂停段 / the pauses that fall inside this hour */
  pauseSegments: ManualPauseSegment[];
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
    pauseSegments: [],
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

    // The pauses, laid out the same way as the session block — a paused stretch is a gap in
    // the work and belongs on the chart, not only in the total.
    for (const pause of session.pauses) {
      const pauseStart = minutesIntoDay(pause.from);
      const pauseEnd = minutesIntoDay(pause.to);
      if (pauseStart === null || pauseEnd === null || pauseEnd <= pauseStart) continue;
      if (dayOf(pause.from) !== day) continue;

      let pauseCursor = pauseStart;
      const pauseLimit = Math.min(pauseEnd, MINUTES_PER_DAY);
      while (pauseCursor < pauseLimit) {
        const hour = Math.min(23, Math.floor(pauseCursor / 60));
        const sliceEnd = Math.min(pauseLimit, (hour + 1) * 60);
        const duration = sliceEnd - pauseCursor;
        rows[hour]!.pauseSegments.push({
          session,
          startMinute: pauseCursor - hour * 60,
          durationMinutes: Math.max(1 / 60, duration),
          clipped: duration < pauseLimit - pauseStart - 1e-9,
        });
        pauseCursor = sliceEnd;
      }
    }
  }

  return rows;
}

/**
 * 该日的全部标记 / every mark placed on a given day.
 *
 * Returned separately from the rows because a mark is a point on the timeline, not a block:
 * it has no duration of its own to lay out, only a position and a label.
 */
export function buildManualDayFlags(
  sessions: readonly ManualSession[],
  day: string,
): ManualFlagMark[] {
  const marks: ManualFlagMark[] = [];

  for (const session of sessions) {
    const intervals = flagIntervals(session.flags);
    session.flags.forEach((flag, index) => {
      if (dayOf(flag.atTime) !== day) return;
      const atMinute = minutesIntoDay(flag.atTime);
      if (atMinute === null) return;
      marks.push({
        atMinute,
        index: index + 1,
        intervalSeconds: intervals[index] ?? 0,
        session,
      });
    });
  }

  return marks;
}

/**
 * 每枚标记对应的"本轮时长"（秒）/ each mark's own duration, in seconds.
 *
 * 标记的 `atSeconds` 是距本轮开始的累计值，直接显示就是一条越拉越长的数列，看不出"这一段
 * 花了多久"。这里改成相邻两枚的差值：第 1 枚从本轮开始算，之后每枚是与上一枚的间隔。
 *
 * A mark's `atSeconds` is cumulative from the run's start, and showing it raw gives a list that
 * only ever grows — it never says how long *this* stretch took. The difference between
 * neighbours does: the first runs from the start, each later one from the mark before it.
 */
export function flagIntervals(flags: readonly ManualFlag[]): number[] {
  return flags.map((flag, index) =>
    index === 0 ? flag.atSeconds : flag.atSeconds - (flags[index - 1]?.atSeconds ?? 0),
  );
}

/** /**
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
