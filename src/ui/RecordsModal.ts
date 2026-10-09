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

import { Modal, Notice, Setting, setIcon, type App } from 'obsidian';

import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { shiftDay } from '../core/manualTimeline';
import {
  buildRecordDayRows,
  isInWeekOf,
  recordDayChannels,
  recordDaySeconds,
} from '../core/recordsTimeline';
import { formatDurationWithSeconds, formatReadTime, todayStr } from '../core/time';
import { buildFileRecords } from '../core/timeline';
import {
  readingChannelClass,
  readingChannelLabel,
  renderHeatmap,
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
  clock: Clock;
  settings: () => PluginSettings;
  log: Logger;

  onChanged?: () => void;
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

  /** reading seconds this week. */
  private weekSeconds(all: Record<string, FileRecord>): number {
    const today = todayStr();
    let total = 0;

    for (const record of Object.values(all)) {

      //  Only the days the file actually has records on, instead of seven full scans
      const days = new Set<string>();
      for (const session of record.readTimeLine) {
        for (const time of Object.keys(session)) {
          days.add(time.slice(0, 10));
        }
      }
      for (const day of days) {
        if (isInWeekOf(day, today)) total += recordDaySeconds(record.readTimeLine, day);
      }
    }

    return total;
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

    const cards: Array<{ label: string; value: string }> = [
      { label: t('statsToday'), value: formatReadTime(todaySeconds, mode) },
      { label: t('statsTodaySessions'), value: String(todaySessions) },
      { label: t('statsWeek'), value: formatReadTime(this.weekSeconds(all), mode) },
      { label: t('recTotalFiles').replace('{n}', String(Object.keys(all).length)), value: '' },
    ];

    const bar = root.createDiv({ cls: 'rtt-stats-bar' });
    for (const card of cards) {
      const el = bar.createDiv({ cls: 'rtt-stats-card' });
      el.createDiv({ cls: 'rtt-stats-label', text: card.label });
      if (card.value) el.createDiv({ cls: 'rtt-stats-value', text: card.value });
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
      stats.createSpan({
        cls: 'rtt-item-session-val',
        text: formatReadTime(record.totalReadTime, mode),
      });

      //  The out-of-window part is listed separately so the split stays visible here too
      if (record.unfocusedReadTime > 0) {
        stats.createSpan({ cls: 'rtt-item-sep', text: ' · ' });

        //  A non-breaking space: an ordinary space collapses at a span boundary and glues

        stats.createSpan({ cls: 'rtt-item-session-label', text: `${t('tabUnfocused')} ` });
        stats.createSpan({
          cls: 'rtt-item-session-val',
          text: formatReadTime(record.unfocusedReadTime, mode),
        });
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
    //  two copies that drift.
    renderHeatmap(root, rows, readingChannelClass, readingChannelLabel);
  }
}
