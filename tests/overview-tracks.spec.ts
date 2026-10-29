import { expect, it } from 'bun:test';
import { buildOverviewTracks } from '../src/core/overviewTracks';
import { countdownIntervals, manualIntervals, mergeIntervals, type OverviewInterval } from '../src/core/overview';
import { sessionActiveSpans } from '../src/core/timedSession';
import { toAbsoluteMinutes } from '../src/core/recordsTimeline';
import type { ManualSession } from '../src/core/types';

const day = '2026-10-29';
const base = toAbsoluteMinutes(day + ' 00:00:00')!;
const at = (minute: number): string => `${day} ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`;
const round = (id: string, from = 540, to = 570, pauses: ManualSession['pauses'] = []): ManualSession => ({ id, startTime: at(from), endTime: at(to), durationSeconds: (to - from) * 60 - pauses.reduce((sum, pause) => sum + (toAbsoluteMinutes(pause.to)! - toAbsoluteMinutes(pause.from)!) * 60, 0), note: id, flags: [], pauses });
const span = (source: OverviewInterval['source'], from: number, to: number): OverviewInterval => ({ source, startAbs: base + from, endAbs: base + to });

it('four simultaneous sources retain four independent tracks and selection identities', () => {
  const tracks = buildOverviewTracks([span('document', 540, 570), span('view', 540, 570)], [round('manual')], [round('countdown')], day);
  expect(tracks.map(track => track.source)).toEqual(['document', 'view', 'manual', 'countdown']);
  expect(tracks.map(track => track.rows[9].segments.length)).toEqual([1, 1, 1, 1]);
  expect(new Set(tracks.flatMap(track => track.processes.map(process => process.id))).size).toBe(4);
});

it('automatic continuity crosses hours and channels, while a real gap starts another process', () => {
  const tracks = buildOverviewTracks([span('view', 599, 600), { ...span('view', 600, 605), channel: 'paused' }, span('view', 605 + 1 / 60, 610)], [], [], day);
  const view = tracks.find(track => track.source === 'view')!;
  expect(view.processes).toHaveLength(2);
  expect(view.rows[9].segments[0].process.id).toBe(view.rows[10].segments[0].process.id);
  expect(view.rows[10].segments[1].process.id).not.toBe(view.rows[10].segments[0].process.id);
});

it('adjacent explicit rounds stay distinct and automatic fragments do not duplicate them', () => {
  const tracks = buildOverviewTracks([span('view', 540, 545), span('document', 545, 550), span('view', 550, 560)], [round('one', 540, 550), round('two', 550, 560)], [], day);
  const manual = tracks.find(track => track.source === 'manual')!;
  expect(manual.processes.map(process => process.session?.id)).toEqual(['one', 'two']);
  expect(manual.rows[9].segments.map(segment => segment.process.id)).toEqual(['manual:one', 'manual:two']);
});

it('round bars preserve the real stop time while accounting places active time around pauses', () => {
  const session = round('paused', 540, 570, [{ from: at(550), to: at(560) }]);
  const track = buildOverviewTracks([], [session], [], day).find(track => track.source === 'manual')!;
  expect(track.rows[9].segments[0].durationMinutes).toBe(30);
  const active = manualIntervals([session]);
  expect(active.map(interval => [interval.startAbs - base, interval.endAbs - base])).toEqual([[540, 550], [560, 570]]);
  const intervals = [...active, ...countdownIntervals([session]), span('document', 550, 560)];
  const merged = mergeIntervals(intervals);
  expect(merged.reduce((sum, interval) => sum + interval.endAbs - interval.startAbs, 0)).toBe(30);
  expect(merged.find(interval => interval.startAbs === base + 550)?.sources).toEqual(['document']);
});

it('a midnight-spanning round keeps its identity on both days and is clipped to each day', () => {
  const session = { ...round('midnight'), startTime: day + ' 23:55:00', endTime: '2026-10-30 00:15:00', durationSeconds: 1200 };
  const today = buildOverviewTracks([], [session], [], day)[2];
  const tomorrow = buildOverviewTracks([], [session], [], '2026-10-30')[2];
  expect(today.rows[23].segments[0].durationMinutes).toBe(5);
  expect(tomorrow.rows[0].segments[0].durationMinutes).toBe(15);
  expect(today.processes[0].id).toBe(tomorrow.processes[0].id);
});

it('legacy net durations remain a cap when pause boundaries are missing', () => {
  const session = { ...round('legacy'), durationSeconds: 600 };
  expect(sessionActiveSpans(session).reduce((sum, interval) => sum + interval.endAbs - interval.startAbs, 0)).toBe(10);
});

it('four overlapping sources count a shared wall-clock period once in the overlap total', async () => {
  const { sourceOverlapMinutes } = await import('../src/core/overview');
  const all = ['document', 'view', 'manual', 'countdown'] as const;
  expect(sourceOverlapMinutes(all.map(source => span(source, 540, 550)), base, base + 1440)).toBe(10);
  expect(sourceOverlapMinutes([span('document', 540, 550), span('document', 545, 555)], base, base + 1440)).toBe(0);
});
