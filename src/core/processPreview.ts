import { formatLocalFull, parseSessionStartTime } from './time';
import { toAbsoluteMinutes } from './recordsTimeline';
import { isPluginViewKey } from './activePath';
import type { TimelineEvent } from './types';
import { buildVisits, type TargetVisit } from './activityVisits';
import type { OverviewInterval, OverviewSource } from './overview';

export const sourceClass: Record<OverviewSource, string> = {
  document: 'rtt-ov-doc', view: 'rtt-ov-view', manual: 'rtt-ov-manual', countdown: 'rtt-ov-countdown',
};

export function visibleSources(hidden: ReadonlySet<string>): Set<OverviewSource> {
  return new Set((Object.keys(sourceClass) as OverviewSource[]).filter(source => !hidden.has(sourceClass[source])));
}

export function filterOverviewIntervals(intervals: readonly OverviewInterval[], sources: ReadonlySet<OverviewSource>): OverviewInterval[] {
  return intervals.filter(interval => sources.has(interval.source));
}

export function visitSeconds(visit: TargetVisit): number {
  return Math.max(0, ((parseSessionStartTime(visit.to)?.getTime() ?? 0) - (parseSessionStartTime(visit.from)?.getTime() ?? 0)) / 1000);
}

/** Only consecutive short visits collapse; long stays and real gaps terminate a group. */
export function groupRapidVisits(visits: readonly TargetVisit[]): TargetVisit[][] {
  const groups: TargetVisit[][] = [];
  for (const visit of visits) {
    const previous = groups[groups.length - 1];
    const last = previous?.[previous.length - 1];
    if (last && visitSeconds(last) <= 10 && visitSeconds(visit) <= 10 && last.to === visit.from) previous.push(visit);
    else groups.push([visit]);
  }
  return groups;
}

/** Clip the event preview to the same visible coverage used by the chart. */
export function previewVisits(
  events: readonly TimelineEvent[], from: string, to: string,
  intervals: readonly OverviewInterval[], sources: ReadonlySet<OverviewSource>,
): TargetVisit[] {
  const fromAbs = toAbsoluteMinutes(from);
  const toAbs = toAbsoluteMinutes(to);
  const fromDate = parseSessionStartTime(from);
  if (fromAbs === null || toAbs === null || !fromDate || toAbs <= fromAbs) return [];
  const at = (absolute: number): string => formatLocalFull(new Date(fromDate.getTime() + Math.round((absolute - fromAbs) * 60000)));
  const visible = filterOverviewIntervals(intervals, sources);
  const visits: TargetVisit[] = [];
  for (const source of ['document', 'view'] as const) {
    if (!sources.has(source)) continue;
    const spans: Array<{ from: number; to: number }> = [];
    for (const interval of visible.filter(item => item.source === source && item.endAbs > fromAbs && item.startAbs < toAbs).sort((a, b) => a.startAbs - b.startAbs)) {
      const start = Math.max(fromAbs, interval.startAbs);
      const end = Math.min(toAbs, interval.endAbs);
      const last = spans[spans.length - 1];
      if (last && start <= last.to + 1e-6) last.to = Math.max(last.to, end);
      else spans.push({ from: start, to: end });
    }
    for (const span of spans) visits.push(...buildVisits(events, at(span.from), at(span.to)).filter(visit => (isPluginViewKey(visit.target) ? 'view' : 'document') === source));
  }
  return visits.sort((a, b) => a.from.localeCompare(b.from));
}
