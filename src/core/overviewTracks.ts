import { toAbsoluteMinutes } from './recordsTimeline';
import type { OverviewInterval, OverviewSource } from './overview';
import { sessionExtent } from './timedSession';
import type { ManualSession } from './types';

export const OVERVIEW_SOURCES = ['document', 'view', 'manual', 'countdown'] as const;
export interface OverviewProcess {
  id: string;
  source: OverviewSource;
  /** Absolute minutes; the original round is retained across hour/day clipping. */
  startAbs: number;
  endAbs: number;
  session?: ManualSession;
}
export interface OverviewTrackSegment {
  process: OverviewProcess;
  startMinute: number;
  durationMinutes: number;
  clipped: boolean;
}
export interface OverviewTrack {
  source: OverviewSource;
  processes: OverviewProcess[];
  rows: Array<{ hour: number; segments: OverviewTrackSegment[] }>;
}

/** Four independent ledgers: automatic continuity and explicit round identities never mix. */
export function buildOverviewTracks(
  intervals: readonly OverviewInterval[], manual: readonly ManualSession[],
  countdown: readonly ManualSession[], day: string,
): OverviewTrack[] {
  const dayStart = toAbsoluteMinutes(day + ' 00:00:00');
  return OVERVIEW_SOURCES.map(source => {
    const processes: OverviewProcess[] = [];
    const rows = Array.from({ length: 24 }, (_, hour) => ({ hour, segments: [] as OverviewTrackSegment[] }));
    if (dayStart === null) return { source, processes, rows };
    const dayEnd = dayStart + 1440;
    if (source === 'document' || source === 'view') {
      for (const interval of intervals.filter(item => item.source === source && item.endAbs > dayStart && item.startAbs < dayEnd).sort((a, b) => a.startAbs - b.startAbs)) {
        const previous = processes[processes.length - 1];
        if (previous && interval.startAbs <= previous.endAbs + 1e-6) previous.endAbs = Math.max(previous.endAbs, interval.endAbs);
        else processes.push({ id: source + ':' + interval.startAbs, source, startAbs: interval.startAbs, endAbs: interval.endAbs });
      }
    } else {
      const sessions = source === 'manual' ? manual : countdown;
      const seen = new Set<string>();
      for (const session of sessions) {
        const extent = sessionExtent(session);
        if (!extent || extent.endAbs <= dayStart || extent.startAbs >= dayEnd || seen.has(session.id)) continue;
        seen.add(session.id);
        processes.push({ id: source + ':' + session.id, source, ...extent, session });
      }
    }
    processes.sort((a, b) => a.startAbs - b.startAbs);
    for (const process of processes) {
      let cursor = Math.max(process.startAbs, dayStart);
      const end = Math.min(process.endAbs, dayEnd);
      while (cursor < end - 1e-7) {
        const hour = Math.min(23, Math.floor((cursor - dayStart + 1e-7) / 60));
        const until = Math.min(end, dayStart + (hour + 1) * 60);
        rows[hour].segments.push({ process, startMinute: Math.max(0, cursor - dayStart - hour * 60), durationMinutes: until - cursor, clipped: cursor > process.startAbs || until < process.endAbs });
        cursor = until;
      }
    }
    return { source, processes, rows };
  });
}
