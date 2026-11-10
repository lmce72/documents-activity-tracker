import { describe, expect, it } from 'bun:test';
import { ActionTypes, STATUS } from '../src/core/constants';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import { createInitialState, createTimerReducer } from '../src/core/reducer';
import { computeSessionDurations } from '../src/core/timeline';
import { liveDeductionSeconds, liveWallClockSeconds, type TimerAction } from '../src/core/types';
import { TimerService } from '../src/services/TimerService';
import { TimerStore } from '../src/services/TimerStore';
import { CapturingLogger, FakeClock, testDeps } from './helpers/fake-clock';
import { MemoryHistory } from './helpers/memory-history';

const FIRST = 'Notes/first.md';
const SECOND = 'Notes/second.md';

function setup(start = '2026-09-15T10:00:00') {
  const clock = new FakeClock(start);
  const { deps } = testDeps(clock);
  const reducer = createTimerReducer(deps);
  let state = createInitialState(deps);
  const dispatch = (action: TimerAction) => { state = reducer(state, action); return state; };
  const startFile = (filePath: string) => dispatch({
    type: ActionTypes.SWITCH_FILE,
    payload: { fromPath: null, toPath: filePath, autoStart: true, parallel: true },
  });
  return { clock, dispatch, startFile, getState: () => state };
}

describe('parallel focus boundaries / 并行焦点边界', () => {
  it('settles every running target before entering and leaving a throttled window', () => {
    const ctx = setup();
    ctx.startFile(FIRST);
    ctx.startFile(SECOND);
    ctx.clock.advanceSeconds(3);
    ctx.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused: false } });
    for (const path of [FIRST, SECOND]) {
      const file = ctx.getState().files.get(path)!;
      expect(file.activeSeconds).toBe(3);
      expect(file.lastTickTimestamp).toBe(ctx.clock.now());
    }
    ctx.clock.advanceSeconds(60);
    ctx.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused: true } });
    for (const path of [FIRST, SECOND]) {
      const file = ctx.getState().files.get(path)!;
      expect(file.activeSeconds).toBe(3);
      expect(file.unfocusedSeconds).toBe(60);
      expect(file.lastTickTimestamp).toBe(ctx.clock.now());
    }
  });

  it('keeps idle split reading separate from ordinary unfocused targets', () => {
    const ctx = setup();
    ctx.startFile(FIRST);
    ctx.dispatch({ type: ActionTypes.SET_SPLIT_READING, payload: { filePath: FIRST, enabled: true } });
    ctx.startFile(SECOND);
    ctx.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused: false } });
    ctx.dispatch({ type: ActionTypes.SET_IDLE });
    ctx.clock.advanceSeconds(30);
    ctx.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused: true } });
    expect(ctx.getState().files.get(FIRST)?.idleSeconds).toBe(30);
    expect(ctx.getState().files.get(FIRST)?.activeSeconds).toBe(0);
    expect(ctx.getState().files.get(SECOND)?.unfocusedSeconds).toBe(30);
    expect(ctx.getState().files.get(SECOND)?.activeSeconds).toBe(0);
  });

  it('drops sleep gaps for every target and never subtracts time after a clock correction', () => {
    const ctx = setup();
    ctx.startFile(FIRST);
    ctx.startFile(SECOND);
    ctx.clock.advanceSeconds(6);
    ctx.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused: false } });
    for (const file of ctx.getState().files.values()) {
      expect(file.activeSeconds).toBe(0);
      expect(file.lastTickTimestamp).toBe(ctx.clock.now());
    }
    ctx.clock.advanceSeconds(-2);
    ctx.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused: true } });
    for (const file of ctx.getState().files.values()) {
      expect(file.activeSeconds).toBe(0);
      expect(file.unfocusedSeconds).toBe(0);
      expect(file.lastTickTimestamp).toBe(ctx.clock.now());
    }
  });

  for (const type of [ActionTypes.USER_ACTIVITY, ActionTypes.CLEAR_IDLE]) {
    it(`${type} resets idle baselines for every parallel split target`, () => {
      const ctx = setup();
      for (const path of [FIRST, SECOND]) {
        ctx.startFile(path);
        ctx.dispatch({ type: ActionTypes.SET_SPLIT_READING, payload: { filePath: path, enabled: true } });
      }
      ctx.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused: false } });
      ctx.dispatch({ type: ActionTypes.SET_IDLE });
      ctx.clock.advanceSeconds(30);
      ctx.dispatch({ type });
      ctx.clock.advanceSeconds(1);
      for (const path of [FIRST, SECOND]) {
        ctx.dispatch({ type: ActionTypes.TICK, payload: { filePath: path } });
        expect(ctx.getState().files.get(path)?.activeSeconds).toBe(1);
      }
    });
  }
});

describe('live deduction / 运行卡扣减', () => {
  it('counts out-of-window time only', () => {
    const ctx = setup();
    ctx.startFile(FIRST);
    ctx.clock.advanceSeconds(3);
    ctx.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused: false } });
    ctx.clock.advanceSeconds(4);
    ctx.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused: true } });

    const file = ctx.getState().files.get(FIRST)!;
    expect(file.unfocusedSeconds).toBe(4);
    expect(liveDeductionSeconds(file)).toBe(4);
  });

  it('never counts focused-but-idle time', () => {
    const ctx = setup();
    ctx.startFile(FIRST);
    ctx.clock.advanceSeconds(1);
    ctx.dispatch({ type: ActionTypes.SET_IDLE });
    for (let second = 0; second < 3; second++) {
      ctx.clock.advanceSeconds(1);
      ctx.dispatch({ type: ActionTypes.TICK, payload: { filePath: FIRST } });
    }

    const file = ctx.getState().files.get(FIRST)!;
    expect(file.idleSeconds).toBe(3);
    expect(liveDeductionSeconds(file)).toBe(0);
  });

  it('freezes while deliberately paused instead of counting the pause', () => {
    const ctx = setup();
    ctx.startFile(FIRST);
    ctx.clock.advanceSeconds(3);
    ctx.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused: false } });
    ctx.clock.advanceSeconds(4);
    ctx.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused: true } });

    const file = ctx.getState().files.get(FIRST)!;
    expect(file.unfocusedSeconds).toBe(4);
    expect(liveDeductionSeconds(file)).toBe(4);

    ctx.dispatch({ type: ActionTypes.TOGGLE_PAUSE, payload: { filePath: FIRST } });
    const frozen = liveDeductionSeconds(ctx.getState().files.get(FIRST)!);
    ctx.clock.advanceSeconds(10);
    //  暂停不进入扣减：橙色数字停在离开窗口的秒数，不再增长
    //  A pause never enters the deduction: the orange figure stays at out-of-window seconds.
    expect(liveDeductionSeconds(ctx.getState().files.get(FIRST)!)).toBe(frozen);

    ctx.dispatch({ type: ActionTypes.TOGGLE_PAUSE, payload: { filePath: FIRST } });
    expect(ctx.getState().files.get(FIRST)?.pausedSeconds).toBe(10);
    expect(liveDeductionSeconds(ctx.getState().files.get(FIRST)!)).toBe(frozen);
  });
});

describe('paused day rollover / 暂停跨日', () => {
  it('reopens a paused session with a start boundary and counts only the new pause tail on resume', () => {
    const ctx = setup('2026-09-15T23:59:50');
    ctx.startFile(FIRST);
    for (let second = 0; second < 5; second++) {
      ctx.clock.advanceSeconds(1);
      ctx.dispatch({ type: ActionTypes.TICK, payload: { filePath: FIRST } });
    }
    ctx.dispatch({ type: ActionTypes.TOGGLE_PAUSE, payload: { filePath: FIRST } });
    ctx.dispatch({ type: ActionTypes.CONSUME_PENDING_WRITES, payload: { count: 1 } });
    ctx.clock.advanceSeconds(10);
    const rolloverTime = ctx.clock.nowFull();
    ctx.dispatch({ type: ActionTypes.DAY_ROLLOVER, payload: { filePath: FIRST } });
    const state = ctx.getState();
    const previous = state.pendingWrites[0]!;
    expect(previous.type).toBe('session');
    if (previous.type !== 'session') throw new Error('Expected yesterday’s saved session');
    expect(previous.activeSeconds).toBe(5);
    expect(previous.totalSeconds).toBe(15);
    expect(state.pendingWrites[1]).toEqual({
      type: 'timeline-start', filePath: FIRST, time: rolloverTime, state: 'pausing', parallel: true,
    });
    const file = state.files.get(FIRST)!;
    expect(file.status).toBe(STATUS.PAUSED);
    expect(file.sessionObject).toEqual({ [rolloverTime]: 'pausing' });
    expect(file.pauseStartTimestamp).toBe(ctx.clock.now());
    ctx.clock.advanceSeconds(5);
    expect(liveWallClockSeconds(ctx.getState().files.get(FIRST)!, ctx.clock.now())).toBe(5);
    ctx.dispatch({ type: ActionTypes.TOGGLE_PAUSE, payload: { filePath: FIRST } });
    expect(ctx.getState().files.get(FIRST)?.pausedSeconds).toBe(5);
    ctx.clock.advanceSeconds(1);
    ctx.dispatch({ type: ActionTypes.TICK, payload: { filePath: FIRST } });
    expect(ctx.getState().files.get(FIRST)?.activeSeconds).toBe(1);
  });

  it('persists a paused continuation that history can derive after resuming and saving', async () => {
    const clock = new FakeClock('2026-09-15T23:59:50');
    const log = new CapturingLogger();
    const { deps } = testDeps(clock, log);
    const store = new TimerStore(deps, createInitialState(deps));
    const history = new MemoryHistory();
    const service = new TimerService({
      store, history, clock, log,
      settings: () => ({ ...DEFAULT_SETTINGS, minReadSeconds: 0 }),
      getActivePath: () => FIRST,
      getOpenPaths: () => [FIRST],
      getSplitTargets: () => [FIRST],
    });
    await service.startCurrent();
    for (let second = 0; second < 5; second++) {
      clock.advanceSeconds(1);
      await service.tick();
    }
    await service.togglePause();
    clock.advanceSeconds(10);
    await service.tick();
    clock.advanceSeconds(5);
    await service.togglePause();
    clock.advanceSeconds(1);
    await service.tick();
    await service.saveCurrent('save');
    const today = history.getEvents().filter(event => event.time.startsWith('2026-09-16'));
    const startIndex = today.findIndex(event => event.type === 'start');
    expect(startIndex).toBeGreaterThanOrEqual(0);
    const duration = computeSessionDurations(today.slice(startIndex), null, false);
    expect(duration.activeSeconds).toBe(1);
    expect(duration.pausedSeconds).toBe(5);
  });
});
