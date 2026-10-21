import { expect, it } from 'bun:test';
import { activityRuns } from '../src/core/activityRuns';
import { buildVisits } from '../src/core/activityVisits';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import { mergeSettings } from '../src/core/settings';
import { createInitialState } from '../src/core/reducer';
import { buildFileRecords, getAllTodaySeconds, getTodaySeconds } from '../src/core/timeline';
import { TimerStore } from '../src/services/TimerStore';
import { TimerService } from '../src/services/TimerService';
import { FakeClock, CapturingLogger, testDeps } from './helpers/fake-clock';
import { MemoryHistory } from './helpers/memory-history';
import type { TimelineEvent } from '../src/core/types';

const view = 'view:rss-reader-view';
const time = (clock: string) => `2026-10-19 ${clock}`;
const events: TimelineEvent[] = [
  { type: 'start', file: view, time: time('10:00:00'), state: 'tracking', activityTitle: '文章 A：完整标题' },
  { type: 'activity', file: view, time: time('10:00:10'), state: 'tracking', activityTitle: '文章 B：完整标题' },
  { type: 'blur', file: view, time: time('10:00:15'), state: 'inactive' },
  { type: 'focus', file: view, time: time('10:00:20'), state: 'tracking' },
  { type: 'save', file: view, time: time('10:00:30'), activeSeconds: 25, unfocusedSeconds: 5 },
];

it('plugin reading defaults on, explicit false survives settings upgrades', () => {
  expect(mergeSettings({}).countPluginViewsAsReading).toBe(true);
  expect(mergeSettings({ countPluginViewsAsReading: false }).countPluginViewsAsReading).toBe(false);
  const reading = buildFileRecords(events, 0, '2026-10-19', { countUnfocused: false });
  const excluded = buildFileRecords(events, 0, '2026-10-19', { countPluginViews: false });
  expect(reading[view]!.totalReadTime).toBe(25);
  expect(reading[view]!.fileName).toBe('文章 B：完整标题');
  expect(excluded[view]!.totalReadTime).toBe(0);
  expect(excluded[view]!.readTimeLine).toEqual(reading[view]!.readTimeLine);
  expect(getTodaySeconds(events, null, view, '2026-10-19', false, false)).toBe(0);
  expect(getAllTodaySeconds(events, [], '2026-10-19', false, false)).toBe(0);
  expect(getAllTodaySeconds(events, [], '2026-10-19', false, true)).toBe(25);
});

it('titles split activity detail without splitting rounds or losing focus attribution', () => {
  const visits = buildVisits(events, time('10:00:00'), time('10:00:30'));
  expect(visits.map(v => [v.title, v.activeSeconds, v.unfocusedSeconds])).toEqual([
    ['文章 A：完整标题', 10, 0], ['文章 B：完整标题', 15, 5],
  ]);
  const clipped = buildVisits(events, time('10:00:12'), time('10:00:22'));
  expect(clipped).toHaveLength(1);
  expect(clipped[0]!.activeSeconds).toBe(5);
  expect(clipped[0]!.unfocusedSeconds).toBe(5);
  expect(clipped[0]!.from).toBe(time('10:00:12'));
});

it('adjacent activity joins across hours and channels; even a one-second real gap breaks it', () => {
  const a = { startMinute: 59, durationMinutes: 1 };
  const b = { startMinute: 0, durationMinutes: 1 };
  const c = { startMinute: 1, durationMinutes: 1 };
  const d = { startMinute: 2 + 1 / 60, durationMinutes: 1 };
  const runs = activityRuns([{ hour: 9, segments: [a] }, { hour: 10, segments: [b, c, d] }]);
  expect(runs.get(a)).toBe(runs.get(c));
  expect(runs.get(a)).toEqual({ id: '599', start: 599, end: 602 });
  expect(runs.get(d)).not.toBe(runs.get(c));
});

it('same-view article changes persist their full titles, retry failures and retain a single round', async () => {
  const clock = new FakeClock('2026-10-19T10:00:00');
  const log = new CapturingLogger();
  const { deps } = testDeps(clock, log);
  const store = new TimerStore(deps, createInitialState(deps));
  const history = new MemoryHistory();
  let title = '文章 A：完整标题';
  const service = new TimerService({ store, history, clock, log,
    settings: () => ({ ...DEFAULT_SETTINGS, autoStartMode: 'always', minReadSeconds: 0, idleTimeoutEnabled: false }),
    getActivePath: () => view, getActiveTitle: () => title, getOpenPaths: () => [view] });
  await service.onActivePathChange();
  for (let i = 0; i < 10; i++) { clock.advanceSeconds(1); await service.tick(); }
  expect(getAllTodaySeconds([], store.getState().files.values(), '2026-10-19', false, false)).toBe(0);
  expect(getAllTodaySeconds([], store.getState().files.values(), '2026-10-19', false, true)).toBe(10);
  title = '文章 B：完整标题';
  history.failAppends = true;
  clock.advanceSeconds(1);
  await service.tick();
  history.failAppends = false;
  clock.advanceSeconds(1);
  await service.tick();
  for (let i = 0; i < 10; i++) { clock.advanceSeconds(1); await service.tick(); }
  await service.saveCurrent('save');
  expect(history.getEvents().map(e => e.type)).toEqual(['start', 'activity', 'save']);
  expect(history.getEvents().flatMap(e => 'activityTitle' in e ? [e.activityTitle] : []))
    .toEqual(['文章 A：完整标题', '文章 B：完整标题', '文章 B：完整标题']);
  expect(getAllTodaySeconds(history.getEvents(), [], '2026-10-19', false, true)).toBe(22);
  expect(getAllTodaySeconds([], store.getState().files.values(), '2026-10-19', false, false)).toBe(0);
});
