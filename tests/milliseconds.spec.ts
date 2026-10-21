/**
 * 毫秒精度 / millisecond precision
 *
 * 计算与落库都以毫秒为准，秒只是它的投影。这里钉住投影关系 —— 不要哪天有人顺手把某一层再 floor 两次。
 * The arithmetic and the records are millisecond-based; a second is a projection of them. What is
 * pinned here is that projection, so no layer quietly floors twice.
 */

import { describe, expect, it } from 'bun:test';

import { buildCountdownPlan } from '../src/core/countdown';
import { createInitialState } from '../src/core/reducer';
import {
  selectCountdownElapsedMs,
  selectCountdownElapsedSeconds,
  selectManualElapsedMs,
  selectManualElapsedSeconds,
} from '../src/core/selectors';
import { CountdownTimerService } from '../src/services/CountdownTimerService';
import { ManualTimerService } from '../src/services/ManualTimerService';
import { TimerStore } from '../src/services/TimerStore';
import { CapturingLogger, FakeClock, testDeps } from './helpers/fake-clock';
import { MemoryHistory } from './helpers/memory-history';

function setup() {
  const clock = new FakeClock('2026-09-15T10:00:00');
  const logger = new CapturingLogger();
  const { deps } = testDeps(clock, logger);
  const store = new TimerStore(deps, createInitialState(deps));
  const history = new MemoryHistory();

  let id = 0;
  const manual = new ManualTimerService({
    store,
    history,
    clock,
    log: logger,
    newId: () => `m-${++id}`,
  });
  const countdown = new CountdownTimerService({
    store,
    history,
    clock,
    log: logger,
    newId: () => `c-${++id}`,
  });

  return { clock, store, history, manual, countdown };
}

describe('正计时 / count-up', () => {
  it('已计时以毫秒为准，秒是它的向下投影', () => {
    const { clock, store, manual } = setup();
    manual.start();
    clock.advance(1500);

    expect(selectManualElapsedMs(store.getState(), clock.now())).toBe(1500);
    expect(selectManualElapsedSeconds(store.getState(), clock.now())).toBe(1);
  });

  it('暂停后毫秒也冻住', () => {
    const { clock, store, manual } = setup();
    manual.start();
    clock.advance(2500);
    manual.pause();
    clock.advance(4000);

    expect(selectManualElapsedMs(store.getState(), clock.now())).toBe(2500);
  });

  it('保存的记录带 durationMs，整秒字段由它派生', async () => {
    const { clock, manual } = setup();
    manual.start();
    clock.advance(1250);

    const session = await manual.stop('');
    expect(session?.durationMs).toBe(1250);
    expect(session?.durationSeconds).toBe(1);
  });

  it('标记同时记下毫秒与整秒', () => {
    const { clock, manual } = setup();
    manual.start();
    clock.advance(1750);

    const mark = manual.flag();
    expect(mark?.atMs).toBe(1750);
    expect(mark?.atSeconds).toBe(1);
  });
});

describe('倒计时 / countdown', () => {
  it('计算保留毫秒，段位置仍按秒推进', () => {
    const { clock, store, countdown } = setup();
    countdown.start(buildCountdownPlan({
      mode: 'down',
      downMinutes: 1,
      focusMinutes: 25,
      breakMinutes: 5,
      cycles: 1,
      repeat: false,
      intervals: [1],
    }));
    clock.advance(2500);

    expect(selectCountdownElapsedMs(store.getState(), clock.now())).toBe(2500);
    expect(selectCountdownElapsedSeconds(store.getState(), clock.now())).toBe(2);
    expect(countdown.position()?.remaining).toBe(58);
  });

  it('保存的记录保留毫秒，并按计划长度夹住', async () => {
    const { clock, countdown } = setup();
    countdown.start(buildCountdownPlan({
      mode: 'down',
      downMinutes: 1,
      focusMinutes: 25,
      breakMinutes: 5,
      cycles: 1,
      repeat: false,
      intervals: [1],
    }));
    clock.advance(1250);

    const session = await countdown.stop('');
    expect(session?.durationMs).toBe(1250);
    expect(session?.durationSeconds).toBe(1);
  });
});
