/**
 * Plugin entry point
 *
 * Assembly layer: wires the layered modules into an Obsidian plugin. No business logic
 * lives here.
 *
 * Layers:
 *
 * Key corrections over the old monolith:
 */

import { Platform, Notice, Plugin, TFile, type WorkspaceLeaf } from 'obsidian';

import { consoleLogger, silentLogger, type Logger } from './core/logger';
import { mergeSettings } from './core/settings';
import { createInitialState } from './core/reducer';
import type { PluginSettings } from './core/types';
import { ObsidianAdapter } from './data/adapter';
import type { HistoryStore } from './data/historyStore';
import { SqliteStore, resolveDatabasePath } from './data/SqliteStore';
import {
  pickDeviceLocal,
  readSharedSettings,
  SHARED_SETTINGS_PATH,
  writeSharedSettings,
} from './data/sharedSettings';
import { VolatileHistoryStore } from './data/VolatileHistoryStore';
import {
  readLiveSnapshot,
  writeLiveSnapshot,
  LIVE_SNAPSHOT_VERSION,
  type LiveSnapshot,
  type LiveTimerEntry,
} from './data/liveTimerSnapshot';
import { selectCountdownElapsedSeconds, selectManualElapsedSeconds } from './core/selectors';
import { ActionTypes, MANUAL_STATUS } from './core/constants';
import { TimerStore } from './services/TimerStore';
import { TimerService } from './services/TimerService';
import { ManualTimerService } from './services/ManualTimerService';
import { CountdownTimerService } from './services/CountdownTimerService';
import { buildCountdownPlan, countdownConfigFrom } from './core/countdown';
import { formatDurationWithSeconds } from './core/time';
import { systemClock } from './services/clock';
import { ActivitySidebarView, VIEW_TYPE_RTT_SIDEBAR } from './ui/SidebarView';
import { RecordsModal } from './ui/RecordsModal';
import { ConfirmModal } from './ui/ConfirmModal';
import { ManualNoteModal } from './ui/ManualNoteModal';
import { ReadTimeSettingTab } from './ui/SettingsTab';
import { installBindings, type Binding } from './ui/obsidianBinding';
import { StatusBarMetrics } from './ui/StatusBar';
import type { PanelId } from './core/statusMetrics';
import { t } from './core/i18n';

/** Fallback display path for the legacy data file when settings.dataFilePath is empty. */
const DEFAULT_LEGACY_PATH = 'Components/History/readTimeHistory.json';

export default class ReadTimeTrackerPlugin extends Plugin {
  /**
   * Plugin settings.
   *
   * Keep this public for compatibility with both older Plugin types and newer hosts.
   */
  settings!: PluginSettings;

  /** debug logging switch */
  private debug = false;

  private log: Logger = silentLogger;

  private sqlite: SqliteStore | null = null;
  private timerStore!: TimerStore;
  private timerService!: TimerService;
  private manualService!: ManualTimerService;
  private countdownService!: CountdownTimerService;
  /**
   * 自动收尾正在进行中 / an automatic finish is in flight.
   * 备注框开着的时候秒针还在走，没有这个闸门就会每秒弹一个框。
   * The second hand keeps running while the note dialog is open; without this gate it would open a
   * new dialog every second.
   */
  private countdownFinishing = false;

  /**
   * 上次重载留下的未保存计时 / unsaved runs left by the previous reload.
   * 读到之后一直留着，直到用户恢复或丢弃 —— 它不属于状态树，因为"还没被接上"本身就是它的状态。
   * Read once and kept until the user restores or discards: it is not part of the state tree because
   * "not yet picked up" is itself its state.
   */
  private pendingLive: LiveSnapshot | null = null;

  /** 快照写入节流 / throttle for snapshot writes. */
  private lastLiveWrite = 0;
  private lastLiveSignature = '';

  private binding: Binding | null = null;
  private statusBar: StatusBarMetrics | null = null;

  /**
   * the repository actually in use.
   * Normally `sqlite`; the in-memory implementation when degraded.
   */
  private history!: HistoryStore;

  private storageWarning: string | null = null;

  override async onload(): Promise<void> {
    this.debug = false;
    this.log = this.debug ? consoleLogger : silentLogger;

    await this.loadSettings();

    this.timerStore = new TimerStore(
      {
        now: () => systemClock.now(),
        nowFull: () => systemClock.nowFull(),
        today: () => systemClock.today(),
        log: this.log,
      },
      createInitialState({
        now: () => systemClock.now(),
        nowFull: () => systemClock.nowFull(),
        today: () => systemClock.today(),
        log: this.log,
      }),
    );

    //
    //  Storage degrades *explicitly* to the in-memory repository when the wasm is
    //  unreadable, and says so. A silent downgrade would let the user believe their
    //  sessions were saved until a restart proves otherwise.
    const adapter = new ObsidianAdapter(this);
    const dbPath = resolveDatabasePath(
      this.settings.dataFilePath,
      this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
    );
    this.sqlite = new SqliteStore(adapter, dbPath, this.log);

    //  落盘闸门：改动总是先落浏览器暂存，vault 文件只在这几个时机写。四个开关由用户自己权衡。
    //  The flush gate: every change is buffered in the browser first, and the vault file is written
    //  only at these moments. The four switches are the user's own tradeoff.
    this.sqlite.setFlushGate((trigger) => {
      switch (trigger) {
        case 'session-end':
          return this.settings.flushOnSessionEnd !== false;
        case 'interval':
          return this.settings.flushOnInterval === true;
        case 'quit':
          return this.settings.flushOnQuit !== false;
        default:

          //  合并刷盘这类没有时机的收尾：只暂存
          //  A coalesced flush with no moment attached: buffer only
          return false;
      }
    });

    let history: HistoryStore = this.sqlite;
    try {
      const init = await this.sqlite.init();
      this.log.info(
        '[RTT] 存储就绪 / storage ready:',
        init.created ? 'created' : `opened (${init.eventCount} events)`,
      );
    } catch (error) {
      this.log.warn('[RTT] SQLite 初始化失败 / SQLite init failed:', error);
      this.storageWarning =
        `存储不可用，本次记录不会保存 / Storage unavailable, nothing will be saved: ` +
        `${error instanceof Error ? error.message : String(error)}`;
      new Notice(
        'Documents Activity Tracker: storage unavailable — sessions will NOT be saved. ' +
          'Is sql-wasm.wasm next to main.js?',
        10000,
      );
      history = new VolatileHistoryStore();
    }
    this.history = history;

    this.timerService = new TimerService({
      isMobile: Platform.isMobile,
      store: this.timerStore,
      history,
      clock: systemClock,
      log: this.log,
      settings: () => this.settings,
      getActivePath: () => this.binding?.getActivePath() ?? null,
      getActiveTitle: () => this.binding?.getActiveTitle() ?? null,
      getOpenPaths: () => this.binding?.getOpenPaths() ?? [],
    });

    this.manualService = new ManualTimerService({
      store: this.timerStore,
      history,
      clock: systemClock,
      log: this.log,
      newId: () => this.newSessionId(),
    });

    this.countdownService = new CountdownTimerService({
      store: this.timerStore,
      history,
      clock: systemClock,
      log: this.log,
      newId: () => this.newSessionId(),
    });

    //  重载/崩溃前留下的那一轮：只读出来备着，**不自动恢复** —— 用户得自己决定要不要接上。
    //  A run left behind by a reload or a crash is read but **not** restored automatically: the user
    //  decides whether to pick it up.
    this.pendingLive = readLiveSnapshot();
    this.timerStore.subscribe(() => this.persistLiveSnapshot());

    if (this.pendingLive) {
      this.log.info('[RTT] 发现未保存的计时 / unsaved timers found:', this.pendingLive.savedAt);
      new Notice(t('recoveryNotice'), 12000);
    }

    this.binding = installBindings({
      mobileMultiWindow: () => this.settings.mobileMultiWindow === true,
      app: this.app,
      plugin: this,
      service: this.timerService,
      log: this.log,
      ownViewTypes: [VIEW_TYPE_RTT_SIDEBAR],
    });

    await this.timerService.recoverUnfinishedSessions();

    this.registerView(
      VIEW_TYPE_RTT_SIDEBAR,
      (leaf: WorkspaceLeaf) =>
        new ActivitySidebarView(leaf, {
          store: this.timerStore,
          history: this.history,
          clock: systemClock,
          log: this.log,
          settings: () => this.settings,
          service: this.timerService,
          manual: this.manualService,
          countdown: this.countdownService,
          recovery: {
            pending: (kind) => (kind === 'manual' ? this.pendingLive?.manual : this.pendingLive?.countdown) ?? null,
            restore: () => this.restorePendingLive(),
            discard: () => this.discardPendingLive(),
          },
          storageWarning: () => this.storageWarning,
          promptNote: (onDone) => new ManualNoteModal(this.app, onDone).open(),
          openRecords: (filePath) => this.openRecords(filePath),
          saveSetting: (patch) => this.updateSettings(patch),
        }),
    );

    this.addRibbonIcon('activity', t('openSidebar'), () => {
      void this.activateSidebar();
    });

    // Status bar (bottom right). Built after the binding so the first paint already has a
    // live store to read.
    this.statusBar = new StatusBarMetrics({
      el: this.addStatusBarItem(),
      store: this.timerStore,
      history: this.history,
      clock: systemClock,
      settings: () => this.settings,
      log: this.log,
      openPanel: (panel) => {
        void this.openPanel(panel);
      },
    });
    this.statusBar.start();

    //  定时批量写：按分钟粒度走，间隔随时反映设置的改动，不必重建定时器
    //  Periodic flush: checked at minute granularity so a change to the interval takes effect at
    //  once, with no timer rebuild.
    let minutesSinceFlush = 0;
    this.registerInterval(
      window.setInterval(() => {
        if (this.settings.flushOnInterval !== true) {
          minutesSinceFlush = 0;
          return;
        }
        minutesSinceFlush += 1;
        const every = Math.max(1, this.settings.flushIntervalMinutes ?? 5);
        if (minutesSinceFlush >= every) {
          minutesSinceFlush = 0;
          void this.history.flushNow({ trigger: 'interval' });
        }
      }, 60_000),
    );

    //  倒计时跑完最后一段要自己收尾：秒针仍然是墙钟推导的，但"跑完了"这件事得有人每秒问一次。
    //  放在这里而不是侧栏里：侧栏关着的时候倒计时照样要走完并存下来。
    //  A countdown that finishes its last phase has to settle itself. The seconds stay wall-clock
    //  derived, but "it is over" needs someone to ask once a second — and it lives here rather than
    //  in the sidebar, so a closed sidebar cannot swallow the finish.
    this.registerInterval(
      window.setInterval(() => {
        this.checkCountdownFinish();

        //  快照兜底：状态没变也要定期刷新已计时 / a periodic refresh even when nothing changed
        this.persistLiveSnapshot();
      }, 1000),
    );

    this.addSettingTab(
      new ReadTimeSettingTab(this.app, this, {
        settings: () => this.settings,
        save: (patch) => this.updateSettings(patch),
        databasePath: () => this.sqlite?.path ?? dbPath,
        legacyPath: () => this.legacyPath(),
      }),
    );

    // commands ─────────────────────────────────────────────────
    this.addCommand({
      id: 'open-sidebar',
      name: t('openSidebar'),
      callback: () => {
        void this.activateSidebar();
      },
    });

    this.addCommand({
      id: 'toggle-pause',
      name: t('pause'),
      checkCallback: (checking) => {
        if (!this.hasActiveSession()) return false;
        if (!checking) void this.timerService.togglePause();
        return true;
      },
    });

    this.addCommand({
      id: 'save-session',
      name: t('btnSave'),
      checkCallback: (checking) => {
        if (!this.hasActiveSession()) return false;
        if (!checking) void this.timerService.saveCurrent('save');
        return true;
      },
    });

    this.addCommand({
      id: 'discard-session',
      name: t('btnDiscard'),
      checkCallback: (checking) => {
        if (!this.hasActiveSession()) return false;
        if (!checking) void this.timerService.discardCurrent();
        return true;
      },
    });

    //  The old build had a `view-all-records` command whose body was a single
    //  "not implemented yet" Notice. It is wired to a real panel here.
    // 命令面板与数据看板都能触发：谁也不敢保证意外关闭不会丢会话，用户需要一个自己能按的
    // "现在就写盘"。
    // Reachable from the palette and from the records browser: an unexpected shutdown cannot be
    // ruled out, so the user needs a "write it now" they can press themselves.
    this.addCommand({
      id: 'save-records',
      name: t('manualSave'),
      callback: () => this.confirmAndSave(),
    });

    this.addCommand({
      id: 'view-all-records',
      name: t('cmdAllRecords'),
      callback: () => this.openRecords(null),
    });

    this.addCommand({
      id: 'view-file-records',
      name: t('cmdFileRecords'),
      checkCallback: (checking) => {
        const path = this.app.workspace.getActiveFile()?.path ?? null;
        if (!path) return false;
        if (!checking) this.openRecords(path);
        return true;
      },
    });

    this.addCommand({
      id: 'manual-start',
      name: t('manualStart'),
      checkCallback: (checking) => {
        if (!this.settings.manualTimerEnabled) return false;
        if (!checking) this.manualService.start();
        return true;
      },
    });

    //  恢复入口放在命令面板：即便侧栏关着、面板没打开，也能把上次没保存的那一轮接回来
    //  The restore entry lives in the palette so a run can be picked up even with the sidebar closed
    this.addCommand({
      id: 'recover-timer',
      name: t('cmdRecoverTimer'),
      checkCallback: (checking) => {
        if (!this.hasPendingLive()) return false;
        if (!checking) this.restorePendingLive();
        return true;
      },
    });

    this.addCommand({
      id: 'countdown-start',
      name: t('countdownStart'),
      checkCallback: (checking) => {
        if (this.settings.countdownTimerEnabled === false) return false;
        if (!checking) {
          this.countdownService.start(
            buildCountdownPlan(countdownConfigFrom(this.settings)),
          );
        }
        return true;
      },
    });

    this.addCommand({
      id: 'countdown-stop',
      name: t('countdownStop'),
      checkCallback: (checking) => {
        if (!this.countdownService.isActive()) return false;
        if (!checking) {
          new ManualNoteModal(this.app, (note) => {
            if (note === null) return;
            void this.countdownService.stop(note);
          }).open();
        }
        return true;
      },
    });

    this.addCommand({
      id: 'manual-stop',
      name: t('manualStop'),
      checkCallback: (checking) => {
        if (!this.manualService.isActive()) return false;
        if (!checking) {
          new ManualNoteModal(this.app, (note) => {
            if (note === null) return;
            void this.manualService.stop(note);
          }).open();
        }
        return true;
      },
    });

    //
    //  The sidebar auto-opens once, right after install; the flag lives in localStorage
    //  rather than settings so the settings contract stays clean. The flag is written only
    //  once the open actually succeeded — otherwise a first attempt that fails because the
    //  layout is not ready yet would never be retried.
    //
    //  Plain `window.localStorage` rather than `app.loadLocalStorage`, which is @since
    //  1.8.7 while this plugin declares minAppVersion 1.7.2. The flag is cosmetic — if the
    //  store is unavailable the worst case is one extra auto-open — so it is not worth
    //  raising the install floor for.
    this.app.workspace.onLayoutReady(() => {
      const HINT_KEY = 'rtt_sidebar_hint_shown';
      try {
        if (window.localStorage.getItem(HINT_KEY)) return;
      } catch (error) {
        this.log.warn('[RTT] 侧栏首次提示读取失败 / hint read failed:', error);
        return;
      }

      void this.activateSidebar().then((opened) => {
        if (!opened) return;
        try {
          window.localStorage.setItem(HINT_KEY, '1');
        } catch (error) {
          this.log.warn('[RTT] 侧栏首次提示写入失败 / hint write failed:', error);
        }
      });
    });
  }

  /**
   * Unload.
   * Exactly one definition: the old monolith declared two, the later shadowing the
   * former, so the timer service was never destroyed.
   */
  override async onunload(): Promise<void> {
    try {
      this.statusBar?.stop();
      this.statusBar = null;
      this.binding?.destroy();
      this.binding = null;
      await this.timerService?.shutdown();
      await this.sqlite?.close();
    } catch (error) {
      this.log.warn('[RTT] 卸载收尾失败 / unload cleanup failed:', error);
    }
  }

  //  ==========================================================================
  // settings
  //  ==========================================================================

  private async loadSettings(): Promise<void> {
    try {
      const local = await this.loadData();
      let settings = mergeSettings(local);

      //  默认共用一套设置：设置随 vault 走，各设备才用同一套口径读同一批数据。
      //  引导键（数据路径、这个开关本身）只认本机 —— 它们决定去哪读、读不读，被对方覆盖就会互相踢。
      //
      //  Shared settings by default: they travel with the vault, so every device reads the same data
      //  by the same rules. The bootstrap keys (the data path and this switch) stay local — they
      //  decide where to read and whether to read at all, and letting the other device override them
      //  would have the two kick each other around.
      if (settings.perDeviceSettings !== true) {
        const path = SHARED_SETTINGS_PATH;
        const shared = await readSharedSettings(this.app.vault.adapter, path);
        if (shared) {
          settings = mergeSettings({ ...shared, ...pickDeviceLocal(local) });
        } else {

          //  第一次：把本机这份写出去，别的设备以后就有得读了
          //  First run: publish this device's settings so the others have something to read
          try {
            await writeSharedSettings(
              this.app.vault.adapter,
              path,
              settings as unknown as Record<string, unknown>,
            );
          } catch (error) {
            this.log.warn('[RTT] 共享设置写出失败 / failed to publish shared settings:', error);
          }
        }
      }

      this.settings = settings;
    } catch (error) {
      console.error('[RTT] 设置加载失败，使用默认值 / settings load failed:', error);
      this.settings = mergeSettings(null);
    }
  }

  /** persist a settings patch and apply it now. */
  private async updateSettings(patch: Partial<PluginSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await this.saveData(this.settings);

    //  共用设置时同时写一份到数据旁边，别的设备下次启动就能拿到同一套口径。
    //  When settings are shared, keep the copy beside the data in step, so the other device picks up
    //  the same rules on its next start.
    if (this.settings.perDeviceSettings !== true) {
      try {
        await writeSharedSettings(
          this.app.vault.adapter,
          SHARED_SETTINGS_PATH,
          this.settings as unknown as Record<string, unknown>,
        );
      } catch (error) {
        this.log.warn('[RTT] 共享设置写入失败 / failed to write shared settings:', error);
      }
    }

    //  Turning document tracking off must actually stop it, or the timer keeps counting
    //  in the background with no UI to show it.
    if (patch.documentTrackingEnabled === false) {
      await this.timerService.saveCurrent('auto-save');
    }
    if (patch.manualTimerEnabled === false) {
      this.manualService.discard();
    }
    if (patch.countdownTimerEnabled === false) {
      this.countdownService.discard();
    }

    //  设置必须**立即**生效，而不是等下一次切换标签页。
    //
    //  每一处设置都被读在行为发生的那一刻：过滤规则决定这个文件还算不算可追踪、自动开始模式决定换
    //  文件要不要开表、失焦口径决定时间进哪一本账。可绑定关系只在 active-leaf-change / file-open 上
    //  重建，而改设置不发这两种事件 —— 实测：把一个文件加进黑名单后它照样继续计时，直到手动切一次
    //  标签页；那正是「设置不立即生效」的来源。所以这里无条件重算绑定并刷新侧栏（onActivePathChange
    //  在 from === to 时自己提前返回，重复调用是安全的）。
    //
    //  Settings must take effect **now**, not at the next tab switch.
    //
    //  Every one of them is read at the moment behaviour happens: filter rules decide whether a file
    //  is trackable at all, auto-start mode decides whether opening it starts a clock, the unfocused
    //  rule decides which ledger time lands in. But the binding is only rebuilt on active-leaf-change /
    //  file-open, and editing settings fires neither. Measured: adding a file to the blacklist left it
    //  still counting until the user switched tabs by hand — that is where "settings do not take effect
    //  immediately" comes from. So the binding is re-aligned and the sidebar refreshed unconditionally
    //  here (onActivePathChange early-returns when from === to, so calling it again is safe).
    await this.timerService.onActivePathChange();
    this.refreshSidebar();
  }

  private legacyPath(): string {
    const configured = (this.settings?.dataFilePath ?? '').trim();
    return configured || DEFAULT_LEGACY_PATH;
  }

  //  ==========================================================================
  // views
  //  ==========================================================================

  /**
   * reveal the sidebar, creating the leaf if needed.
   *
   * whether the sidebar is now open
   */
  private async activateSidebar(): Promise<boolean> {
    try {
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_RTT_SIDEBAR);
      if (existing.length > 0) {
        await this.app.workspace.revealLeaf(existing[0]!);
        return true;
      }

      //  `ensureSideLeaf` gets the right sidebar, creating it when absent. The earlier
      //  `getRightLeaf(false)` returns null when the right sidebar has never been expanded,
      //  so the first open failed silently — measured: no sidebar on first load, success
      //  when called by hand.
      await this.app.workspace.ensureSideLeaf(VIEW_TYPE_RTT_SIDEBAR, 'right', {
        active: true,
        reveal: true,
      });
      return true;
    } catch (error) {
      this.log.warn('[RTT] 打开侧栏失败 / failed to open sidebar:', error);
      return false;
    }
  }

  /**
   * 先确认，再保存 / confirm, then save.
   *
   * 保存会结束当前会话并把所有计时器停下来，属于不可撤销的动作，所以必须先问一次。
   * Saving ends the running session and stops every timer, which cannot be undone, so it asks
   * first.
   */
  private confirmAndSave(): void {
    new ConfirmModal(this.app, {
      title: t('manualSave'),
      message: t('manualSaveConfirm'),
      confirmText: t('saveRecordsNow'),
      cancelText: t('cancel'),
      onConfirm: () => {
        void this.saveAllRecords();
      },
    }).open();
  }

  /**
   * 倒计时跑完的最后一段 / the countdown's last phase finished.
   *
   * 备注开关关着（默认）就直接保存并提示；开着就弹备注框，**取消也保存** —— 这一段已经跑完了，
   * 没写备注不该成为丢掉它的理由。
   *
   * With the note toggle off (the default) the run saves itself and says so. With it on, a note
   * dialog opens and cancelling still saves: the stretch already happened, and not writing a note is
   * no reason to throw it away.
   */
  private checkCountdownFinish(): void {
    if (this.countdownFinishing) return;
    if (this.settings.countdownTimerEnabled === false) return;
    if (!this.countdownService.isComplete()) return;

    this.countdownFinishing = true;

    const finish = (note: string): void => {
      void this.countdownService
        .stop(note)
        .then((session) => {
          if (!session) return;
          new Notice(
            t('countdownFinishedNotice').replace(
              '{time}',
              formatDurationWithSeconds(session.durationSeconds),
            ),
            5000,
          );
        })
        .finally(() => {
          this.countdownFinishing = false;
        });
    };

    if (this.settings.countdownPromptNote === true) {
      new ManualNoteModal(this.app, (note) => {
        finish(note ?? '');
      }).open();
    } else {
      finish('');
    }
  }

  //  ==========================================================================
  // 未保存计时的临时快照与恢复 / live snapshot and recovery
  //  ==========================================================================

  /**
   * 把正在跑的计时写进 localStorage / write the running timers to localStorage.
   *
   * 触发点是状态树订阅：正计时与倒计时的子状态只在它们自己的动作里换对象，TICK 每秒换的是整棵
   * 树，所以"子状态引用变了"就是"真的有事发生"。再加上五秒兜底，崩溃最多丢五秒。
   *
   * Driven by the store subscription: the two sub-states only change identity on their own actions,
   * while TICK replaces the root every second — so "reference changed" means "something happened".
   * A five-second fallback caps a crash at five lost seconds.
   */
  private persistLiveSnapshot(): void {
    try {
      const state = this.timerStore.getState();
      const now = systemClock.now();

      const active = state.manual.status !== MANUAL_STATUS.IDLE
        || state.countdown.status !== MANUAL_STATUS.IDLE;
      const signature = [
        state.manual.status,
        state.manual.flags.length,
        state.manual.pauses.length,
        state.countdown.status,
        state.countdown.flags.length,
        state.countdown.pauses.length,
      ].join('|');

      //  空闲且没有待恢复的残留：不必再写
      //  Idle with nothing pending: nothing to write
      if (!active && !this.hasPendingLive()) {
        if (this.lastLiveSignature !== '') {
          writeLiveSnapshot(null);
          this.lastLiveSignature = '';
        }
        return;
      }
      if (signature === this.lastLiveSignature && now - this.lastLiveWrite < 5000) return;

      this.lastLiveSignature = signature;
      this.lastLiveWrite = now;

      const manual: LiveTimerEntry | undefined = state.manual.status !== MANUAL_STATUS.IDLE
        ? {
            startedAt: state.manual.startedAt,
            elapsedMs: selectManualElapsedSeconds(state, now) * 1000,
            pausedMs: state.manual.pausedMs,
            pauses: state.manual.pauses,
            flags: state.manual.flags,
            running: state.manual.status === MANUAL_STATUS.RUNNING,
          }
        : this.pendingLive?.manual;

      const countdown = state.countdown.status !== MANUAL_STATUS.IDLE && state.countdown.plan
        ? {
            startedAt: state.countdown.startedAt,
            elapsedMs: selectCountdownElapsedSeconds(state, now) * 1000,
            pausedMs: state.countdown.pausedMs,
            pauses: state.countdown.pauses,
            flags: state.countdown.flags,
            running: state.countdown.status === MANUAL_STATUS.RUNNING,
            plan: state.countdown.plan,
          }
        : this.pendingLive?.countdown;

      writeLiveSnapshot({
        version: LIVE_SNAPSHOT_VERSION,
        savedAt: now,
        ...(manual ? { manual } : {}),
        ...(countdown ? { countdown } : {}),
      });
    } catch (error) {
      this.log.warn('[RTT] 临时快照写入失败 / snapshot write failed:', error);
    }
  }

  /** 有没有待恢复的计时 / whether anything is waiting to be restored. */
  private hasPendingLive(): boolean {
    return !!(this.pendingLive?.manual || this.pendingLive?.countdown);
  }

  /**
   * 恢复待处理的计时 / bring the pending runs back.
   *
   * 恢复成**暂停**、累计值等于快照那一刻：应用关着的时间不算进去，否则恢复等于凭空造一段专注。
   * Restored **paused** at the snapshotted elapsed; time while the app was closed is not counted,
   * or restoring would invent focus that never happened.
   */
  private restorePendingLive(): void {
    const pending = this.pendingLive;
    if (!pending) return;

    const now = systemClock.now();
    try {
      if (pending.manual) {
        const entry = pending.manual;
        this.timerStore.dispatch({
          type: ActionTypes.MANUAL_RESTORE,
          payload: {
            startTimestamp: now - Math.round(entry.elapsedMs) - entry.pausedMs,
            startedAt: entry.startedAt,
            pausedMs: entry.pausedMs,
            pauses: entry.pauses,
            flags: entry.flags,
          },
        });
      }

      if (pending.countdown) {
        const entry = pending.countdown;
        this.timerStore.dispatch({
          type: ActionTypes.COUNTDOWN_RESTORE,
          payload: {
            startTimestamp: now - Math.round(entry.elapsedMs) - entry.pausedMs,
            startedAt: entry.startedAt,
            pausedMs: entry.pausedMs,
            pauses: entry.pauses,
            flags: entry.flags,
            plan: entry.plan,
          },
        });
      }

      this.pendingLive = null;
      new Notice(t('recoveryRestored'), 6000);
      this.persistLiveSnapshot();
      this.refreshSidebar();
    } catch (error) {
      this.log.warn('[RTT] 恢复未保存计时失败 / restore failed:', error);
      new Notice(String(error), 6000);
    }
  }

  /** 丢弃待恢复的计时 / drop the pending runs. */
  private discardPendingLive(): void {
    this.pendingLive = null;
    writeLiveSnapshot(null);
    this.lastLiveSignature = '';
    this.refreshSidebar();
  }

  /**
   * 保存记录并把计时器归位 / write everything down and settle the timers.
   *
   * 文档会话直接落盘（保存即结束），手动计时只**暂停**而不是丢弃 —— 那一段是真实发生的专注时间，
   * 丢掉才是数据损失。
   * The document session is closed by saving; the manual timer is only *paused*, never
   * discarded — that stretch really happened and throwing it away would be the data loss.
   */
  private async saveAllRecords(): Promise<void> {
    try {
      if (this.hasActiveSession()) {
        await this.timerService.saveCurrent('save');
      }
      if (this.manualService.isActive()) {
        this.manualService.pause();
      }
      //  倒计时同理：暂停而不是丢弃 / the countdown likewise: pause, never discard
      if (this.countdownService.isActive()) {
        this.countdownService.pause();
      }
      await this.history.flushNow({ force: true });
      this.refreshSidebar();
      new Notice(t('recordsSaved'), 3000);
      this.log.info('[RTT] 手动保存记录 / manual save completed');
    } catch (error) {
      this.log.warn('[RTT] 手动保存失败 / manual save failed:', error);
      new Notice(String(error), 6000);
    }
  }

  /**
   * Reveal the sidebar on a given panel / 打开侧栏并切到指定面板.
   * The status bar's items use this so a duration leads to the panel it belongs to.
   */
  private async openPanel(panel: PanelId): Promise<void> {
    try {
      const opened = await this.activateSidebar();
      if (!opened) return;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RTT_SIDEBAR)) {
        const view = leaf.view;
        if (view instanceof ActivitySidebarView) view.showPanel(panel);
      }
    } catch (error) {
      this.log.warn('[RTT] 打开面板失败 / failed to open the panel:', error);
    }
  }

  /**
   * open the reading-records browser.
   *
   *                 the file to preselect; null follows the active file
   */
  private openRecords(filePath: string | null = null): void {
    try {
      new RecordsModal(this.app, {
        service: this.timerService ?? undefined,
        history: this.history,
        clock: systemClock,
        settings: () => this.settings,
        saveSetting: (patch) => this.updateSettings(patch),
        log: this.log,
        onChanged: () => this.refreshSidebar(),
        onSaveRecords: () => this.confirmAndSave(),
        initialFilePath: filePath ?? this.app.workspace.getActiveFile()?.path ?? null,
      }).open();
    } catch (error) {
      this.log.warn('[RTT] 打开记录面板失败 / failed to open the records panel:', error);
      new Notice(String(error), 6000);
    }
  }

  /**
   * force the sidebar to re-render.
   * The sidebar subscribes to the state machine, which knows nothing about the records
   * table, so a deletion needs an explicit refresh.
   */
  private refreshSidebar(): void {
    try {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RTT_SIDEBAR)) {
        const view = leaf.view;
        if (view instanceof ActivitySidebarView) view.refresh();
      }
    } catch (error) {
      this.log.warn('[RTT] 刷新侧栏失败 / sidebar refresh failed:', error);
    }
  }

  /** whether a document session is in progress. */
  private hasActiveSession(): boolean {
    const state = this.timerStore.getState();
    const filePath = state.activeFilePath;
    if (!filePath) return false;
    const file = state.files.get(filePath);
    return file?.status === 'tracking' || file?.status === 'paused';
  }

  /** generate a manual session id. */
  private newSessionId(): string {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch (error) {

      //  Some mobile WebViews lack crypto.randomUUID; fall back to time + random
      this.log.warn('[RTT] randomUUID 不可用 / unavailable:', error);
    }
    return `manual-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  //  ==========================================================================
  // read-only API for DataviewJS
  //  ==========================================================================

  /** every record entry. */
  getRecords(): Record<string, unknown> {
    return this.history.getRecords();
  }

  /**
   *
   * Existing DataviewJS in this vault calls the old name; the refactor renamed it to
   * `getRecords()` with no alias, so those scripts silently received `undefined`. Both
   * names work now.
   */
  getAllRecords(): Record<string, unknown> {
    return this.getRecords();
  }

  /**
   * The old build opened `ReadRecordsModal`, which always threw because `IconizeLoader`
   * was undefined; this opens the rewritten panel instead.
   */
  showFileRecords(filePath?: string): void {
    this.openRecords(filePath ?? this.app.workspace.getActiveFile()?.path ?? null);
  }

  /** one record entry. */
  getRecord(filePath: string): unknown {
    return this.history.getRecord(filePath);
  }

  /** manual sessions. */
  getManualSessions(): unknown[] {
    return this.history.getManualSessions();
  }

  /** whether a path is currently tracked. */
  isTracking(file: TFile | string): boolean {
    const path = typeof file === 'string' ? file : file.path;
    return this.timerStore.getState().activeFilePath === path;
  }
}
