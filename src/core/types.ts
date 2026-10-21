/**
 * Core type definitions
 *
 * Origin: previously implicit/JSDoc shapes scattered across vault main.js,
 * now consolidated into explicit types.
 *
 * L0 module; depends only on constants.
 */

import type { FileStatus, ActionType, ManualStatus } from './constants';

/**
 * 一段时间算作什么 / what a stretch of time counts as.
 *
 * 三选而不是开关：窗口失焦与空闲超时都能被理解成「照算阅读」「算作暂停」或「根本不该记」，
 * 一个布尔值表达不了第三种。逐段归类优先于这里，这里只决定**新时段**与没被单独归类的时段。
 *
 * Three options rather than a switch: blur and idle can each mean "still reading", "paused", or
 * "should not be recorded at all", and a boolean cannot say the third. Per-stretch classification
 * wins over this; this decides **new** stretches and ones never classified by hand.
 */
export type AttributionPolicy = 'reading' | 'paused' | 'ignored';

//  ============================================================================
// Settings
//  ============================================================================

/**
 * Plugin settings.
 *
 * The first 13 fields are identical to the original (including 3 write-only legacy
 * fields); the last 2 are the new feature toggles. Defaults live in defaults.ts.
 */
export interface PluginSettings {
  /** 'blacklist' | 'whitelist' */
  filterMode: string;
  /** comma or newline separated */
  filterPatterns: string;
  idleTimeoutEnabled: boolean;
  idleTimeout: number;
  /** min session seconds */
  minReadSeconds: number;
  /** 'compact' | 'precise' */
  timeDisplayMode: string;
  /** 'always' | 'start-only' | 'return-only' | 'manual' */
  autoStartMode: string;
  useIconize: boolean;
  dataFilePath: string;
  /**
   * 旧设置：控制文档面板里那张「今日总时长」卡。该卡已被四条通道取代，键保留只为兼容旧 data.json。
   * Legacy: used to control a today-total cell that the four channel cells replaced. Kept only so an
   * older data.json still loads.
   */
  todayTotalDisplay: string;
  /** legacy, intentionally untouched */
  autoSaveEnabled: boolean;
  /** legacy, intentionally untouched */
  autoSaveInterval: number;
  /** legacy, intentionally untouched */
  trackingMode: string;

  //  --------------------------------------------------------------------------
  // New in this refactor
  //  --------------------------------------------------------------------------

  /**
   * Document tracking toggle: no timer service, no in-note widget, no document
   * section in the sidebar. Manual timing is unaffected.
   */
  documentTrackingEnabled: boolean;

  /**
   * Manual-timer toggle: hides its UI, ribbon icon and service; document tracking
   * is unaffected.
   */
  manualTimerEnabled: boolean;

  /**
   * Whether the manual stopwatch shows seconds. On by default; when off it reads to the
   * minute only, for long focus sessions where a ticking second is a distraction.
   */
  manualShowSeconds: boolean;

  /**
   * 正计时显示毫秒 / show milliseconds on the count-up stopwatch.
   *
   * 计算与存储一直是毫秒级的（`durationMs`），这个开关只决定**读出来**要不要那三位小数：
   * 长时间专注时跳动的末位是干扰，需要卡点的人则正相反。
   * The arithmetic and the stored record are millisecond-based either way (`durationMs`); this
   * switch only decides whether the readout shows those three decimals — noise during a long focus
   * session, and exactly what someone timing a short task wants.
   */
  manualShowMilliseconds: boolean;

  /**
   *
   * Whether document activity is still recorded while manual timing runs. On by default.
   * When off, the heartbeat and file switches stop producing events, so nothing lands in
   * any document's reading record — the two are separate ledgers and the user may want
   * only the manual one. The document panel reads 0s meanwhile, because nothing is being
   * recorded.
   */
  manualRecordDocActivity: boolean;

  /**
   * Whether unfocused time counts as reading time. Off by default.
   *
   * On: `reading = in-window + out-of-window`, the behaviour the unfocused channel was added
   * for. Off: out-of-window stretches are still recorded and still shown in their own card,
   * but no total anywhere includes them — which is what you want if the note simply stayed
   * open while you were in another application.
   *
   * The toggle only changes accounting, never recording, so flipping it re-reads the same
   * history rather than losing the stretches.
   */
  countUnfocusedAsReading: boolean;

  /**
   * 离开窗口时默认算作什么 / what a blur stretch counts as by default.
   *
   * 控制落在视图里（文档面板的「离开与空闲」区块），不再放设置页：它是一个会随时改的判断，
   * 改的时候人正看着那几个数。
   * The control lives in the view (the document panel's "away and idle" block), not in the settings
   * tab: it is a judgement the user changes while looking at the very numbers it moves.
   *
   * `countUnfocusedAsReading` 只用于迁移旧配置，运行期不再读它。
   * `countUnfocusedAsReading` is read only when migrating an older config.
   */
  awayPolicy: AttributionPolicy;

  /** 空闲超时时默认算作什么 / what an idle stretch counts as by default. */
  idlePolicy: AttributionPolicy;
  /** Keep recording plugin activity even when excluded from reading totals. */
  countPluginViewsAsReading: boolean;

  /**
   * Which durations the status bar pins, as exactly {@link MAX_STATUS_METRICS} slots.
   *
   * An array rather than four named fields so adding a metric needs no new setting, and so
   * the slots stay ordered — the status bar renders them left to right. An empty string
   * means the slot is unused.
   */
  statusBarMetrics: string[];

  /**
   * Desktop: show the status bar entries as icons instead of label + duration.
   *
   * Mobile always shows a single icon regardless — there is no room for more.
   */
  statusBarIconsOnly: boolean;

  //  --------------------------------------------------------------------------
  // 落盘时机 / when the vault file is written
  //  --------------------------------------------------------------------------
  //
  //  改动总是先进浏览器自己的 IndexedDB（崩溃不丢、不同步），vault 里的 SQLite 只在下列时机写。
  //  四个开关各自独立，用户自己权衡写入频率与同步冲突：关掉的越多文件越安静，但一旦没走到某个
  //  时机就崩溃，那份改动就只在 IndexedDB 里，下次启动才补进文件。
  //
  //  Changes always land in the browser own IndexedDB first (survives a crash, never synced).
  //  The SQLite file in the vault is written only at the moments below. The four switches are
  //  independent so the user weighs write frequency against sync conflicts themselves: the more
  //  that are off, the quieter the file — but a crash before the next enabled moment leaves that
  //  change in IndexedDB only, applied to the file on the next start.

  /** 每轮会话结束就写 / write whenever a session ends */
  flushOnSessionEnd: boolean;

  /** 退出 Obsidian / 卸载插件时写 / write on quit or plugin unload */
  flushOnQuit: boolean;

  /** 定时批量写 / write on a timer */
  flushOnInterval: boolean;

  /** 定时批量写的间隔（分钟）/ the timer interval, in minutes */
  flushIntervalMinutes: number;

  //  --------------------------------------------------------------------------
  // 倒计时 / countdown modes
  //  --------------------------------------------------------------------------
  //
  //  倒计时与正计时是**两套独立的账**：各自的状态、记录表、面板与统计，互不混用。下面的字段只
  //  属于倒计时，正计时的 `manual*` 字段一个也不读它们。
  //
  //  The countdown and the count-up are two **separate ledgers**: their own state, their own
  //  records table, their own panel and their own statistics. The fields below belong to the
  //  countdown only; no `manual*` field reads any of them.

  /** 倒计时功能开关 / countdown feature toggle */
  countdownTimerEnabled: boolean;
  /** 'down' | 'pomodoro' | 'interval' */
  countdownMode: CountdownMode;
  /** 倒计时模式的分钟数 / minutes for a plain countdown */
  countdownMinutes: number;
  /** 番茄钟专注分钟 / pomodoro focus minutes */
  countdownFocusMinutes: number;
  /** 番茄钟休息分钟 / pomodoro break minutes */
  countdownBreakMinutes: number;
  /** 番茄钟重复的轮数 / pomodoro cycles when repeating */
  countdownCycles: number;
  /** 番茄钟是否重复（关闭＝单周期）/ whether pomodoro repeats; off means a single cycle */
  countdownRepeat: boolean;
  /** 不规则周期的各段分钟数 / minutes per phase for the irregular mode */
  countdownIntervals: number[];
  /**
   * 自动跑完最后一段时是否询问备注 / whether finishing the last phase asks for a note.
   *
   * 默认关闭：跑完直接保存（备注为空）并给一条提示。开启后弹出备注框，取消也算保存 ——
   * 一段已经走完的专注不该因为没写备注就消失。
   *
   * Off by default: the run saves itself with an empty note and says so. On: a note dialog
   * opens, and cancelling still saves — completed focus must not vanish for want of a note.
   */
  countdownPromptNote: boolean;

  /**
   * 设备独立设置 / settings kept per device.
   *
   * 关（默认）：设置写进数据旁边的共享文件，随 vault 同步，各设备用同一套口径。
   * 开：只写本机的 data.json，各设备各用各的。
   *
   * Off (default): settings go into a shared file beside the data and travel with the vault, so
   * every device reads the data by the same rules. On: only this device's data.json is written and
   * each device keeps its own.
   */
  perDeviceSettings: boolean;
}

//  ============================================================================
// Sessions & records
//  ============================================================================

/**
 * State values stored in a sessionObject.
 *
 * `inactive` is new: written while the window is unfocused. It keeps blur stretches out
 * of the active total, since `calculateSessionDuration` only counts `tracking` — which
 * fixes the original's bug of counting blur stretches as active time.
 */
export type SessionState = 'tracking' | 'pausing' | 'saved' | 'inactive' | 'idle';

/**
 * Session timeline object.
 */
export type SessionStateMap = Record<string, SessionState>;

/** A paused range as [startMs, endMs]. */
export type PausedRange = [number | null, number];

/** Per-file timer state. */
export interface TimerFileState {
  filePath: string;
  status: FileStatus;
  sessionStartTime: string | null;

  /**
   * single source of truth: pure active seconds.
   * The original kept an additional `accumulatedSeconds` (wall clock, incl. pauses);
   * the two were not identical. Merged here into active + paused, with wall clock derived.
   */
  activeSeconds: number;

  /**
   * single source of truth: accumulated paused seconds.
   * Reproduces the original rounding: floor(pauseDuration / 1000) added once on resume.
   */
  pausedSeconds: number;

  /**
   *
   * Behaviour change: the old implementation stopped counting on window blur and lost
   * that time entirely. Blur now keeps counting, banked here rather than in
   * `activeSeconds`, so in-window and out-of-window time stay separable.
   */
  unfocusedSeconds: number;

  /**
   * 有焦点但无输入的空闲秒数 / seconds of focused-but-no-input time.
   *
   * 以前这段被直接丢弃：TICK 在 isIdle 时提前返回，CLEAR_IDLE 又把基准重置，于是它既不是阅读也
   * 不是暂停，任何合计里都找不到。现在它是一条独立通道，按 `idlePolicy` 决定算作什么。
   *
   * This used to be discarded outright: TICK returned early while idle and CLEAR_IDLE reset the
   * baseline, so the stretch was neither reading nor paused and appeared in no total. It is now a
   * channel of its own, attributed by `idlePolicy`.
   *
   * 可选：旧快照与旧测试夹具没有这个字段，读作 0。
   * Optional: older snapshots and fixtures lack it; read as zero.
   */
  idleSeconds?: number;

  lastTickTimestamp: number | null;
  pauseStartTimestamp: number | null;
  sessionObject: SessionStateMap | null;
  pausedRanges: PausedRange[];

  /**
   * 用户明确丢弃过这一轮 / the user explicitly discarded a session on this file.
   *
   * 丢弃是一句明确的"这轮我不要了"，所以在这之后自动开始就是在推翻用户的动作。置位后
   * `shouldAutoStart` 对该文件一律返回 false，直到用户手动开始（或这文件又跑完保存一轮）。
   * 实测：丢弃 → 点到别处解绑 → 点回笔记，被 autoStartMode=always 拉起，读起来就是"丢弃后自动开始"。
   *
   * Discarding says "I do not want this round", so auto-starting afterwards would overrule the user.
   * Once set, `shouldAutoStart` returns false for that file until the user starts it by hand (or the
   * file completes a saved round). Measured: discard → click away (unbind) → click back, and
   * autoStartMode=always pulls it back up — which reads as "it restarts itself after a discard".
   */
  discardedByUser?: boolean;
  /** 手动保存后等待再次手动开始 / explicit save blocks automatic restart. */
  savedByUser?: boolean;
  /** 本轮分屏阅读 / split reading for this session only. */
  splitReading?: boolean;
}

/**
 * Derive reading seconds.
 * In-window plus out-of-window: both are real reading time, so both count.
 */
export function readingSeconds(file: TimerFileState): number {
  return file.activeSeconds + file.unfocusedSeconds;
}

/**
 * Derive wall-clock seconds.
 *
 * Extended by this refactor: unfocused time is part of the session's wall clock, so
 * wall = in-window + unfocused + paused. It differs from the original
 * `accumulatedSeconds` only by the unfocused part, which the original never recorded —
 * for pre-existing data `unfocusedSeconds` is 0 and the value is unchanged.
 */
export function wallClockSeconds(file: TimerFileState): number {
  return file.activeSeconds + file.unfocusedSeconds + (file.idleSeconds ?? 0) + file.pausedSeconds;
}

/** 未结算暂停也参与显示和保存 / include an ongoing pause in display and save. */
export function liveWallClockSeconds(file: TimerFileState, nowMs: number): number {
  const pending = file.status === 'paused' && file.pauseStartTimestamp !== null
    ? Math.max(0, Math.floor((nowMs - file.pauseStartTimestamp) / 1000)) : 0;
  return wallClockSeconds(file) + pending;
}

//  ============================================================================
// Manual timer
//  ============================================================================

/**
 * Manual-timer state.
 *
 * Independent of document tracking: bound to no file, not part of `activeFilePath`, and
 * unaffected by the document filter rules. It only answers "since when have I been
 * focusing on something, and for how long".
 */
export interface ManualTimerState {
  status: ManualStatus;
  /** start timestamp in ms, null when idle */
  startTimestamp: number | null;
  /** local full timestamp string for persistence */
  startedAt: string;
  /**
   * accumulated paused milliseconds.
   * Milliseconds rather than seconds so repeated short pauses do not lose precision.
   */
  pausedMs: number;
  /** start of the current pause, null when not paused */
  pauseStartTimestamp: number | null;
  /** 本段暂停的起点（本地全时间串），与上面那个毫秒值同时设置 / local timestamp of the current pause */
  pauseStartFull: string;
  /**
   * 已结束的暂停区间 / pauses that have already ended.
   * 总暂停毫秒数（`pausedMs`）说明停了多久，这里说明**停在哪一段** —— 热力图要画暂停块就必须知道
   * 位置，光有一个总数是画不出来的。
   * `pausedMs` says how long; this says *where*, which is what a heatmap needs to place a block.
   */
  pauses: ManualPause[];
  /**
   * marks placed during this run.
   * Saved with the session on stop; `MANUAL_START` clears it, so each run starts empty.
   */
  flags: ManualFlag[];
}

/**
 * One mark placed during manual timing.
 *
 * A mark records the net seconds (pauses excluded) since the run began, at the instant it
 * was placed — not a wall-clock time. The session is measured in net seconds, and a
 * wall-clock mark would drift out of step with it.
 */
export interface ManualFlag {
  /** net seconds since the run began */
  atSeconds: number;
  /** when it was placed, local full timestamp */
  atTime: string;
  /** optional label, may be empty */
  label: string;
  /**
   * 打标记那一刻的净毫秒 / net milliseconds at the moment it was placed.
   * 旧数据没有它，按 `atSeconds × 1000` 读。
   * Absent in older data; read it as `atSeconds × 1000`.
   */
  atMs?: number;
  /**
   * 倒计时专用：是在第几段打的标记（从 1 起）/ countdown only: which phase it was placed in.
   * 正计时的标记没有段可指，留空。
   * A count-up mark has no phase to point at, so it stays empty.
   */
  phase?: number;
}

/** 一段暂停的起止 / one pause, by wall clock. */
export interface ManualPause {
  /** 暂停开始 / when the pause began */
  from: string;
  /** 恢复 / when it ended */
  to: string;
}

/**
 * A completed manual session.
 * The unit of persistence; `note` is what the user fills in after stopping.
 */
export interface ManualSession {
  id: string;

  startTime: string;
  endTime: string;

  durationSeconds: number;

  /**
   * 净毫秒 / net milliseconds.
   *
   * 计算与显示都以它为准，`durationSeconds` 是它的整秒投影（统计仍按秒汇总）。旧记录没有这个
   * 字段，读作 `durationSeconds × 1000` —— 秒级的旧数据本来也只有那么多信息。
   *
   * The authoritative figure; `durationSeconds` is its whole-second projection, since totals still
   * roll up in seconds. Older records lack it and are read as `durationSeconds × 1000` — second-level
   * data never had more information than that.
   */
  durationMs?: number;

  /** what the user wrote, may be empty */
  note: string;

  flags: ManualFlag[];
  /**
   * 本轮的暂停区间 / this run's pauses, in order.
   * 只存总暂停毫秒数的话，热力图上无处落笔 —— 它是"多久"，不是"哪里"。
   * A total says how long, not where, and a heatmap needs where.
   */
  pauses: ManualPause[];
}

//  ============================================================================
// Countdown timer
//  ============================================================================

/** 三种倒计时模式 / the three countdown modes. */
export type CountdownMode = 'down' | 'pomodoro' | 'interval';

/**
 * 一段固定长度的计时 / one fixed-length phase.
 *
 * `kind` 只影响显示（专注／休息／第 N 段），不参与计时。
 * `kind` only affects the wording; it plays no part in timing.
 */
export interface CountdownPhase {
  kind: 'focus' | 'break' | 'segment';
  seconds: number;
}

/** 一次运行的完整方案 / the whole plan for one run. */
export interface CountdownPlan {
  mode: CountdownMode;
  phases: CountdownPhase[];
}

/**
 * 倒计时状态 / countdown state.
 *
 * 与 `ManualTimerState` 平行而不是复用：两者可以各自运行、各自暂停，共用一份状态就必然要加一个
 * "这是谁的"标志，而那正是会把两边搅在一起的地方。
 *
 * Parallel to `ManualTimerState` rather than shared: the two run and pause independently, and one
 * shared slice would need a "whose is this" flag — exactly the thing that would tangle them.
 */
export interface CountdownTimerState {
  status: ManualStatus;
  /** start timestamp in ms, null when idle */
  startTimestamp: number | null;
  /** local full timestamp for persistence */
  startedAt: string;
  /** accumulated paused milliseconds */
  pausedMs: number;
  /** start of the current pause, null when not paused */
  pauseStartTimestamp: number | null;
  /** local timestamp of the current pause */
  pauseStartFull: string;
  /** pauses that have already ended */
  pauses: ManualPause[];
  /** marks placed during this run */
  flags: ManualFlag[];
  /**
   * 本次运行解析好的方案 / the plan resolved when this run started.
   * 运行中改设置不碰它 —— 这正是"方案在开始时冻结"的实现。
   * Editing settings mid-run never touches it: that is what freezing the plan at start means.
   */
  plan: CountdownPlan | null;
}

/**
 * 一次已完成的倒计时 / a completed countdown run.
 *
 * 继承 `ManualSession`，所以 `manualTimeline` 的热力图、列表与统计函数可以直接用；多出来的四个
 * 字段说明这次是哪种倒计时、计划多久、有没有走完。
 *
 * Extends `ManualSession` so the manual timeline helpers (heatmap, list, totals) work on it
 * unchanged; the four extra fields say which mode it was, how long it planned to run, and whether
 * it got there.
 */
export interface CountdownSession extends ManualSession {
  mode: CountdownMode;
  /** planned length in seconds */
  plannedSeconds: number;
  /** whether the last phase finished on its own */
  completed: boolean;
  /** the plan's phases, so an old session still explains itself */
  phases: CountdownPhase[];
}

//  ============================================================================
// Pending writes
//  ============================================================================

/** A new session started. */
export interface TimelineStartWrite {
  type: 'timeline-start';
  filePath: string;
  time: string;
  state: string;
}

/** A session was discarded. */
export interface TimelineDiscardWrite {
  type: 'timeline-discard';
  filePath: string;
  time: string;
}

/** A session was saved. */
export interface SessionWrite {
  type: 'session';
  filePath: string;
  session: SessionStateMap;
  /**
   * which event type to write on flush.
   *
   * `save` is an explicit user save; `auto-save` is an automatic close (tab switch or
   * close, day rollover, startup recovery). Real data contains both (5 save / 23
   * auto-save), and the heatmap renders them differently, so the caller states it rather
   * than leaving the service to guess.
   */
  eventType: 'save' | 'auto-save';
  /** in-window seconds, added to records */
  activeSeconds: number;
  /** out-of-window seconds, accumulated separately */
  unfocusedSeconds: number;
  /** focused-but-idle seconds, accumulated separately / 有焦点但无输入的秒数 */
  idleSeconds?: number;
  /** wall clock, written as event.duration */
  totalSeconds: number;
}

export type PendingWrite = TimelineStartWrite | TimelineDiscardWrite | SessionWrite;

//  ============================================================================
// Global timer state
//  ============================================================================

/**
 * The single state tree managed by the reducer.
 *
 * Document tracking and the manual timer share this tree but are data-independent: no
 * field references the other, and the manual timer never touches activeFilePath. One
 * tree means one persistence and subscription path; the service layer stays split.
 */
export interface TimerState {
  activeFilePath: string | null;
  files: Map<string, TimerFileState>;
  /**
   * 没有"全局暂停中"这个标志 / there is deliberately no global paused flag.
   *
   * 暂停是**会话**的属性（`TimerFileState.status`），而同时只可能有一个会话在跑，所以在状态树里再存
   * 一份只会多出一个能被写脏的地方：实测「暂停 → 丢弃 → 重新开始」之后，那份标志留在 true 上，TICK
   * 于是每次都提前返回，计时停在 0 秒不动，直到再手动暂停/继续一次才恢复。
   *
   * Pausing is a property of the *session* (`TimerFileState.status`), and only one session runs at a
   * time, so a second copy in the state tree only adds somewhere for it to go stale. Measured: after
   * pause → discard → start, that copy stayed true, every tick returned early, and the clock sat at
   * 0 seconds until the user toggled pause twice by hand.
   */
  isIdle: boolean;
  /**
   * whether the Obsidian window is focused.
   * Counting does not stop on blur — it flows into `unfocusedSeconds`. Starts focused.
   */
  isWindowFocused: boolean;
  /** manual-timer state, unrelated to files */
  manual: ManualTimerState;
  /** countdown state, unrelated to files and to `manual` */
  countdown: CountdownTimerState;
  lastActivityTime: number;
  lastTickTime: number | null;
  /** used for day-rollover detection */
  lastCheckDay: string;
  pendingWrites: PendingWrite[];
}

//  ============================================================================
//  Action
//  ============================================================================

/**
 *
 * Note: the original carried `currentTime` in TICK / TOGGLE_PAUSE payloads while also
 * calling Date.now() directly inside the reducer, which made deterministic replay
 * impossible. Time now comes solely from the injected clock; payloads no longer carry
 * it. Internal contract change only — the observable behaviour is unchanged.
 */
export interface TogglePausePayload {
  filePath: string;
}
export interface TickPayload {
  filePath: string;
}

/**
 * Discriminated union of every action.
 *
 * PAUSE_SESSION /
 *
 * Versus the original: dropped 4 declared-but-unimplemented constants; renamed
 * CLEAR_PENDING_WRITES to CONSUME_PENDING_WRITES (consume N from the head, which is
 * what removes the concurrent double-write); added REQUEUE_PENDING_WRITES so a failed
 * flush no longer silently drops events.
 */
export type TimerAction =
  | { type: Extract<ActionType, 'TICK'>; payload: TickPayload }
  | { type: Extract<ActionType, 'TOGGLE_PAUSE'>; payload: TogglePausePayload }
  | {
      type: Extract<ActionType, 'SWITCH_FILE'>;
      payload: { fromPath: string | null; toPath: string; autoStart: boolean };
    }
  | {
      type: Extract<ActionType, 'SAVE_SESSION'>;
      payload: {
        filePath: string;
        minReadSeconds: number;

        eventType?: 'save' | 'auto-save';
      };
    }
  | { type: Extract<ActionType, 'DISCARD_SESSION'>; payload: { filePath: string } }
  | { type: Extract<ActionType, 'USER_ACTIVITY'> }
  | { type: Extract<ActionType, 'SET_IDLE'> }
  | { type: Extract<ActionType, 'CLEAR_IDLE'> }
  | {
      type: Extract<ActionType, 'DAY_ROLLOVER'>;
      payload: { filePath: string | null };
    }
  | {
      type: Extract<ActionType, 'RESTORE_FILE'>;
      payload: { filePath: string; fileState: TimerFileState };
    }
  | {
      type: Extract<ActionType, 'CONSUME_PENDING_WRITES'>;
      payload: { count: number };
    }
  | {
      type: Extract<ActionType, 'REQUEUE_PENDING_WRITES'>;
      payload: { writes: PendingWrite[] };
    }
  //  --------------------------------------------------------------------------
  // New in this refactor
  //  --------------------------------------------------------------------------
  | {
      type: Extract<ActionType, 'SET_WINDOW_FOCUS'>;
      payload: { focused: boolean };
    }
  | { type: Extract<ActionType, 'SET_SPLIT_READING'>; payload: { filePath: string; enabled: boolean } }
  | { type: Extract<ActionType, 'UNBIND_FILE'> }
  | { type: Extract<ActionType, 'MANUAL_START'> }
  | { type: Extract<ActionType, 'MANUAL_PAUSE'> }
  | { type: Extract<ActionType, 'MANUAL_RESUME'> }
  | { type: Extract<ActionType, 'MANUAL_STOP'> }
  | {
      type: Extract<ActionType, 'MANUAL_FLAG'>;
      payload: { atSeconds: number; atTime: string; label: string };
    }
  | {
      type: Extract<ActionType, 'COUNTDOWN_START'>;
      /** 方案在这里冻结 / the plan is frozen here */
      payload: { plan: CountdownPlan };
    }
  | {
      type: Extract<ActionType, 'MANUAL_RESTORE'>;
      /**
       * 恢复一份未保存的计时 / bring back an unsaved run.
       *
       * 时间戳由调用方算好：恢复出来是**暂停**态，且累计值等于快照那一刻的值 —— 应用关着的
       * 那段时间不算进去，否则"恢复"就等于凭空造出一段没发生过的专注。
       * The caller computes the timestamp: the run comes back **paused** with exactly the elapsed
       * value it had when snapshotted. Time while the app was closed is not counted — otherwise
       * "restore" would invent focus that never happened.
       */
      payload: {
        startTimestamp: number;
        startedAt: string;
        pausedMs: number;
        pauses: ManualPause[];
        flags: ManualFlag[];
      };
    }
  | {
      type: Extract<ActionType, 'COUNTDOWN_RESTORE'>;
      payload: {
        startTimestamp: number;
        startedAt: string;
        pausedMs: number;
        pauses: ManualPause[];
        flags: ManualFlag[];
        plan: CountdownPlan;
      };
    }
  | { type: Extract<ActionType, 'COUNTDOWN_PAUSE'> }
  | { type: Extract<ActionType, 'COUNTDOWN_RESUME'> }
  | { type: Extract<ActionType, 'COUNTDOWN_STOP'> }
  | {
      type: Extract<ActionType, 'COUNTDOWN_FLAG'>;
      payload: { atSeconds: number; atTime: string; label: string; phase: number };
    };

//  ============================================================================
// Persisted data shapes
//  ============================================================================

/** A per-file record entry. */
export interface RecordEntry {
  fileName: string;
  /** total reading time = in-window + out-of-window */
  totalReadTime: number;
  lastReadAt: string;
  /**
   * Optional: records written before this refactor lack it; read as 0.
   */
  unfocusedReadTime?: number;
}

/** Timeline event types. */
export type TimelineEventType =
  | 'activity'
  | 'start'
  | 'pause'
  | 'resume'
  | 'save'
  | 'auto-save'
  | 'discard'
  | 'blur'
  | 'focus'
  | 'idle'
  | 'idle-end'
  | 'switch';

/**
 * Events that hang off a single file.
 * Field combinations taken from the measured real data.
 */
export interface FileTimelineEvent {
  time: string;
  /** Full native view title, preserved at each activity boundary. */
  activityTitle?: string;
  type:
    | 'activity'
    | 'start'
    | 'pause'
    | 'resume'
    | 'save'
    | 'auto-save'
    | 'blur'
    | 'focus'
    | 'idle'
    | 'idle-end';
  file: string;
  state?: string;
  /** cause for blur/focus/idle events */
  reason?: string;
  /** wall-clock seconds on save events */
  duration?: number;
  /** in-window seconds on save events */
  activeSeconds?: number;

  unfocusedSeconds?: number;
  /** focused-but-idle seconds on save events / 保存事件上的空闲秒数 */
  idleSeconds?: number;
  /** 保留失焦来源，仅修改归属 / preserve blur provenance while changing attribution. */
  unfocusedDisposition?: 'reading' | 'paused' | 'unfocused';
}

/** A discarded session (no `state` field in real data). */
export interface DiscardTimelineEvent {
  time: string;
  type: 'discard';
  file: string;
  state?: string;
}

/** A file switch, keyed by from/to rather than file. */
export interface SwitchTimelineEvent {
  time: string;
  type: 'switch';
  from: string;
  to: string;
  fromState?: string;
  toState?: string;
}

export type TimelineEvent =
  | FileTimelineEvent
  | DiscardTimelineEvent
  | SwitchTimelineEvent;

/**
 * Derived per-file view model.
 *
 * Computed from the timeline on demand; never persisted (records holds only 3 fields).
 */
export interface FileRecord {
  fileName: string;
  /** total reading time = in-window + out-of-window */
  totalReadTime: number;
  /** out-of-window part, across ALL time — the counterpart of `totalReadTime` */
  unfocusedReadTime: number;
  readTimeToday: number;
  /**
   * Out-of-window part **today only** — the counterpart of `readTimeToday`.
   *
   * Needed because the two all-time figures and the two today figures are different scopes,
   * and a today-scoped view that pairs `readTimeToday` with the all-time `unfocusedReadTime`
   * can print a part larger than the whole ("today 5 min · out of window 2 h") as soon as the
   * vault has more than one day of history.
   */
  unfocusedReadTimeToday: number;
  lastReadAt: string;

  readTimeLine: SessionStateMap[];

  hasAbnormalSession: boolean;
}

/** The whole on-disk data file. */
export interface HistoryCache {
  version?: number;
  records: Record<string, RecordEntry>;
  timeline: TimelineEvent[];
  settings?: Partial<PluginSettings>;
}

/** replaces the original Notice side effect. */
export interface MigrationReport {
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
  recordsBefore: number;
  recordsAfter: number;
  timelineBefore: number;
  timelineAfter: number;
  /** events dropped for lacking a usable `time` */
  droppedMalformed: number;

  unknownEventTypes: string[];
}
