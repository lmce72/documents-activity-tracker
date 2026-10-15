import { describe, it, expect } from 'bun:test';
import { ActionTypes } from '../src/core/constants';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import { countsUnfocusedAsReading } from '../src/core/settings';
import { createInitialState } from '../src/core/reducer';
import { TimerStore } from '../src/services/TimerStore';
import { TimerService } from '../src/services/TimerService';
import { FakeClock, CapturingLogger, testDeps } from './helpers/fake-clock';
import { MemoryHistory } from './helpers/memory-history';
import { buildFileRecords, computeSessionDurations } from '../src/core/timeline';
import { buildRecordDayRows, recordDayChannels } from '../src/core/recordsTimeline';
import { classifyUnfocusedInterval, listUnfocusedIntervals } from '../src/core/unfocused';
import { selectDocumentDisplayState } from '../src/core/selectors';
import type { TimelineEvent } from '../src/core/types';

const FILE = 'Notes/a.md';
function setup() {
  const clock = new FakeClock('2026-09-15T10:00:00');
  const log = new CapturingLogger();
  const { deps } = testDeps(clock, log);
  const store = new TimerStore(deps, createInitialState(deps));
  const history = new MemoryHistory();
  const service = new TimerService({ store, history, clock, log, settings: () => ({...DEFAULT_SETTINGS, minReadSeconds: 0, autoStartMode: 'always'}), getActivePath: () => FILE, getOpenPaths: () => [FILE] });
  return { clock, store, history, service, advance: async (seconds: number) => { for(let i=0;i<seconds;i++) { clock.advanceSeconds(1); await service.tick(); } } };
}
const events: TimelineEvent[] = [
  { time:'2026-09-15 10:00:00', type:'start', file:FILE, state:'tracking' },
  { time:'2026-09-15 10:00:10', type:'blur', file:FILE, state:'inactive' },
  { time:'2026-09-15 10:01:10', type:'focus', file:FILE, state:'tracking' },
  { time:'2026-09-15 10:01:20', type:'save', file:FILE, duration:80, activeSeconds:20, unfocusedSeconds:60 },
];
describe('split reading and reversible blur classification', () => {
  it('unfocused reading defaults off, explicit existing preference survives', () => {
    expect(DEFAULT_SETTINGS.countUnfocusedAsReading).toBe(false);
    expect(countsUnfocusedAsReading(DEFAULT_SETTINGS)).toBe(false);
    expect(countsUnfocusedAsReading({...DEFAULT_SETTINGS, countUnfocusedAsReading: true})).toBe(true);
  });
  it('toggle is prospective, keeps reading while blurred and resets after save', async () => {
    const ctx=setup(); await ctx.service.startCurrent(); await ctx.advance(5);
    await ctx.service.onWindowFocusChange(false); await ctx.advance(10);
    await ctx.service.setSplitReading(true); await ctx.advance(20);
    expect(selectDocumentDisplayState(ctx.store.getState())).toBe('running');
    expect(ctx.store.getState().files.get(FILE)!.activeSeconds).toBe(25);
    expect(ctx.store.getState().files.get(FILE)!.unfocusedSeconds).toBe(10);
    await ctx.service.setSplitReading(false); await ctx.advance(5);
    expect(ctx.store.getState().files.get(FILE)!.unfocusedSeconds).toBe(15);
    expect(computeSessionDurations(ctx.history.getEvents(),ctx.clock.now(),true).activeSeconds).toBe(25);
    await ctx.service.onWindowFocusChange(true);
    await ctx.service.saveCurrent('save');
    expect(ctx.store.getState().files.get(FILE)!.splitReading).toBe(false);
  });
  it('split mode integrates throttled ticks and still respects manual pause', async () => {
    const ctx=setup(); await ctx.service.startCurrent(); await ctx.service.setSplitReading(true);
    await ctx.service.onWindowFocusChange(false); ctx.clock.advanceSeconds(60); await ctx.service.tick();
    expect(ctx.store.getState().files.get(FILE)!.activeSeconds).toBe(60);
    await ctx.service.togglePause(); await ctx.advance(10);
    expect(ctx.store.getState().files.get(FILE)!.activeSeconds).toBe(60);
    await ctx.service.togglePause(); await ctx.advance(2);
    expect(ctx.store.getState().files.get(FILE)!.activeSeconds).toBe(62);
  });
  it('classification changes totals and heatmap, preserving provenance and allowing reversal', () => {
    const reading = classifyUnfocusedInterval(events,1,'reading');
    expect('unfocusedDisposition' in events[1]).toBe(false);
    const record=buildFileRecords(reading.events,0,'2026-09-15',{countUnfocused:false})[FILE];
    expect(record.totalReadTime).toBe(80);
    expect(recordDayChannels(record.readTimeLine,'2026-09-15').inWindow).toBe(80);
    const paused=classifyUnfocusedInterval(reading.events,1,'paused');
    expect(computeSessionDurations(paused.events,null,false).pausedSeconds).toBe(60);
    const restored=classifyUnfocusedInterval(paused.events,1,'unfocused');
    expect(computeSessionDurations(restored.events,null,false).unfocusedSeconds).toBe(60);
    expect(restored.events[3]).toEqual(events[3]);
    expect(listUnfocusedIntervals(restored.events)[0].from).toBe(events[1].time);
    expect(listUnfocusedIntervals(restored.events)[0].to).toBe(events[2].time);
    expect(buildRecordDayRows(record.readTimeLine,'2026-09-15').some(row=>row.segments.length)).toBe(true);
  });
  it('rejects open intervals', () => expect(()=>classifyUnfocusedInterval(events.slice(0,2),1,'reading')).toThrow());
  it('service adjusts live counters and preserves changes after save', async () => {
    const ctx=setup(); await ctx.service.startCurrent(); await ctx.advance(5);
    await ctx.service.onWindowFocusChange(false); await ctx.advance(10); await ctx.service.onWindowFocusChange(true);
    const interval=listUnfocusedIntervals(ctx.history.getEvents())[0];
    await ctx.service.classifyUnfocused(interval.index,interval.from,'reading');
    expect(ctx.store.getState().files.get(FILE)!.activeSeconds).toBe(15);
    expect(ctx.store.getState().files.get(FILE)!.unfocusedSeconds).toBe(0);
    await ctx.service.saveCurrent('save');
    expect(buildFileRecords(ctx.history.getEvents(),ctx.clock.now(),'2026-09-15',{countUnfocused:false})[FILE].totalReadTime).toBe(15);
    expect(ctx.history.getRecord(FILE)?.totalReadTime).toBe(15);
  });
});

it('mode does not leak into another document, even when paused', async () => {
  const ctx=setup(); await ctx.service.startCurrent(); await ctx.service.setSplitReading(true); await ctx.service.togglePause();
  ctx.store.dispatch({type:ActionTypes.SWITCH_FILE,payload:{fromPath:FILE,toPath:'Notes/b.md',autoStart:true}});
  expect(ctx.store.getState().files.get(FILE)?.splitReading).toBe(false);
  expect(ctx.store.getState().files.get('Notes/b.md')?.splitReading ?? false).toBe(false);
});
it('closed live intervals can be moved into paused and back without changing wall time', async () => {
  const ctx=setup(); await ctx.service.startCurrent(); await ctx.advance(5);
  await ctx.service.onWindowFocusChange(false); await ctx.advance(10); await ctx.service.onWindowFocusChange(true);
  const interval=listUnfocusedIntervals(ctx.history.getEvents())[0];
  await ctx.service.classifyUnfocused(interval.index,interval.from,'paused');
  expect(ctx.store.getState().files.get(FILE)?.pausedSeconds).toBe(10);
  expect(ctx.store.getState().files.get(FILE)?.unfocusedSeconds).toBe(0);
  await ctx.service.classifyUnfocused(interval.index,interval.from,'unfocused');
  expect(ctx.store.getState().files.get(FILE)?.pausedSeconds).toBe(0);
  expect(ctx.store.getState().files.get(FILE)?.unfocusedSeconds).toBe(10);
});

it('ongoing manual pause grows in display totals and is included when saved directly', async () => {
  const {liveWallClockSeconds}=await import('../src/core/types');
  const {getDayChannelSeconds}=await import('../src/core/timeline');
  const ctx=setup();await ctx.service.startCurrent();await ctx.advance(5);await ctx.service.togglePause();await ctx.advance(65);
  const file=ctx.store.getState().files.get(FILE)!;
  expect(liveWallClockSeconds(file,ctx.clock.now())).toBe(70);
  expect(getDayChannelSeconds([], [file], ctx.clock.today(), ctx.clock.now()).pausedSeconds).toBe(65);
  expect(file.activeSeconds).toBe(5);
  await ctx.service.saveCurrent('save');
  const saved=ctx.history.getEvents().find(e=>e.type==='save');
  expect(saved && 'duration' in saved ? saved.duration : null).toBe(70);
});
