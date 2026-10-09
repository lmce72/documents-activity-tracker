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
import { createInitialState, createTimerReducer } from './core/reducer';
import type { PluginSettings } from './core/types';
import { ObsidianAdapter } from './data/adapter';
import type { HistoryStore } from './data/historyStore';
import { SqliteStore, resolveDatabasePath } from './data/SqliteStore';
import { VolatileHistoryStore } from './data/VolatileHistoryStore';
import { TimerStore } from './services/TimerStore';
import { TimerService } from './services/TimerService';
import { ManualTimerService } from './services/ManualTimerService';
import { systemClock } from './services/clock';
import { ActivitySidebarView, VIEW_TYPE_RTT_SIDEBAR } from './ui/SidebarView';
import { RecordsModal } from './ui/RecordsModal';
import { ManualNoteModal } from './ui/ManualNoteModal';
import { ReadTimeSettingTab } from './ui/SettingsTab';
import { installBindings, type Binding } from './ui/obsidianBinding';
import { t } from './core/i18n';

/** Fallback display path for the legacy data file when settings.dataFilePath is empty. */
const DEFAULT_LEGACY_PATH = 'Components/History/readTimeHistory.json';

export default class ReadTimeTrackerPlugin extends Plugin {
  /**
   * Plugin settings.
   *
   * `Plugin` declares `settings?: unknown` since 1.13 and the documented pattern is to
   * narrow it on the subclass, so this cannot be private.
   */
  override settings!: PluginSettings;

  /** debug logging switch */
  private debug = false;

  private log: Logger = silentLogger;

  private sqlite: SqliteStore | null = null;
  private timerStore!: TimerStore;
  private timerService!: TimerService;
  private manualService!: ManualTimerService;
  private binding: Binding | null = null;

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
    this.app.workspace.onLayoutReady(() => {
      const HINT_KEY = 'rtt_sidebar_hint_shown';
      try {
        if (this.app.loadLocalStorage(HINT_KEY)) return;
      } catch (error) {
        this.log.warn('[RTT] 侧栏首次提示读取失败 / hint read failed:', error);
        return;
      }

      void this.activateSidebar().then((opened) => {
        if (!opened) return;
        try {
          this.app.saveLocalStorage(HINT_KEY, true);
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
      this.settings = mergeSettings(await this.loadData());
    } catch (error) {
      console.error('[RTT] 设置加载失败，使用默认值 / settings load failed:', error);
      this.settings = mergeSettings(null);
    }
  }

  /** persist a settings patch and apply it now. */
  private async updateSettings(patch: Partial<PluginSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await this.saveData(this.settings);

    //  Turning document tracking off must actually stop it, or the timer keeps counting
    //  in the background with no UI to show it.
    if (patch.documentTrackingEnabled === false) {
      await this.timerService.saveCurrent('auto-save');
    }

    //  When "record document activity" goes back on, the active file must be re-bound right
    //  away. Measured: toggling it off and on did nothing until the user switched tabs,
    //  because binding only happens on active-leaf-change and a settings change fires none.
    if (patch.manualRecordDocActivity === true || patch.documentTrackingEnabled === true) {
      await this.timerService.onActivePathChange();
    }
    if (patch.manualTimerEnabled === false) {
      this.manualService.discard();
    }
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
   * open the reading-records browser.
   *
   *                 the file to preselect; null follows the active file
   */
  private openRecords(filePath: string | null = null): void {
    try {
      new RecordsModal(this.app, {
        history: this.history,
        clock: systemClock,
        settings: () => this.settings,
        log: this.log,
        onChanged: () => this.refreshSidebar(),
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
