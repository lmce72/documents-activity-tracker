/**
 * State container with pub-sub
 *
 * Origin: vault main.js lines 454-544.
 *
 * Changes:
 *     Takes the reducer by injection so the clock is decided at assembly time.
 *     `deserialize` moved to data/snapshot.ts, which owns the on-disk shape.
 *     Typed; dispatch semantics unchanged.
 *
 */

import { createInitialState, type ReducerDeps } from '../core/reducer';
import { createTimerReducer } from '../core/reducer';
import type { TimerAction, TimerState } from '../core/types';

/** A subscriber. */
export type Listener = (state: TimerState) => void;

export class TimerStore {
  private state: TimerState;
  private readonly listeners = new Set<Listener>();
  private readonly cachedSelectors = new Map<string, unknown>();
  private readonly reducer: (state: TimerState, action: TimerAction) => TimerState;

  constructor(private readonly deps: ReducerDeps, initialState?: TimerState) {
    this.reducer = createTimerReducer(deps);
    this.state = initialState ?? createInitialState(deps);
  }

  getState(): TimerState {
    return this.state;
  }

  /**
   * Dispatch an action.
   * If the reducer throws, the old state is kept so a state-machine bug cannot break
   * the plugin.
   */
  dispatch(action: TimerAction): void {
    try {
      const prevState = this.state;
      this.state = this.reducer(prevState, action);

      if (this.state !== prevState) {
        this.cachedSelectors.clear();
        this.notifyListeners();
      }
    } catch (error) {
      console.error('[RTT][TimerStore] dispatch 失败 / failed:', error, action);
    }
  }

  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    this.listeners.forEach((listener) => {
      try {
        listener(this.state);
      } catch (error) {

        //  One failing subscriber must not affect the others
        console.error('[RTT][TimerStore] 订阅者执行错误 / listener error:', error);
      }
    });
  }

  /**
   * A memoised selector.
   */
  select<T>(selector: (state: TimerState) => T, cacheKey?: string): T {
    if (cacheKey && this.cachedSelectors.has(cacheKey)) {
      return this.cachedSelectors.get(cacheKey) as T;
    }
    const result = selector(this.state);
    if (cacheKey) this.cachedSelectors.set(cacheKey, result);
    return result;
  }
}
