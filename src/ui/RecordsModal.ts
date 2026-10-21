/**
 * Reading-records browser
 *
 * Origin: the vault monolith's `ReadRecordsModal`. That class could not open at all — it
 * referenced an `IconizeLoader` defined nowhere (docs/PHASE3_FEATURES_PLAN.md B3), so the
 * constructor threw `ReferenceError`. This is a rewrite, not a port:
 *   1. Records are derived from the event stream on demand instead of a `_cache` that can
 *      drift away from the stream.
 *   2. Deletion goes through `history.deleteFileEvents()` and reaches disk; the old one
 *      mutated an in-memory timeline and lost the change on restart.
 *   3. Iconize support is a capability probe that degrades to a default icon, so a missing
 *      or changed plugin can never take the whole window down.
 *   4. Adds a day heatmap coloured by channel (in-window / out-of-window / paused), which
 *      is the role the unported `HeatmapView` used to play.
 *
 */

import { Modal, Notice, Setting, setIcon, setTooltip, type App } from 'obsidian';
import type { TimerService } from '../services/TimerService';

import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { shiftDay } from '../core/manualTimeline';
import {
  buildRecordDayRows,
  recordDayChannels,
  weekReadingSeconds,
} from '../core/recordsTimeline';
import {
  formatDurationWithSeconds,
  formatReadTime,
  formatReadTimeParts,
  todayStr,
} from '../core/time';
import { countsPluginViewsAsReading, countsUnfocusedAsReading } from '../core/settings';
import { buildFileRecords } from '../core/timeline';
import { appendDurationParts, setReadTime } from './durationText';
import {
  CHANNEL_CLASSES,
  filterRowsByClass,
  readingChannelClass,
  readingChannelLabel,
  renderHeatmap,
  renderHeatmapLegend,
  type LegendEntry,
} from './heatmapRender';
import type { FileRecord, PluginSettings } from '../core/types';
import type { Clock } from '../services/clock';
import type { HistoryStore } from '../data/historyStore';

/** sort orders. */
export type RecordSort = 'last-desc' | 'last-asc' | 'total-desc' | 'total-asc';

const SORT_OPTIONS: ReadonlyArray<{ value: RecordSort; labelKey: 'sortLastReadDesc' | 'sortLastReadAsc' | 'sortTotalDesc' | 'sortTotalAsc' }> = [
  { value: 'last-desc', labelKey: 'sortLastReadDesc' },
  { value: 'last-asc', labelKey: 'sortLastReadAsc' },
  { value: 'total-desc', labelKey: 'sortTotalDesc' },
  { value: 'total-asc', labelKey: 'sortTotalAsc' },
];

/** what the modal needs. */
export interface RecordsModalDeps {
  history: HistoryStore;
  service?: TimerService;
  clock: Clock;
  settings: () => PluginSettings;
  log: Logger;

  onChanged?: () => void;
  /** 手动保存记录 / force the running session to disk */
  onSaveRecords?: () => void;
  /** a file to preselect */
  initialFilePath?: string | null;
}

export class RecordsModal extends Modal {
  private sort: RecordSort = 'last-desc';
  private search = '';
  /**
   * whether to restore focus to the search box.
   * Set only when a re-render was caused by typing; otherwise selecting a row would steal
   * focus away from the list.
   */
  private refocusSearch = false;
  /** the file whose heatmap is shown */
  private selected: string | null;
  private day: string = todayStr();
  /** delete awaiting a second click */
  private pendingDelete: string | null = null;

  /**
   * 被图例关掉的那几类 / the kinds the legend has switched off.
   * 与侧栏同名共用一套语义：键是段的取色类。
   */
  private hiddenHeatmap = new Set<string>();

  constructor(
    app: App,
    private readonly deps: RecordsModalDeps,
  ) {
    super(app);
    this.selected = deps.initialFilePath ?? null;
  }

  override onOpen(): void {
    this.titleEl.setText(t('recTitle'));
    this.modalEl.addClass('rtt-records-modal');
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  //  ==========================================================================
  // data
  //  ==========================================================================

  private buildAll(): Record<string, FileRecord> {
    return buildFileRecords(
      this.deps.history.getEvents(),
      this.deps.clock.now(),
      todayStr(),
      { countUnfocused: countsUnfocusedAsReading(this.deps.settings()), countPluginViews: countsPluginViewsAsReading(this.deps.settings()) },
    );
  }

  /** apply the search box and the sort order. */
  private visibleEntries(all: Record<string, FileRecord>): Array<[string, FileRecord]> {
    const needle = this.search.trim().toLowerCase();

    const entries = Object.entries(all).filter(([filePath, record]) => {
      if (!needle) return true;
      return (
        filePath.toLowerCase().includes(needle) ||
        record.fileName.toLowerCase().includes(needle)
      );
    });

    const byText = (a: string, b: string): number => a.localeCompare(b);

    entries.sort((a, b) => {
      switch (this.sort) {
        case 'last-asc':
          return byText(a[1].lastReadAt, b[1].lastReadAt) || byText(a[0], b[0]);
        case 'total-desc':
          return b[1].totalReadTime - a[1].totalReadTime || byText(a[0], b[0]);
        case 'total-asc':
          return a[1].totalReadTime - b[1].totalReadTime || byText(a[0], b[0]);
        case 'last-desc':
        default:
          return byText(b[1].lastReadAt, a[1].lastReadAt) || byText(a[0], b[0]);
      }
    });

    return entries;
  }

  /**
   * 本周阅读秒数 / reading seconds this week.
   * 与侧栏统计卡共用同一个实现 / shares one implementation with the sidebar's stat card.
   */
  private weekSeconds(all: Record<string, FileRecord>): number {
    return weekReadingSeconds(
      Object.values(all).map((record) => record.readTimeLine),
      todayStr(),
    );
  }

  /**
   * 底部的「立即保存记录」/ the save control at the foot of the panel.
   *
   * 放在最下方且不抢眼：它是保险措施，不是每次打开都要按的动作。
   * At the foot and unemphatic: it is a safety net, not something to press on every open.
   */
  private renderSaveBar(root: HTMLElement): void {
    if (!this.deps.onSaveRecords) return;
    const bar = root.createDiv({ cls: 'rtt-records-savebar' });
    const button = bar.createEl('button', { text: t('manualSave') });
    setTooltip(button, t('manualSaveConfirm'));
    button.addEventListener('click', () => this.deps.onSaveRecords?.());
  }

  //  ==========================================================================
  // rendering
  //  ==========================================================================

  private render(): void {
    try {
      const root = this.contentEl;
      root.empty();

      const all = this.buildAll();
      const settings = this.deps.settings();
      const mode = settings.timeDisplayMode;

      this.renderStats(root, all, mode);
      this.renderToolbar(root);

      //  The heatmap sits *above* the list: the shape of the day first, then the per-file
      //  detail underneath it.
      this.renderDetail(root, all, mode);
      this.renderList(root, all, mode);
      this.renderSaveBar(root);
    } catch (error) {
      this.deps.log.warn('[RTT][records] 渲染失败 / render failed:', error);
      this.contentEl.empty();
      this.contentEl.createDiv({ cls: 'rtt-list-empty', text: String(error) });
    }
  }

  /** the statistic cards across the top. */
  private renderStats(
    root: HTMLElement,
    all: Record<string, FileRecord>,
    mode: string,
  ): void {
    const today = todayStr();
    const events = this.deps.history.getEvents();

    //  Today's session count comes straight from the event stream, matching the sidebar
    const todaySessions = events.filter(
      (event) =>
        event.time.startsWith(today) &&
        (event.type === 'save' || event.type === 'auto-save'),
    ).length;

    //  Today's total sums each record's `readTimeToday`, which buildFileRecords derives
    //  live and therefore already includes the in-progress session.
    const todaySeconds = Object.values(all).reduce(
      (total, record) => total + record.readTimeToday,
      0,
    );

    const cards: Array<{ label: string; value?: string; seconds?: number }> = [
      { label: t('statsToday'), seconds: todaySeconds },
      { label: t('statsTodaySessions'), value: String(todaySessions) },
      { label: t('statsWeek'), seconds: this.weekSeconds(all) },
      { label: t('recTotalFiles').replace('{n}', String(Object.keys(all).length)), value: '' },
    ];

    const bar = root.createDiv({ cls: 'rtt-stats-bar' });
    for (const card of cards) {
      const el = bar.createDiv({ cls: 'rtt-stats-card' });
      el.createDiv({ cls: 'rtt-stats-label', text: card.label });
      const value = el.createDiv({ cls: 'rtt-stats-value' });
      if (card.seconds !== undefined) setReadTime(value, card.seconds, mode);
      else if (card.value) value.setText(card.value);
    }
  }

  /** the search box and the sort dropdown. */
  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: 'rtt-records-toolbar' });

    const search = bar.createEl('input', { type: 'search' });
    search.placeholder = t('searchPlaceholder');
    search.value = this.search;
    search.setAttribute('aria-label', t('searchPlaceholder'));
    search.addEventListener('input', () => {
      this.search = search.value;
      this.refocusSearch = true;
      this.render();
    });

    const select = bar.createEl('select');
    select.setAttribute('aria-label', t('recSort'));
    for (const option of SORT_OPTIONS) {
      select.createEl('option', { value: option.value, text: t(option.labelKey) });
    }
    select.value = this.sort;
    select.addEventListener('change', () => {
      this.sort = select.value as RecordSort;
      this.render();
    });

    //  Focus returns to the search box after the re-render, or every keystroke loses it.
    //  `ownerDocument` rather than the global `document`: modals render into
    //  activeDocument, which is a different object in a multi-window workspace.
    if (this.refocusSearch) {
      this.refocusSearch = false;
      const doc = this.contentEl.ownerDocument;
      const win = doc.defaultView ?? window;
      win.setTimeout(() => {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
      }, 0);
    }
  }

  /** the record list. */
  private renderList(
    root: HTMLElement,
    all: Record<string, FileRecord>,
    mode: string,
  ): void {
    const entries = this.visibleEntries(all);

    if (entries.length === 0) {
      root.createDiv({ cls: 'rtt-list-empty', text: t('noRecords') });
      return;
    }

    const list = root.createDiv({ cls: 'rtt-list' });

    for (const [filePath, record] of entries) {
      const item = list.createDiv({
        cls: this.selected === filePath ? 'rtt-list-item is-selected' : 'rtt-list-item',
      });

      this.renderRowIcon(item, filePath);

      const text = item.createDiv({ cls: 'rtt-item-text' });
      text.createDiv({ cls: 'rtt-item-name', text: record.fileName });

      const stats = text.createDiv({ cls: 'rtt-item-stats' });
      const total = stats.createSpan({ cls: 'rtt-item-session-val rtt-dur' });
      appendDurationParts(total, formatReadTimeParts(record.totalReadTime, mode));

      //  The out-of-window part is listed separately so the split stays visible here too
      if (record.unfocusedReadTime > 0) {
        stats.createSpan({ cls: 'rtt-item-sep', text: ' · ' });

        //  A non-breaking space: an ordinary space collapses at a span boundary and glues

        stats.createSpan({ cls: 'rtt-item-session-label', text: `${t('tabUnfocused')} ` });
        const out = stats.createSpan({ cls: 'rtt-item-session-val rtt-dur' });
        appendDurationParts(out, formatReadTimeParts(record.unfocusedReadTime, mode));
      }

      const meta = text.createDiv({ cls: 'rtt-records-meta' });
      if (record.lastReadAt) {
        meta.createSpan({ text: `${t('lastRead')}${record.lastReadAt}` });
      }
      if (record.readTimeToday > 0) {
        meta.createSpan({
          text: `${t('statsToday')} ${formatReadTime(record.readTimeToday, mode)}`,
        });
      }

      //  An abnormal unfinished session must be flagged, or the time looks invented
      if (record.hasAbnormalSession) {
        meta.createSpan({ cls: 'rtt-records-warn', text: t('noDay') });
      }

      item.addEventListener('click', () => {
        this.selected = filePath;
        this.day = todayStr();
        this.pendingDelete = null;
        this.render();

        //  The file opens without dismissing the panel, so browsing keeps its place
        void this.app.workspace.openLinkText(filePath, '', false);
      });

      this.renderDeleteButton(item, filePath, record);
    }
  }

  /** row icon, defaulting when Iconize is absent. */
  private renderRowIcon(item: HTMLElement, filePath: string): void {
    const holder = item.createDiv({ cls: 'rtt-item-icon' });

    if (this.deps.settings().useIconize) {
      const custom = this.resolveIconizeIcon(filePath);
      if (custom) {
        setIcon(holder, custom);
        return;
      }
    }

    setIcon(holder, 'file-text');
  }

  /**
   * best-effort Iconize lookup.
   *
   * The old code did `new IconizeLoader()` against a class that never existed, so the whole
   * panel threw on construction. Every step here is guarded: plugin absent, API renamed,
   * or return shape changed all yield null so the caller falls back — an icon is decoration
   * and must never gate whether the panel opens.
   */
  private resolveIconizeIcon(filePath: string): string | null {
    try {
      const iconize = (this.app as unknown as {
        plugins?: { plugins?: Record<string, unknown> };
      }).plugins?.plugins?.['obsidian-icon-folder'];
      if (!iconize || typeof iconize !== 'object') return null;

      const api = iconize as {
        getIcon?: (path: string) => unknown;
        getFileIcon?: (path: string) => unknown;
      };
      const raw = api.getIcon?.(filePath) ?? api.getFileIcon?.(filePath);

      if (typeof raw !== 'string') return null;

      //  Iconize identifiers have no colon ("lucideBook"), while setIcon wants a lowercase
      //  hyphenated lucide name; a mismatch falls back rather than rendering nothing.
      const match = raw.match(/^lucide-?([A-Z][A-Za-z0-9]*)$/);
      if (!match) return null;

      return match[1]!
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase();
    } catch (error) {
      this.deps.log.warn('[RTT][records] Iconize 图标读取失败 / icon lookup failed:', error);
      return null;
    }
  }

  /**
   * the delete button, confirmed by a second click.
   *
   * Deletion removes every event for the file and cannot be undone, so one click never
   * commits it.
   */
  private renderDeleteButton(
    item: HTMLElement,
    filePath: string,
    record: FileRecord,
  ): void {
    const confirming = this.pendingDelete === filePath;
    const btn = item.createEl('button', {
      cls: confirming ? 'rtt-item-delete is-confirming' : 'rtt-item-delete',
      text: confirming ? '✓' : '×',
    });
    btn.setAttribute('aria-label', t('recDelete'));
    btn.title = confirming ? t('recDeleteConfirm').replace('{name}', record.fileName) : t('recDelete');

    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.pendingDelete !== filePath) {
        this.pendingDelete = filePath;
        this.render();
        return;
      }

      try {
        const removed = this.deps.history.deleteFileEvents(filePath);
        void this.deps.history.flushNow();
        this.pendingDelete = null;
        if (this.selected === filePath) this.selected = null;
        new Notice(t('recDeleted').replace('{name}', record.fileName), 3000);
        this.deps.log.info('[RTT][records] 删除文件记录 / deleted records:', filePath, removed);
        this.deps.onChanged?.();
        this.render();
      } catch (error) {
        this.deps.log.warn('[RTT][records] 删除失败 / delete failed:', error);
        new Notice(String(error), 6000);
      }
    });
  }

  /** the selected file's heatmap for one day. */
  private renderDetail(
    root: HTMLElement,
    all: Record<string, FileRecord>,
    mode: string,
  ): void {
    new Setting(root).setName(t('recDetailTitle')).setHeading();

    const filePath = this.selected;
    const record = filePath ? all[filePath] : undefined;

    if (!filePath || !record) {
      root.createDiv({ cls: 'rtt-list-empty', text: t('recDetailHint') });
      return;
    }

    //  失焦归类搬到了侧栏文档面板的「离开与空闲」区块：那是同一个面板里的一段列表，不再单开一层
    //  弹窗。这里留一句指路，用户不会在记录浏览器里找那个已经不存在的按钮。
    //  Blur classification moved to the document panel's "away and idle" block — one list inside a
    //  panel instead of a layer of modal. A line of signposting beats a button that no longer exists.
    root.createDiv({ cls: 'rtt-empty-hint', text: t('unfocusedMoved') });
    // day navigation
    const nav = root.createDiv({ cls: 'rtt-timeline-nav' });
    const prev = nav.createEl('button', { cls: 'rtt-nav-btn', text: '‹' });
    prev.setAttribute('aria-label', t('prevDay'));
    prev.addEventListener('click', (event) => {
      event.stopPropagation();
      this.day = shiftDay(this.day, -1);
      this.render();
    });

    nav.createSpan({ cls: 'rtt-nav-date', text: `${record.fileName} · ${this.day}` });

    const next = nav.createEl('button', { cls: 'rtt-nav-btn', text: '›' });
    next.setAttribute('aria-label', t('nextDay'));
    next.addEventListener('click', (event) => {
      event.stopPropagation();
      this.day = shiftDay(this.day, 1);
      this.render();
    });

    const todayBtn = nav.createEl('button', { text: t('todayLabel') });
    todayBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.day = todayStr();
      this.render();
    });

    const rows = buildRecordDayRows(record.readTimeLine, this.day);
    const hasAny = rows.some((row) => row.segments.length > 0);

    if (!hasAny) {
      root.createDiv({ cls: 'rtt-list-empty', text: t('noDay') });
      return;
    }

    // the day's three-channel summary
    const channels = recordDayChannels(record.readTimeLine, this.day);
    const summary = root.createDiv({ cls: 'rtt-records-meta' });
    summary.createSpan({ text: `${t('tabInWindow')} ${formatReadTime(channels.inWindow, mode)}` });
    summary.createSpan({ text: `${t('tabUnfocused')} ${formatReadTime(channels.outOfWindow, mode)}` });
    summary.createSpan({ text: `${t('recChannelPaused')} ${formatDurationWithSeconds(channels.paused)}` });

    //  Shared with the sidebar's document panel — one template and one colouring, instead of
    //  two copies that drift. The legend is shared too: same entries, same toggles.
    const legend: LegendEntry[] = [
      { key: CHANNEL_CLASSES['in-window'], className: CHANNEL_CLASSES['in-window'], label: t('tabInWindow') },
      { key: CHANNEL_CLASSES['out-of-window'], className: CHANNEL_CLASSES['out-of-window'], label: t('tabUnfocused') },
      { key: CHANNEL_CLASSES.paused, className: CHANNEL_CLASSES.paused, label: t('recChannelPaused') },
    ];
    renderHeatmapLegend(root, legend, this.hiddenHeatmap, (key) => {
      if (this.hiddenHeatmap.has(key)) this.hiddenHeatmap.delete(key);
      else this.hiddenHeatmap.add(key);
      this.render();
    });

    renderHeatmap(
      root,
      filterRowsByClass(rows, readingChannelClass, this.hiddenHeatmap),
      readingChannelClass,
      readingChannelLabel,
    );
  }
}
