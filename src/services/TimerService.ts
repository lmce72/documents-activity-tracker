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

import { ActionTypes, STATUS, TICK_GAP_LIMIT_MS, UNFOCUSED_GAP_LIMIT_MS } from '../core/constants';
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
import { formatLocalFull, parseSessionStartTime } from '../core/time';
import { readLastSeen, recoveryEnd, writeLastSeen } from '../data/liveTimerSnapshot';
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
  isMobile?: boolean;
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

/**
 * 一段失焦该记成什么 / how a blur stretch should be recorded.
 *
 * 只写**结构性事实**：暂停中的会话是暂停、分屏阅读期间是阅读，其余一律不写归类 —— 没有归类的
 * 时段由口径在展示时解释（见 core/account.ts）。把口径烧进事件是错的：口径改了，历史数据会跟着
 * 变成一个当时并不成立的判断，而且实时计数器（它只有"离开"一个通道）会与事件里的归类对不上。
 *
 * Only **structural facts** are written: a paused session is paused, split reading is reading, and
 * everything else is left unclassified — the policy interprets unclassified stretches at display time
 * (see core/account.ts). Baking the policy into events would be wrong twice: changing it would rewrite
 * what the past meant, and the live counters (which have one "away" channel) would stop agreeing with
 * the disposition in the event.
 */
function awayDisposition(
  file: TimerFileState,
): 'reading' | 'paused' | undefined {
  if (file.status === STATUS.PAUSED) return 'paused';
  if (file.splitReading === true) return 'reading';
  return undefined;
}

export class TimerService {
  private mobileBackground = false;
  private foregroundResumePath: string | null = null;

  /** Close the reading round before the WebView can freeze; background has no live tail. */
  async onMobileBackgroundChange(background: boolean): Promise<void> {
    if (!this.deps.isMobile || background === this.mobileBackground) return;
    this.mobileBackground = background;
    try {
      if (background) {
        const state = this.deps.store.getState();
        const path = state.activeFilePath;
        const file = path ? state.files.get(path) : undefined;
        this.foregroundResumePath = file?.status === STATUS.TRACKING ? path : null;
        // No await before closing and appending: native pause may freeze JS immediately.
        if (path && file) {
          const last = file.lastTickTimestamp;
          const limit = state.isWindowFocused ? TICK_GAP_LIMIT_MS : UNFOCUSED_GAP_LIMIT_MS;
          if (file.status === STATUS.TRACKING && last !== null && this.deps.clock.now() - last > limit) {
            this.appendEvent({ time: formatLocalFull(new Date(last + 1000)), type: 'blur',
              file: path, state: 'inactive', reason: 'mobile-background-gap', unfocusedDisposition: 'ignored' });
          }
          this.dispatchSave(path, 'auto-save', 0);
        }
        this.deps.store.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused: false } });
        await this.flushPendingWrites();
      } else {
        const resumePath = this.foregroundResumePath;
        this.foregroundResumePath = null;
        this.deps.store.dispatch({ type: ActionTypes.SET_WINDOW_FOCUS, payload: { focused: true } });
        await this.onActivePathChange();
        if (!this.mobileBackground && resumePath && resumePath === this.deps.getActivePath()) await this.startCurrent();
      }
    } catch (error) {
      this.deps.log.warn('[RTT][service] Mobile lifecycle transition failed:', error);
    }
  }

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

      //  进程被杀时不会有任何事件，唯一的证据是最后一次心跳：按它收尾，否则整段后台时间会被算成专注
      //  A killed process leaves no events; the last heartbeat is the only evidence. Closing at it keeps
      //  the background stretch out of the session instead of crediting it as focus.
      const recoveredEnd = recoveryEnd(
        last.time,
        readLastSeen(),
        filePath,
        this.deps.clock.nowFull(),
      );

      // Without local heartbeat evidence, mobile recovery must not invent time until launch.
      const endTime = this.deps.isMobile && recoveredEnd === this.deps.clock.nowFull()
        ? last.time : recoveredEnd;
      this.deps.history.appendEvents([
        {
          time: endTime,
          type: 'auto-save',
          file: filePath,
          state: 'saved',
        },
      ]);
      writeLastSeen(null);
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
    if (this.mobileBackground) return;
    if (!isDocumentRecordingEnabled(this.deps.settings())) return;

    try {
      await this.applyIdleState();

      //  断层排在跨日/关孤儿之前：否则跨夜冻结会被跨日收尾写成"整夜专注"
      //  The gap goes before rollover and orphan closing: a freeze across midnight would otherwise be
      //  turned into "focused all night" by the rollover's own auto-save.
      await this.closeFrozenGap();
      if (this.mobileBackground) return;
      this.applyDayRollover();
      await this.closeOrphanSessions();
      if (this.mobileBackground) return;

      const filePath = this.deps.store.getState().activeFilePath;
      if (filePath) {
        this.deps.store.dispatch({ type: ActionTypes.TICK, payload: { filePath } });
      }

      await this.flushPendingWrites();
      this.syncActivityTitle();
      this.writeHeartbeat();
    } catch (error) {
      this.deps.log.warn('[RTT][service] 心跳处理失败 / tick failed:', error);
    }
  }

  /** 上次写心跳的时刻 / when the heartbeat was last written. */
  private lastHeartbeatAt = 0;

  /**
   * 记一次"还在跑" / record that the session is still running.
   *
   * 五秒一次就够：被杀最多丢掉最后五秒的归属，而它决定了**其余整段**后台时间算不算专注。
   * 一次性写 localStorage 很便宜，但没必要每秒都写。
   *
   * Once every five seconds is enough: a kill loses at most the last five seconds' attribution, while
   * this is what decides whether **all the rest** of the background time counts as focus. One
   * localStorage write is cheap, but there is no reason to do it every second.
   */
  private writeHeartbeat(): void {
    try {
      const state = this.deps.store.getState();
      const filePath = state.activeFilePath;
      const file = filePath ? state.files.get(filePath) : undefined;
      if (!filePath || !file) return;
      if (file.status !== STATUS.TRACKING && file.status !== STATUS.PAUSED) return;

      const now = this.deps.clock.now();
      if (now - this.lastHeartbeatAt < 5000) return;
      this.lastHeartbeatAt = now;
      writeLastSeen({ filePath, at: this.deps.clock.nowFull() });
    } catch (error) {
      this.deps.log.warn('[RTT][service] 心跳写入失败 / heartbeat write failed:', error);
    }
  }

  /**
   * 处理心跳断开的时间断层 / account for a gap in the heartbeat.
   *
   * 手机退到后台、锁屏，或桌面休眠时，WebView 被冻结，心跳与 Capacitor 的状态事件可能都不来。
   * 实测：23:46:46 有一条 start，下一条事件是次日 07:17 的 blur —— 中间 7.5 小时没有任何边界，
   * 推导只能把它算成专注，热力图于是画出一整条通宵蓝。实时计数那边反而是对的（大间隔的 tick 被丢弃）。
   *
   * 断层是真的"没在计时"，所以这里把它补成一段离开：在最后一个心跳之后写 blur、在现在写 focus。
   * 判据与 TICK 丢弃大间隔的那条线完全一致，两套账才不会各说各的。
   *
   * When a phone is backgrounded or locked, or a desktop sleeps, the WebView freezes and neither the
   * heartbeat nor Capacitor's state event necessarily arrives. Measured: a `start` at 23:46:46 with the
   * next event at 07:17 the following morning — 7.5 hours with no boundary, so the derivation could only
   * call it focus and the heatmap drew one solid overnight bar. The live counters were right (the large
   * tick was dropped); only the event stream was missing the truth.
   *
   * The gap really is time not being timed, so it is closed as an away stretch: a blur right after the
   * last heartbeat and a focus now. The threshold is exactly the one TICK uses to drop a large gap, so
   * the two ledgers cannot disagree.
   */
  private async closeFrozenGap(): Promise<void> {
    const state = this.deps.store.getState();
    const filePath = state.activeFilePath;
    const file = filePath ? state.files.get(filePath) : undefined;
    if (!filePath || !file || file.status !== STATUS.TRACKING) return;

    const last = file.lastTickTimestamp;
    if (last === null) return;

    const now = this.deps.clock.now();
    const gap = now - last;
    const limit = state.isWindowFocused ? TICK_GAP_LIMIT_MS : UNFOCUSED_GAP_LIMIT_MS;
    if (gap <= limit) return;

    try {
      await this.flushPendingWrites();

      //  最后一个心跳覆盖的是它自己那一秒，从下一毫秒起才算离开
      //  The last heartbeat covered its own second; the stretch starts right after it
      const awayFrom = new Date(last + 1000);
      this.appendEvent({
        time: formatLocalFull(awayFrom),
        type: 'blur',
        file: filePath,
        state: 'inactive',
        reason: 'frozen-gap',
        ...(this.deps.isMobile ? { unfocusedDisposition: 'ignored' as const }
          : awayDisposition(file) ? { unfocusedDisposition: awayDisposition(file) } : {}),
      });
      this.appendEvent({
        time: this.deps.clock.nowFull(),
        type: 'focus',
        file: filePath,
        state: 'tracking',
        reason: 'frozen-gap-end',
      });

      //  基准挪到"现在"：这段已经记进事件流，TICK 不该再按大间隔处理一次
      //  Move the baseline to now: the stretch is in the event stream, so TICK must not handle it again
      this.deps.store.dispatch({
        type: ActionTypes.RESTORE_FILE,
        payload: { filePath, fileState: { ...file, lastTickTimestamp: now } },
      });

      await this.flushPendingWrites();
      this.deps.log.info('[RTT][service] 心跳断层已记为离开 / frozen gap recorded as away:', Math.round(gap / 1000), 's');
    } catch (error) {
      this.deps.log.warn('[RTT][service] 断层处理失败 / frozen-gap handling failed:', error);
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
  private async applyIdleState(): Promise<void> {
    const settings = this.deps.settings();
    const state = this.deps.store.getState();

    if (!state.isWindowFocused) return;

    if (!settings.idleTimeoutEnabled) {
      if (state.isIdle || this.idleOpen) await this.settleIdle(false);
      return;
    }

    const timeoutMs = normalizeIdleTimeoutSeconds(settings.idleTimeout) * 1000;
    const idleMs = this.deps.clock.now() - state.lastActivityTime;

    if (idleMs > timeoutMs) {
      //  标志已经是 true 但边界没开（例如上一轮留下的空闲状态）：补写开头，否则这一段会被并进
      //  前一个区间算成专注
      //  The flag is already true but no boundary was opened (say, left over from the previous round):
      //  write the opening anyway, or the stretch folds into the previous interval as active time.
      if (!state.isIdle || !this.idleOpen) await this.settleIdle(true);
      return;
    }

    if (state.isIdle || this.idleOpen) await this.settleIdle(false);
  }

  /**
   * 进入或离开空闲 / enter or leave an idle stretch.
   *
   * 事件是必需的，不是装饰：时长由事件推导，没有 idle/idle-end 这两条边界，空闲那段会被并进上一条
   * 事件之后的区间，在推导里变成专注或暂停 —— 总数对不上，而这一段恰恰是最容易被误当成"还在读"的。
   *
   * The events are load-bearing: durations are derived from the event stream, and without an
   * idle/idle-end boundary the stretch would fall into the gap after the previous event and be
   * derived as active or paused time. The one stretch most likely to be mistaken for reading is
   * exactly the one that needs its own boundary.
   */
  private async settleIdle(entering: boolean): Promise<void> {
    try {
      await this.flushPendingWrites();
      this.writeIdleBoundary(entering);

      this.deps.store.dispatch({
        type: entering ? ActionTypes.SET_IDLE : ActionTypes.CLEAR_IDLE,
      });

      await this.flushPendingWrites();
    } catch (error) {
      this.deps.log.warn('[RTT][service] 空闲结算失败 / idle settle failed:', error);
    }
  }

  /**
   * 这一段空闲是否已经用 `idle` 事件开头 / whether an idle stretch has an open `idle` boundary.
   *
   * 只写开头不写结尾是不行的，而"离开空闲"有两条完全不同的路：定时器发现（applyIdleState）与
   * 用户输入（markUserActivity）。后者先把状态树里的 isIdle 抹掉，等定时器下一次醒来时已经看不出
   * 刚才空闲过 —— 实测中 idle-end 因此一条都没写出来，空闲区间一路延伸到下一次保存，把用户回来
   * 之后的阅读也吞成了空闲。用一个显式标志把两条路都收口。
   *
   * An opening without a closing will not do, and "leaving idle" has two very different paths: the
   * heartbeat noticing, and the user producing input. The latter clears isIdle from the state tree
   * first, so by the time the heartbeat wakes up there is nothing to notice — measured, not a single
   * idle-end was written, the idle interval ran on to the next save, and everything read after coming
   * back was swallowed as idle. One explicit flag closes both paths.
   */
  private idleOpen = false;

  /** 写一条空闲边界；重复调用不会写出第二条同向边界 / write one idle boundary, never twice in a row. */
  private writeIdleBoundary(entering: boolean, reason?: string): void {
    if (entering === this.idleOpen) return;

    const state = this.deps.store.getState();
    const filePath = state.activeFilePath;
    const file = filePath ? state.files.get(filePath) : undefined;

    //  只有进行中的会话才有边界可写 / only a session in progress has a boundary worth writing
    if (filePath && file && file.status === STATUS.TRACKING) {
      this.appendEvent({
        time: this.deps.clock.nowFull(),
        type: entering ? 'idle' : 'idle-end',
        file: filePath,
        state: entering ? 'idle' : 'tracking',
        reason: reason ?? (entering ? 'idle-timeout' : 'idle-resume'),
      });
    }

    this.idleOpen = entering;
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
    //  输入是"离开空闲"的另一条路：先收尾，再让 USER_ACTIVITY 把标志抹掉
    //  Input is the other way out of idle: close the boundary first, then let USER_ACTIVITY clear the flag.
    if (this.idleOpen) this.writeIdleBoundary(false, 'user-activity');
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
    if (this.mobileBackground) return;
    if (!isDocumentRecordingEnabled(this.deps.settings())) return;

    try {
      const settings = this.deps.settings();
      const fromPath = this.deps.store.getState().activeFilePath;
      const candidate = this.deps.getActivePath();
      const toPath =
        candidate && isTrackableTarget(candidate, settings) ? candidate : null;

      if (fromPath === toPath) return;

      await this.flushPendingWrites();
      if (this.mobileBackground) return;

      if (fromPath) {
        this.dispatchSave(fromPath, 'auto-save');

        //  The session-close event must land before the switch event is appended: save only
        //  queues, so appending the switch now would put it before the session it closes
        //  and the derivation could not attribute that stretch.
        await this.flushPendingWrites();
        if (toPath) this.appendEvent(this.buildSwitchEvent(fromPath, toPath));
      }

      if (this.mobileBackground) return;
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
          /**
           * 回到窗口时可能仍然空闲 / regaining focus does not mean the user is back.
           *
           * 失焦期间空闲判定被跳过（输入事件也一起停了），所以回来那一刻 `isIdle` 往往还是 true。
           * 这时若照常写一条 `focus` 事件，事件流会把"回来了但还没动"的那段算成专注 —— 实时计数
           * 记的是空闲，落盘后的账却是阅读，两边从此对不上。写 `idle` 事件，让推导也知道这一段是空闲。
           *
           * Idle detection is skipped while the window is unfocused (input events stop with it), so
           * `isIdle` is usually still true the moment focus returns. Writing a `focus` event there
           * would have the event stream count "back, but not yet moving" as active — the live counters
           * say idle, the settled record says reading, and the two stop agreeing. An `idle` event
           * keeps the derivation honest.
           */
          const stillIdle = focused
            && this.deps.store.getState().isIdle
            && file.status === STATUS.TRACKING;

          this.appendEvent({
            time: this.deps.clock.nowFull(),
            type: focused ? (stillIdle ? 'idle' : 'focus') : 'blur',
            file: filePath,
            state: focused
              ? file.status === STATUS.TRACKING
                ? stillIdle ? 'idle' : 'tracking'
                : 'pausing'
              : 'inactive',
            reason: focused
              ? stillIdle ? 'window-focus-idle' : 'window-focus'
              : 'window-blur',
            ...(!focused ? { unfocusedDisposition: awayDisposition(file) } : {}),
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
      //  关掉分屏阅读后，这段回到用户设定的默认口径（而不是硬编码成"不算"）
      //  Turning split reading off hands this stretch back to the configured default instead of a
      //  hard-coded "not counted".
      unfocusedDisposition: file.status === STATUS.PAUSED
        ? 'paused'
        : enabled ? 'reading' : undefined,
    });
    await this.flushPendingWrites();
  }

  /** 已结束的失焦段可重新归类，原始事件不丢弃 / reclassify closed blur intervals. */
  async classifyUnfocused(index: number, expectedTime: string, disposition: 'reading' | 'paused' | 'unfocused' | 'ignored'): Promise<void> {
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
      sessionObject[interval.from] = disposition === 'reading' ? 'tracking' : disposition === 'paused' ? 'pausing' : disposition === 'ignored' ? 'ignored' : 'inactive';
      for (const time of Object.keys(sessionObject)) if (time >= interval.from && time < interval.to) sessionObject[time] = disposition === 'reading' ? 'tracking' : disposition === 'paused' ? 'pausing' : disposition === 'ignored' ? 'ignored' : 'inactive';
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
    if (this.mobileBackground) return;
    //  新的一轮以 start 事件开头，之前那条空闲边界随之作废；按下开始本身就是一次用户动作，
    //  残留的空闲标志一并清掉，否则新一轮的第一秒会被记成空闲
    //  A new round opens with a start event, which retires any idle boundary still lying open. Pressing
    //  start is itself user activity, so the leftover idle flag is cleared too — otherwise the first
    //  second of the new round is filed as idle.
    this.idleOpen = false;
    if (this.deps.store.getState().isIdle) {
      this.deps.store.dispatch({ type: ActionTypes.CLEAR_IDLE });
    }
    try {
      const settings = this.deps.settings();
      if (!isDocumentRecordingEnabled(settings)) return;

      // 先处理排队中的视图切换，防止开始按钮使用上一个对象。
      // Resolve queued view changes before starting the current target.
      await this.onActivePathChange();
      if (this.mobileBackground) return;

      const state = this.deps.store.getState();
      const target = this.deps.getActivePath();
      if (!target || !isTrackableTarget(target, settings)) return;

      //  立刻记一次：刚开跑就被杀时也有一条心跳可依
      //  One right away, so a kill seconds after starting still has a heartbeat to rely on.
      writeLastSeen({ filePath: target, at: this.deps.clock.nowFull() });
      this.lastHeartbeatAt = this.deps.clock.now();

      const file = state.files.get(target);
      if (file?.status === STATUS.TRACKING) return;

      await this.flushPendingWrites();
      if (this.mobileBackground) return;
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
    this.idleOpen = false;
    writeLastSeen(null);
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
  private dispatchSave(filePath: string, kind: SaveKind, minReadSeconds?: number): void {
    //  保存/丢弃事件本身就是空闲段的终点，标志跟着落下，免得下一次空闲写出重复的开头
    //  A save or discard is itself the end of the stretch; drop the flag so the next idle opens cleanly.
    this.idleOpen = false;
    //  会话结束：心跳作废，否则下一轮恢复会把旧终点当成新会话的终点
    //  The session is over: the heartbeat is retired, or a later recovery would use a stale end.
    writeLastSeen(null);


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
        minReadSeconds: minReadSeconds ?? settings.minReadSeconds ?? 0,
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
      idleSeconds: write.idleSeconds ?? 0,
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
