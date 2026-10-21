/**
 * 空闲通道 / the idle channel
 *
 * 空闲以前被直接丢弃。现在它有两条边界事件（`idle` / `idle-end`），落盘后的账要能认出这一段，
 * 而不是把它并进前一个区间算成专注。
 * Idle used to be discarded. It now has two boundary events, and the settled account has to recognise
 * the stretch instead of folding it into the previous interval as active time.
 */

import { describe, expect, it } from 'bun:test';

import { ActionTypes } from '../src/core/constants';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import { createInitialState } from '../src/core/reducer';
import { computeSessionDurations } from '../src/core/timeline';
import { listIdleIntervals, listUnfocusedIntervals } from '../src/core/unfocused';
import type { TimelineEvent } from '../src/core/types';
import { TimerService } from '../src/services/TimerService';
import { TimerStore } from '../src/services/TimerStore';
import { CapturingLogger, FakeClock, testDeps } from './helpers/fake-clock';
import { MemoryHistory } from './helpers/memory-history';

const FILE = 'Notes/a.md';
const D = '2026-09-15';

function setup() {
  const clock = new FakeClock('2026-09-15T10:00:00');
  const log = new CapturingLogger();
  const { deps } = testDeps(clock, log);
  const store = new TimerStore(deps, createInitialState(deps));
  const history = new MemoryHistory();
  const service = new TimerService({
    store,
    history,
    clock,
    log,
    settings: () => ({ ...DEFAULT_SETTINGS, minReadSeconds: 0, autoStartMode: 'always' }),
    getActivePath: () => FILE,
    getOpenPaths: () => [FILE],
  });
  return { clock, store, history, service };
}

describe('listIdleIntervals / 空闲时段', () => {
  it('一对 idle / idle-end 组成一段', () => {
    const events: TimelineEvent[] = [
      { time: `${D} 10:00:00`, type: 'start', file: FILE, state: 'tracking' },
      { time: `${D} 10:01:00`, type: 'idle', file: FILE, state: 'idle' },
      { time: `${D} 10:03:00`, type: 'idle-end', file: FILE, state: 'tracking' },
      { time: `${D} 10:05:00`, type: 'save', file: FILE, state: 'saved' },
    ];

    const intervals = listIdleIntervals(events);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.from).toBe(`${D} 10:01:00`);
    expect(intervals[0]?.to).toBe(`${D} 10:03:00`);
    expect(intervals[0]?.seconds).toBe(120);
  });

  it('空闲段不会被误当作离开窗口', () => {
    const events: TimelineEvent[] = [
      { time: `${D} 10:00:00`, type: 'start', file: FILE, state: 'tracking' },
      { time: `${D} 10:01:00`, type: 'idle', file: FILE, state: 'idle' },
      { time: `${D} 10:03:00`, type: 'idle-end', file: FILE, state: 'tracking' },
    ];
    expect(listUnfocusedIntervals(events)).toHaveLength(0);
  });

  it('被丢弃的会话里没有空闲段', () => {
    const events: TimelineEvent[] = [
      { time: `${D} 10:00:00`, type: 'start', file: FILE, state: 'tracking' },
      { time: `${D} 10:01:00`, type: 'idle', file: FILE, state: 'idle' },
      { time: `${D} 10:02:00`, type: 'idle-end', file: FILE, state: 'tracking' },
      { time: `${D} 10:03:00`, type: 'discard', file: FILE },
    ];
    expect(listIdleIntervals(events)).toHaveLength(0);
  });
});

describe('computeSessionDurations / 推导', () => {
  it('空闲段记进 idleSeconds，不并进专注', () => {
    const events: TimelineEvent[] = [
      { time: `${D} 10:00:00`, type: 'start', file: FILE, state: 'tracking' },
      { time: `${D} 10:01:00`, type: 'idle', file: FILE, state: 'idle' },
      { time: `${D} 10:03:00`, type: 'idle-end', file: FILE, state: 'tracking' },
      {
        time: `${D} 10:05:00`,
        type: 'save',
        file: FILE,
        state: 'saved',
        duration: 300,
        activeSeconds: 180,
        unfocusedSeconds: 0,
        idleSeconds: 120,
      },
    ];

    const durations = computeSessionDurations(events, null, false);
    expect(durations.activeSeconds).toBe(180);
    expect(durations.idleSeconds).toBe(120);
    expect(durations.unfocusedSeconds).toBe(0);
  });
});

describe('回到窗口但仍在空闲 / focus regained while idle', () => {
  it('写 idle 事件而不是 focus，否则那段会被算成专注', async () => {
    const ctx = setup();
    await ctx.service.startCurrent();

    //  失焦 → 空闲标志保持 → 回来 / blur, the idle flag survives, then focus returns
    await ctx.service.onWindowFocusChange(false);
    ctx.store.dispatch({ type: ActionTypes.SET_IDLE });
    await ctx.service.onWindowFocusChange(true);

    const events = ctx.history.getEvents();
    const last = events[events.length - 1]!;
    expect(last.type).toBe('idle');
    expect('state' in last ? last.state : undefined).toBe('idle');

    //  之后真正有输入：idle-end 收尾 / real input closes it
    ctx.clock.advanceSeconds(60);
    await ctx.service.tick();
    ctx.store.dispatch({ type: ActionTypes.USER_ACTIVITY });
    await ctx.service.tick();

    const idle = listIdleIntervals(ctx.history.getEvents());
    expect(idle.length).toBeGreaterThan(0);
  });
});

describe('空闲收尾 / closing the stretch', () => {
  it('用户一动就把 idle-end 写出来，回来之后的阅读不会被吞成空闲', async () => {
    const clock = new FakeClock('2026-09-15T10:00:00');
    const log = new CapturingLogger();
    const { deps } = testDeps(clock, log);
    const store = new TimerStore(deps, createInitialState(deps));
    const history = new MemoryHistory();
    const service = new TimerService({
      store,
      history,
      clock,
      log,
      settings: () => ({
        ...DEFAULT_SETTINGS,
        minReadSeconds: 0,
        autoStartMode: 'always',
        idleTimeoutEnabled: true,
        idleTimeout: 1,
      }),
      getActivePath: () => FILE,
      getOpenPaths: () => [FILE],
    });

    await service.startCurrent();

    //  2 秒没输入 → 进入空闲 / two quiet seconds: idle begins
    clock.advanceSeconds(2);
    await service.tick();
    //  再空转 1 秒 / one more idle second
    clock.advanceSeconds(1);
    await service.tick();

    //  用户回来 / the user comes back
    service.markUserActivity();

    //  之后读了 2 秒 / two seconds of reading
    clock.advanceSeconds(2);
    await service.tick();

    const events = history.getEvents();
    const types = events.map((event) => event.type);
    expect(types).toContain('idle');
    expect(types).toContain('idle-end');

    //  收尾事件的顺序必须是 idle → idle-end，而不是拖到保存；之后若再次无输入，会开始新的一段
    //  The boundary closes as idle → idle-end rather than waiting for the save; another quiet stretch
    //  may open a fresh one.
    const idleIndex = types.indexOf('idle');
    const endIndex = types.indexOf('idle-end', idleIndex);
    expect(endIndex).toBeGreaterThan(idleIndex);

    const durations = computeSessionDurations(events, null, true);
    expect(durations.idleSeconds).toBeGreaterThan(0);
    expect(durations.activeSeconds).toBeGreaterThan(0);
  });
});

describe('逐段「不记录」的推导 / an ignored stretch in the derivation', () => {
  it('哪条通道都不进 / enters no channel', () => {
    const events: TimelineEvent[] = [
      { time: `${D} 10:00:00`, type: 'start', file: FILE, state: 'tracking' },
      {
        time: `${D} 10:01:00`,
        type: 'blur',
        file: FILE,
        state: 'inactive',
        unfocusedDisposition: 'ignored',
      },
      { time: `${D} 10:03:00`, type: 'focus', file: FILE, state: 'tracking' },
      {
        time: `${D} 10:05:00`,
        type: 'save',
        file: FILE,
        state: 'saved',
        duration: 300,
        activeSeconds: 180,
        unfocusedSeconds: 120,
      },
    ];

    const durations = computeSessionDurations(events, null, false);
    expect(durations.activeSeconds).toBe(180);
    expect(durations.unfocusedSeconds).toBe(0);
    expect(durations.idleSeconds).toBe(0);
    expect(durations.pausedSeconds).toBe(0);
  });
});
