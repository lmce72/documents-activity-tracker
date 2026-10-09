/**
 * Document tracking service
 *
 * Role: translate what happens outside (tab switch, window blur, user activity, the
 * one-second heartbeat) into state-machine actions, and flush the resulting pending
 * writes into the event log.
 *
 * Layering: this class imports no runtime value from obsidian (types only), so it is
 * fully testable outside Obsidian with an in-memory repository. The actual DOM and
 * workspace wiring lives in `obsidianBinding.ts`, which is where runtime values appear.
 *
 * Behaviour changes versus the original:
 *
 */

import {
  ActionTypes,
  STATUS,
} from '../core/constants';
import { shouldTrackFile } from '../core/filters';
import type { Logger } from '../core/logger';
import {
  isDocumentRecordingEnabled,
  normalizeIdleTimeoutSeconds,
} from '../core/settings';
import { eventFileRefs } from '../core/migration';
import type {
  PluginSettings,
  SessionWrite,
  TimelineEvent,
  TimerFileState,
} from '../core/types';
import type { Clock } from './clock';
import type { TimerStore } from './TimerStore';
import type { HistoryStore } from '../data/historyStore';

/** Environment queries the service needs. */
export interface TimerServiceDeps {
  store: TimerStore;
  history: HistoryStore;
  clock: Clock;
  log: Logger;
  /** live reference, so setting changes apply at once */
  settings: () => PluginSettings;
  /** the active markdown file path, if any */
  getActivePath: () => string | null;
  /** markdown paths still open in some leaf */
  getOpenPaths: () => string[];
}

/** why a session closed. */
export type SaveKind = 'save' | 'auto-save';

export class TimerService {
  constructor(private readonly deps: TimerServiceDeps) {}

  //  ==========================================================================

  //  ==========================================================================

  /**
   *
   * Closes only the session of the last event: an older unclosed session means the log was
   * interrupted, and one synthetic auto-save cannot recover its real end time — inventing
   * one would fabricate a duration.
   */
  async recoverUnfinishedSessions(): Promise<void> {
    try {
      const events = this.deps.history.getEvents();
      if (events.length === 0) return;

      const last = events[events.length - 1]!;
      if (last.type === 'save' || last.type === 'auto-save' || last.type === 'discard') return;

      const filePath = eventFileRefs(last)[0];
      if (!filePath) return;

      await this.deps.history.flushNow();
      this.deps.history.appendEvents([
        {
          time: this.deps.clock.nowFull(),
          type: 'auto-save',
          file: filePath,
          state: 'saved',
        },
      ]);
      await this.deps.history.flushNow();

      this.deps.log.info(
        '[RTT][service] 已闭合上次遗留的未完成会话 / closed leftover session:',
        filePath,
      );
    } catch (error) {
      this.deps.log.warn('[RTT][service] 恢复未完成会话失败 / recovery failed:', error);
    }
  }

  //  ==========================================================================
  // heartbeat
  //  ==========================================================================

  /**
   * The one-second heartbeat.
   * Order matters: idle and day rollover first, then close sessions whose tab is gone,
   * and only then count a tick.
   */
  async tick(): Promise<void> {
    if (!isDocumentRecordingEnabled(this.deps.settings())) return;

    try {
      this.applyIdleState();
      this.applyDayRollover();
      await this.closeOrphanSessions();

      const filePath = this.deps.store.getState().activeFilePath;
      if (filePath) {
        this.deps.store.dispatch({ type: ActionTypes.TICK, payload: { filePath } });
      }

      await this.flushPendingWrites();
    } catch (error) {
      this.deps.log.warn('[RTT][service] 心跳处理失败 / tick failed:', error);
    }
  }

  /**
   * idle detection.
   *
   * Idle detection is skipped while the window is unfocused, and that is the crux of the
   * new feature. Idle is detected from input events inside the Obsidian window, and none
   * arrive once it loses focus; applying it there would make "keep counting while
   * unfocused" expire after the default 20s — exactly the case the feature exists for.
   * The current idle flag is preserved instead. The cost is that leaving the window open
   * while away still counts, bounded by the 90s tick gap and the 4h attribution cap.
   */
  private applyIdleState(): void {
    const settings = this.deps.settings();
    const state = this.deps.store.getState();

    if (!state.isWindowFocused) return;

    if (!settings.idleTimeoutEnabled) {
      if (state.isIdle) this.deps.store.dispatch({ type: ActionTypes.CLEAR_IDLE });
      return;
    }

    const timeoutMs = normalizeIdleTimeoutSeconds(settings.idleTimeout) * 1000;
    const idleMs = this.deps.clock.now() - state.lastActivityTime;

    if (idleMs > timeoutMs) {
      if (!state.isIdle) this.deps.store.dispatch({ type: ActionTypes.SET_IDLE });
      return;
    }

    if (state.isIdle) this.deps.store.dispatch({ type: ActionTypes.CLEAR_IDLE });
  }

  /** day rollover, made idempotent by the reducer. */
  private applyDayRollover(): void {
    this.deps.store.dispatch({
      type: ActionTypes.DAY_ROLLOVER,
      payload: { filePath: this.deps.store.getState().activeFilePath },
    });
  }

  /**
   * User activity.
   * Called by the binding layer, throttled: dispatching on every mouse move would swamp
   * the subscribers.
   */
  markUserActivity(): void {
    this.deps.store.dispatch({ type: ActionTypes.USER_ACTIVITY });
  }

  //  ==========================================================================
  // switching files
  //  ==========================================================================

  /**
   * The active file changed.
   * Reads the active path itself rather than taking it as an argument, so no call site
   * gets to interpret "the current file" differently.
   */
  async onActivePathChange(): Promise<void> {
    if (!isDocumentRecordingEnabled(this.deps.settings())) return;

    try {
      const settings = this.deps.settings();
      const fromPath = this.deps.store.getState().activeFilePath;
      const candidate = this.deps.getActivePath();
      const toPath = candidate && shouldTrackFile(candidate, settings) ? candidate : null;

      if (fromPath === toPath) return;

      await this.flushPendingWrites();

      if (fromPath) {
        this.dispatchSave(fromPath, 'auto-save');

        //  The session-close event must land before the switch event is appended: save only
        //  queues, so appending the switch now would put it before the session it closes
        //  and the derivation could not attribute that stretch.
        await this.flushPendingWrites();
        if (toPath) this.appendEvent(this.buildSwitchEvent(fromPath, toPath));
      }

      if (toPath) {
        this.deps.store.dispatch({
          type: ActionTypes.SWITCH_FILE,
          payload: {
            fromPath,
            toPath,
            autoStart: this.shouldAutoStart(toPath, settings),
          },
        });
      } else {
        this.deps.store.dispatch({ type: ActionTypes.UNBIND_FILE });
      }

      await this.flushPendingWrites();
    } catch (error) {
      this.deps.log.warn('[RTT][service] 切换文件失败 / switch failed:', error);
    }
  }

  /**
   * Whether to start counting.
   * Mirrors the original's four modes one for one.
   */
  private shouldAutoStart(filePath: string, settings: PluginSettings): boolean {
    const seenBefore = this.deps.store.getState().files.has(filePath);
    switch (settings.autoStartMode) {
      case 'always':
        return true;
      case 'start-only':
        return !seenBefore;
      case 'return-only':
        return seenBefore;
      case 'manual':
      default:
        return false;
    }
  }

  //  ==========================================================================
  // window focus
  //  ==========================================================================

  /**
   * The window focus changed.
   *
   * Blur no longer stops counting: the reducer routes subsequent ticks into
   * `unfocusedSeconds`. This method dispatches the change and logs a blur/focus event so
   * the event stream still records when the window was not in front.
   */
  async onWindowFocusChange(focused: boolean): Promise<void> {
    if (!isDocumentRecordingEnabled(this.deps.settings())) return;

    try {
      const before = this.deps.store.getState();
      if (before.isWindowFocused === focused) return;

      //  Drain the queue before appending the boundary event, for the same reason as in
      //  onActivePathChange: observations must follow the session events they came after.
      await this.flushPendingWrites();

      this.deps.store.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused } });

      const filePath = before.activeFilePath;
      if (filePath) {
        const file = this.deps.store.getState().files.get(filePath);

        //  Only a session in progress has a boundary worth recording
        if (file && (file.status === STATUS.TRACKING || file.status === STATUS.PAUSED)) {
          this.appendEvent({
            time: this.deps.clock.nowFull(),
            type: focused ? 'focus' : 'blur',
            file: filePath,
            state: focused
              ? file.status === STATUS.TRACKING
                ? 'tracking'
                : 'pausing'
              : 'inactive',
            reason: focused ? 'window-focus' : 'window-blur',
          });
        }
      }

      await this.flushPendingWrites();
    } catch (error) {
      this.deps.log.warn('[RTT][service] 处理窗口焦点失败 / focus handling failed:', error);
    }
  }

  //  ==========================================================================
  // user actions
  //  ==========================================================================

  /**
   * Start counting for the current file.
   *
   * Required: `autoStartMode` defaults to `manual`, where opening a file only binds it
   * without counting. Without this entry point the user has no way to start at all —
   * a dead end confirmed by running the plugin.
   */
  async startCurrent(): Promise<void> {
    try {
      const settings = this.deps.settings();
      if (!isDocumentRecordingEnabled(settings)) return;

      const state = this.deps.store.getState();
      const target = state.activeFilePath ?? this.deps.getActivePath();
      if (!target || !shouldTrackFile(target, settings)) return;

      const file = state.files.get(target);
      if (file?.status === STATUS.TRACKING) return;

      await this.flushPendingWrites();
      this.deps.store.dispatch({
        type: ActionTypes.SWITCH_FILE,
        payload: { fromPath: state.activeFilePath, toPath: target, autoStart: true },
      });
      await this.flushPendingWrites();
    } catch (error) {
      this.deps.log.warn('[RTT][service] 开始计时失败 / start failed:', error);
    }
  }

  /** Save the current session. */
  async saveCurrent(kind: SaveKind = 'save'): Promise<void> {
    try {
      const filePath = this.deps.store.getState().activeFilePath;
      if (!filePath) return;

      this.dispatchSave(filePath, kind);
      await this.flushPendingWrites();
    } catch (error) {
      this.deps.log.warn('[RTT][service] 保存会话失败 / save failed:', error);
    }
  }

  /** Discard the current session. */
  async discardCurrent(): Promise<void> {
    try {
      const filePath = this.deps.store.getState().activeFilePath;
      if (!filePath) return;

      this.deps.store.dispatch({
        type: ActionTypes.DISCARD_SESSION,
        payload: { filePath },
      });
      await this.flushPendingWrites();
    } catch (error) {
      this.deps.log.warn('[RTT][service] 丢弃会话失败 / discard failed:', error);
    }
  }

  async togglePause(): Promise<void> {
    try {
      const filePath = this.deps.store.getState().activeFilePath;
      if (!filePath) return;

      const before = this.deps.store.getState().files.get(filePath);
      if (!before || (before.status !== STATUS.TRACKING && before.status !== STATUS.PAUSED)) {
        return;
      }

      await this.flushPendingWrites();
      this.deps.store.dispatch({ type: ActionTypes.TOGGLE_PAUSE, payload: { filePath } });

      //  The pause boundary must reach the event log, or pause time cannot be reconstructed
      //  from the stream — the original only recorded it in the session map.
      const after = this.deps.store.getState().files.get(filePath);
      if (after && after.status !== before.status) {
        const paused = after.status === STATUS.PAUSED;
        this.appendEvent({
          time: this.deps.clock.nowFull(),
          type: paused ? 'pause' : 'resume',
          file: filePath,
          state: paused ? 'pausing' : 'tracking',
          reason: 'user-toggle',
        });
      }

      await this.flushPendingWrites();
    } catch (error) {
      this.deps.log.warn('[RTT][service] 暂停切换失败 / toggle failed:', error);
    }
  }

  //  ==========================================================================

  //  ==========================================================================

  /**
   * Close sessions whose tab is gone.
   *
   * This is where the original lost data most often: a closed tab never comes back, so a
   * session not flushed at that moment is lost for good. Every in-progress session whose
   * path is no longer open is auto-saved here.
   */
  async closeOrphanSessions(): Promise<void> {
    try {
      const settings = this.deps.settings();
      if (!isDocumentRecordingEnabled(settings)) return;

      const open = new Set(this.deps.getOpenPaths());
      const state = this.deps.store.getState();
      const orphans: string[] = [];

      for (const [filePath, file] of state.files) {
        if (file.status !== STATUS.TRACKING && file.status !== STATUS.PAUSED) continue;
        if (open.has(filePath)) continue;
        orphans.push(filePath);
      }

      if (orphans.length === 0) return;

      await this.flushPendingWrites();
      for (const filePath of orphans) this.dispatchSave(filePath, 'auto-save');

      //  If the active file was closed too, unbind — otherwise the timer stays attached to
      //  a file that is no longer open.
      const activeFilePath = state.activeFilePath;
      if (activeFilePath && orphans.includes(activeFilePath)) {
        this.deps.store.dispatch({ type: ActionTypes.UNBIND_FILE });
      }

      await this.flushPendingWrites();
    } catch (error) {
      this.deps.log.warn('[RTT][service] 闭合孤儿会话失败 / orphan close failed:', error);
    }
  }

  /** Wrap up before the app quits. */
  async shutdown(): Promise<void> {
    try {
      const filePath = this.deps.store.getState().activeFilePath;
      if (filePath) this.dispatchSave(filePath, 'auto-save');
      await this.flushPendingWrites();
      await this.deps.history.flushNow();
    } catch (error) {
      this.deps.log.warn('[RTT][service] 退出收尾失败 / shutdown failed:', error);
    }
  }

  //  ==========================================================================
  // flushing
  //  ==========================================================================

  /** Dispatch one session save. */
  private dispatchSave(filePath: string, kind: SaveKind): void {
    const settings = this.deps.settings();
    this.deps.store.dispatch({
      type: ActionTypes.SAVE_SESSION,
      payload: {
        filePath,
        minReadSeconds: settings.minReadSeconds ?? 0,
        eventType: kind,
      },
    });
  }

  /**
   * Flush the pending-write queue into the store.
   *
   * The event write and the queue consumption happen in one synchronous block with no
   * await between them: an interruption would replay the queue and duplicate session
   * events, which is exactly how the original produced 18 duplicate start events. The
   * store writes events in a single transaction, so the pair is atomic.
   */
  async flushPendingWrites(): Promise<void> {
    const writes = this.deps.store.getState().pendingWrites;
    if (writes.length === 0) return;

    const events: TimelineEvent[] = [];
    const recordUpdates: Array<{
      filePath: string;
      activeSeconds: number;
      unfocusedSeconds: number;
      lastReadAt: string;
    }> = [];

    for (const write of writes) {
      if (write.type === 'timeline-start') {
        events.push({
          time: write.time,
          type: 'start',
          file: write.filePath,
          state: write.state,
        });
        continue;
      }

      if (write.type === 'timeline-discard') {
        events.push({ time: write.time, type: 'discard', file: write.filePath });
        continue;
      }

      events.push(this.buildSessionEvent(write));
      recordUpdates.push({
        filePath: write.filePath,
        activeSeconds: write.activeSeconds,
        unfocusedSeconds: write.unfocusedSeconds,
        lastReadAt: this.sessionEndTime(write).slice(0, 10),
      });
    }

    try {
      if (events.length > 0) this.deps.history.appendEvents(events);
    } catch (error) {

      //  Nothing was written, so the queue stays put and the next tick retries
      this.deps.log.warn('[RTT][service] 事件写入失败，队列保留 / event write failed:', error);
      return;
    }

    this.deps.store.dispatch({
      type: ActionTypes.CONSUME_PENDING_WRITES,
      payload: { count: writes.length },
    });

    for (const update of recordUpdates) {
      this.deps.history.applySessionSave(update.filePath, update);
    }

    await this.deps.history.flushNow();
  }

  /** The session's end timestamp. */
  private sessionEndTime(write: SessionWrite): string {
    const times = Object.keys(write.session).sort();
    return times.length > 0 ? times[times.length - 1]! : this.deps.clock.nowFull();
  }

  /** Build the timeline event for a session write. */
  private buildSessionEvent(write: SessionWrite): TimelineEvent {
    return {
      time: this.sessionEndTime(write),
      type: write.eventType,
      file: write.filePath,
      state: 'saved',
      duration: write.totalSeconds,
      activeSeconds: write.activeSeconds,
      unfocusedSeconds: write.unfocusedSeconds,
    };
  }

  /** Build a switch event. */
  private buildSwitchEvent(fromPath: string, toPath: string): TimelineEvent {
    const state = this.deps.store.getState();
    const fromFile = state.files.get(fromPath);
    const fileState = (file: TimerFileState | undefined): string =>
      file?.status === STATUS.PAUSED ? 'pausing' : 'tracking';

    return {
      time: this.deps.clock.nowFull(),
      type: 'switch',
      from: fromPath,
      to: toPath,
      fromState: fileState(fromFile),
      toState: 'tracking',
    };
  }

  /**
   * Append one observational event.
   * Synchronous; the caller decides where to await persistence.
   */
  private appendEvent(event: TimelineEvent): void {
    try {
      this.deps.history.appendEvents([event]);
    } catch (error) {
      this.deps.log.warn('[RTT][service] 事件追加失败 / event append failed:', error);
    }
  }
}
