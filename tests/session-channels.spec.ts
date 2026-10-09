/**
 * Dual-channel timing, manual timer and blur attribution.
 *
 * Covers the three new capabilities: blur keeps counting into `unfocusedSeconds`, the
 * independent manual timer, and blur-aware duration attribution.
 */

import { describe, expect, it } from 'bun:test';

import { ActionTypes, MANUAL_STATUS, STATUS } from '../src/core/constants';
import { createInitialState, createTimerReducer } from '../src/core/reducer';
import {
  selectManualElapsedSeconds,
  selectReadingSeconds,
  selectUnfocusedSeconds,
} from '../src/core/selectors';
import { computeSessionDurations } from '../src/core/timeline';
import {
  wallClockSeconds,
  type TimelineEvent,
  type TimerState,
} from '../src/core/types';
import { CapturingLogger, FakeClock, testDeps } from './helpers/fake-clock';

const FILE = 'Notes/alpha.md';
const D = '2026-09-07';

/** Build a fresh test context. */
function setup() {
  const clock = new FakeClock('2026-09-15T10:00:00');
  const logger = new CapturingLogger();
  const { deps } = testDeps(clock, logger);
  const reducer = createTimerReducer(deps);
  let state: TimerState = createInitialState(deps);

  const dispatch = (action: Parameters<typeof reducer>[1]): TimerState => {
    state = reducer(state, action);
    return state;
  };

  const drain = (): void => {
    const count = state.pendingWrites.length;
    if (count > 0) {
      dispatch({ type: ActionTypes.CONSUME_PENDING_WRITES, payload: { count } });
    }
  };

  return { clock, logger, dispatch, drain, getState: () => state };
}

function startTracking(ctx: ReturnType<typeof setup>, filePath = FILE): void {
  ctx.dispatch({
    type: ActionTypes.SWITCH_FILE,
    payload: { fromPath: null, toPath: filePath, autoStart: true },
  });
  ctx.drain();
}

/** Advance n seconds, one TICK per second. */
function tick(ctx: ReturnType<typeof setup>, seconds: number, filePath = FILE): void {
  for (let i = 0; i < seconds; i++) {
    ctx.clock.advanceSeconds(1);
    ctx.dispatch({ type: ActionTypes.TICK, payload: { filePath } });
  }
}

/** One TICK without advancing the clock. */
function bareTick(ctx: ReturnType<typeof setup>, filePath = FILE): void {
  ctx.dispatch({ type: ActionTypes.TICK, payload: { filePath } });
}

function setFocus(ctx: ReturnType<typeof setup>, focused: boolean): void {
  ctx.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused } });
}

describe('窗口焦点双通道 / window-focus channels', () => {
  it('初始视为聚焦，聚焦期间仍记入 activeSeconds', () => {
    const ctx = setup();
    expect(ctx.getState().isWindowFocused).toBe(true);

    startTracking(ctx);
    tick(ctx, 5);

    const file = ctx.getState().files.get(FILE)!;
    expect(file.activeSeconds).toBe(5);
    expect(file.unfocusedSeconds).toBe(0);
  });

  it('失焦后继续计时，但记入 unfocusedSeconds；恢复焦点后回到 activeSeconds', () => {
    const ctx = setup();
    startTracking(ctx);
    tick(ctx, 5);

    setFocus(ctx, false);
    tick(ctx, 4);
    let file = ctx.getState().files.get(FILE)!;
    expect(file.activeSeconds).toBe(5);
    expect(file.unfocusedSeconds).toBe(4);
    expect(selectReadingSeconds(ctx.getState(), FILE)).toBe(9);

    setFocus(ctx, true);
    tick(ctx, 3);
    file = ctx.getState().files.get(FILE)!;
    expect(file.activeSeconds).toBe(8);
    expect(file.unfocusedSeconds).toBe(4);
    expect(selectUnfocusedSeconds(ctx.getState(), FILE)).toBe(4);
  });

  it('失焦通道按实际间隔结算：被节流成 60 秒一次的 tick 记满 60 秒', () => {
    const ctx = setup();
    startTracking(ctx);
    tick(ctx, 2);
    setFocus(ctx, false);

    ctx.clock.advanceSeconds(60);
    bareTick(ctx);
    expect(ctx.getState().files.get(FILE)!.unfocusedSeconds).toBe(60);

    ctx.clock.advanceSeconds(60);
    bareTick(ctx);
    expect(ctx.getState().files.get(FILE)!.unfocusedSeconds).toBe(120);
  });

  it('失焦通道超过 90 秒的跳变（休眠）被丢弃并告警，随后恢复累加', () => {
    const ctx = setup();
    startTracking(ctx);
    setFocus(ctx, false);

    ctx.clock.advanceSeconds(600);
    bareTick(ctx);
    expect(ctx.getState().files.get(FILE)!.unfocusedSeconds).toBe(0);
    expect(ctx.logger.hasWarning('间隔过长')).toBe(true);

    ctx.clock.advanceSeconds(1);
    bareTick(ctx);
    expect(ctx.getState().files.get(FILE)!.unfocusedSeconds).toBe(1);
  });

  it('切换焦点时结算离开通道已流逝的时间，不丢那一分钟', () => {
    const ctx = setup();
    startTracking(ctx);
    setFocus(ctx, false);

    ctx.clock.advanceSeconds(45);
    setFocus(ctx, true);

    expect(ctx.getState().files.get(FILE)!.unfocusedSeconds).toBe(45);

    ctx.clock.advanceSeconds(1);
    setFocus(ctx, false);
    expect(ctx.getState().files.get(FILE)!.activeSeconds).toBe(1);
  });

  it('切换前的间隔已超出可信范围时只重置基准，不结算', () => {
    const ctx = setup();
    startTracking(ctx);
    setFocus(ctx, false);

    ctx.clock.advanceSeconds(600);
    setFocus(ctx, true);
    expect(ctx.getState().files.get(FILE)!.unfocusedSeconds).toBe(0);
  });

  it('暂停或空闲时不累加任何通道', () => {
    const ctx = setup();
    startTracking(ctx);
    setFocus(ctx, false);

    ctx.dispatch({ type: ActionTypes.SET_IDLE });
    tick(ctx, 3);
    expect(ctx.getState().files.get(FILE)!.unfocusedSeconds).toBe(0);

    ctx.dispatch({ type: ActionTypes.CLEAR_IDLE });
    tick(ctx, 3);
    expect(ctx.getState().files.get(FILE)!.unfocusedSeconds).toBe(3);
  });

  it('失焦期间写入的会话状态是 inactive，焦点期间是 tracking', () => {
    const ctx = setup();
    startTracking(ctx);
    setFocus(ctx, false);
    tick(ctx, 1);

    const sessionObject = ctx.getState().files.get(FILE)!.sessionObject!;
    const states = Object.values(sessionObject);
    expect(states).toContain('inactive');

    expect(states[0]).toBe('tracking');
    expect(states[states.length - 1]).toBe('inactive');

    setFocus(ctx, true);
    tick(ctx, 1);
    const after = Object.values(ctx.getState().files.get(FILE)!.sessionObject!);
    expect(after[after.length - 1]).toBe('tracking');
  });

  it('重复设置同一焦点状态不产生新状态 / 不结算', () => {
    const ctx = setup();
    startTracking(ctx);
    const before = ctx.getState();
    expect(ctx.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused: true } })).toBe(
      before,
    );
  });
});

describe('SAVE_SESSION 与失焦时长 / saving with unfocused time', () => {
  it('阈值口径为 窗口内 + 脱离窗口，且两段分别写入待写入队列', () => {
    const ctx = setup();
    startTracking(ctx);
    tick(ctx, 3);

    setFocus(ctx, false);
    ctx.clock.advanceSeconds(60);
    bareTick(ctx);
    setFocus(ctx, true);

    ctx.dispatch({
      type: ActionTypes.SAVE_SESSION,
      payload: { filePath: FILE, minReadSeconds: 20 },
    });

    const write = ctx.getState().pendingWrites[0]!;
    expect(write.type).toBe('session');
    if (write.type !== 'session') throw new Error('unreachable');

    expect(write.activeSeconds).toBe(3);
    expect(write.unfocusedSeconds).toBe(60);

    expect(write.totalSeconds).toBe(63);
  });

  it('单靠失焦时长也能越过阈值', () => {
    const ctx = setup();
    startTracking(ctx);
    setFocus(ctx, false);
    ctx.clock.advanceSeconds(30);
    bareTick(ctx);

    ctx.dispatch({
      type: ActionTypes.SAVE_SESSION,
      payload: { filePath: FILE, minReadSeconds: 20 },
    });

    expect(ctx.getState().pendingWrites).toHaveLength(1);
  });

  it('会话清空后 unfocusedSeconds 归零', () => {
    const ctx = setup();
    startTracking(ctx);
    setFocus(ctx, false);
    ctx.clock.advanceSeconds(30);
    bareTick(ctx);

    ctx.dispatch({
      type: ActionTypes.SAVE_SESSION,
      payload: { filePath: FILE, minReadSeconds: 5 },
    });

    const file = ctx.getState().files.get(FILE)!;
    expect(file.unfocusedSeconds).toBe(0);
    expect(file.activeSeconds).toBe(0);
    expect(wallClockSeconds(file)).toBe(0);
  });
});

describe('手动计时 / manual timer', () => {
  it('开始 → 计时；暂停冻结；恢复继续；停止归零', () => {
    const ctx = setup();
    const state = () => ctx.getState();

    expect(state().manual.status).toBe(MANUAL_STATUS.IDLE);
    expect(selectManualElapsedSeconds(state(), ctx.clock.now())).toBe(0);

    ctx.dispatch({ type: ActionTypes.MANUAL_START });
    expect(state().manual.status).toBe(MANUAL_STATUS.RUNNING);

    ctx.clock.advanceSeconds(90);
    expect(selectManualElapsedSeconds(state(), ctx.clock.now())).toBe(90);

    ctx.dispatch({ type: ActionTypes.MANUAL_PAUSE });
    ctx.clock.advanceSeconds(30);
    expect(selectManualElapsedSeconds(state(), ctx.clock.now())).toBe(90);

    ctx.dispatch({ type: ActionTypes.MANUAL_RESUME });
    ctx.clock.advanceSeconds(10);
    expect(selectManualElapsedSeconds(state(), ctx.clock.now())).toBe(100);

    ctx.dispatch({ type: ActionTypes.MANUAL_STOP });
    expect(state().manual.status).toBe(MANUAL_STATUS.IDLE);
    expect(selectManualElapsedSeconds(state(), ctx.clock.now())).toBe(0);
  });

  it('记录开始时刻的本地时间串，供落库使用', () => {
    const ctx = setup();
    ctx.dispatch({ type: ActionTypes.MANUAL_START });
    expect(ctx.getState().manual.startedAt).toBe('2026-09-15 10:00:00');
  });

  it('非法转移无副作用：未开始不能暂停、运行中不能重复开始', () => {
    const ctx = setup();

    const idle = ctx.getState();
    expect(ctx.dispatch({ type: ActionTypes.MANUAL_PAUSE })).toBe(idle);
    expect(ctx.dispatch({ type: ActionTypes.MANUAL_RESUME })).toBe(idle);
    expect(ctx.dispatch({ type: ActionTypes.MANUAL_STOP })).toBe(idle);

    ctx.dispatch({ type: ActionTypes.MANUAL_START });
    const running = ctx.getState();
    expect(ctx.dispatch({ type: ActionTypes.MANUAL_START })).toBe(running);
    expect(ctx.dispatch({ type: ActionTypes.MANUAL_RESUME })).toBe(running);
  });

  it('与文档追踪相互独立：两边同时进行、互不改写对方状态', () => {
    const ctx = setup();
    startTracking(ctx);
    tick(ctx, 5);

    const activeBefore = ctx.getState().activeFilePath;
    ctx.dispatch({ type: ActionTypes.MANUAL_START });
    ctx.clock.advanceSeconds(60);

    expect(ctx.getState().activeFilePath).toBe(activeBefore);
    expect(ctx.getState().files.get(FILE)!.activeSeconds).toBe(5);

    tick(ctx, 3);
    expect(selectManualElapsedSeconds(ctx.getState(), ctx.clock.now())).toBe(63);

    expect(ctx.getState().files.get(FILE)!.activeSeconds).toBe(7);
  });
});

describe('computeSessionDurations — 按事件类型归属', () => {
  const ev = (e: Record<string, unknown>): TimelineEvent => e as unknown as TimelineEvent;

  it('blur→focus 之间的时间归入失焦，不再算作活跃（修正既有缺陷）', () => {
    const events = [
      ev({ time: `${D} 08:00:00`, type: 'start', file: 'a.md', state: 'tracking' }),

      ev({ time: `${D} 08:10:00`, type: 'blur', file: 'a.md', state: 'tracking' }),
      ev({ time: `${D} 08:20:00`, type: 'focus', file: 'a.md', state: 'tracking' }),
      ev({ time: `${D} 08:30:00`, type: 'save', file: 'a.md', state: 'saved' }),
    ];

    const d = computeSessionDurations(events, null, false);
    expect(d.activeSeconds).toBe(1200);
    expect(d.unfocusedSeconds).toBe(600); //  08:10→08:20
    expect(d.pausedSeconds).toBe(0);
    expect(d.abnormal).toBe(false);
  });

  it('inactive 状态同样归入失焦（新数据）', () => {
    const events = [
      ev({ time: `${D} 08:00:00`, type: 'start', file: 'a.md', state: 'tracking' }),
      ev({ time: `${D} 08:01:00`, type: 'tick-state', file: 'a.md', state: 'inactive' }),
      ev({ time: `${D} 08:02:00`, type: 'save', file: 'a.md', state: 'saved' }),
    ];

    const d = computeSessionDurations(events, null, false);
    expect(d.activeSeconds).toBe(60);
    expect(d.unfocusedSeconds).toBe(60);
  });

  it('pause→resume 之间的时间归入暂停，不计入阅读', () => {
    const events = [
      ev({ time: `${D} 08:00:00`, type: 'start', file: 'a.md', state: 'tracking' }),
      ev({ time: `${D} 08:01:00`, type: 'pause', file: 'a.md', state: 'pausing' }),
      ev({ time: `${D} 08:03:00`, type: 'resume', file: 'a.md', state: 'tracking' }),
      ev({ time: `${D} 08:04:00`, type: 'save', file: 'a.md', state: 'saved' }),
    ];

    const d = computeSessionDurations(events, null, false);
    expect(d.activeSeconds).toBe(120);
    expect(d.pausedSeconds).toBe(120);
  });

  it('超过 4 小时的失焦段视为人已离开，不计入任何一档', () => {
    const events = [
      ev({ time: `${D} 08:00:00`, type: 'start', file: 'a.md', state: 'tracking' }),
      ev({ time: `${D} 09:00:00`, type: 'blur', file: 'a.md', state: 'inactive' }),

      ev({ time: '2026-09-08 00:00:00', type: 'focus', file: 'a.md', state: 'tracking' }),
      ev({ time: '2026-09-08 00:10:00', type: 'save', file: 'a.md', state: 'saved' }),
    ];

    const d = computeSessionDurations(events, null, false);
    expect(d.unfocusedSeconds).toBe(0);
    expect(d.activeSeconds).toBe(3600 + 600);
  });

  it('推算段超过 24 小时不采信，但事件夹出的真实间隔仍然采信', () => {
    const events = [
      ev({ time: '2026-09-01 08:00:00', type: 'start', file: 'a.md', state: 'tracking' }),
      ev({ time: '2026-09-01 08:00:30', type: 'blur', file: 'a.md', state: 'inactive' }),
    ];
    const now = new Date('2026-09-07T08:00:00').getTime();

    const d = computeSessionDurations(events, now, true);
    expect(d.activeSeconds).toBe(30);
    expect(d.unfocusedSeconds).toBe(0);
    expect(d.abnormal).toBe(true);
  });

  it('switch 事件不作为归属边界，跨过它继续累计', () => {
    const events = [
      ev({ time: `${D} 08:00:00`, type: 'start', file: 'a.md', state: 'tracking' }),
      ev({
        time: `${D} 08:05:00`,
        type: 'switch',
        from: 'x.md',
        to: 'a.md',
        fromState: 'tracking',
        toState: 'tracking',
      }),
      ev({ time: `${D} 08:10:00`, type: 'save', file: 'a.md', state: 'saved' }),
    ];

    expect(computeSessionDurations(events, null, false).activeSeconds).toBe(600);
  });

  it('空事件返回全零', () => {
    expect(computeSessionDurations([], 1000, true)).toEqual({
      activeSeconds: 0,
      unfocusedSeconds: 0,
      pausedSeconds: 0,
      abnormal: false,
    });
  });
});
