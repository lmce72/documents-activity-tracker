import { expect, it } from 'bun:test';
import { filterOverviewIntervals, groupRapidVisits, previewVisits, visibleSources } from '../src/core/processPreview';
import { buildOverviewRows } from '../src/core/overview';
import { toAbsoluteMinutes } from '../src/core/recordsTimeline';
import type { TargetVisit } from '../src/core/activityVisits';
import type { OverviewInterval } from '../src/core/overview';
import type { TimelineEvent } from '../src/core/types';

const at = (seconds: number): string => `2026-10-29 09:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
const base = toAbsoluteMinutes(at(0))!;
const interval = (from: number, to: number, source: OverviewInterval['source']): OverviewInterval => ({ startAbs: base + from / 60, endAbs: base + to / 60, source });
const visit = (from: number, to: number, target = 'A.md'): TargetVisit => ({ target, from: at(from), to: at(to), activeSeconds: to - from, unfocusedSeconds: 0, pausedSeconds: 0, nextTarget: null });

it('manual-only filtering rebuilds overlaps and excludes document/view event previews', () => {
  const sources = visibleSources(new Set(['rtt-ov-doc', 'rtt-ov-view', 'rtt-ov-countdown']));
  const intervals = [interval(0, 60, 'document'), interval(10, 40, 'view'), interval(20, 50, 'manual')];
  const rows = buildOverviewRows(filterOverviewIntervals(intervals, sources), '2026-10-29');
  const pieces = rows.flatMap(row => row.segments);
  expect(pieces).toHaveLength(1);
  expect(pieces[0]?.sources).toEqual(['manual']);
  expect(pieces[0]?.durationMinutes).toBeCloseTo(0.5);
  expect(previewVisits([{ type: 'start', time: at(0), file: 'A.md' }], at(0), at(60), intervals, sources)).toEqual([]);
});

it('ten seconds is included; long visits and real gaps terminate rapid switching', () => {
  const groups = groupRapidVisits([visit(0, 10), visit(10, 20, 'B.md'), visit(20, 31, 'C.md'), visit(31, 35), visit(36, 40, 'B.md')]);
  expect(groups.map(group => group.length)).toEqual([2, 1, 1, 1]);
});

it('preview omits ignored gaps and hidden views without joining separate visits', () => {
  const events: TimelineEvent[] = [{ type: 'start', file: 'A.md', time: at(0) }, { type: 'switch', from: 'A.md', to: 'view:rss', time: at(20) }];
  const intervals = [interval(0, 5, 'document'), interval(10, 20, 'document'), interval(20, 40, 'view')];
  const visits = previewVisits(events, at(0), at(35), intervals, new Set(['document']));
  expect(visits.map(item => [item.from, item.to])).toEqual([[at(0), at(5)], [at(10), at(20)]]);
  expect(groupRapidVisits(visits).map(group => group.length)).toEqual([1, 1]);
});

it('coverage across channel and hour boundaries remains one visit, clipped at the selection end', () => {
  const events: TimelineEvent[] = [{ type: 'start', file: 'A.md', time: at(0) }];
  const visits = previewVisits(events, at(5), at(45), [interval(0, 30, 'document'), interval(30, 60, 'document')], new Set(['document']));
  expect(visits).toHaveLength(1);
  expect(visits[0]?.activeSeconds).toBe(40);
  expect(visits[0]?.to).toBe(at(45));
});
