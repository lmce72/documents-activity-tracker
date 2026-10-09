/**
 * Sidebar view
 *
 * The original had no ItemView at all (zero `registerView` calls): everything lived in the
 * note header and modals, with a floating div on mobile. This view gathers status and
 * controls into a real sidebar, with two topbar icons switching between the document panel
 * and the manual-timer panel.
 *
 * Rendering strategy:
 *
 *   State changes every second (the heartbeat dispatches TICK) but the *structure* rarely
 *   does. The subscription therefore compares a structural signature and only re-renders
 *   when it changes; numbers are updated in place once a second, so re-rendering does not
 *   wipe the user's text selection or scroll position.
 *
 * All styling reuses existing classes; no new CSS.
 */

import { ItemView, Setting, setIcon, setTooltip, type WorkspaceLeaf } from 'obsidian';

import { STATUS } from '../core/constants';
import { formatDurationWithSeconds, formatReadTime, todayStr } from '../core/time';
import { getLang, t } from '../core/i18n';
import type { Logger } from '../core/logger';
import {
  buildManualDayRows,
  manualDayTotalSeconds,
  manualSessionsOfDay,
  shiftDay,
} from '../core/manualTimeline';
import {
  selectManualElapsedSeconds,
  selectReadingSeconds,
  selectUnfocusedSeconds,
} from '../core/selectors';
import {
  buildOverviewRows,
  documentIntervals,
  manualIntervals,
  overviewTotals,
} from '../core/overview';
import { buildDocumentDayRows } from '../core/recordsTimeline';
import {
  readingChannelClass,
  readingChannelLabel,
  renderHeatmap,
} from './heatmapRender';
import { buildFileRecords, getAllTodaySeconds, getTodaySessionCount } from '../core/timeline';
import type { FileRecord, PluginSettings } from '../core/types';
import type { Clock } from '../services/clock';
import type { ManualTimerService } from '../services/ManualTimerService';
import type { TimerStore } from '../services/TimerStore';
import type { TimerService } from '../services/TimerService';
import type { HistoryStore } from '../data/historyStore';

/** The view type id. */
export const VIEW_TYPE_RTT_SIDEBAR = 'documents-activity-tracker-sidebar';

/**
 * how many rows a panel list shows.
 *
 * The sidebar is narrow and the long tail is usually negligible; the full list lives in the
 * records browser, one click below.
 */
const TOP_LIST_ITEMS = 3;

/** Panels. */
type Panel = 'document' | 'manual' | 'overview';

/** the numbers updated in place every second. */
type LiveKey = 'session' | 'unfocused' | 'today' | 'manual';

interface LiveNodes {
  session?: HTMLElement;
  unfocused?: HTMLElement;
  today?: HTMLElement;
  manual?: HTMLElement;
  /** the ring, driven by a CSS variable */
  ring?: HTMLElement;

  manualLabel?: HTMLElement;
}

/** View dependencies. */
export interface SidebarDeps {
  store: TimerStore;
  history: HistoryStore;
  clock: Clock;
  log: Logger;
  settings: () => PluginSettings;
  service: TimerService;
  manual: ManualTimerService;
  /** storage degradation notice, null when healthy */
  storageWarning: () => string | null;
  /** prompt for the note; null = cancelled */
  promptNote: (onDone: (note: string | null) => void) => void;
  /** open the records panel; null follows the file */
  openRecords: (filePath: string | null) => void;
  /** persist a settings patch and apply it at once */
  saveSetting: (patch: Partial<PluginSettings>) => Promise<void>;
}

export class ActivitySidebarView extends ItemView {
  private panel: Panel = 'document';
  private day: string = todayStr();

  /** whether the manual list is expanded to everything */
  private manualExpanded = false;

  /** whether the hand-drawn calendar popover is open */
  private calendarOpen = false;

  /**
   * the month the calendar is showing.
   * Separate from `day` (the selected date): turning pages is not choosing, and the user may
   * browse and pick nothing.
   */
  private calendarMonth = '';

  private calendarDismiss: (() => void) | null = null;

  /** structural signature, to avoid per-second re-render */
  private signature = '';
  private unsubscribe: (() => void) | null = null;

  /** nodes updated in place every second */
  private liveNodes: LiveNodes = {};

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: SidebarDeps,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_RTT_SIDEBAR;
  }

  override getDisplayText(): string {
    return t('sidebarTitle');
  }

  override getIcon(): string {
    return 'activity';
  }

  override async onOpen(): Promise<void> {

    //  The panel switcher lives at the top of the content area rather than in topbar
    //  actions: icon-only glyphs are ambiguous in a narrow sidebar and collapse into the
    //  overflow menu on mobile. See `renderPanelTabs`.
    this.unsubscribe = this.deps.store.subscribe(() => this.onStateChange());
    this.register(() => this.unsubscribe?.());

    //  The manual elapsed time is timestamp-derived and not part of any dispatch, so it
    //  needs its own once-a-second update.
    this.registerInterval(
      window.setInterval(() => this.updateLiveNumbers(), 1000),
    );

    this.render();
  }

  override async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * force a re-render.
   *
   * Changes to the records table (a deletion, an external write) do not pass through the
   * state machine and never reach the subscription, so the host calls this explicitly.
   */
  refresh(): void {
    this.signature = '';
    this.render();
  }

  /** Switch panels and force a re-render. */
  private setPanel(panel: Panel): void {
    if (this.panel === panel) return;
    this.panel = panel;
    this.signature = '';
    this.render();
  }

  /**
   * On state change: re-render only when the structure changed, else just update numbers.
   */
  private onStateChange(): void {
    const next = this.computeSignature();
    if (next === this.signature) {
      this.updateLiveNumbers();
      return;
    }
    this.render();
  }

  /**
   * only the quantities that shape the DOM.
   *
   * Called on every state change (once a second while tracking), so it deliberately does
   * not query the records table: that query would run every second for nothing, and the
   * record count shapes no structure.
   */
  private computeSignature(): string {
    const state = this.deps.store.getState();
    const settings = this.deps.settings();

    const parts = [
      this.panel,
      this.day,
      settings.documentTrackingEnabled,
      settings.manualTimerEnabled,

      //  It changes the card count, so it must be in the signature or the structure sticks
      settings.todayTotalDisplay,
      state.activeFilePath ?? '-',
      state.manual.status,

      //  The mark count belongs in the signature: it shapes the marks section, and leaving
      //  it out means marks placed through the service never appear.
      String(state.manual.flags.length),

      //  Expanding the manual list changes how many rows it has, so it belongs here
      String(this.manualExpanded),

      //  The calendar's open state shapes the DOM; without it turning pages would not redraw
      String(this.calendarOpen),
      this.calendarMonth,
      state.files.get(state.activeFilePath ?? '')?.status ?? '-',
    ];

    // the count only shapes the manual panel
    if (this.panel === 'manual') {
      parts.push(String(this.deps.history.getManualSessions().length));
    }

    return parts.join('|');
  }

  //  ==========================================================================
  // rendering
  //  ==========================================================================

  private render(): void {
    try {
      const root = this.contentEl;

      //  The previous calendar listeners must come off before the DOM is torn down, or every
      //  re-render adds another pair holding already-detached nodes.
      this.calendarDismiss?.();
      root.empty();
      this.liveNodes = {};
      this.signature = this.computeSignature();

      this.renderPanelTabs(root);

      //  A degraded store must be obvious, or the user assumes records are being saved
      const warning = this.deps.storageWarning();
      if (warning) {
        root.createDiv({ cls: 'rtt-warning-text', text: warning });
      }

      if (this.panel === 'document') this.renderDocumentPanel(root);
      else if (this.panel === 'manual') this.renderManualPanel(root);
      else this.renderOverviewPanel(root);

      this.updateLiveNumbers();
    } catch (error) {

      //  A render failure must not leave a blank view: show an error instead
      this.deps.log.warn('[RTT][sidebar] 渲染失败 / render failed:', error);
      this.contentEl.empty();
      this.contentEl.createDiv({ cls: 'rtt-empty-hint', text: String(error) });
    }
  }

  /**
   * panel switcher: icon-plus-label buttons.
   *
   * The two panel names are written on the buttons. Previously only topbar icons existed,
   * and the bare `activity` / `timer` glyphs do not say what they open, so the user had to
   * click each once to find out; worse in a narrow sidebar or on mobile, where the topbar
   * action row collapses into an overflow menu.
   */
  private renderPanelTabs(root: HTMLElement): void {
    const bar = root.createDiv({ cls: 'rtt-panel-tabs' });
    bar.setAttribute('role', 'tablist');

    const addTab = (panel: Panel, icon: string, label: string): void => {
      const active = this.panel === panel;
      const btn = bar.createEl('button', {
        cls: active ? 'rtt-panel-tab is-active' : 'rtt-panel-tab',
      });
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(active));
      setIcon(btn.createSpan({ cls: 'rtt-panel-tab-icon' }), icon);
      btn.createSpan({ cls: 'rtt-panel-tab-label', text: label });
      btn.addEventListener('click', () => this.setPanel(panel));
    };

    addTab('document', 'activity', t('panelDocument'));
    addTab('manual', 'timer', t('panelManual'));
    addTab('overview', 'gauge', t('panelOverview'));
  }

  /**
   * whether to render the today-total card.
   *
   * mirrors the three choices in the settings tab:
   * never
   * always
   *
   *               the active file's status, undefined when no file is bound
   */
  private shouldShowTodayTotal(
    settings: PluginSettings,
    status: string | undefined,
  ): boolean {
    if (settings.todayTotalDisplay === 'never') return false;
    if (settings.todayTotalDisplay === 'always') return true;
    return status !== STATUS.TRACKING;
  }

  /** The statistic cards. */
  private renderStatCards(
    parent: HTMLElement,
    cards: Array<{ label: string; value: string; liveKey?: LiveKey }>,
  ): void {
    const bar = parent.createDiv({ cls: 'rtt-stats-bar' });
    for (const card of cards) {
      const el = bar.createDiv({ cls: 'rtt-stats-card' });
      el.createDiv({ cls: 'rtt-stats-label', text: card.label });
      const value = el.createDiv({ cls: 'rtt-stats-value', text: card.value });
      if (card.liveKey) this.liveNodes[card.liveKey] = value;
    }
  }

  /** The document-tracking panel. */
  private renderDocumentPanel(root: HTMLElement): void {
    const settings = this.deps.settings();
    if (!settings.documentTrackingEnabled) {
      root.createDiv({ cls: 'rtt-empty-hint', text: t('trackerOff') });
      root.createDiv({ cls: 'rtt-empty-hint', text: t('trackerOffDesc') });
      return;
    }

    const state = this.deps.store.getState();
    const filePath = state.activeFilePath;

    const cards: Array<{ label: string; value: string; liveKey?: LiveKey }> = [
      {
        label: t('thisSession').replace(/[:：]\s*$/, ''),
        value: '0 秒',
        liveKey: 'session',
      },
      { label: t('tabUnfocused'), value: '0 秒', liveKey: 'unfocused' },
    ];

    //  `todayTotalDisplay` used to be written to settings and never read — a dead knob.
    //  Its three values now decide whether the today-total card is rendered.
    if (this.shouldShowTodayTotal(settings, state.files.get(filePath ?? '')?.status)) {
      cards.push({ label: t('statsTodayTotal'), value: '0 秒', liveKey: 'today' });
    }

    cards.push({
      label: t('sessionCount'),
      value: String(
        filePath
          ? getTodaySessionCount(this.deps.history.getEvents(), state.files.get(filePath) ?? null, filePath)
          : 0,
      ),
    });

    this.renderStatCards(root, cards);

    //  The records are derived once: the heatmap and the list read the same result, so
    //  computing twice is both slower and open to disagreeing mid-render.
    const records = buildFileRecords(
      this.deps.history.getEvents(),
      this.deps.clock.now(),
      todayStr(),
    );

    this.renderDocumentHeatmap(root, records);
    this.renderCurrentSession(root, filePath);
    this.renderTodayList(root, records);
  }

  /**
   * today's document-tracking heatmap.
   *
   * The three panels each draw their own scope: this one draws **document tracking**, the
   * manual panel draws **manual timing**, and the overview draws their **union**. So this
   * chart merges every document's stretches rather than a single file, matching the manual
   * panel's "all sessions that day".
   */
  private renderDocumentHeatmap(
    root: HTMLElement,
    records: Record<string, FileRecord>,
  ): void {

    //  The heatmap is always *today*, not `this.day`: the document list below it is
    //  "top three today", and a chart for one day above a list for another contradicts itself.
    const rows = buildDocumentDayRows(
      Object.values(records).map((record) => record.readTimeLine),
      todayStr(),
    );

    new Setting(root).setName(t('docHeatmapTitle')).setHeading();

    const drawn = renderHeatmap(root, rows, readingChannelClass, readingChannelLabel);

    if (!drawn) {
      root.createDiv({ cls: 'rtt-list-empty', text: t('docHeatmapEmpty') });
    }
  }

  /** current session: file name plus controls. */
  private renderCurrentSession(root: HTMLElement, filePath: string | null): void {
    const section = root.createDiv({ cls: 'rtt-heatmap-wrap' });
    new Setting(section).setName(filePath ?? t('noOpenFile')).setHeading();

    if (!filePath) return;

    const state = this.deps.store.getState();
    const file = state.files.get(filePath);
    const status = file?.status ?? STATUS.IDLE;

    const bar = section.createDiv({ cls: 'rtt-timeline-nav' });

    //  Three states, three buttons: IDLE must offer "start", because autoStartMode defaults
    //  to manual and without it the user can never begin.
    //

    //  All pure icons with no fill: with the labels gone, each button's only readable name is
    //  its tooltip and aria-label, both written by `iconButton`.
    if (status === STATUS.IDLE) {
      this.iconButton(bar, 'play', t('btnStart'), () => {
        void this.deps.service.startCurrent().then(() => this.render());
      });
      return;
    }

    const paused = status === STATUS.PAUSED;
    this.iconButton(bar, paused ? 'play' : 'pause', paused ? t('btnResume') : t('btnPause'), () => {
      void this.deps.service.togglePause();
    });

    this.iconButton(bar, 'save', t('btnSave'), () => {
      void this.deps.service.saveCurrent('save');
    });

    this.iconButton(
      bar,
      'x',
      t('btnDiscard'),
      () => {
        void this.deps.service.discardCurrent();
      },
      { danger: true },
    );
  }

  /**
   * one record row.
   *
   * Both the document and the manual list build rows through this one function. They used
   * to be written twice and drifted in the details (one had a meta line, one did not; one
   * was clickable, one was not), so "unify the record style" could never stay fixed. The
   * shape is fixed at three parts: name / primary figure / muted meta line.
   */
  private renderRecordRow(
    list: HTMLElement,
    options: {
      name: string;
      /** primary figures, separated automatically */
      stats: string[];
      /** the muted meta line; omitted when empty */
      meta?: string[];
      onActivate?: () => void;
      onDelete?: () => void;
      deleteLabel?: string;
    },
  ): void {
    const item = list.createDiv({ cls: 'rtt-list-item' });
    const text = item.createDiv({ cls: 'rtt-item-text' });
    text.createDiv({ cls: 'rtt-item-name', text: options.name });

    const stats = text.createDiv({ cls: 'rtt-item-stats' });
    options.stats.forEach((value, index) => {
      if (index > 0) stats.createSpan({ cls: 'rtt-item-sep', text: ' · ' });
      stats.createSpan({ cls: 'rtt-item-session-val', text: value });
    });

    if (options.meta && options.meta.length > 0) {
      const meta = text.createDiv({ cls: 'rtt-records-meta' });
      for (const entry of options.meta) meta.createSpan({ text: entry });
    }

    if (options.onActivate) {
      item.addClass('is-clickable');
      item.addEventListener('click', options.onActivate);
    } else {

      //  The base rule gives every row a pointer cursor; a row that cannot be clicked has to
      //  correct that, or the cursor is lying.
      item.addClass('is-static');
    }

    if (options.onDelete) {
      this.iconButton(item, 'trash-2', options.deleteLabel ?? t('recDelete'), options.onDelete, {
        ghost: true,
        stopPropagation: true,
      });
    }
  }

  /**
   * the "view all records" entry point.
   *
   * Full width, centred, no fill, icon plus label: it is the only way into the full browser,
   * so it must not degrade to a bare icon — with no label nothing says what it opens.
   */
  private renderViewAllButton(root: HTMLElement): void {
    const btn = root.createEl('button', { cls: 'rtt-view-all-btn' });
    setIcon(btn.createSpan({ cls: 'rtt-view-all-icon' }), 'list-filter');
    btn.createSpan({ cls: 'rtt-view-all-label', text: t('viewAllRecords') });
    setTooltip(btn, t('viewAllRecordsDesc'));
    btn.addEventListener('click', () => this.deps.openRecords(null));
  }

  /**
   * an icon-only button.
   *
   * Built on Obsidian's own `.clickable-icon` rather than a bespoke reset: it is the only
   * selector that makes the themed `button:not(.clickable-icon)` rule stop applying, so the
   * fill and shadow vanish without `!important`. Focus ring, radius and icon colour follow
   * the theme.
   *
   *                      no hover fill and no outline — fully blended (day arrows and such)
   */
  private iconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
    options: { ghost?: boolean; stopPropagation?: boolean; danger?: boolean } = {},
  ): HTMLButtonElement {
    const cls = ['clickable-icon', 'rtt-icon-btn'];
    if (options.ghost) cls.push('is-ghost');
    if (options.danger) cls.push('is-danger');

    const btn = parent.createEl('button', { cls: cls.join(' ') });
    setIcon(btn, icon);

    //  setTooltip also writes aria-label, which is now the button's only readable name
    setTooltip(btn, label);
    btn.setAttribute('aria-label', label);

    btn.addEventListener('click', (event) => {
      if (options.stopPropagation) event.stopPropagation();
      onClick();
    });

    return btn;
  }

  /**
   * the document list, top three by time today.
   *
   * Capped at three: the sidebar is narrow and the long tail is usually negligible. The full
   * browser is one step below, so the cap never hides anything for good.
   */
  private renderTodayList(root: HTMLElement, records: Record<string, FileRecord>): void {
    const mode = this.deps.settings().timeDisplayMode;

    const rows = Object.entries(records)
      .filter(([, record]) => record.readTimeToday > 0)
      .sort((a, b) => b[1].readTimeToday - a[1].readTimeToday)
      .slice(0, TOP_LIST_ITEMS);

    new Setting(root).setName(t('docListTop')).setHeading();

    if (rows.length === 0) {
      root.createDiv({ cls: 'rtt-list-empty', text: t('docListEmpty') });
    } else {
      const list = root.createDiv({ cls: 'rtt-list' });
      for (const [filePath, record] of rows) {
        const stats = [formatReadTime(record.readTimeToday, mode)];
        if (record.unfocusedReadTime > 0) {

          //  A non-breaking space: an ordinary one collapses at a span boundary
          stats.push(`${t('tabUnfocused')} ${formatReadTime(record.unfocusedReadTime, mode)}`);
        }

        const meta: string[] = [];
        if (record.lastReadAt) meta.push(`${t('lastRead')}${record.lastReadAt}`);

        this.renderRecordRow(list, {
          name: record.fileName,
          stats,
          meta,
          onActivate: () => {
            void this.app.workspace.openLinkText(filePath, '', false);
          },
        });
      }
    }

    //  The entry stays even with nothing today: otherwise "nothing today" reads as "nothing
    //  at all".
    this.renderViewAllButton(root);
  }

  /** The manual-timer panel. */
  private renderManualPanel(root: HTMLElement): void {
    if (!this.deps.settings().manualTimerEnabled) {
      root.createDiv({ cls: 'rtt-empty-hint', text: t('manualTimerOff') });
      root.createDiv({ cls: 'rtt-empty-hint', text: t('manualTimerOffDesc') });
      return;
    }

    this.renderManualControls(root);
    this.renderManualToggles(root);
    this.renderManualStats(root);
    this.renderManualHeatmap(root);
    this.renderManualList(root);
  }

  /** manual timer controls. */
  private renderManualControls(root: HTMLElement): void {
    const section = root.createDiv({ cls: 'rtt-heatmap-wrap' });
    new Setting(section).setName(t('panelManual')).setHeading();

    this.renderStopwatch(section);

    const state = this.deps.store.getState();
    const status = state.manual.status;
    const bar = section.createDiv({ cls: 'rtt-timeline-nav' });

    if (status === 'idle') {
      this.iconButton(bar, 'play', t('manualStart'), () => {
        this.deps.manual.start();
        this.render();
      });
      this.renderManualFlags(section);
      return;
    }

    const paused = status === 'paused';
    this.iconButton(
      bar,
      paused ? 'play' : 'pause',
      paused ? t('manualResume') : t('manualPause'),
      () => {
        if (paused) this.deps.manual.resume();
        else this.deps.manual.pause();
        this.render();
      },
    );

    //  Marking records the net seconds and nothing else: it neither stops the clock nor
    //  opens a prompt, because interrupting focus with a form defeats the point. Any label
    //  is written when the session stops.
    this.iconButton(bar, 'flag', t('manualFlag'), () => {
      const mark = this.deps.manual.flag();
      if (mark) this.render();
    });

    //  Stop means stop-and-save, drawn as the player-metaphor square; the saving half of the
    //  meaning lives in the tooltip only.
    this.iconButton(bar, 'square', t('manualStop'), () => {
      this.deps.promptNote((note) => {
        if (note === null) return;
        void this.deps.manual.stop(note).then(() => this.render());
      });
    });

    this.iconButton(
      bar,
      'x',
      t('manualDiscard'),
      () => {
        this.deps.manual.discard();
        this.render();
      },
      { danger: true },
    );

    this.renderManualFlags(section);
  }

  /**
   * the stopwatch: ring plus readout.
   *
   * The ring is a `conic-gradient` rather than SVG: a progress ring whose value changes
   * every second is simplest driven by a CSS variable, with no hand-built SVG nodes. The
   * hole comes from `mask`, which also masks descendants, so the readout is a *sibling*.
   */
  private renderStopwatch(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: 'rtt-stopwatch' });
    this.liveNodes.ring = wrap.createDiv({ cls: 'rtt-stopwatch-ring' });

    const face = wrap.createDiv({ cls: 'rtt-stopwatch-face' });
    this.liveNodes.manualLabel = face.createDiv({
      cls: 'rtt-stopwatch-state',
      text: t('manualIdle'),
    });
    this.liveNodes.manual = face.createDiv({
      cls: 'rtt-stopwatch-time',
      text: formatDurationWithSeconds(0),
    });
    void wrap.createDiv({ cls: 'rtt-stopwatch-hint', text: t('manualRingHint') });
  }

  /** the marks placed during this run. */
  private renderManualFlags(root: HTMLElement): void {
    const state = this.deps.store.getState();
    const flags = state.manual.flags;

    new Setting(root).setName(t('manualFlagsTitle')).setHeading();

    if (flags.length === 0) {
      root.createDiv({ cls: 'rtt-list-empty', text: t('manualNoFlags') });
      return;
    }

    const list = root.createDiv({ cls: 'rtt-flag-list' });
    for (const [index, mark] of flags.entries()) {
      const chip = list.createDiv({ cls: 'rtt-flag-chip' });
      setIcon(chip.createSpan({ cls: 'rtt-flag-icon' }), 'flag');
      chip.createSpan({ text: formatDurationWithSeconds(mark.atSeconds) });
      chip.setAttribute('aria-label', `${mark.atTime} · ${formatDurationWithSeconds(mark.atSeconds)}`);
      void index;
    }
  }

  /**
   * the two switches on the manual panel.
   *
   * They live on the panel rather than the settings tab because they change how *this run*
   * behaves: the user starts the clock here and should be able to adjust it here.
   */
  private renderManualToggles(root: HTMLElement): void {
    const settings = this.deps.settings();

    new Setting(root)
      .setName(t('manualShowSeconds'))
      .setDesc(t('manualShowSecondsDesc'))
      .addToggle((toggle) =>
        toggle.setValue(settings.manualShowSeconds !== false).onChange((value) => {
          void this.deps.saveSetting({ manualShowSeconds: value }).then(() => this.render());
        }),
      );

    new Setting(root)
      .setName(t('manualRecordDoc'))
      .setDesc(t('manualRecordDocDesc'))
      .addToggle((toggle) =>
        toggle.setValue(settings.manualRecordDocActivity !== false).onChange((value) => {
          void this.deps.saveSetting({ manualRecordDocActivity: value }).then(() => this.render());
        }),
      );
  }

  /**
   * the overview panel.
   *
   * Document and manual timing cover the same wall clock, so adding them would count a
   * stretch of "reading with the stopwatch running" twice. This panel takes the **union**,
   * counting jointly covered time once, and still lists each ledger's total and the overlap.
   */
  private renderOverviewPanel(root: HTMLElement): void {
    const settings = this.deps.settings();
    if (!settings.documentTrackingEnabled && !settings.manualTimerEnabled) {
      root.createDiv({ cls: 'rtt-empty-hint', text: t('ovEmpty') });
      return;
    }

    const records = buildFileRecords(
      this.deps.history.getEvents(),
      this.deps.clock.now(),
      todayStr(),
    );

    const intervals = [
      ...documentIntervals(Object.values(records).map((record) => record.readTimeLine)),
      ...manualIntervals(this.deps.history.getManualSessions()),
    ];

    const totals = overviewTotals(intervals, this.day);
    const mode = settings.timeDisplayMode;

    this.renderStatCards(root, [
      { label: t('ovUnion'), value: formatReadTime(Math.round(totals.unionMinutes * 60), mode) },
      { label: t('ovDocument'), value: formatReadTime(Math.round(totals.documentMinutes * 60), mode) },
      { label: t('ovManual'), value: formatReadTime(Math.round(totals.manualMinutes * 60), mode) },
      { label: t('ovOverlap'), value: formatReadTime(Math.round(totals.overlapMinutes * 60), mode) },
    ]);

    // day navigation
    const head = root.createDiv({ cls: 'rtt-heatmap-wrap' });
    this.renderDayNav(head);

    const rows = buildOverviewRows(intervals, this.day);
    const hasAny = rows.some((row) => row.segments.length > 0);

    if (!hasAny) {
      head.createDiv({ cls: 'rtt-list-empty', text: t('ovEmpty') });
      return;
    }

    const legend = head.createDiv({ cls: 'rtt-records-meta' });
    for (const [cls, label] of [
      ['rtt-ov-doc', t('ovDocument')],
      ['rtt-ov-manual', t('ovManual')],
      ['rtt-ov-both', t('ovLegendBoth')],
    ] as const) {
      const item = legend.createSpan({ cls: 'rtt-ov-legend-item' });
      item.createSpan({ cls: `rtt-ov-swatch ${cls}` });
      item.createSpan({ text: label });
    }

    renderHeatmap(
      head,
      rows,
      (segment) =>
        segment.sources.length > 1
          ? 'rtt-ov-both'
          : segment.sources[0] === 'manual'
            ? 'rtt-ov-manual'
            : 'rtt-ov-doc',
      (segment) =>
        `${formatDurationWithSeconds(Math.round(segment.durationMinutes * 60))} · ` +
        segment.sources
          .map((source) => (source === 'manual' ? t('ovManual') : t('ovDocument')))
          .join(' + '),
    );

    root.createDiv({ cls: 'rtt-records-meta', text: t('ovExplain') });
  }

  /** today's manual total. */
  private renderManualStats(root: HTMLElement): void {
    const sessions = this.deps.history.getManualSessions();
    const today = todayStr();
    const todaySessions = manualSessionsOfDay(sessions, today);

    this.renderStatCards(root, [
      {
        label: t('manualTodayTotal'),
        value: formatReadTime(manualDayTotalSeconds(sessions, today), 'precise'),
      },
      { label: t('manualListTitle'), value: String(todaySessions.length) },
    ]);
  }

  /** the manual-timing heatmap. */
  private renderManualHeatmap(root: HTMLElement): void {
    const head = root.createDiv({ cls: 'rtt-heatmap-wrap' });

    this.renderDayNav(head);

    const sessions = this.deps.history.getManualSessions();
    const rows = buildManualDayRows(sessions, this.day);

    //  Manual stretches are green, the same colour the overview gives "manual": one thing
    //  must be one colour across panels, or every legend has to be relearned.
    const drawn = renderHeatmap(
      head,
      rows,
      () => 'rtt-hm-manual',
      (segment) =>
        `${segment.session.startTime.slice(11)} · ${formatDurationWithSeconds(segment.session.durationSeconds)}` +
        (segment.session.note ? ` · ${segment.session.note}` : ''),
    );

    if (!drawn) {
      head.createDiv({ cls: 'rtt-list-empty', text: t('manualNoRecords') });
    }
  }

  /**
   * day navigation.
   *
   * The arrows are pure icons fully blended into the background; the date in the middle is a
   * native `<input type="date">`, so desktop opens the system calendar and mobile raises the
   * platform picker. A hand-drawn calendar would need its own touch handling and is more
   * likely to trip the project's "no accidental taps while scrolling" requirement.
   *
   * A native date input CANNOT disable individual days — only a contiguous `min`/`max`
   * range; there is no per-day disabling. Two gates cover it: `min`/`max` clamp to the
   * earliest and latest day that has records, blocking everything outside, and a `change`
   * guard refuses the record-less days inside. Today and the currently viewed day are folded
   * into the range, or a record-less today would leave the value outside min/max.
   */
  private renderDayNav(parent: HTMLElement): void {
    const nav = parent.createDiv({ cls: 'rtt-timeline-nav' });

    this.iconButton(
      nav,
      'chevron-left',
      t('prevDay'),
      () => {
        this.day = shiftDay(this.day, -1);
        this.render();
      },
      { ghost: true },
    );

    const trigger = nav.createEl('button', { cls: 'rtt-day-trigger' });
    setIcon(trigger.createSpan({ cls: 'rtt-day-trigger-icon' }), 'calendar');
    trigger.createSpan({ cls: 'rtt-day-trigger-label', text: this.day });
    trigger.setAttribute('aria-label', t('dayPicker'));
    trigger.setAttribute('aria-expanded', String(this.calendarOpen));
    setTooltip(trigger, t('dayPickerDesc'));
    trigger.addEventListener('click', () => {
      this.calendarOpen = !this.calendarOpen;

      //  Every open starts from the selected day's month, not wherever the last browse ended
      this.calendarMonth = this.day.slice(0, 7);
      this.render();
    });

    this.iconButton(
      nav,
      'chevron-right',
      t('nextDay'),
      () => {
        this.day = shiftDay(this.day, 1);
        this.calendarOpen = false;
        this.render();
      },
      { ghost: true },
    );

    if (this.calendarOpen) this.renderCalendar(nav, trigger);
  }

  /**
   * the hand-drawn calendar.
   *
   * A native `<input type="date">` **cannot disable individual days** (only a contiguous
   * min/max), and "only days with records are selectable" is exactly per-day — hence a
   * hand-drawn one. No `innerHTML`: the project's red line requires Obsidian's DOM builders,
   * and the calendar examples online are almost all template strings. Date wording is not
   * hardcoded either — `Intl.DateTimeFormat` renders it per language, saving 7 weekday names
   * across 2 languages.
   */
  private renderCalendar(anchor: HTMLElement, trigger: HTMLElement): void {
    const recorded = new Set(this.availableDays());
    const locale = getLang() === 'zh' ? 'zh-CN' : 'en-US';

    const pop = anchor.createDiv({ cls: 'rtt-cal' });
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', t('dayPicker'));

    const [yearText, monthText] = this.calendarMonth.split('-');
    const year = Number(yearText);
    const month = Number(monthText) - 1;
    if (!Number.isFinite(year) || !Number.isFinite(month)) return;

    const monthDate = new Date(year, month, 1);

    // month header ──
    const head = pop.createDiv({ cls: 'rtt-cal-head' });
    this.iconButton(
      head,
      'chevron-left',
      t('prevMonth'),
      () => {
        this.shiftCalendarMonth(-1);
      },
      { ghost: true },
    );
    head.createDiv({
      cls: 'rtt-cal-title',
      text: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(
        monthDate,
      ),
    });
    this.iconButton(
      head,
      'chevron-right',
      t('nextMonth'),
      () => {
        this.shiftCalendarMonth(1);
      },
      { ghost: true },
    );

    // weekday header, Monday first ──
    const grid = pop.createDiv({ cls: 'rtt-cal-grid' });
    const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
    for (let i = 0; i < 7; i++) {

      //  2026-01-05 is a Monday; a fixed anchor avoids depending on what day today is
      grid.createDiv({
        cls: 'rtt-cal-wd',
        text: weekdayFormat.format(new Date(2026, 0, 5 + i)),
      });
    }

    // leading blanks
    const lead = (monthDate.getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) grid.createDiv({ cls: 'rtt-cal-cell is-blank' });

    const pad = (n: number): string => String(n).padStart(2, '0');
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = todayStr();
    let monthHasRecords = false;

    for (let date = 1; date <= daysInMonth; date++) {
      const value = `${year}-${pad(month + 1)}-${pad(date)}`;
      const hasRecords = recorded.has(value);
      if (hasRecords) monthHasRecords = true;

      const cell = grid.createEl('button', { cls: 'rtt-cal-cell' });
      cell.setText(String(date));

      if (value === this.day) cell.addClass('is-selected');
      if (value === today) cell.addClass('is-today');

      if (!hasRecords) {

        //  A record-less day is *disabled* rather than selectable-then-refused: that is the
        //  whole point of drawing this by hand.
        cell.addClass('is-disabled');
        cell.disabled = true;
        cell.setAttribute('aria-disabled', 'true');
        cell.setAttribute('aria-label', `${value} — ${t('dayNoRecords')}`);
        continue;
      }

      cell.addClass('has-records');
      cell.setAttribute('aria-label', value);
      cell.addEventListener('click', () => {
        this.day = value;
        this.calendarOpen = false;
        this.render();
      });
    }

    const foot = pop.createDiv({ cls: 'rtt-cal-foot' });
    if (!monthHasRecords) {
      foot.createSpan({ cls: 'rtt-cal-note', text: t('calNoRecords') });
    } else {
      foot.createSpan({ cls: 'rtt-cal-note', text: t('calOnlyRecorded') });
    }

    const todayBtn = foot.createEl('button', { cls: 'rtt-cal-today', text: t('todayLabel') });

    //  Disabled when today has no records, so it cannot jump to a blank day
    if (!recorded.has(today)) {
      todayBtn.disabled = true;
      todayBtn.addClass('is-disabled');
    } else {
      todayBtn.addEventListener('click', () => {
        this.day = today;
        this.calendarOpen = false;
        this.render();
      });
    }

    // Escape ──

    //  The listener goes on ownerDocument, not the global document: the sidebar lives in
    //  activeDocument and in a multi-window workspace those are different objects.
    const doc = this.contentEl.ownerDocument;
    const close = (): void => {
      this.calendarOpen = false;
      this.calendarDismiss = null;
      doc.removeEventListener('mousedown', onPointerDown);
      doc.removeEventListener('keydown', onKeyDown);
      this.render();
    };
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;

      //  The trigger toggles on its own; without this it would close and immediately reopen
      if (pop.contains(target) || trigger.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    doc.addEventListener('mousedown', onPointerDown);
    doc.addEventListener('keydown', onKeyDown);
    this.calendarDismiss = () => {
      doc.removeEventListener('mousedown', onPointerDown);
      doc.removeEventListener('keydown', onKeyDown);
    };
  }

  private shiftCalendarMonth(delta: number): void {
    const [yearText, monthText] = this.calendarMonth.split('-');
    const year = Number(yearText);
    const month = Number(monthText) - 1;
    if (!Number.isFinite(year) || !Number.isFinite(month)) return;

    const moved = new Date(year, month + delta, 1);
    const pad = (n: number): string => String(n).padStart(2, '0');
    this.calendarMonth = `${moved.getFullYear()}-${pad(moved.getMonth() + 1)}`;
    this.calendarOpen = true;
    this.render();
  }

  /**
   * Document events and manual sessions both count: the user navigates one date across panels.
   */
  private availableDays(): string[] {
    const days = new Set<string>();
    for (const event of this.deps.history.getEvents()) {
      const day = event.time.slice(0, 10);
      if (day) days.add(day);
    }
    for (const session of this.deps.history.getManualSessions()) {
      const day = session.startTime.slice(0, 10);
      if (day) days.add(day);
    }
    return [...days].sort();
  }

  /**
   * that day's manual-session list.
   *
   * Shows the three most RECENT by default, the rest behind "show more". Same narrow-sidebar
   * reasoning as the document panel's top three, but a different order: newest-first, because
   * manual timing answers "what did I just do"; the document panel sorts by duration, because
   * it answers "where did my time go".
   */
  private renderManualList(root: HTMLElement): void {
    const all = manualSessionsOfDay(this.deps.history.getManualSessions(), this.day)
      .slice()
      .reverse();

    new Setting(root).setName(t('manualRecent')).setHeading();

    if (all.length === 0) {
      root.createDiv({ cls: 'rtt-list-empty', text: t('manualNoRecords') });
      return;
    }

    const visible = this.manualExpanded ? all : all.slice(0, TOP_LIST_ITEMS);
    const list = root.createDiv({ cls: 'rtt-list' });

    for (const session of visible) {
      const marks = session.flags?.length ?? 0;
      this.renderRecordRow(list, {
        name: session.note || t('noteLabel'),
        stats: [
          formatDurationWithSeconds(session.durationSeconds),
          `${session.startTime.slice(11, 16)} – ${session.endTime.slice(11, 16)}`,
        ],
        meta: marks > 0 ? [`${t('manualFlagsTitle')} ${marks}`] : [],
        onDelete: () => {
          this.deps.history.deleteManualSession(session.id);
          void this.deps.history.flushNow();
          this.render();
        },
        deleteLabel: t('btnDiscard'),
      });
    }

    //  "Show more" appears only when there is more to show, or it is a button that does nothing
    if (all.length > TOP_LIST_ITEMS) {
      const more = root.createEl('button', { cls: 'rtt-view-all-btn' });
      setIcon(
        more.createSpan({ cls: 'rtt-view-all-icon' }),
        this.manualExpanded ? 'chevron-up' : 'chevron-down',
      );
      more.createSpan({
        cls: 'rtt-view-all-label',
        text: this.manualExpanded ? t('manualShowLess') : t('manualShowMore'),
      });
      more.addEventListener('click', () => {
        this.manualExpanded = !this.manualExpanded;
        this.render();
      });
    }
  }

  //  ==========================================================================
  // once-a-second in-place updates
  //  ==========================================================================

  private updateLiveNumbers(): void {
    try {
      const state = this.deps.store.getState();
      const mode = this.deps.settings().timeDisplayMode;
      const filePath = state.activeFilePath;

      if (this.liveNodes.session) {
        this.liveNodes.session.setText(
          filePath
            ? formatReadTime(selectReadingSeconds(state, filePath), mode)
            : '0 秒',
        );
      }

      if (this.liveNodes.unfocused) {
        this.liveNodes.unfocused.setText(
          filePath
            ? formatReadTime(selectUnfocusedSeconds(state, filePath), mode)
            : '0 秒',
        );
      }

      if (this.liveNodes.today) {
        this.liveNodes.today.setText(
          formatReadTime(
            getAllTodaySeconds(this.deps.history.getEvents(), state.files.values()),
            mode,
          ),
        );
      }

      if (this.liveNodes.manual) {
        const elapsed = selectManualElapsedSeconds(state, this.deps.clock.now());

        //  With "show seconds" off, the readout stops at the minute so nothing ticks
        this.liveNodes.manual.setText(
          this.deps.settings().manualShowSeconds !== false
            ? formatDurationWithSeconds(elapsed)
            : formatReadTime(elapsed, 'compact'),
        );

        this.liveNodes.manualLabel?.setText(
          state.manual.status === 'running'
            ? t('manualRunning')
            : state.manual.status === 'paused'
              ? t('manualPaused')
              : t('manualIdle'),
        );

        //  The ring is progress through the current minute, reset to zero when idle
        if (this.liveNodes.ring) {
          const percent =
            state.manual.status === 'idle' ? 0 : ((elapsed % 60) / 60) * 100;
          this.liveNodes.ring.style.setProperty('--rtt-ring-pct', String(percent));
        }
      }
    } catch (error) {

      //  A failed number update must not break the view; the next heartbeat retries
      this.deps.log.warn('[RTT][sidebar] 数字刷新失败 / live update failed:', error);
    }
  }
}
