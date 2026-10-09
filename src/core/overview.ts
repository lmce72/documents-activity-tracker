/**
 * Overview: the union of document and manual timing
 *
 * **Why a union.** Document tracking and manual timing are two separate ledgers covering
 * the same wall clock. Read a note with the stopwatch running and those ten minutes appear
 * in both — adding them would report twenty. The overview therefore counts covered time
 * once, as the union of every interval.
 *
 * The per-source totals and the overlap are still reported: "union 32, document 20, manual
 * 20, overlap 8" says more than a bare 32 — a large overlap means both ledgers ran at once.
 *
 * Pure L0 logic: no DOM, no environment, testable offline.
 */

import { MINUTES_PER_DAY, toAbsoluteMinutes } from './recordsTimeline';
import type { ManualSession } from './types';

/** which ledger an interval came from. */
export type OverviewSource = 'document' | 'manual';

export interface OverviewInterval {
  startAbs: number;
  endAbs: number;
  source: OverviewSource;
}

/** a merged stretch, possibly covered by both. */
export interface MergedInterval {
  startAbs: number;
  endAbs: number;
  sources: OverviewSource[];
}

/** one segment on the overview heatmap. */
export interface OverviewSegment {

  startMinute: number;

  durationMinutes: number;
  /** which ledgers cover it */
  sources: OverviewSource[];
  /** clipped by an hour boundary or midnight */
  clipped: boolean;
}

export interface OverviewHourRow {
  hour: number;
  segments: OverviewSegment[];
  totalMinutes: number;
}

export interface OverviewTotals {
  /** Minutes covered by the union, counted once - never double counted. */
  unionMinutes: number;

  documentMinutes: number;
  /** manual total */
  manualMinutes: number;
  /** minutes covered by both ledgers at once */
  overlapMinutes: number;
}

/** collect a file's timeline into absolute intervals. */
export function documentIntervals(
  readTimeLines: Iterable<readonly import('./types').SessionStateMap[]>,
  options: { includePaused?: boolean } = {},
): OverviewInterval[] {
  const out: OverviewInterval[] = [];
  for (const readTimeLine of readTimeLines) {
    const parsed = new Map<string, number | null>();
    for (const session of readTimeLine) {
      const times = Object.keys(session).sort();
      for (let i = 0; i < times.length - 1; i++) {
        const state = session[times[i]!];

        //  Reading totals exclude pauses; the overview includes them by default
        if (!options.includePaused && state === 'pausing') continue;
        if (state !== 'tracking' && state !== 'inactive' && state !== 'pausing') continue;

        const readAbs = (time: string): number | null => {
          if (!parsed.has(time)) parsed.set(time, toAbsoluteMinutes(time));
          return parsed.get(time) ?? null;
        };
        const startAbs = readAbs(times[i]!);
        const endAbs = readAbs(times[i + 1]!);
        if (startAbs === null || endAbs === null || endAbs <= startAbs) continue;

        out.push({ startAbs, endAbs, source: 'document' });
      }
    }
  }
  return out;
}

/** collect manual sessions into absolute intervals. */
export function manualIntervals(sessions: readonly ManualSession[]): OverviewInterval[] {
  const out: OverviewInterval[] = [];

  for (const session of sessions) {
    const startAbs = toAbsoluteMinutes(session.startTime);
    if (startAbs === null) continue;

    //  Sessions carry a net duration, but occupy one continuous stretch. The net duration is
    //  laid out from the start so that it overlaps document intervals correctly.
    const endAbs = startAbs + session.durationSeconds / 60;
    if (endAbs <= startAbs) continue;

    out.push({ startAbs, endAbs, source: 'manual' });
  }

  return out;
}

/**
 * Merge into a union.
 *
 * A sweep: sort by start, merge overlapping intervals, and record which sources cover each.
 */
export function mergeIntervals(
  intervals: readonly OverviewInterval[],
): MergedInterval[] {
  if (intervals.length === 0) return [];

  //  Collect endpoints first, then attribute each elementary stretch between neighbours, so a
  //  partial overlap is split into stretches with their own sources.
  const edges = new Set<number>();
  for (const interval of intervals) {
    edges.add(interval.startAbs);
    edges.add(interval.endAbs);
  }

  const points = [...edges].sort((a, b) => a - b);
  const out: MergedInterval[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (end <= start) continue;

    const sources = new Set<OverviewSource>();
    for (const interval of intervals) {

      //  Half-open [start, end): touching endpoints are not an overlap
      if (interval.startAbs <= start && interval.endAbs >= end) sources.add(interval.source);
    }
    if (sources.size === 0) continue;

    const covered = [...sources].sort();
    const previous = out[out.length - 1];

    //  Merge neighbours with identical sources so a continuous stretch is not fragmented
    if (
      previous &&
      previous.endAbs === start &&
      previous.sources.length === covered.length &&
      previous.sources.every((s, index) => s === covered[index])
    ) {
      previous.endAbs = end;
      continue;
    }

    out.push({ startAbs: start, endAbs: end, sources: covered });
  }

  return out;
}

/** that day's totals. */
export function overviewTotals(
  intervals: readonly OverviewInterval[],
  day: string,
): OverviewTotals {
  const dayMinutes = dayOf(day);
  const inDay = intervals.filter((interval) => overlapsDay(interval, dayMinutes));
  const clipped = inDay.map((interval) => clipToDay(interval, dayMinutes));

  let documentMinutes = 0;
  let manualMinutes = 0;
  for (const interval of clipped) {
    const length = interval.endAbs - interval.startAbs;
    if (interval.source === 'document') documentMinutes += length;
    else manualMinutes += length;
  }

  const merged = mergeIntervals(clipped);
  const unionMinutes = merged.reduce((sum, m) => sum + (m.endAbs - m.startAbs), 0);

  return {
    unionMinutes,
    documentMinutes,
    manualMinutes,

    //  Overlap = both totals minus the union. The union never exceeds the sum, so this
    //  cannot go negative; max(0, …) absorbs floating-point noise.
    overlapMinutes: Math.max(0, documentMinutes + manualMinutes - unionMinutes),
  };
}

/** build that day's heatmap rows. */
export function buildOverviewRows(
  intervals: readonly OverviewInterval[],
  day: string,
): OverviewHourRow[] {
  const rows: OverviewHourRow[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    segments: [],
    totalMinutes: 0,
  }));

  const dayMinutes = dayOf(day);
  const merged = mergeIntervals(
    intervals
      .filter((interval) => overlapsDay(interval, dayMinutes))
      .map((interval) => clipToDay(interval, dayMinutes)),
  );

  for (const interval of merged) {
    let cursor = interval.startAbs;
    while (cursor < interval.endAbs) {
      const minuteIntoDay = cursor - dayMinutes;
      const hour = Math.min(23, Math.floor(minuteIntoDay / 60));
      const hourEndAbs = dayMinutes + (hour + 1) * 60;
      const sliceEnd = Math.min(interval.endAbs, hourEndAbs);

      const durationMinutes = sliceEnd - cursor;
      rows[hour]!.segments.push({
        startMinute: cursor - (dayMinutes + hour * 60),
        durationMinutes: Math.max(1 / 60, durationMinutes),
        sources: interval.sources,
        clipped: durationMinutes < interval.endAbs - interval.startAbs - 1e-9,
      });
      rows[hour]!.totalMinutes += durationMinutes;

      cursor = sliceEnd;
    }
  }

  return rows;
}

//  ============================================================================
// day helpers
//  ============================================================================

/** midnight of that day, in absolute minutes. */
function dayOf(day: string): number {
  const parsed = toAbsoluteMinutes(`${day} 00:00`);
  return parsed ?? 0;
}

/** whether an interval touches the day. */
function overlapsDay(interval: OverviewInterval, dayMinutes: number): boolean {
  return interval.startAbs < dayMinutes + MINUTES_PER_DAY && interval.endAbs > dayMinutes;
}

/** clip an interval to the day. */
function clipToDay(interval: OverviewInterval, dayMinutes: number): OverviewInterval {
  return {
    startAbs: Math.max(interval.startAbs, dayMinutes),
    endAbs: Math.min(interval.endAbs, dayMinutes + MINUTES_PER_DAY),
    source: interval.source,
  };
}
