import { expect, it } from 'bun:test';
import { MobileActivity } from '../src/core/mobileActivity';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import { createInitialState } from '../src/core/reducer';
import { dayAccount } from '../src/core/account';
import { TimerStore } from '../src/services/TimerStore';
import { TimerService } from '../src/services/TimerService';
import { FakeClock, CapturingLogger, testDeps } from './helpers/fake-clock';
import { MemoryHistory } from './helpers/memory-history';
import { pickDeviceLocal, withoutDeviceLocal } from '../src/data/sharedSettings';

const path = 'view:mobile-ink-annotation-center-view';
function setup(mobile = true, serviceClass: typeof TimerService = TimerService) {
  const clock = new FakeClock('2026-10-25T23:59:50');
  const log = new CapturingLogger();
  const { deps } = testDeps(clock, log);
  const store = new TimerStore(deps, createInitialState(deps));
  const history = new MemoryHistory();
  const service = new serviceClass({ store, history, clock, log, isMobile: mobile,
    getActivePath: () => path, getOpenPaths: () => [path],
    settings: () => ({ ...DEFAULT_SETTINGS, autoStartMode: 'always', idleTimeoutEnabled: false, minReadSeconds: 60 }),
  });
  const account = () => dayAccount({ events: history.getEvents(), manual: [], countdown: [],
    day: '2026-10-26', nowMs: clock.now(), policy: { away: 'reading', idle: 'reading', pluginViews: true } });
  return { service, store, history, clock, account, log };
}

it('ordinary mobile stops on focus loss; DeX only permits a visible unfocused window', () => {
  const state = new MobileActivity();
  state.focused = false;
  state.nativePaused = true;
  expect(state.background(false)).toBe(true);
  expect(state.background(true)).toBe(false);
  state.nativeActive = false;
  expect(state.background(true)).toBe(true);
  state.focused = true;
  expect(state.background(true)).toBe(true); // stale Web focus cannot undo native stop
  state.nativeActive = true;
  state.visible = false;
  expect(state.background(true)).toBe(true);
  state.visible = true;
  state.frozen = true;
  expect(state.background(true)).toBe(true);
});

it('DeX preference remains local even when other settings are shared', () => {
  expect(DEFAULT_SETTINGS.mobileMultiWindow).toBe(false);
  expect(pickDeviceLocal({ mobileMultiWindow: true })).toEqual({ mobileMultiWindow: true });
  expect(withoutDeviceLocal({ mobileMultiWindow: true, awayPolicy: 'reading' })).toEqual({ awayPolicy: 'reading' });
});

it('background closes even a short round and cannot accrue or start a new one overnight', async () => {
  const c = setup();
  await c.service.onActivePathChange();
  c.clock.advanceSeconds(2);
  await c.service.tick();
  await c.service.onMobileBackgroundChange(true);
  expect(c.store.getState().files.get(path)?.status).toBe('idle');
  expect(c.history.getEvents().slice(-1)[0]?.type).toBe('auto-save');
  c.clock.setLocal('2026-10-26T08:00:00');
  await c.service.tick();
  await c.service.onActivePathChange();
  await c.service.startCurrent();
  await c.service.onMobileBackgroundChange(true);
  expect(c.history.getEvents()).toHaveLength(2);
  expect(c.account().total).toBe(0);
  await c.service.onMobileBackgroundChange(false);
  expect(c.store.getState().files.get(path)?.status).toBe('tracking');
  expect(c.history.getEvents().slice(-1)[0]?.time).toBe('2026-10-26 08:00:00');
  expect(c.account().total).toBe(0);
  expect(c.log.warnings).toEqual([]);
});

it('a delayed native background event also excludes the frozen overnight gap', async () => {
  const c = setup();
  await c.service.onActivePathChange();
  c.clock.advanceSeconds(2);
  await c.service.tick();
  c.clock.setLocal('2026-10-26T08:00:00');
  await c.service.onMobileBackgroundChange(true);
  expect(c.account().total).toBe(0);
  expect(c.history.getEvents().some(e => e.type === 'blur' && e.unfocusedDisposition === 'ignored')).toBe(true);
});

it('missing lifecycle events do not turn a frozen gap into split reading on mobile', async () => {
  const c = setup();
  await c.service.onActivePathChange();
  await c.service.setSplitReading(true);
  c.clock.advanceSeconds(1);
  await c.service.tick();
  c.clock.setLocal('2026-10-26T08:00:00');
  await c.service.tick();
  expect(c.account().total).toBe(0);
});

it('returning to foreground does not resume a user-paused timer', async () => {
  const c = setup();
  await c.service.onActivePathChange();
  await c.service.togglePause();
  await c.service.onMobileBackgroundChange(true);
  c.clock.setLocal('2026-10-26T08:00:00');
  await c.service.onMobileBackgroundChange(false);
  expect(c.store.getState().files.get(path)?.status).toBe('idle');
});

it('desktop ignores mobile lifecycle requests', async () => {
  const c = setup(false);
  await c.service.onActivePathChange();
  await c.service.onMobileBackgroundChange(true);
  expect(c.store.getState().files.get(path)?.status).toBe('tracking');
});

class DelayedFlushService extends TimerService {
  private barrier: { enter: () => void; released: Promise<void> } | null = null;

  delayNextFlush(): { entered: Promise<void>; release: () => void } {
    let enter = (): void => {};
    let release = (): void => {};
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    this.barrier = { enter, released };
    return { entered, release };
  }

  override async flushPendingWrites(): Promise<void> {
    const barrier = this.barrier;
    this.barrier = null;
    if (barrier) {
      barrier.enter();
      await barrier.released;
    }
    await super.flushPendingWrites();
  }
}

it('a frozen-gap tick waiting for storage cannot revive a background-saved round', async () => {
  const c = setup(true, DelayedFlushService);
  const service = c.service as DelayedFlushService;
  await service.onActivePathChange();
  c.clock.advanceSeconds(1);
  await service.tick();
  c.clock.setLocal('2026-10-26T08:00:00');
  const barrier = service.delayNextFlush();
  const tick = service.tick();
  await barrier.entered;
  await service.onMobileBackgroundChange(true);
  barrier.release();
  await tick;
  expect(c.store.getState().files.get(path)?.status).toBe('idle');
  expect(c.history.getEvents().slice(-1)[0]?.type).toBe('auto-save');
  expect(c.account().total).toBe(0);
});

it('an old start waiting for storage cannot cross a complete background/foreground cycle', async () => {
  const c = setup(true, DelayedFlushService);
  const service = c.service as DelayedFlushService;
  await service.onActivePathChange();
  await service.onMobileBackgroundChange(true);
  const barrier = service.delayNextFlush();
  const foreground = service.onMobileBackgroundChange(false);
  await barrier.entered;
  await service.onMobileBackgroundChange(true);
  await service.onMobileBackgroundChange(false);
  const before = c.history.getEvents().length;
  barrier.release();
  await foreground;
  expect(c.history.getEvents()).toHaveLength(before);
  expect(c.history.getEvents().filter(event => event.type === 'start')).toHaveLength(2);
  expect(c.store.getState().files.get(path)?.status).toBe('tracking');
});
