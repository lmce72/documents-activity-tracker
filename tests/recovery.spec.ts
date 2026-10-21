/**
 * 未保存计时的恢复 / recovering unsaved timers
 *
 * 正计时只活在内存里：插件重载或崩溃，那一轮就没了。这里钉住两件事 —— 快照本身能读写、读不懂时
 * 安全放弃；恢复出来的那一轮停在快照那一刻、并且是暂停的。
 *
 * The count-up lives only in memory: a reload or a crash takes it. Two things are pinned here — the
 * snapshot survives a round trip and fails safe on garbage, and a restored run holds exactly the
 * elapsed value from the snapshot, paused.
 */

import { describe, expect, it } from 'bun:test';

import { ActionTypes } from '../src/core/constants';
import { createInitialState } from '../src/core/reducer';
import { selectCountdownElapsedSeconds, selectManualElapsedSeconds } from '../src/core/selectors';
import {
  LIVE_SNAPSHOT_KEY,
  LIVE_SNAPSHOT_VERSION,
  readLiveSnapshot,
  writeLiveSnapshot,
  type SnapshotStorage,
} from '../src/data/liveTimerSnapshot';
import { TimerStore } from '../src/services/TimerStore';
import { FakeClock, CapturingLogger, testDeps } from './helpers/fake-clock';

/** 内存里的 Storage / storage in memory. */
function makeStorage(): SnapshotStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (key) => raw.get(key) ?? null,
    setItem: (key, value) => {
      raw.set(key, value);
    },
    removeItem: (key) => {
      raw.delete(key);
    },
  };
}

const entry = {
  startedAt: '2026-09-15 10:00:00',
  elapsedMs: 125_000,
  pausedMs: 0,
  pauses: [],
  flags: [{ atSeconds: 60, atTime: '2026-09-15 10:01:00', label: '' }],
  running: true,
};

describe('live snapshot / 快照读写', () => {
  it('正计时与倒计时都能原样读回', () => {
    const storage = makeStorage();
    writeLiveSnapshot(
      {
        version: LIVE_SNAPSHOT_VERSION,
        savedAt: 1000,
        manual: entry,
        countdown: { ...entry, plan: { mode: 'down', phases: [{ kind: 'focus', seconds: 600 }] } },
      },
      storage,
    );

    const loaded = readLiveSnapshot(storage);
    expect(loaded?.manual?.elapsedMs).toBe(125_000);
    expect(loaded?.manual?.flags).toHaveLength(1);
    expect(loaded?.countdown?.plan?.phases[0]?.seconds).toBe(600);
  });

  it('写 null 或两边都空就清掉', () => {
    const storage = makeStorage();
    writeLiveSnapshot({ version: LIVE_SNAPSHOT_VERSION, savedAt: 1, manual: entry }, storage);
    expect(storage.raw.has(LIVE_SNAPSHOT_KEY)).toBe(true);

    writeLiveSnapshot(null, storage);
    expect(storage.raw.has(LIVE_SNAPSHOT_KEY)).toBe(false);
  });

  it('坏 JSON、版本不对、空对象都读成 null', () => {
    const storage = makeStorage();
    storage.setItem(LIVE_SNAPSHOT_KEY, '{ not json');
    expect(readLiveSnapshot(storage)).toBeNull();

    storage.setItem(LIVE_SNAPSHOT_KEY, JSON.stringify({ version: 99, manual: entry }));
    expect(readLiveSnapshot(storage)).toBeNull();

    storage.setItem(LIVE_SNAPSHOT_KEY, JSON.stringify({ version: LIVE_SNAPSHOT_VERSION }));
    expect(readLiveSnapshot(storage)).toBeNull();
  });
});

describe('restore / 恢复到快照那一刻', () => {
  it('正计时恢复成暂停，已计时与快照一致，继续后从这里接着走', () => {
    const clock = new FakeClock('2026-09-15T12:00:00');
    const log = new CapturingLogger();
    const { deps } = testDeps(clock, log);
    const store = new TimerStore(deps, createInitialState(deps));

    const now = clock.now();
    store.dispatch({
      type: ActionTypes.MANUAL_RESTORE,
      payload: {
        startTimestamp: now - entry.elapsedMs,
        startedAt: entry.startedAt,
        pausedMs: 0,
        pauses: [],
        flags: entry.flags,
      },
    });

    const state = store.getState();
    expect(state.manual.status).toBe('paused');
    expect(selectManualElapsedSeconds(state, clock.now())).toBe(125);

    //  暂停中时间不流逝 / time does not move while paused
    clock.advanceSeconds(600);
    expect(selectManualElapsedSeconds(store.getState(), clock.now())).toBe(125);

    //  继续后从 125 秒接着走，而不是把应用关着的十分钟算进去
    store.dispatch({ type: ActionTypes.MANUAL_RESUME });
    clock.advanceSeconds(5);
    expect(selectManualElapsedSeconds(store.getState(), clock.now())).toBe(130);
    expect(store.getState().manual.flags).toHaveLength(1);
  });

  it('倒计时恢复后位置正确，且是暂停的', () => {
    const clock = new FakeClock('2026-09-15T12:00:00');
    const log = new CapturingLogger();
    const { deps } = testDeps(clock, log);
    const store = new TimerStore(deps, createInitialState(deps));

    const now = clock.now();
    store.dispatch({
      type: ActionTypes.COUNTDOWN_RESTORE,
      payload: {
        startTimestamp: now - entry.elapsedMs,
        startedAt: entry.startedAt,
        pausedMs: 0,
        pauses: [],
        flags: [],
        plan: {
          mode: 'pomodoro',
          phases: [
            { kind: 'focus', seconds: 60 },
            { kind: 'break', seconds: 300 },
          ],
        },
      },
    });

    const state = store.getState();
    expect(state.countdown.status).toBe('paused');
    expect(selectCountdownElapsedSeconds(state, clock.now())).toBe(125);
    expect(state.countdown.plan?.phases).toHaveLength(2);
  });

  it('已经在跑的时候不会被恢复覆盖', () => {
    const clock = new FakeClock('2026-09-15T12:00:00');
    const log = new CapturingLogger();
    const { deps } = testDeps(clock, log);
    const store = new TimerStore(deps, createInitialState(deps));

    store.dispatch({ type: ActionTypes.MANUAL_START });
    const before = store.getState().manual;

    store.dispatch({
      type: ActionTypes.MANUAL_RESTORE,
      payload: {
        startTimestamp: clock.now() - 60_000,
        startedAt: '2026-09-15 11:00:00',
        pausedMs: 0,
        pauses: [],
        flags: [],
      },
    });

    expect(store.getState().manual).toBe(before);
  });
});
