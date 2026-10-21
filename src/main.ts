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

import { Notice, Plugin, TFile, type WorkspaceLeaf } from 'obsidian';

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
import { TimerStore } from './services/TimerStore';
import { TimerService } from './services/TimerService';
import { ManualTimerService } from './services/ManualTimerService';
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

    this.binding = installBindings({
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
