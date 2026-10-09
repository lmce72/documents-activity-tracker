/**
 * Manual timer service
 *
 * Independent of document tracking: bound to no file, unaffected by document filters, and
 * fully functional with document tracking switched off. The user starts it, stops it,
 * writes what they did, and the session is persisted.
 *
 * Time is derived from timestamps rather than ticked (`selectManualElapsedSeconds`), so
 * throttling, a fresh start or a stalled renderer cannot under-count a manual session.
 *
 */

import { ActionTypes, MANUAL_STATUS } from '../core/constants';
import type { Logger } from '../core/logger';
import { selectManualElapsedSeconds } from '../core/selectors';
import type { ManualFlag, ManualSession } from '../core/types';
import type { Clock } from './clock';
import type { TimerStore } from './TimerStore';
import type { HistoryStore } from '../data/historyStore';

/** Service dependencies. */
export interface ManualTimerServiceDeps {
  store: TimerStore;
  history: HistoryStore;
  clock: Clock;
  log: Logger;
  /**
   * Injected rather than calling crypto.randomUUID() so tests can assert what is stored.
   */
  newId: () => string;
}

export class ManualTimerService {
  constructor(private readonly deps: ManualTimerServiceDeps) {}

  start(): void {
    this.deps.store.dispatch({ type: ActionTypes.MANUAL_START });
  }

  /** Pause. */
  pause(): void {
    this.deps.store.dispatch({ type: ActionTypes.MANUAL_PAUSE });
  }

  /** Resume. */
  resume(): void {
    this.deps.store.dispatch({ type: ActionTypes.MANUAL_RESUME });
  }

  /** The net elapsed seconds. */
  elapsedSeconds(): number {
    return selectManualElapsedSeconds(this.deps.store.getState(), this.deps.clock.now());
  }

  /**
   * Place a mark.
   *
   * Records the *net* seconds at this instant (pauses excluded) rather than a wall-clock
   * time: the session is measured in net seconds and a wall-clock mark would not line up.
   * Marking while paused is allowed — the user may well want to note something at that
   * moment, and the net seconds stay put while paused.
   *
   * the mark, or null when idle
   */
  flag(label = ''): ManualFlag | null {
    try {
      if (!this.isActive()) return null;

      const mark: ManualFlag = {
        atSeconds: this.elapsedSeconds(),
        atTime: this.deps.clock.nowFull(),
        label,
      };

      this.deps.store.dispatch({
        type: ActionTypes.MANUAL_FLAG,
        payload: { atSeconds: mark.atSeconds, atTime: mark.atTime, label },
      });

      return mark;
    } catch (error) {
      this.deps.log.warn('[RTT][manual] 打标记失败 / flag failed:', error);
      return null;
    }
  }

  /** the marks placed during this run. */
  flags(): ManualFlag[] {
    return [...this.deps.store.getState().manual.flags];
  }

  isActive(): boolean {
    return this.deps.store.getState().manual.status !== MANUAL_STATUS.IDLE;
  }

  /**
   * Stop and persist.
   *
   * `note` comes from the stop dialog and may be empty: forcing it would only produce
   * filler text typed to dismiss the dialog.
   *
   * the stored session, or null if idle
   */
  async stop(note: string): Promise<ManualSession | null> {
    try {
      const state = this.deps.store.getState();
      if (state.manual.status === MANUAL_STATUS.IDLE) return null;

      //  Read the duration before dispatching: stopping resets the sub-state
      const durationSeconds = this.elapsedSeconds();

      const session: ManualSession = {
        id: this.deps.newId(),
        startTime: state.manual.startedAt || this.deps.clock.nowFull(),
        endTime: this.deps.clock.nowFull(),
        durationSeconds,
        note,

        //  Read before the dispatch too: stopping resets the sub-state, marks included
        flags: [...state.manual.flags],
      };

      this.deps.history.appendManualSession(session);
      this.deps.store.dispatch({ type: ActionTypes.MANUAL_STOP });
      await this.deps.history.flushNow();

      this.deps.log.info(
        `[RTT][manual] 已保存手动计时 / manual session saved: ${durationSeconds}s`,
      );
      return session;
    } catch (error) {
      this.deps.log.warn('[RTT][manual] 保存手动计时失败 / manual stop failed:', error);
      return null;
    }
  }

  /**
   * For when the user realises the timer was started by mistake.
   */
  discard(): void {
    this.deps.store.dispatch({ type: ActionTypes.MANUAL_STOP });
  }
}
