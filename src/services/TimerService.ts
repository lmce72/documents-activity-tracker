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
import { isTrackableTarget } from '../core/filters';
import { isPluginViewKey } from '../core/activePath';
import type { Logger } from '../core/logger';
import {
  isDocumentRecordingEnabled,
  normalizeIdleTimeoutSeconds,
} from '../core/settings';
import { eventFileRefs } from '../core/migration';
import { classifyUnfocusedInterval, listUnfocusedIntervals } from '../core/unfocused';
import { buildFileRecords } from '../core/timeline';
import { parseSessionStartTime } from '../core/time';
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
  getActiveTitle?: () => string | null;
  /** markdown paths still open in some leaf */
  getOpenPaths: () => string[];
}

/** why a session closed. */
export type SaveKind = 'save' | 'auto-save';

export class TimerService {
  private readonly activityTitles = new Map<string, string>();
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
      this.syncActivityTitle();
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
   *
   * Serialised through a promise chain. Two workspace events (`active-leaf-change` and
   * `file-open`) both fire for one switch, and because this method awaits between reading
   * `fromPath` and dispatching, the two runs interleave: both observe the same old
   * `fromPath`, both compute the same `toPath`, and both write a `switch` event. Measured on
   * a real vault: every switch was logged twice (122 switch events against 106 starts).
   * Chaining means the second run starts after the first has settled and then early-returns
   * on `fromPath === toPath`.
   *
   * Reads the active path itself rather than taking it as an argument, so no call site
   * gets to interpret "the current file" differently.
   */
  async onActivePathChange(): Promise<void> {
    this.pathChangeChain = this.pathChangeChain.then(() => this.applyActivePathChange());
    return this.pathChangeChain;
  }

  private pathChangeChain: Promise<void> = Promise.resolve();

  /** The body of {@link onActivePathChange}; see there for why it is serialised. */
  private async applyActivePathChange(): Promise<void> {
    if (!isDocumentRecordingEnabled(this.deps.settings())) return;

    try {
      const settings = this.deps.settings();
      const fromPath = this.deps.store.getState().activeFilePath;
      const candidate = this.deps.getActivePath();
      const toPath =
        candidate && isTrackableTarget(candidate, settings) ? candidate : null;

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

    //  用户明确保存或丢弃后不再自动开 —— 自动开始等于推翻用户刚刚做出的动作。手动点「开始计时」
    //  走的是另一条路（直接带 autoStart: true），不受这一条限制。
    //  A round the user explicitly discarded does not auto-start again: doing so would overrule the
    //  action they just took. Pressing "start timing" by hand goes the other way (it passes
    //  autoStart: true straight through) and is unaffected.
    const existing = this.deps.store.getState().files.get(filePath);
    if (existing?.discardedByUser || existing?.savedByUser) return false;

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
            ...(!focused ? { unfocusedDisposition: file.status === STATUS.PAUSED ? 'paused' as const : file.splitReading ? 'reading' as const : 'unfocused' as const } : {}),
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

  /** 分屏阅读仅作用于本轮 / split reading applies prospectively to this session. */
  async setSplitReading(enabled: boolean): Promise<void> {
    await this.flushPendingWrites();
    const state = this.deps.store.getState();
    const filePath = state.activeFilePath;
    const file = filePath ? state.files.get(filePath) : undefined;
    if (!filePath || !file || file.status === STATUS.IDLE || !!file.splitReading === enabled) return;
    this.deps.store.dispatch({ type: ActionTypes.SET_SPLIT_READING, payload: { filePath, enabled } });
    if (!state.isWindowFocused) this.appendEvent({ time: this.deps.clock.nowFull(), type: 'blur', file: filePath,
      state: file.status === STATUS.PAUSED ? 'pausing' : enabled ? 'tracking' : 'inactive', reason: 'split-reading-toggle',
      unfocusedDisposition: file.status === STATUS.PAUSED ? 'paused' : enabled ? 'reading' : 'unfocused',
    });
    await this.flushPendingWrites();
  }

  /** 已结束的失焦段可重新归类，原始事件不丢弃 / reclassify closed blur intervals. */
  async classifyUnfocused(index: number, expectedTime: string, disposition: 'reading' | 'paused' | 'unfocused'): Promise<void> {
    await this.flushPendingWrites();
    const events = this.deps.history.getEvents();
    const interval = listUnfocusedIntervals(events).find((item) => item.index === index && item.from === expectedTime);
    if (!interval || !interval.to) throw new Error('失焦时段已变更或尚未结束 / interval changed or still open');
    if (!this.canClassifyUnfocused(interval.filePath, interval.from)) throw new Error('请先恢复或保存当前暂停 / resume or save the current pause first');
    const result = classifyUnfocusedInterval(events, index, disposition);
    this.deps.history.replaceEvents(result.events);
    const state = this.deps.store.getState();
    const file = state.files.get(interval.filePath);
    if (state.activeFilePath === interval.filePath && file?.sessionStartTime && interval.from >= file.sessionStartTime && file.status !== STATUS.IDLE) {
      const sessionObject = { ...file.sessionObject };
      sessionObject[interval.from] = disposition === 'reading' ? 'tracking' : disposition === 'paused' ? 'pausing' : 'inactive';
      for (const time of Object.keys(sessionObject)) if (time >= interval.from && time < interval.to) sessionObject[time] = disposition === 'reading' ? 'tracking' : disposition === 'paused' ? 'pausing' : 'inactive';
      this.deps.store.dispatch({ type: ActionTypes.RESTORE_FILE, payload: { filePath: interval.filePath, fileState: { ...file, sessionObject,
        activeSeconds: Math.max(0, file.activeSeconds + result.delta.activeSeconds),
        unfocusedSeconds: Math.max(0, file.unfocusedSeconds + result.delta.unfocusedSeconds),
        pausedSeconds: Math.max(0, file.pausedSeconds + result.delta.pausedSeconds),
      } } });
    }
    // records 只物化已结束会话；当前轮保存时会再累加，不能提前写进去。
    // Materialize closed sessions only; saving the live session will add it later.
    const closedEvents = file && file.status !== STATUS.IDLE && file.sessionStartTime
      ? result.events.filter((event) => event.time < file.sessionStartTime! || (event.type === 'switch' ? event.from !== interval.filePath && event.to !== interval.filePath : event.file !== interval.filePath))
      : result.events;
    const record = buildFileRecords(closedEvents, this.deps.clock.now(), undefined, { countUnfocused: true })[interval.filePath];
    this.deps.history.upsertRecord(interval.filePath, { totalReadTime: record?.totalReadTime ?? 0, unfocusedReadTime: record?.unfocusedReadTime ?? 0 });
    await this.deps.history.flushNow({ force: true });
  }

  canClassifyUnfocused(filePath: string, from: string): boolean {
    const file = this.deps.store.getState().files.get(filePath);
    const fromMs = parseSessionStartTime(from)?.getTime();
    return !(file?.status === STATUS.PAUSED && file.pauseStartTimestamp !== null && (fromMs === undefined || fromMs >= file.pauseStartTimestamp));
  }

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

      // 先处理排队中的视图切换，防止开始按钮使用上一个对象。
      // Resolve queued view changes before starting the current target.
      await this.onActivePathChange();

      const state = this.deps.store.getState();
      const target = this.deps.getActivePath();
      if (!target || !isTrackableTarget(target, settings)) return;

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
      await this.onActivePathChange();
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
          state: paused ? 'pausing' : this.deps.store.getState().isWindowFocused || after.splitReading ? 'tracking' : 'inactive',
          ...(!this.deps.store.getState().isWindowFocused && !paused ? { unfocusedDisposition: after.splitReading ? 'reading' as const : 'unfocused' as const } : {}),
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
      await this.deps.history.flushNow({ trigger: 'quit' });
    } catch (error) {
      this.deps.log.warn('[RTT][service] 退出收尾失败 / shutdown failed:', error);
    }
  }

  //  ==========================================================================
  // flushing
  //  ==========================================================================

  /** Dispatch one session save. */
  private dispatchSave(filePath: string, kind: SaveKind): void {

    //  只结算**正在进行**的会话。保存的语义是"把眼下这一轮落盘"，而闲置的文件没有可落盘的东西 ——
    //  对它保存只会写一条空 session，顺带把 clearedFile 里的 discardedByUser 冲成 false（用户刚
    //  显式丢弃的那一笔因此又被允许自动开始）。
    //  Only settles a session that is **in progress**. Saving means "write down the round in front of
    //  us", and an idle file has nothing to write: saving it anyway emits an empty session and, through
    //  clearedFile, resets discardedByUser to false — re-arming the auto-start the user had just
    //  suppressed.
    const current = this.deps.store.getState().files.get(filePath);
    if (!current || (current.status !== STATUS.TRACKING && current.status !== STATUS.PAUSED)) return;

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
      if (events.length > 0) {
        const titled = events.map(event => this.withActivityTitle(event));
        this.deps.history.appendEvents(titled);
        this.rememberActivityTitles(titled);
      }
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

    //  结算过会话才算「一轮结束」，这才是那条触发；纯 tick / 焦点之类的收尾没有时机可言，只做暂存。
    //  落盘与否由设置里的闸门定。
    //  A settled session is what "a round ended" means and that is the only trigger here; a plain tick
    //  or a focus change has no moment attached and only buffers. Writing the file is the gate's call.
    await this.deps.history.flushNow({
      trigger: recordUpdates.length > 0 ? 'session-end' : undefined,
    });
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

  /** Stable target keys keep article-title changes inside the same reading round. */
  private withActivityTitle(event: TimelineEvent): TimelineEvent {
    if (event.type === 'switch' || event.type === 'discard' || !isPluginViewKey(event.file)) return event;
    const title = event.activityTitle ?? (event.type === 'start' && this.deps.getActivePath() === event.file
      ? this.deps.getActiveTitle?.() : this.activityTitles.get(event.file));
    if (!title) return event;
    return { ...event, activityTitle: title };
  }

  private rememberActivityTitles(events: readonly TimelineEvent[]): void {
    for (const event of events) {
      if ('activityTitle' in event && event.activityTitle) this.activityTitles.set(event.file, event.activityTitle);
    }
  }

  private syncActivityTitle(): void {
    const state = this.deps.store.getState();
    const path = state.activeFilePath;
    if (!path || !isPluginViewKey(path) || this.deps.getActivePath() !== path) return;
    const file = state.files.get(path);
    if (!file || (file.status !== STATUS.TRACKING && file.status !== STATUS.PAUSED)) return;
    const title = this.deps.getActiveTitle?.();
    if (!title || title === this.activityTitles.get(path)) return;
    this.appendEvent({ time: this.deps.clock.nowFull(), type: 'activity', file: path,
      activityTitle: title, state: file.status === STATUS.PAUSED ? 'pausing'
        : state.isWindowFocused || file.splitReading ? 'tracking' : 'inactive' });
  }

  private appendEvent(event: TimelineEvent): void {
    try {
      const titled = this.withActivityTitle(event);
      this.deps.history.appendEvents([titled]);
      this.rememberActivityTitles([titled]);
    } catch (error) {
      this.deps.log.warn('[RTT][service] 事件追加失败 / event append failed:', error);
    }
  }
}
