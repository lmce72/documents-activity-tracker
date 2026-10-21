/**
 * Countdown modes / 倒计时
 *
 * Three modes share one model: a run is a sequence of fixed-length phases. What is pinned here is
 * the part that is easy to get wrong — where a phase boundary falls, what a paused run reports, and
 * that a finished run is recorded at its planned length rather than a tick late.
 */

import { describe, expect, it } from 'bun:test';

import {
  buildCountdownPlan,
  clampCycles,
  clampMinutes,
  countdownConfigFrom,
  locatePhase,
  planTotalSeconds,
  type CountdownConfig,
} from '../src/core/countdown';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import { createInitialState } from '../src/core/reducer';
import type { PluginSettings } from '../src/core/types';
import { CountdownTimerService } from '../src/services/CountdownTimerService';
import { TimerStore } from '../src/services/TimerStore';
import { CapturingLogger, FakeClock, testDeps } from './helpers/fake-clock';
import { MemoryHistory } from './helpers/memory-history';

function config(overrides: Partial<CountdownConfig> = {}): CountdownConfig {
  return {
    mode: 'down',
    downMinutes: 25,
    focusMinutes: 25,
    breakMinutes: 5,
    cycles: 4,
    repeat: false,
    intervals: [25, 5, 25],
    ...overrides,
  };
}

describe('buildCountdownPlan / 生成方案', () => {
  it('倒计时＝一段', () => {
    const plan = buildCountdownPlan(config());
    expect(plan.mode).toBe('down');
    expect(plan.phases).toEqual([{ kind: 'focus', seconds: 1500 }]);
    expect(planTotalSeconds(plan)).toBe(1500);
  });

  it('番茄钟单周期＝专注 + 休息，忽略轮数', () => {
    const plan = buildCountdownPlan(config({ mode: 'pomodoro', repeat: false, cycles: 9 }));
    expect(plan.phases.map((p) => p.kind)).toEqual(['focus', 'break']);
    expect(plan.phases.map((p) => p.seconds)).toEqual([1500, 300]);
  });

  it('番茄钟重复＝按轮数连排，末轮休息保留', () => {
    const plan = buildCountdownPlan(config({ mode: 'pomodoro', repeat: true, cycles: 3 }));
    expect(plan.phases).toHaveLength(6);
    expect(plan.phases.map((p) => p.kind)).toEqual([
      'focus', 'break', 'focus', 'break', 'focus', 'break',
    ]);
  });

  it('不规则周期按顺序展开', () => {
    const plan = buildCountdownPlan(config({ mode: 'interval', intervals: [10, 20, 30] }));
    expect(plan.phases.map((p) => p.seconds)).toEqual([600, 1200, 1800]);
    expect(plan.phases.every((p) => p.kind === 'segment')).toBe(true);
  });

  it('删空的分段表回到默认值，而不是留下跑不起来的方案', () => {
    const plan = buildCountdownPlan(config({ mode: 'interval', intervals: [] }));
    expect(plan.phases.length).toBeGreaterThan(0);
  });
});

describe('输入夹取 / clamping', () => {
  it('分钟数至少 1、至多一天', () => {
    expect(clampMinutes(0, 25)).toBe(1);
    expect(clampMinutes(-5, 25)).toBe(1);
    expect(clampMinutes(99999, 25)).toBe(24 * 60);
    expect(clampMinutes(Number.NaN, 25)).toBe(25);
    expect(clampMinutes('30', 25)).toBe(30);
  });

  it('轮数至少 1', () => {
    expect(clampCycles(0)).toBe(1);
    expect(clampCycles(-3)).toBe(1);
    expect(clampCycles(Number.NaN)).toBe(4);
  });

  it('从设置里读出的配置经过同一套夹取', () => {
    const parsed = countdownConfigFrom({ ...DEFAULT_SETTINGS, countdownMinutes: 0 });
    expect(parsed.downMinutes).toBe(1);
  });
});

describe('locatePhase / 段边界', () => {
  const plan = buildCountdownPlan(config({ mode: 'pomodoro', repeat: true, cycles: 2 }));

  it('第 0 秒属于第一段', () => {
    const position = locatePhase(plan, 0);
    expect(position.index).toBe(0);
    expect(position.remaining).toBe(1500);
    expect(position.completed).toBe(false);
  });

  it('整段结束的那一刻才切到下一段', () => {
    expect(locatePhase(plan, 1499).index).toBe(0);
    expect(locatePhase(plan, 1500).index).toBe(1);
    expect(locatePhase(plan, 1500).phaseElapsed).toBe(0);
  });

  it('段内位置与剩余同时正确', () => {
    const position = locatePhase(plan, 1600);
    expect(position.index).toBe(1);
    expect(position.phaseElapsed).toBe(100);
    expect(position.remaining).toBe(200);
  });

  it('跑完之后停在最后一段且标记完成', () => {
    const total = planTotalSeconds(plan);
    const position = locatePhase(plan, total + 30);
    expect(position.completed).toBe(true);
    expect(position.remaining).toBe(0);
    expect(position.elapsed).toBe(total);
  });

  it('负数视为 0', () => {
    expect(locatePhase(plan, -10).elapsed).toBe(0);
  });
});

/** Assemble a countdown service over a fake clock. */
function setup(overrides: Partial<PluginSettings> = {}) {
  const clock = new FakeClock('2026-09-15T10:00:00');
  const logger = new CapturingLogger();
  const { deps } = testDeps(clock, logger);
  const store = new TimerStore(deps, createInitialState(deps));
  const history = new MemoryHistory();

  let idCounter = 0;
  const countdown = new CountdownTimerService({
    store,
    history,
    clock,
    log: logger,
    newId: () => `cd-${++idCounter}`,
  });

  return { clock, logger, store, history, countdown, overrides };
}

describe('CountdownTimerService / 计时与落库', () => {
  it('开始后按墙钟推进，并把方案冻结进状态', () => {
    const { clock, store, countdown } = setup();
    const plan = buildCountdownPlan(config());
    expect(countdown.start(plan)).toBe(true);

    expect(store.getState().countdown.plan).toEqual(plan);
    clock.advanceSeconds(90);
    expect(countdown.elapsedSeconds()).toBe(90);
    expect(countdown.position()?.remaining).toBe(1410);
  });

  it('运行中同一时刻不能开第二次', () => {
    const { countdown } = setup();
    expect(countdown.start(buildCountdownPlan(config()))).toBe(true);
    expect(countdown.start(buildCountdownPlan(config()))).toBe(false);
  });

  it('空方案不开始', () => {
    const { countdown } = setup();
    expect(countdown.start({ mode: 'interval', phases: [] })).toBe(false);
    expect(countdown.isActive()).toBe(false);
  });

  it('暂停让剩余时间冻住', () => {
    const { clock, countdown } = setup();
    countdown.start(buildCountdownPlan(config()));
    clock.advanceSeconds(60);
    countdown.pause();
    clock.advanceSeconds(120);
    expect(countdown.elapsedSeconds()).toBe(60);
    expect(countdown.position()?.remaining).toBe(1440);

    countdown.resume();
    clock.advanceSeconds(30);
    expect(countdown.elapsedSeconds()).toBe(90);
  });

  it('跑完后保存的长度夹到计划值，并标记完成', async () => {
    const { clock, history, countdown } = setup();
    countdown.start(buildCountdownPlan(config({ downMinutes: 1 })));

    //  Tick 晚到 4 秒：记录仍应是 60 秒，而不是 64
    clock.advanceSeconds(64);
    expect(countdown.isComplete()).toBe(true);

    const session = await countdown.stop('');
    expect(session).not.toBeNull();
    expect(session?.durationSeconds).toBe(60);
    expect(session?.plannedSeconds).toBe(60);
    expect(session?.completed).toBe(true);
    expect(session?.mode).toBe('down');
    expect(history.getCountdownSessions()).toHaveLength(1);
  });

  it('提前停止记的是实际时长，并标明未完成', async () => {
    const { clock, countdown } = setup();
    countdown.start(buildCountdownPlan(config()));
    clock.advanceSeconds(300);
    const session = await countdown.stop('写周报');

    expect(session?.durationSeconds).toBe(300);
    expect(session?.completed).toBe(false);
    expect(session?.note).toBe('写周报');
  });

  it('停止后回到空闲，方案清空', async () => {
    const { countdown, store } = setup();
    countdown.start(buildCountdownPlan(config()));
    await countdown.stop('');
    expect(store.getState().countdown.status).toBe('idle');
    expect(store.getState().countdown.plan).toBeNull();
  });

  it('标记记下净秒数与所在段', () => {
    const { clock, countdown } = setup();
    countdown.start(buildCountdownPlan(config({ mode: 'pomodoro', repeat: true, cycles: 2 })));
    clock.advanceSeconds(1600);

    const mark = countdown.flag('休息中');
    expect(mark?.atSeconds).toBe(1600);
    expect(mark?.phase).toBe(2);
    expect(countdown.flags()).toHaveLength(1);
  });

  it('暂停中打标记，净秒数不动', () => {
    const { clock, countdown } = setup();
    countdown.start(buildCountdownPlan(config()));
    clock.advanceSeconds(120);
    countdown.pause();
    clock.advanceSeconds(60);
    expect(countdown.flag()?.atSeconds).toBe(120);
  });

  it('暂停中停止时补上未闭合的那段暂停', async () => {
    const { clock, countdown } = setup();
    countdown.start(buildCountdownPlan(config()));
    clock.advanceSeconds(60);
    countdown.pause();
    clock.advanceSeconds(40);
    const session = await countdown.stop('');
    expect(session?.pauses).toHaveLength(1);
  });

  it('与正计时分表：倒计时的记录不会出现在手动记录里', async () => {
    const { clock, history, countdown } = setup();
    countdown.start(buildCountdownPlan(config()));
    clock.advanceSeconds(60);
    await countdown.stop('');

    expect(history.getCountdownSessions()).toHaveLength(1);
    expect(history.getManualSessions()).toHaveLength(0);
  });

  it('丢弃不落库', () => {
    const { clock, history, countdown } = setup();
    countdown.start(buildCountdownPlan(config()));
    clock.advanceSeconds(60);
    countdown.discard();

    expect(countdown.isActive()).toBe(false);
    expect(history.getCountdownSessions()).toHaveLength(0);
  });
});
