/**
 * Service layer tests
 *
 * Covers the whole surface of `TimerService` and `ManualTimerService` against an
 * in-memory repository and a fake clock — no Obsidian, no sql.js.
 */

import { describe, expect, it } from 'bun:test';

import { MANUAL_STATUS, STATUS } from '../src/core/constants';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import { createInitialState, createTimerReducer } from '../src/core/reducer';
import type { PluginSettings, TimelineEvent } from '../src/core/types';
import { TimerStore } from '../src/services/TimerStore';
import { ManualTimerService } from '../src/services/ManualTimerService';
import { TimerService } from '../src/services/TimerService';
import { CapturingLogger, FakeClock, testDeps } from './helpers/fake-clock';
import { MemoryHistory } from './helpers/memory-history';

const FILE = 'Notes/alpha.md';
const OTHER = 'Notes/beta.md';

/** Assemble a full service stack. */
function setup(overrides: Partial<PluginSettings> = {}) {
  const clock = new FakeClock('2026-09-15T10:00:00');
  const logger = new CapturingLogger();
  const { deps } = testDeps(clock, logger);
  const store = new TimerStore(deps, createInitialState(deps));
  const history = new MemoryHistory();

  const settings: PluginSettings = { ...DEFAULT_SETTINGS, ...overrides };

  let activePath: string | null = null;
  let openPaths: string[] = [];

  const service = new TimerService({
    store,
    history,
    clock,
    log: logger,
    settings: () => settings,
    getActivePath: () => activePath,
    getOpenPaths: () => openPaths,
  });

  let idCounter = 0;
  const manual = new ManualTimerService({
    store,
    history,
    clock,
    log: logger,
    newId: () => `manual-${++idCounter}`,
  });

  return {
    clock,
    logger,
    store,
    history,
    settings,
    service,
    manual,
    setActive: (path: string | null) => {
      activePath = path;
    },
    setOpen: (paths: string[]) => {
      openPaths = paths;
    },
    /** open a file in both senses. */
    open: async (path: string) => {
      activePath = path;
      openPaths = [...openPaths, path];
      await service.onActivePathChange();
    },
    /** advance n seconds, one heartbeat per second. */
    advance: async (seconds: number) => {
      for (let i = 0; i < seconds; i++) {
        clock.advanceSeconds(1);
        await service.tick();
      }
    },
    events: (): TimelineEvent[] => history.getEvents(),
    types: (): string[] => history.getEvents().map((e) => e.type),
  };
}

describe('TimerService — 会话落盘 / flushing sessions', () => {
  it('打开文件写入 start 事件，心跳每秒累加', async () => {
    const ctx = setup({ autoStartMode: 'always', minReadSeconds: 0 });
    await ctx.open(FILE);
    await ctx.advance(5);

    expect(ctx.types()).toEqual(['start']);
    const file = ctx.store.getState().files.get(FILE)!;
    expect(file.activeSeconds).toBe(5);
  });

  it('保存会话写入 save 事件，带两侧时长与墙钟', async () => {
    const ctx = setup({ autoStartMode: 'always', minReadSeconds: 0 });
    await ctx.open(FILE);
    await ctx.advance(4);

    await ctx.service.onWindowFocusChange(false);
    ctx.clock.advanceSeconds(60);
    await ctx.service.tick();
    await ctx.service.onWindowFocusChange(true);

    await ctx.service.saveCurrent('save');

    const save = ctx.events().find((e) => e.type === 'save')!;
    expect(save).toBeDefined();
    const details = save as unknown as Record<string, number>;
    expect(details.activeSeconds).toBe(4);
    expect(details.unfocusedSeconds).toBe(60);
    expect(details.duration).toBe(64);

    const record = ctx.history.getRecord(FILE)!;
    expect(record.totalReadTime).toBe(64);
    expect(record.unfocusedReadTime).toBe(60);
  });

  it('自动闭合写 auto-save，显式保存写 save', async () => {
    const ctx = setup({ autoStartMode: 'always', minReadSeconds: 0 });
    await ctx.open(FILE);
    await ctx.advance(2);
    await ctx.service.saveCurrent('save');

    ctx.setActive(OTHER);
    ctx.setOpen([OTHER]);
    await ctx.service.onActivePathChange();
    await ctx.advance(2);

    expect(ctx.types()).toContain('save');
    expect(ctx.types()).toContain('auto-save');
  });

  it('低于起步阈值不写入记录', async () => {
    const ctx = setup({ autoStartMode: 'always', minReadSeconds: 20 });
    await ctx.open(FILE);
    await ctx.advance(3);
    await ctx.service.saveCurrent('save');

    expect(ctx.types()).toEqual(['start']);
    expect(ctx.history.getRecord(FILE)).toBeNull();
  });

  it('待写入队列被消费，不会重复写同一条会话', async () => {
    const ctx = setup({ autoStartMode: 'always', minReadSeconds: 0 });
    await ctx.open(FILE);
    await ctx.advance(3);
    await ctx.service.saveCurrent('save');

    expect(ctx.store.getState().pendingWrites).toHaveLength(0);
    expect(ctx.types().filter((t) => t === 'save')).toHaveLength(1);
  });

  it('事件写入失败时队列保留，下次心跳重试', async () => {
    const ctx = setup({ autoStartMode: 'always', minReadSeconds: 0 });
    await ctx.open(FILE);
    await ctx.advance(3);

    ctx.history.failAppends = true;
    await ctx.service.saveCurrent('save');
    expect(ctx.store.getState().pendingWrites.length).toBeGreaterThan(0);

    ctx.history.failAppends = false;
    await ctx.service.tick();
    expect(ctx.store.getState().pendingWrites).toHaveLength(0);
    expect(ctx.types()).toContain('save');
  });
});

describe('TimerService — 窗口失焦 / window blur', () => {
  it('失焦不停表：时间进 unfocusedSeconds，并留下 blur 事件', async () => {
    const ctx = setup({ autoStartMode: 'always', minReadSeconds: 0 });
    await ctx.open(FILE);
    await ctx.advance(3);

    await ctx.service.onWindowFocusChange(false);
    await ctx.advance(5);

    const file = ctx.store.getState().files.get(FILE)!;
    expect(file.activeSeconds).toBe(3);
    expect(file.unfocusedSeconds).toBe(5);
    expect(ctx.store.getState().isWindowFocused).toBe(false);

    const blur = ctx.events().find((e) => e.type === 'blur')!;
    expect((blur as { reason?: string }).reason).toBe('window-blur');
    expect((blur as { state?: string }).state).toBe('inactive');
  });

  it('恢复焦点后时间回到 activeSeconds，并留下 focus 事件', async () => {
    const ctx = setup({ autoStartMode: 'always', minReadSeconds: 0 });
    await ctx.open(FILE);
    await ctx.service.onWindowFocusChange(false);
    await ctx.advance(5);
    await ctx.service.onWindowFocusChange(true);
    await ctx.advance(4);

    const file = ctx.store.getState().files.get(FILE)!;
    expect(file.activeSeconds).toBe(4);
    expect(file.unfocusedSeconds).toBe(5);

    const focus = ctx.events().find((e) => e.type === 'focus')!;
    expect((focus as { reason?: string }).reason).toBe('window-focus');
    expect((focus as { state?: string }).state).toBe('tracking');
  });

  it('重复设置同一焦点状态不产生事件', async () => {
    const ctx = setup({ autoStartMode: 'always', minReadSeconds: 0 });
    await ctx.open(FILE);
    await ctx.advance(1);

    await ctx.service.onWindowFocusChange(true);
    expect(ctx.types()).toEqual(['start']);
  });

  it('没有进行中的会话时不记录边界事件', async () => {
    const ctx = setup({ autoStartMode: 'always', minReadSeconds: 0 });
    await ctx.service.onWindowFocusChange(false);
    expect(ctx.types()).toEqual([]);
  });

  it('文档追踪关闭时失焦不派发任何状态变更', async () => {
    const ctx = setup({ autoStartMode: 'always', documentTrackingEnabled: false });
    await ctx.service.onWindowFocusChange(false);
    expect(ctx.store.getState().isWindowFocused).toBe(true);
  });
});

describe('TimerService — 切换文件与事件顺序 / switching and event order', () => {
  it('切换时事件顺序为 save → switch → start', async () => {
    const ctx = setup({ autoStartMode: 'always', minReadSeconds: 0 });
    await ctx.open(FILE);
    await ctx.advance(3);

    ctx.setActive(OTHER);
    ctx.setOpen([FILE, OTHER]);
    ctx.clock.advanceSeconds(1);
    await ctx.service.onActivePathChange();

    expect(ctx.types()).toEqual(['start', 'auto-save', 'switch', 'start']);

    const switchEvent = ctx.events().find((e) => e.type === 'switch')!;
    expect((switchEvent as { from?: string }).from).toBe(FILE);
    expect((switchEvent as { to?: string }).to).toBe(OTHER);
  });

  it('切到被过滤规则排除的文件时解绑当前文件', async () => {
    const ctx = setup({
      autoStartMode: 'always',
      minReadSeconds: 0,
      filterMode: 'blacklist',
      filterPatterns: 'Archive/',
    });
    await ctx.open(FILE);
    await ctx.advance(2);

    ctx.setActive('Archive/old.md');
    await ctx.service.onActivePathChange();

    expect(ctx.store.getState().activeFilePath).toBeNull();

    expect(ctx.types()).toContain('auto-save');
  });

  it('autoStartMode=manual 时不自动计时', async () => {
    const ctx = setup({ autoStartMode: 'manual', minReadSeconds: 0 });
    await ctx.open(FILE);
    await ctx.advance(3);

    expect(ctx.store.getState().files.get(FILE)!.status).toBe(STATUS.IDLE);
    expect(ctx.store.getState().files.get(FILE)!.activeSeconds).toBe(0);
  });

  it('autoStartMode=start-only 只在首次打开时开始', async () => {
    const ctx = setup({ autoStartMode: 'start-only', minReadSeconds: 0 });
    await ctx.open(FILE);
    await ctx.advance(2);
    await ctx.service.saveCurrent('save');

    ctx.setActive(OTHER);
    ctx.setOpen([FILE, OTHER]);
    await ctx.service.onActivePathChange();
    ctx.setActive(FILE);
    await ctx.service.onActivePathChange();

    const file = ctx.store.getState().files.get(FILE)!;
    expect(file.status).toBe(STATUS.IDLE);
  });
});

describe('TimerService — 标签关闭 / closing tabs', () => {
  it('标签关闭时自动闭合会话，避免阅读时长丢失', async () => {
    const ctx = setup({ autoStartMode: 'always', minReadSeconds: 0 });
    await ctx.open(FILE);
    await ctx.advance(6);

    ctx.setOpen([]);
    ctx.setActive(null);
    await ctx.service.closeOrphanSessions();

    const save = ctx.events().find((e) => e.type === 'auto-save')!;
    expect(save).toBeDefined();
    expect((save as { activeSeconds?: number }).activeSeconds).toBe(6);
    expect(ctx.store.getState().activeFilePath).toBeNull();
  });

  it('仍打开的标签不被误闭合', async () => {
    const ctx = setup({ autoStartMode: 'always', minReadSeconds: 0 });
    await ctx.open(FILE);
    await ctx.advance(3);

    await ctx.service.closeOrphanSessions();
    expect(ctx.types()).toEqual(['start']);
    expect(ctx.store.getState().files.get(FILE)!.status).toBe(STATUS.TRACKING);
  });
});

describe('TimerService — 启动恢复与空闲 / recovery and idle', () => {
  it('上次遗留的未闭合会话被补一条 auto-save', async () => {
    const ctx = setup();
    ctx.history.appendEvents([
      { time: '2026-09-14 08:00:00', type: 'start', file: FILE, state: 'tracking' },
    ]);

    await ctx.service.recoverUnfinishedSessions();

    const last = ctx.events()[ctx.events().length - 1]!;
    expect(last.type).toBe('auto-save');
    expect((last as { file?: string }).file).toBe(FILE);
  });

  it('已闭合的会话不重复闭合', async () => {
    const ctx = setup();
    ctx.history.appendEvents([
      { time: '2026-09-14 08:00:00', type: 'start', file: FILE, state: 'tracking' },
      { time: '2026-09-14 08:10:00', type: 'save', file: FILE, state: 'saved' },
    ]);

    await ctx.service.recoverUnfinishedSessions();
    expect(ctx.types()).toEqual(['start', 'save']);
  });

  it('空闲超时后停止累加，活动恢复后继续', async () => {
    const ctx = setup({
      autoStartMode: 'always',
      minReadSeconds: 0,
      idleTimeoutEnabled: true,
      idleTimeout: 5,
    });
    await ctx.open(FILE);

    await ctx.advance(20);
    expect(ctx.store.getState().isIdle).toBe(true);
    const idleSeconds = ctx.store.getState().files.get(FILE)!.activeSeconds;
    expect(idleSeconds).toBeGreaterThan(0);
    expect(idleSeconds).toBeLessThan(20);

    await ctx.service.markUserActivity();
    await ctx.advance(3);
    expect(ctx.store.getState().isIdle).toBe(false);
    expect(ctx.store.getState().files.get(FILE)!.activeSeconds).toBe(idleSeconds + 3);
  });

  it('空闲期间的时间不会被事后补记 / idle time is not re-absorbed', async () => {
    const ctx = setup({
      autoStartMode: 'always',
      minReadSeconds: 0,
      idleTimeoutEnabled: true,
      idleTimeout: 5,
    });
    await ctx.open(FILE);
    await ctx.advance(2);
    const before = ctx.store.getState().files.get(FILE)!.activeSeconds;

    await ctx.advance(30);
    const whileIdle = ctx.store.getState().files.get(FILE)!.activeSeconds;
    await ctx.service.markUserActivity();
    await ctx.advance(1);

    const after = ctx.store.getState().files.get(FILE)!.activeSeconds;

    expect(after).toBe(whileIdle + 1);
    expect(after - before).toBeLessThan(10);
  });

  it('失焦期间不做空闲判定：脱离窗口的计时不会被空闲超时掐断', async () => {
    const ctx = setup({
      autoStartMode: 'always',
      minReadSeconds: 0,
      idleTimeoutEnabled: true,
      idleTimeout: 5,
    });
    await ctx.open(FILE);
    await ctx.service.onWindowFocusChange(false);

    await ctx.advance(30);
    expect(ctx.store.getState().isIdle).toBe(false);
    expect(ctx.store.getState().files.get(FILE)!.unfocusedSeconds).toBe(30);
  });
});

describe('ManualTimerService — 手动计时 / manual timer', () => {
  it('开始 → 停止 → 带 note 落库', async () => {
    const ctx = setup();
    ctx.manual.start();
    expect(ctx.store.getState().manual.status).toBe(MANUAL_STATUS.RUNNING);

    ctx.clock.advanceSeconds(1500);
    expect(ctx.manual.elapsedSeconds()).toBe(1500);

    const session = await ctx.manual.stop('写周报');
    expect(session).not.toBeNull();
    expect(session!.durationSeconds).toBe(1500);
    expect(session!.note).toBe('写周报');
    expect(session!.startTime).toBe('2026-09-15 10:00:00');

    expect(ctx.history.getManualSessions()).toHaveLength(1);
    expect(ctx.store.getState().manual.status).toBe(MANUAL_STATUS.IDLE);
  });

  it('note 可以为空', async () => {
    const ctx = setup();
    ctx.manual.start();
    ctx.clock.advanceSeconds(60);
    const session = await ctx.manual.stop('');
    expect(session!.note).toBe('');
  });

  it('暂停时长不计入', async () => {
    const ctx = setup();
    ctx.manual.start();
    ctx.clock.advanceSeconds(100);
    ctx.manual.pause();
    ctx.clock.advanceSeconds(50);
    ctx.manual.resume();
    ctx.clock.advanceSeconds(20);

    const session = await ctx.manual.stop('复习');
    expect(session!.durationSeconds).toBe(120);
  });

  it('未开始时停止不落库', async () => {
    const ctx = setup();
    expect(await ctx.manual.stop('空')).toBeNull();
    expect(ctx.history.getManualSessions()).toHaveLength(0);
  });

  it('discard 结束但不落库', async () => {
    const ctx = setup();
    ctx.manual.start();
    ctx.clock.advanceSeconds(30);
    ctx.manual.discard();

    expect(ctx.store.getState().manual.status).toBe(MANUAL_STATUS.IDLE);
    expect(ctx.history.getManualSessions()).toHaveLength(0);
  });

  it('与文档追踪互不干扰：两边同时进行、各自记录', async () => {

    const ctx = setup({
      autoStartMode: 'always',
      minReadSeconds: 0,
      idleTimeoutEnabled: false,
    });
    await ctx.open(FILE);
    await ctx.advance(10);

    ctx.manual.start();
    await ctx.advance(20);

    const file = ctx.store.getState().files.get(FILE)!;
    expect(file.activeSeconds).toBe(30);
    expect(ctx.manual.elapsedSeconds()).toBe(20);

    await ctx.manual.stop('手动的事');
    await ctx.service.saveCurrent('save');

    expect(ctx.history.getManualSessions()).toHaveLength(1);
    expect(ctx.history.getRecord(FILE)!.totalReadTime).toBe(30);
  });

  it('文档追踪关闭时手动计时照常工作', async () => {
    const ctx = setup({ documentTrackingEnabled: false });
    ctx.manual.start();
    ctx.clock.advanceSeconds(60);
    const session = await ctx.manual.stop('不追踪文档时也能计时');

    expect(session!.durationSeconds).toBe(60);
    expect(ctx.history.getManualSessions()).toHaveLength(1);
  });

  it('落库前会强制 flush', async () => {
    const ctx = setup();
    const before = ctx.history.flushCount;
    ctx.manual.start();
    ctx.clock.advanceSeconds(5);
    await ctx.manual.stop('x');
    expect(ctx.history.flushCount).toBeGreaterThan(before);
  });
});
