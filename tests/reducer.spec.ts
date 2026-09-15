/**
 * 状态机测试 / Reducer tests
 *
 * 覆盖本次重构中改动最深的几处：
 *   - 双秒数字段合并（activeSeconds + pausedSeconds，墙钟派生）
 *   - 跨日处理 DAY_ROLLOVER（原实现只有常量、无 case）
 *   - 待写入队列的消费语义（CONSUME / REQUEUE）
 *   - 时间注入带来的确定性（「跟踪 10s → 暂停 30s → 恢复 10s」可精确断言）
 *   - reducer 的纯性（不修改入参 state）
 *
 * Covers the deepest changes: merged second-counters, the previously unimplemented
 * DAY_ROLLOVER, the pending-write consumption semantics, clock injection, and purity.
 */

import { describe, expect, it } from 'bun:test';

import { ActionTypes, STATUS } from '../src/core/constants';
import { createInitialState, createTimerReducer } from '../src/core/reducer';
import { wallClockSeconds, type TimerState } from '../src/core/types';
import { CapturingLogger, FakeClock, testDeps } from './helpers/fake-clock';

const FILE = 'Notes/alpha.md';
const OTHER = 'Notes/beta.md';

/** 建一个可用的测试环境 / Build a fresh test context. */
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

  /** 把当前队列清空，使断言只看到本用例新产生的事件 / drain so assertions see only new writes. */
  const drain = (): void => {
    const count = state.pendingWrites.length;
    if (count > 0) {
      dispatch({ type: ActionTypes.CONSUME_PENDING_WRITES, payload: { count } });
    }
  };

  return { clock, logger, reducer, dispatch, drain, getState: () => state };
}

/**
 * 让某文件进入追踪态 / Put a file into TRACKING with an open session.
 * 默认清空待写入队列：SWITCH_FILE 自身会推一条 timeline-start，
 * 若不清空，后续针对 pendingWrites 的断言都会被它干扰。
 *
 * Drains pending writes by default, because SWITCH_FILE itself queues a
 * timeline-start that would otherwise skew later assertions.
 */
function startTracking(ctx: ReturnType<typeof setup>, filePath = FILE): void {
  ctx.dispatch({
    type: ActionTypes.SWITCH_FILE,
    payload: { fromPath: null, toPath: filePath, autoStart: true },
  });
  ctx.drain();
}

/** 推进 n 秒，每秒一个 TICK / Advance n seconds, one TICK per second. */
function tick(ctx: ReturnType<typeof setup>, seconds: number, filePath = FILE): void {
  for (let i = 0; i < seconds; i++) {
    ctx.clock.advanceSeconds(1);
    ctx.dispatch({ type: ActionTypes.TICK, payload: { filePath } });
  }
}

describe('TICK — 累加与间隔防护', () => {
  it('每秒给 activeSeconds 加 1，pausedSeconds 保持为 0', () => {
    const ctx = setup();
    startTracking(ctx);
    tick(ctx, 10);

    const file = ctx.getState().files.get(FILE)!;
    expect(file.activeSeconds).toBe(10);
    expect(file.pausedSeconds).toBe(0);
    expect(wallClockSeconds(file)).toBe(10);
  });

  it('未被追踪的文件不累加', () => {
    const ctx = setup();
    startTracking(ctx);
    ctx.clock.advanceSeconds(1);
    ctx.dispatch({ type: ActionTypes.TICK, payload: { filePath: OTHER } });

    expect(ctx.getState().files.get(OTHER)).toBeUndefined();
  });

  it('间隔超过 5 秒的那一次 tick 被丢弃并告警（防止休眠后错误累加）', () => {
    const ctx = setup();
    startTracking(ctx);
    tick(ctx, 5);
    expect(ctx.getState().files.get(FILE)!.activeSeconds).toBe(5);

    // 模拟系统休眠：直接跨过 60 秒
    ctx.clock.advanceSeconds(60);
    ctx.dispatch({ type: ActionTypes.TICK, payload: { filePath: FILE } });

    expect(ctx.getState().files.get(FILE)!.activeSeconds).toBe(5); // 未增加
    expect(ctx.logger.hasWarning('间隔过长')).toBe(true);

    // 丢弃后时间戳已刷新，下一次正常 tick 应恢复累加
    tick(ctx, 1);
    expect(ctx.getState().files.get(FILE)!.activeSeconds).toBe(6);
  });

  it('全局暂停或空闲时不累加', () => {
    const ctx = setup();
    startTracking(ctx);
    ctx.dispatch({ type: ActionTypes.SET_IDLE });
    tick(ctx, 3);
    expect(ctx.getState().files.get(FILE)!.activeSeconds).toBe(0);

    ctx.dispatch({ type: ActionTypes.CLEAR_IDLE });
    tick(ctx, 3);
    expect(ctx.getState().files.get(FILE)!.activeSeconds).toBe(3);
  });
});

describe('TOGGLE_PAUSE — 双秒数字段合并', () => {
  it('跟踪 10 秒 → 暂停 30 秒 → 恢复 10 秒：active=20, paused=30, 墙钟=50', () => {
    const ctx = setup();
    startTracking(ctx);
    tick(ctx, 10);

    // 暂停
    ctx.clock.advanceSeconds(1);
    ctx.dispatch({ type: ActionTypes.TOGGLE_PAUSE, payload: { filePath: FILE } });
    expect(ctx.getState().files.get(FILE)!.status).toBe(STATUS.PAUSED);

    // 暂停 30 秒（期间不 tick）
    ctx.clock.advanceSeconds(30);

    // 恢复
    ctx.dispatch({ type: ActionTypes.TOGGLE_PAUSE, payload: { filePath: FILE } });
    const afterResume = ctx.getState().files.get(FILE)!;
    expect(afterResume.status).toBe(STATUS.TRACKING);
    // 恰好 30 秒。暂停前那 1 秒落在两次 tick 之间、不计入（与原实现一致）
    expect(afterResume.pausedSeconds).toBe(30);
    expect(afterResume.activeSeconds).toBe(10);

    tick(ctx, 10);
    const final = ctx.getState().files.get(FILE)!;
    expect(final.activeSeconds).toBe(20);
    expect(final.pausedSeconds).toBe(30);
    // 墙钟 = 活跃 + 暂停，等价于原实现的 accumulatedSeconds
    expect(wallClockSeconds(final)).toBe(50);
  });

  it('恢复时记录一段 pausedRanges，供热力图渲染橙色块', () => {
    const ctx = setup();
    startTracking(ctx);
    tick(ctx, 3);

    ctx.dispatch({ type: ActionTypes.TOGGLE_PAUSE, payload: { filePath: FILE } });
    const pauseStart = ctx.clock.now();
    ctx.clock.advanceSeconds(12);
    ctx.dispatch({ type: ActionTypes.TOGGLE_PAUSE, payload: { filePath: FILE } });

    const ranges = ctx.getState().files.get(FILE)!.pausedRanges;
    expect(ranges).toHaveLength(1);
    expect(ranges[0]![0]).toBe(pauseStart);
    expect(ranges[0]![1]).toBe(ctx.clock.now());
  });

  it('IDLE 态下 toggle 不产生任何变化', () => {
    const ctx = setup();
    ctx.dispatch({
      type: ActionTypes.SWITCH_FILE,
      payload: { fromPath: null, toPath: FILE, autoStart: false },
    });
    const before = ctx.getState();
    const after = ctx.dispatch({
      type: ActionTypes.TOGGLE_PAUSE,
      payload: { filePath: FILE },
    });
    expect(after).toBe(before); // 引用相等 = 未产生新状态
  });
});

describe('SAVE_SESSION — 阈值与结算', () => {
  it('低于阈值时清空会话且不产生待写入', () => {
    const ctx = setup();
    startTracking(ctx);
    tick(ctx, 3);

    ctx.dispatch({
      type: ActionTypes.SAVE_SESSION,
      payload: { filePath: FILE, minReadSeconds: 20 },
    });

    const state = ctx.getState();
    expect(state.pendingWrites).toHaveLength(0);
    const file = state.files.get(FILE)!;
    expect(file.status).toBe(STATUS.IDLE);
    expect(file.activeSeconds).toBe(0);
    expect(file.sessionObject).toBeNull();
    expect(ctx.logger.infos.some((m) => m.includes('时长不足'))).toBe(true);
  });

  it('达到阈值时产生一条 session 待写入，totalSeconds 用墙钟值', () => {
    const ctx = setup();
    startTracking(ctx);
    tick(ctx, 10);
    // 制造一段暂停，验证 totalSeconds 记的是墙钟而非活跃
    ctx.dispatch({ type: ActionTypes.TOGGLE_PAUSE, payload: { filePath: FILE } });
    ctx.clock.advanceSeconds(20);
    ctx.dispatch({ type: ActionTypes.TOGGLE_PAUSE, payload: { filePath: FILE } });

    ctx.dispatch({
      type: ActionTypes.SAVE_SESSION,
      payload: { filePath: FILE, minReadSeconds: 5 },
    });

    const writes = ctx.getState().pendingWrites;
    expect(writes).toHaveLength(1);
    const write = writes[0]!;
    expect(write.type).toBe('session');
    if (write.type !== 'session') throw new Error('unreachable');

    expect(write.activeSeconds).toBe(10);
    expect(write.totalSeconds).toBe(30); // 10 活跃 + 20 暂停
    expect(write.session[Object.keys(write.session).sort().pop()!]).toBe('saved');

    const file = ctx.getState().files.get(FILE)!;
    expect(file.status).toBe(STATUS.IDLE);
    expect(file.activeSeconds).toBe(0);
    expect(file.pausedSeconds).toBe(0);
  });
});

describe('DISCARD_SESSION', () => {
  it('清空会话并写入一条 discard 事件', () => {
    const ctx = setup();
    startTracking(ctx);
    tick(ctx, 7);

    ctx.dispatch({ type: ActionTypes.DISCARD_SESSION, payload: { filePath: FILE } });

    const state = ctx.getState();
    const writes = state.pendingWrites;
    expect(writes).toHaveLength(1);
    expect(writes[0]!.type).toBe('timeline-discard');
    expect(state.files.get(FILE)!.status).toBe(STATUS.IDLE);
    expect(state.files.get(FILE)!.activeSeconds).toBe(0);
  });
});

describe('SWITCH_FILE', () => {
  it('新文件自动开始时产生 timeline-start 并进入追踪态', () => {
    const ctx = setup();
    // 刻意直接 dispatch 而不用 startTracking：后者会清空队列，而本用例要断言这条 start
    ctx.dispatch({
      type: ActionTypes.SWITCH_FILE,
      payload: { fromPath: null, toPath: FILE, autoStart: true },
    });

    const state = ctx.getState();
    expect(state.activeFilePath).toBe(FILE);
    expect(state.files.get(FILE)!.status).toBe(STATUS.TRACKING);
    expect(state.pendingWrites).toHaveLength(1);
    expect(state.pendingWrites[0]!.type).toBe('timeline-start');
  });

  it('autoStart=false 时进入 IDLE 且不写 start 事件', () => {
    const ctx = setup();
    ctx.dispatch({
      type: ActionTypes.SWITCH_FILE,
      payload: { fromPath: null, toPath: FILE, autoStart: false },
    });

    expect(ctx.getState().files.get(FILE)!.status).toBe(STATUS.IDLE);
    expect(ctx.getState().pendingWrites).toHaveLength(0);
  });

  it('切走时旧文件转 IDLE；切回时不重复写 start', () => {
    const ctx = setup();
    startTracking(ctx);
    tick(ctx, 5);

    ctx.dispatch({
      type: ActionTypes.SWITCH_FILE,
      payload: { fromPath: FILE, toPath: OTHER, autoStart: true },
    });
    expect(ctx.getState().files.get(FILE)!.status).toBe(STATUS.IDLE);
    expect(ctx.getState().activeFilePath).toBe(OTHER);

    const writesBefore = ctx.getState().pendingWrites.length;
    ctx.dispatch({
      type: ActionTypes.SWITCH_FILE,
      payload: { fromPath: OTHER, toPath: FILE, autoStart: true },
    });

    expect(ctx.getState().files.get(FILE)!.status).toBe(STATUS.TRACKING);
    expect(ctx.getState().pendingWrites.length).toBe(writesBefore);
  });
});

describe('DAY_ROLLOVER — 原实现缺失的能力', () => {
  it('跨日时闭合昨日会话并开启新会话', () => {
    const ctx = setup();
    startTracking(ctx);
    tick(ctx, 30);
    const beforeRollover = ctx.getState().files.get(FILE)!;
    expect(beforeRollover.sessionStartTime!.startsWith('2026-09-15')).toBe(true);

    // 跨到次日
    ctx.clock.setLocal('2026-09-16T00:00:05');
    ctx.dispatch({ type: ActionTypes.DAY_ROLLOVER, payload: { filePath: FILE } });

    const state = ctx.getState();
    // 一条 session（闭合昨日）+ 一条 timeline-start（开启今日）
    const types = state.pendingWrites.map((w) => w.type);
    expect(types).toContain('session');
    expect(types).toContain('timeline-start');

    const file = state.files.get(FILE)!;
    expect(file.sessionStartTime!.startsWith('2026-09-16')).toBe(true);
    expect(file.activeSeconds).toBe(0);
    expect(file.pausedSeconds).toBe(0);
    expect(file.status).toBe(STATUS.TRACKING);
    expect(state.lastCheckDay).toBe('2026-09-16');
  });

  it('同一天内重复触发是幂等的（无副作用）', () => {
    const ctx = setup();
    startTracking(ctx);
    ctx.clock.setLocal('2026-09-16T00:00:05');

    ctx.dispatch({ type: ActionTypes.DAY_ROLLOVER, payload: { filePath: FILE } });
    const afterFirst = ctx.getState();
    const writesAfterFirst = afterFirst.pendingWrites.length;

    const afterSecond = ctx.dispatch({
      type: ActionTypes.DAY_ROLLOVER,
      payload: { filePath: FILE },
    });

    expect(afterSecond).toBe(afterFirst); // 引用相等 = 完全无副作用
    expect(afterSecond.pendingWrites.length).toBe(writesAfterFirst);
  });

  it('会话开始于今日时不触发任何重置', () => {
    const ctx = setup();
    startTracking(ctx);
    const before = ctx.getState();
    const after = ctx.dispatch({
      type: ActionTypes.DAY_ROLLOVER,
      payload: { filePath: FILE },
    });
    expect(after).toBe(before);
  });
});

describe('待写入队列 / pending-write queue', () => {
  it('CONSUME_PENDING_WRITES 从队首消费指定条数', () => {
    const ctx = setup();
    startTracking(ctx);
    // 切到新文件推入 1 条 timeline-start，再丢弃推入 1 条 timeline-discard
    ctx.dispatch({
      type: ActionTypes.SWITCH_FILE,
      payload: { fromPath: FILE, toPath: OTHER, autoStart: true },
    });
    ctx.dispatch({ type: ActionTypes.DISCARD_SESSION, payload: { filePath: OTHER } });

    const queued = ctx.getState().pendingWrites;
    expect(queued).toHaveLength(2);
    expect(queued.map((w) => w.type)).toEqual(['timeline-start', 'timeline-discard']);

    ctx.dispatch({
      type: ActionTypes.CONSUME_PENDING_WRITES,
      payload: { count: 1 },
    });

    const remaining = ctx.getState().pendingWrites;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.type).toBe('timeline-discard'); // 队首那条已被消费
  });

  it('消费 0 或负数不改变状态', () => {
    const ctx = setup();
    startTracking(ctx);
    const before = ctx.getState();
    expect(
      ctx.dispatch({ type: ActionTypes.CONSUME_PENDING_WRITES, payload: { count: 0 } }),
    ).toBe(before);
    expect(
      ctx.dispatch({ type: ActionTypes.CONSUME_PENDING_WRITES, payload: { count: -3 } }),
    ).toBe(before);
  });

  it('REQUEUE_PENDING_WRITES 把事件写回队首，顺序不变', () => {
    const ctx = setup();
    startTracking(ctx);
    ctx.dispatch({
      type: ActionTypes.SWITCH_FILE,
      payload: { fromPath: FILE, toPath: OTHER, autoStart: true },
    });

    const claimed = ctx.getState().pendingWrites;
    ctx.dispatch({
      type: ActionTypes.CONSUME_PENDING_WRITES,
      payload: { count: claimed.length },
    });
    expect(ctx.getState().pendingWrites).toHaveLength(0);

    ctx.dispatch({
      type: ActionTypes.REQUEUE_PENDING_WRITES,
      payload: { writes: claimed },
    });

    const restored = ctx.getState().pendingWrites;
    expect(restored).toHaveLength(claimed.length);
    expect(restored.map((w) => w.type)).toEqual(claimed.map((w) => w.type));
  });
});

describe('纯性 / purity', () => {
  it('不修改入参 state', () => {
    const ctx = setup();
    startTracking(ctx);
    tick(ctx, 5);

    const state = ctx.getState();
    const filesSnapshot = [...state.files.entries()].map(([k, v]) => [k, { ...v }]);
    const pendingSnapshot = JSON.stringify(state.pendingWrites);

    ctx.dispatch({ type: ActionTypes.TOGGLE_PAUSE, payload: { filePath: FILE } });
    tick(ctx, 2, OTHER);

    // 老 state 对象的内容必须原封不动
    const filesNow = [...state.files.entries()].map(([k, v]) => [k, { ...v }]);
    expect(JSON.stringify(filesNow)).toBe(JSON.stringify(filesSnapshot));
    expect(JSON.stringify(state.pendingWrites)).toBe(pendingSnapshot);
    expect(state.files.get(FILE)!.status).toBe(STATUS.TRACKING);
  });

  it('相同输入必得相同输出（时钟固定时）', () => {
    const run = () => {
      const ctx = setup();
      startTracking(ctx);
      tick(ctx, 5);
      ctx.dispatch({ type: ActionTypes.TOGGLE_PAUSE, payload: { filePath: FILE } });
      ctx.clock.advanceSeconds(9);
      ctx.dispatch({ type: ActionTypes.TOGGLE_PAUSE, payload: { filePath: FILE } });
      return JSON.stringify([...ctx.getState().files.entries()]);
    };
    expect(run()).toBe(run());
  });
});

describe('USER_ACTIVITY / 空闲', () => {
  it('用户活动清除空闲标记并刷新时间', () => {
    const ctx = setup();
    ctx.dispatch({ type: ActionTypes.SET_IDLE });
    expect(ctx.getState().isIdle).toBe(true);

    ctx.clock.advanceSeconds(5);
    ctx.dispatch({ type: ActionTypes.USER_ACTIVITY });

    expect(ctx.getState().isIdle).toBe(false);
    expect(ctx.getState().lastActivityTime).toBe(ctx.clock.now());
  });
});
