import { activityRuns } from '../core/activityRuns';
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
import {
  formatDurationParts,
  formatDurationWithSeconds,
  formatReadTimeParts,
  parseSessionStartTime,
  todayStr,
  type DurationPart,
} from '../core/time';
import { getLang, t } from '../core/i18n';
import { countsPluginViewsAsReading, countsUnfocusedAsReading } from '../core/settings';
import type { Logger } from '../core/logger';
import {
  buildManualDayFlags,
  buildManualDayRows,
  flagIntervals,
  manualDayTotalSeconds,
  manualSessionsOfDay,
  shiftDay,
} from '../core/manualTimeline';
import { selectManualElapsedSeconds } from '../core/selectors';
import {
  buildOverviewRows,
  documentIntervals,
  manualIntervals,
  overviewTotals,
  overviewWeekTotals,
} from '../core/overview';
import { buildDocumentDayRows, weekReadingSeconds } from '../core/recordsTimeline';
import { isPluginViewKey } from '../core/activePath';
import {
  CHANNEL_CLASSES,
  filterRowsByClass,
  readingChannelClass,
  readingChannelLabel,
  renderHeatmap,
  renderHeatmapLegend,
  renderSegmentDetail,
  selectSegment,
  type HeatmapBlock,
  type HeatmapRow,
  type HeatmapSegment,
  type LegendEntry,
} from './heatmapRender';
import { renderTimelineList, type TimelineNode } from './timelineList';
import { HScrollTicker } from './hScrollTicker';
import { createSecondPie } from './secondPie';
import { docState, stateIcon } from './StatusBar';
import { UnfocusedModal } from './UnfocusedModal';
import { renderManualFlagsTable, renderManualSessionDetail } from './manualSessionDetail';
import { appendDurationParts, setClockTime, setReadTime } from './durationText';
import {
  buildFileRecords,
  getDayChannelSeconds,
  getAllTodaySeconds,
  getTodaySeconds,
  getTodaySessionCount,
} from '../core/timeline';
import { liveWallClockSeconds } from '../core/types';
import type { FileRecord, PluginSettings, TimelineEvent } from '../core/types';
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
type LiveKey =
  | 'session'
  | 'unfocused'
  | 'fileToday'
  | 'today'
  | 'todayRead'
  | 'todayUnread'
  | 'manual';

interface LiveNodes {
  /** 当前计时状态卡第一行：本轮时长 / the session card's headline: this round's duration */
  session?: HTMLElement;
  /** 第二行尾部「-空窗/暂停」的数值 / the figure at the end of line 2, the away-and-paused part */
  unfocused?: HTMLElement;
  /** …连同它前面的分隔符，为 0 时整段收起 / the wrapper around it, hidden while it is zero */
  unfocusedBox?: HTMLElement;

  /** 状态卡第三行：该文件今日合计 / line 3 of the card: the file's total today */
  fileToday?: HTMLElement;

  /** 计时中的 60 秒圆饼 / the 60-second pie inside the running badge */
  pie?: HTMLElement;

  /** 四宫格 / the stat grid */
  today?: HTMLElement;
  todayRead?: HTMLElement;
  todayUnread?: HTMLElement;

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

  /** Whether the overview's day detail is expanded past its first few entries. */
  private overviewExpanded = false;

  /**
   * 手动计时的专注视图 / the manual timer's focus view.
   *
   * 只留大圆环与本轮的标记表：秒表是这一屏唯一要读的东西，开关、统计、热力图、记录都收起来。
   * Only the big ring and this round's marks stay: the stopwatch is the one thing to read on this
   * screen, so the switches, stats, heatmap and session list fold away.
   */
  private manualFocus = false;

  /**
   * 标记表是否常显示 / whether the mark table is pinned open.
   *
   * 与"悬停偷看"分开：悬停是临时的（鼠标离开就收），点击是持久状态。分开存，重绘后常显示才记得住。
   * Kept apart from the hover peek: hovering is transient (it folds away when the pointer leaves) while
   * a click is a state. Stored separately so a re-render remembers the pin.
   */
  private manualFocusTablePinned = false;

  /** whether the hand-drawn calendar popover is open */
  private calendarOpen = false;

  /**
   * the month the calendar is showing.
   * Separate from `day` (the selected date): turning pages is not choosing, and the user may
   * browse and pick nothing.
   */
  private calendarMonth = '';

  private calendarDismiss: (() => void) | null = null;

  /**
   * 状态卡上那个横向滚动的文件名 / the file name scrolling along the card.
   * 重绘会换掉它所在的节点，所以每次重绘都要把上一个停掉，否则每绘一次就多一个还在量布局的定时器。
   * A re-render replaces the node it runs on, so each render has to stop the previous one — otherwise
   * every render leaves behind a timer still measuring layout.
   */
  private nameTicker: HScrollTicker | null = null;

  /**
   * 侧栏够不够宽 / whether the sidebar is wide enough to fold into two columns.
   *
   * 用 ResizeObserver 而不是 CSS 容器查询：容器查询要求给滚动容器加 contain，而面板顶部的吸顶标签
   * 依赖那个滚动容器建立 sticky 上下文 —— 为了两列去动它不值。
   *
   * A ResizeObserver rather than a CSS container query: the latter needs contain on the scroller,
   * and the sticky panel tabs depend on that scroller being their sticky context. Not worth moving it
   * for a two-column layout.
   */
  private widthObserver: ResizeObserver | null = null;

  /** 折成两列所需的宽度 / the width at which the fold makes sense. */
  private static readonly WIDE_PX = 600;

  /**
   * 被图例关掉的那几类 / the kinds the legend has switched off.
   *
   * 键就是段的取色类（文档/总看板）或覆盖层的自报名（手动面板的暂停块、标记），所以三个面板的键
   * 互不冲突，共用一个集合即可。它是**结构**的一部分：关掉一类会改变图里有哪些段，因此必须进签名。
   *
   * The keys are the segments' colouring classes (document / overview) or the overlays' own names
   * (the manual panel's pause blocks and marks), so the three panels cannot collide and one set
   * serves them all. It is part of the *structure*: hiding a kind changes which segments the chart
   * has, so it belongs in the signature.
   */
  private hiddenHeatmap = new Set<string>();

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

    //  宽度变了只切一个类，不重绘：两列是纯排版，重建 DOM 会把滚动位置和选中状态一起丢掉。
    //  A width change only flips a class, never re-renders: the fold is pure layout, and rebuilding the
    //  DOM would throw away scroll position and selection with it.
    this.widthObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      this.contentEl.toggleClass('is-wide', width >= ActivitySidebarView.WIDE_PX);
    });
    this.widthObserver.observe(this.contentEl);
  }

  override async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.widthObserver?.disconnect();
    this.widthObserver = null;
    this.nameTicker?.destroy();
    this.nameTicker = null;
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

  /**
   * 宽侧栏时的两列 / two columns when the sidebar is wide.
   *
   * 语义是「把现有的上下顺序从中间折成左右」：左列放上面那部分，右列放下面那部分。窄时两列叠成一列，
   * DOM 顺序不变 —— 于是只有一套渲染路径，两种宽度共用。
   *
   * The idea is to fold the existing top-to-bottom order into two columns: the upper part on the left,
   * the lower part on the right. Narrow, they stack and the DOM order is unchanged — one rendering
   * path serves both widths.
   */
  private createColumns(root: HTMLElement): { left: HTMLElement; right: HTMLElement } {
    const cols = root.createDiv({ cls: 'rtt-panel-cols' });
    return {
      left: cols.createDiv({ cls: 'rtt-panel-col' }),
      right: cols.createDiv({ cls: 'rtt-panel-col' }),
    };
  }

  /** 点图例：把这一类收起 / 放回 / toggle one kind off the chart and back. */
  private toggleHeatmapClass(key: string): void {
    if (this.hiddenHeatmap.has(key)) this.hiddenHeatmap.delete(key);
    else this.hiddenHeatmap.add(key);
    this.render();
  }

  /**
   * Draw a heatmap whose stretches open a "what happened" block when clicked.
   *
   * The detail container is created *after* the chart because it has to sit below it, while
   * `renderHeatmap` appends the chart itself. That ordering is safe because the click
   * callback can only run once the user interacts — long after the assignment below.
   *
   * 详情块必须在图**下方**，而图由 renderHeatmap 自行追加，所以它是先声明、后创建；回调只会在
   * 用户点击时触发，那时赋值早已完成。
   */
  private renderClickableHeatmap<S extends HeatmapSegment>(
    parent: HTMLElement,
    rows: readonly HeatmapRow<S>[],
    classOf: (segment: S) => string,
    labelOf: (segment: S) => string,
    describe: (block: HeatmapBlock<S>, hour: number) => {
      what: string;
      icon: string;
      kind?: string;
    },
    /** The event log, so the stretch can list the operations recorded inside it. */
    events: readonly TimelineEvent[],
    /** The day the chart was drawn for, so the detail can name the right clock times. */
    day: string,
    /** 图例条目；给了就在图**上方**画一条可点的图例 / legend entries; drawn above the chart */
    legend?: readonly LegendEntry[],
    /** Extra layer drawn inside each row's track; see `renderHeatmap`. */
    overlay?: (bar: HTMLElement, hour: number) => void,
    detail?: { groupOf: (segment: S) => string; render: (panel: HTMLElement, segment: S) => void },
  ): boolean {
    let panel: HTMLElement | null = null;

    //  图例在图上方，与图共用同一套取色类：点名字隐藏那一类，段被滤掉但行与坐标不动，再点回原位。
    //  The legend sits above the chart and shares its colouring classes: clicking a name hides that
    //  kind, the rows and their coordinates stay put, and clicking again restores the exact picture.
    if (legend && legend.length > 0) {
      renderHeatmapLegend(parent, legend, this.hiddenHeatmap, (key) => this.toggleHeatmapClass(key));
    }

    const shown = filterRowsByClass(rows, classOf, this.hiddenHeatmap);

    const runs = activityRuns(shown);
    const groupOf = detail?.groupOf ?? ((segment: S) => runs.get(segment)!.id);
    const drawn = renderHeatmap(
      parent,
      shown,
      classOf,
      labelOf,
      (block, hour, element) => {
        if (!panel) return;
        const isSelected = selectSegment(parent, element, groupOf(block.members[0]!));
        panel.empty();
        // Clicking the lit stretch again clears it, so the block can be dismissed in place.
        if (!isSelected) return;
        if (detail) { detail.render(panel, block.members[0]!); return; }
        const run = runs.get(block.members[0]!)!;
        const members = shown.flatMap(row => row.segments).filter(segment => runs.get(segment) === run);
        const info = describe({ ...block, members }, hour);
        renderSegmentDetail(panel, {
          hour,
          segment: { ...block, startMinute: run.start - hour * 60, durationMinutes: run.end - run.start },
          what: info.what,
          icon: info.icon,
          kind: info.kind,
          pieces: members.length,
          events,
          day,
        });
      },
      overlay,
      groupOf,
    );

    if (!drawn) return false;
    panel = parent.createDiv({ cls: 'rtt-hm-detail' });
    return true;
  }

  /**
   * Reveal a panel from outside the view / 由外部切换到某个面板.
   * Used by the status bar, whose items jump to the panel their duration belongs to.
   */
  showPanel(panel: Panel): void {
    this.setPanel(panel);
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
      //  It changes every duration shown, so flipping it must recompute at once; without it
      //  the panels keep displaying the old accounting until some unrelated state change
      //  happens to trigger a re-render.
      settings.countUnfocusedAsReading,
      settings.countPluginViewsAsReading,
      String(this.deps.history.getEvents().length),
      state.activeFilePath ?? '-',
      state.isWindowFocused,
      state.files.get(state.activeFilePath ?? '')?.splitReading,
      state.isIdle,
      state.manual.status,

      //  The mark count belongs in the signature: it shapes the marks section, and leaving
      //  it out means marks placed through the service never appear.
      String(state.manual.flags.length),

      //  Expanding the manual list changes how many rows it has, so it belongs here
      String(this.manualExpanded),
      String(this.overviewExpanded),
      String(this.manualFocus),

      //  The calendar's open state shapes the DOM; without it turning pages would not redraw
      String(this.calendarOpen),
      this.calendarMonth,
      state.files.get(state.activeFilePath ?? '')?.status ?? '-',

      //  图例的开关决定图里有哪些段，属于结构；不进签名就点了没反应
      //  The legend's toggles decide which segments the chart has — structure, so without them in
      //  the signature a click would do nothing.
      [...this.hiddenHeatmap].sort().join(','),
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
      //  re-render adds another pair holding already-detached nodes. The name ticker goes the same
      //  way: its nodes are about to be replaced.
      this.calendarDismiss?.();
      this.nameTicker?.destroy();
      this.nameTicker = null;
      root.empty();
      this.liveNodes = {};
      this.signature = this.computeSignature();

      //  每次重绘都按当前宽度定一次，不单靠观察者：观察者的首次回调可能赶在布局之前（宽度读到 0），
      //  之后又不再变化，于是类名一直没加上。
      //  Settle the class on every render rather than trusting the observer alone: the observer's first
      //  callback can land before layout (width 0) and then never fire again, leaving the class off.
      this.contentEl.toggleClass(
        'is-wide',
        this.contentEl.clientWidth >= ActivitySidebarView.WIDE_PX,
      );

      //  A degraded store must be obvious, or the user assumes records are being saved. It stays
      //  full width: it is about the whole plugin, not about one column.
      const warning = this.deps.storageWarning();
      if (warning) {
        root.createDiv({ cls: 'rtt-warning-text', text: warning });
      }

      //  专注视图不是把几块藏起来，而是换成一个覆盖整幅的视图：下面那些区块干脆不渲染。
      //  The focus view is not a few blocks hidden — it is one view covering the whole area, and the
      //  blocks underneath are simply not rendered.
      if (this.panel === 'manual' && this.manualFocus) {
        this.renderManualFocus(root);
        this.updateLiveNumbers();
        return;
      }

      //  两列在这里建，而不是各面板自己建：面板标签属于「上面那部分」，要和面板内容一起落在左列。
      //  The columns are built here rather than inside each panel: the panel tabs belong to the upper
      //  part and have to land in the left column together with the panel's own content.
      const { left, right } = this.createColumns(root);
      this.renderPanelTabs(left);

      if (this.panel === 'document') this.renderDocumentPanel(left, right);
      else if (this.panel === 'manual') this.renderManualPanel(left, right);
      else this.renderOverviewPanel(left, right);

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
   * whether to render the today-total cell.
   *
   * 统计卡现在是把「今日总时长」拆成阅读与非阅读的两格之和，所以这一格不该在按下开始的瞬间消失 ——
   * 会闪的一格算不上宫格。设置里的 `never` 仍然可以把它去掉，另两个取值都显示。
   *
   * The grid now decomposes "today total" into reading plus non-reading, so this cell must not
   * vanish the moment a session starts: a cell that blinks in and out is not a grid. `never`
   * still removes it; the other two values show it.
   */
  private shouldShowTodayTotal(settings: PluginSettings): boolean {
    return settings.todayTotalDisplay !== 'never';
  }

  /** The statistic cards. */
  private renderStatCards(
    parent: HTMLElement,
    cards: Array<{
      label: string;
      /** Plain text for counts; use `seconds` for anything that is a duration. */
      value?: string;
      /** A duration, rendered with the muted-unit treatment. */
      seconds?: number;
      liveKey?: LiveKey;
      /** 点击整张卡片的动作 / what clicking the whole card does */
      onClick?: () => void;
    }>,
  ): void {
    const mode = this.deps.settings().timeDisplayMode;
    const bar = parent.createDiv({ cls: 'rtt-stats-bar' });

    for (const card of cards) {
      const el = bar.createDiv({ cls: 'rtt-stats-card' });
      el.createDiv({ cls: 'rtt-stats-label', text: card.label });

      const value = el.createDiv({ cls: 'rtt-stats-value' });
      if (card.seconds !== undefined) setReadTime(value, card.seconds, mode);
      else if (card.value !== undefined) value.setText(card.value);

      if (card.liveKey) this.liveNodes[card.liveKey] = value;

      if (card.onClick) {
        el.addClass('is-clickable');
        setTooltip(el, t('listShowStretch'));
        el.addEventListener('click', card.onClick);
      }
    }
  }

  /** The document-tracking panel. */
  private renderDocumentPanel(left: HTMLElement, right: HTMLElement): void {
    const settings = this.deps.settings();
    if (!settings.documentTrackingEnabled) {
      left.createDiv({ cls: 'rtt-empty-hint', text: t('trackerOff') });
      left.createDiv({ cls: 'rtt-empty-hint', text: t('trackerOffDesc') });
      return;
    }

    const state = this.deps.store.getState();
    const filePath = state.activeFilePath;

    //  The records are derived once: the stat grid, the heatmap and the list all read the same
    //  result, so computing twice is both slower and open to disagreeing mid-render.
    const records = buildFileRecords(
      this.deps.history.getEvents(),
      this.deps.clock.now(),
      todayStr(),
      { countUnfocused: countsUnfocusedAsReading(settings), countPluginViews: countsPluginViewsAsReading(settings) },
    );

    //  自上而下三段：此刻的数字（四宫格 → 当前状态）、这一天的形状（热力图）、这一天的排名（列表）。
    //  热力图贴着列表，两者说的都是"今天这一天"；当前状态卡与四宫格说的都是"现在"。
    //  Top to bottom: the numbers for now (grid, then the current-session card), the shape of the
    //  day (the heatmap), and the day's ranking (the list). The heatmap sits against the list —
    //  both describe the day — while the card joins the grid as the "right now" block.
    //  上：此刻的数字（四宫格 + 当前状态）；下：这一天的形状与排名
    //  Top: the numbers for now (grid + current session); bottom: the day's shape and ranking
    this.renderDocumentStats(left, records, settings);
    this.renderCurrentSession(left, filePath, records);
    this.renderDocumentHeatmap(right, records);
    this.renderTodayList(right, records);
  }

  /**
   * 文档面板顶部的四宫格 / the four-cell grid at the top of the document panel.
   *
   * 今日总时长拆成阅读与非阅读：三种时间（窗口内专注、脱离窗口、暂停）里，前一种算阅读，后两种
   * 算非阅读，于是「总 = 阅读 + 非阅读」永远成立，四格里的三个数也永远互不相等 —— 否则两格显示
   * 同一个数，格子就白占了。
   *
   * Today's total splits into reading and non-reading: of the three channels the tracker records
   * (in-window, out-of-window, paused) the first is reading and the other two are not, so
   * "total = reading + non-reading" always holds and the three figures never coincide — two cells
   * showing the same number would waste the space.
   */
  private renderDocumentStats(
    root: HTMLElement,
    records: Record<string, FileRecord>,
    settings: PluginSettings,
  ): void {
    //  Placeholder zeros: updateLiveNumbers overwrites them before the paint settles. They only
    //  have to be durations so the unit markup exists to be updated.
    const cards: Array<{
      label: string;
      value?: string;
      seconds?: number;
      liveKey?: LiveKey;
    }> = [];

    if (this.shouldShowTodayTotal(settings)) {
      cards.push({ label: t('statsTodayTotal'), seconds: 0, liveKey: 'today' });
    }
    cards.push({ label: t('statsTodayRead'), seconds: 0, liveKey: 'todayRead' });
    cards.push({ label: t('statsTodayUnread'), seconds: 0, liveKey: 'todayUnread' });

    //  本周是慢变量：它由已落盘的记录算出，不含正在进行的会话尾段，所以不需要每秒重算
    //  The week figure is a slow variable — derived from settled records, without the running
    //  session's tail — so it needs no per-second recomputation.
    cards.push({
      label: t('statsWeekRead'),
      seconds: weekReadingSeconds(
        Object.values(records).map((record) => record.readTimeLine),
        todayStr(),
      ),
    });

    this.renderStatCards(root, cards);
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
    // Notes only: plugin views have their own channel, shown in the overview panel.
    const rows = buildDocumentDayRows(
      Object.entries(records)
        .filter(([key]) => !isPluginViewKey(key))
        .map(([, record]) => record.readTimeLine),
      todayStr(),
    );

    new Setting(root).setName(t('docHeatmapTitle')).setHeading();

    const drawn = this.renderClickableHeatmap(
      root,
      rows,
      readingChannelClass,
      readingChannelLabel,
      (block) => ({
        what: readingChannelLabel(block.members[0]!),
        icon: 'file-text',
        kind: 'document',
      }),
      this.deps.history.getEvents(),
      todayStr(),
      [
        { key: CHANNEL_CLASSES['in-window'], className: CHANNEL_CLASSES['in-window'], label: t('tabInWindow') },
        { key: CHANNEL_CLASSES['out-of-window'], className: CHANNEL_CLASSES['out-of-window'], label: t('tabUnfocused') },
        { key: CHANNEL_CLASSES.paused, className: CHANNEL_CLASSES.paused, label: t('recChannelPaused') },
      ],
    );

    if (!drawn) {
      root.createDiv({ cls: 'rtt-list-empty', text: t('docHeatmapEmpty') });
    }
  }

  /**
   * 当前计时状态卡 / the current-session card.
   *
   * 左边一枚状态图标，右边三行：本轮时长（无标签）、文件名 · 第几轮 · -空窗与暂停、该文件今日合计。
   * 原来这里是"标题 = 文件名 + 一排按钮"，文件名占了一整行的位置而时长反而藏在四宫格里；现在最
   * 该一眼看到的是**这一轮正在跑多久**，文件名退到第二行与轮数同行。
   *
   * An icon on the left and three lines on the right: this round's duration (no label), the file
   * name with the round number and the away-and-paused deduction, then the file's total today.
   * It used to be a file-name heading plus a button row — the name took a whole line while the
   * running duration hid in the grid, when the duration is the thing to read at a glance.
   */
  private renderCurrentSession(
    root: HTMLElement,
    filePath: string | null,
    records: Record<string, FileRecord>,
  ): void {
    const section = root.createDiv({ cls: 'rtt-heatmap-wrap' });
    const state = this.deps.store.getState();
    const mode = this.deps.settings().timeDisplayMode;

    const card = section.createDiv({ cls: 'rtt-live-card' });

    //  计时中不画图标，改画"圆环 + 60 秒圆饼"：圆环是这枚徽标的外框，饼按当前这一分钟的进度走，
    //  每 60 秒转满一圈。跑没跑起来一眼就能看出来，不需要读数字。
    //  While timing, the badge stops drawing a glyph and draws a ring with a 60-second pie instead:
    //  the ring is the badge outline, the pie follows progress through the current minute, filling
    //  once every 60 seconds. Whether the clock is running is then visible without reading a number.
    const iconState = docState(state);
    const icon = card.createDiv({ cls: `rtt-live-icon is-${iconState}` });
    if (iconState === 'running') {
      const pie = createSecondPie(icon);
      this.liveNodes.pie = pie.disc;
    } else {
      setIcon(icon, stateIcon(iconState));
    }

    const body = card.createDiv({ cls: 'rtt-live-body' });

    if (!filePath) {

      //  没有文档可跟随时这张卡只剩一句说明，内容整体居中：左边一枚图标、右边一句左对齐的提示，
      //  在一条空卡里会显得偏在左侧。
      //  With nothing to follow, the card holds one sentence and nothing else, so its content is
      //  centred as a whole: an icon at the left with a left-aligned hint beside it reads as
      //  stranded on the left of an otherwise empty card.
      card.addClass('is-empty');
      body.createDiv({ cls: 'rtt-live-title is-muted', text: t('noOpenFile') });
      return;
    }

    const file = state.files.get(filePath);
    const record = records[filePath];
    const name = record?.fileName ?? filePath;
    const status = file?.status ?? STATUS.IDLE;
    const running = status === STATUS.TRACKING || status === STATUS.PAUSED;

    // line 1 — 本轮有效阅读时长 / this round's reading time, or "not started" ──
    //  两种状态共用同一套三行版式，只有第一行的内容不同：以前未计时会把文件名顶到第一行、第二行写
    //  "未开始"，于是同一个面板在两种状态下长得不一样，看的人得重新认一次。
    //  Both states share one three-line layout and only the first line's content differs. The idle
    //  state used to push the file name up to line 1 and put "not started" on line 2, so the panel
    //  changed shape between the two states and had to be re-read each time.
    if (running) {
      //  A live node: set by updateLiveNumbers on the same tick, so it is created empty. A
      //  placeholder figure would flash a wrong number for one frame.
      this.liveNodes.session = body.createDiv({ cls: 'rtt-live-time' });
    } else {
      body.createDiv({ cls: 'rtt-live-time is-idle', text: t('statusNotStarted') });
    }

    // line 2 — 文件名 · 第 N 轮 [· -mm:ss（空窗或暂停）] ──
    //  单行不放行：文件名超宽就在自己的格子里横向滚动，轮数与被扣掉的时间始终留在原位可见。
    //  One line, never wrapped: an over-wide name scrolls horizontally inside its own cell, so the
    //  round number and the deduction stay put and visible.
    const line2 = body.createDiv({ cls: 'rtt-live-line is-one-line' });
    const nameBox = line2.createSpan({ cls: 'rtt-live-name' });
    const nameTrack = nameBox.createSpan({ cls: 'rtt-live-name-track', text: name });
    line2.createSpan({ cls: 'rtt-live-sep', text: ' · ' });

    //  轮数仍是一个入口：点它看这个文件今天的每一轮
    //  The round count stays an entry point: click it for the file's rounds today.
    const round = line2.createSpan({
      cls: 'rtt-live-round',
      text: t('statusRound').replace(
        '{n}',
        String(getTodaySessionCount(this.deps.history.getEvents(), filePath)),
      ),
    });
    setTooltip(round, t('viewAllRecordsDesc'));
    round.addEventListener('click', () => this.deps.openRecords(filePath));

    //  The deduction names what was *not* reading inside the round beside it; a permanent
    //  "-0秒" would be noise, so the box is hidden while the figure is zero. With nothing running
    //  there is nothing to deduct from, so the box is not built at all.
    if (running) {
      const box = line2.createSpan({ cls: 'rtt-live-deduct' });
      box.createSpan({ cls: 'rtt-live-sep', text: ' · ' });
      this.liveNodes.unfocusedBox = box;
      this.liveNodes.unfocused = box.createEl('button', { cls: 'rtt-live-deduct-value clickable-icon' });
      setTooltip(this.liveNodes.unfocused, t('unfocusedManage'));
      this.liveNodes.unfocused.addEventListener('click', () => new UnfocusedModal(this.app, { history: this.deps.history, service: this.deps.service, log: this.deps.log, filePath, onChanged: () => this.refresh() }).open());
    }

    //  名字太长就在这一行里横着走 / an over-long name scrolls along this row
    this.nameTicker?.destroy();
    this.nameTicker = new HScrollTicker(nameBox, nameTrack);
    this.nameTicker.start();

    // line 3 — 该文件今日合计 / the file's total today ──
    //  Also live: it grows while this round runs, and a frozen figure next to a ticking one
    //  reads as a bug rather than as staleness.
    const line3 = body.createDiv({ cls: 'rtt-live-line' });
    line3.createSpan({ cls: 'rtt-live-label', text: `${t('statusFileToday')} ` });
    const todayTotal = line3.createSpan({ cls: 'rtt-dur' });
    this.liveNodes.fileToday = todayTotal;
    appendDurationParts(
      todayTotal,
      formatReadTimeParts(record?.readTimeToday ?? 0, mode),
    );

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

    new Setting(section)
      .setName(t('splitReading'))
      .setDesc(t('splitReadingDesc'))
      .addToggle((toggle) => toggle.setValue(file?.splitReading === true).onChange((enabled) => {
        void this.deps.service.setSplitReading(enabled).catch((error: unknown) => this.deps.log.warn('[RTT] split reading failed:', error));
      }));
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
      /**
       * Primary figures, separated automatically. A duration is passed as parts so its unit
       * can be drawn muted; a plain string is used for anything that is not a duration.
       */
      stats: Array<string | readonly DurationPart[]>;
      /** the muted meta line; omitted when empty */
      meta?: string[];
      /** Row click: reveal this entry's stretch rather than leaving the panel. */
      onShowStretch?: () => void;
      /** The right-edge control that opens the underlying file. */
      onOpen?: () => void;
      onDelete?: () => void;
      deleteLabel?: string;
    },
  ): void {
    const item = list.createDiv({ cls: 'rtt-list-item' });
    const text = item.createDiv({ cls: 'rtt-item-text' });
    text.createDiv({ cls: 'rtt-item-name', text: options.name });

    const stats = text.createDiv({ cls: 'rtt-item-stats' });
    options.stats.forEach((entry, index) => {
      if (index > 0) stats.createSpan({ cls: 'rtt-item-sep', text: ' · ' });
      const holder = stats.createSpan({ cls: 'rtt-item-session-val' });
      if (typeof entry === 'string') holder.setText(entry);
      else {
        holder.addClass('rtt-dur');
        appendDurationParts(holder, entry);
      }
    });

    if (options.meta && options.meta.length > 0) {
      const meta = text.createDiv({ cls: 'rtt-records-meta' });
      for (const entry of options.meta) meta.createSpan({ text: entry });
    }

    if (options.onShowStretch) {
      item.addClass('is-clickable');
      item.addEventListener('click', options.onShowStretch);
    } else {

      //  The base rule gives every row a pointer cursor; a row that cannot be clicked has to
      //  correct that, or the cursor is lying.
      item.addClass('is-static');
    }

    // Opening the file is its own intention, so it gets one button at the right edge; the
    // row's own click is left for revealing the stretch.
    if (options.onOpen) {
      this.iconButton(item, 'external-link', t('listOpenFile'), options.onOpen, {
        ghost: true,
        stopPropagation: true,
      });
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
      .filter(([key, record]) => !isPluginViewKey(key) && record.readTimeToday > 0)
      .sort((a, b) => b[1].readTimeToday - a[1].readTimeToday)
      .slice(0, TOP_LIST_ITEMS);

    new Setting(root).setName(t('docListTop')).setHeading();

    // Filled after the list, captured by the row callbacks — see renderOverviewList for why
    // the order is safe.
    let detail: HTMLElement | null = null;
    const showStretch = (nodes: TimelineNode[]): void => {
      if (!detail) return;
      detail.empty();
      renderTimelineList(detail, nodes);
    };

    if (rows.length === 0) {
      root.createDiv({ cls: 'rtt-list-empty', text: t('docListEmpty') });
    } else {
      const list = root.createDiv({ cls: 'rtt-list' });
      for (const [filePath, record] of rows) {
        const stats: Array<string | readonly DurationPart[]> = [
          formatReadTimeParts(record.readTimeToday, mode),
        ];
        if (record.unfocusedReadTimeToday > 0) {

          //  A non-breaking space: an ordinary one collapses at a span boundary
          stats.push(`${t('tabUnfocused')}\u00A0`);
          stats.push(formatReadTimeParts(record.unfocusedReadTimeToday, mode));
        }

        const meta: string[] = [];
        if (record.lastReadAt) meta.push(`${t('lastRead')}${record.lastReadAt}`);

        this.renderRecordRow(list, {
          name: record.fileName,
          stats,
          meta,
          onShowStretch: () => showStretch(this.entryStretchNodes(filePath, record, false, mode)),
          onOpen: () => {
            void this.app.workspace.openLinkText(filePath, '', false);
          },
        });
      }
    }

    detail = root.createDiv({ cls: 'rtt-hm-detail' });

    //  The entry stays even with nothing today: otherwise "nothing today" reads as "nothing
    //  at all".
    this.renderViewAllButton(root);
  }

  /** The manual-timer panel. */
  private renderManualPanel(left: HTMLElement, right: HTMLElement): void {
    if (!this.deps.settings().manualTimerEnabled) {
      left.createDiv({ cls: 'rtt-empty-hint', text: t('manualTimerOff') });
      left.createDiv({ cls: 'rtt-empty-hint', text: t('manualTimerOffDesc') });
      return;
    }

    //  上：秒表与开关；下：这一天的热力图与记录
    //  Top: the stopwatch and its switches; bottom: the day's heatmap and sessions
    this.renderManualControls(left);
    this.renderManualToggles(left);
    this.renderManualStats(left);
    this.renderManualHeatmap(right);
    this.renderManualList(right);
  }

  /** manual timer controls. */
  private renderManualControls(root: HTMLElement): void {
    const section = root.createDiv({ cls: 'rtt-heatmap-wrap' });
    new Setting(section).setName(t('panelManual')).setHeading();

    this.renderStopwatch(section);

    const bar = section.createDiv({ cls: 'rtt-timeline-nav' });
    this.renderManualButtons(bar);
    this.renderManualFlags(section);
  }

  /**
   * 秒表的操作按钮 / the stopwatch's control row.
   *
   * 抽出来给普通面板与专注视图共用：两处按钮一模一样，各写一份迟早会漏掉某个状态。
   * Pulled out so the panel and the focus overlay share one row: the buttons are identical, and two
   * copies would eventually miss a state in one of them.
   */
  private renderManualButtons(bar: HTMLElement): void {
    const status = this.deps.store.getState().manual.status;

    if (status !== 'idle') {
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

      //  Marking records the net seconds and nothing else: it neither stops the clock nor opens a
      //  prompt, because interrupting focus with a form defeats the point.
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
    } else {
      this.iconButton(bar, 'play', t('manualStart'), () => {
        this.deps.manual.start();
        this.render();
      });
    }

    //  专注切换放最右，任何状态都在：它切的是"看什么"，不是计时动作。
    //  The focus toggle sits at the end and is present in every state: it switches what is shown,
    //  never what is timed.
    this.iconButton(
      bar,
      this.manualFocus ? 'minimize-2' : 'maximize-2',
      this.manualFocus ? t('manualFocusOff') : t('manualFocusOn'),
      () => {
        this.manualFocus = !this.manualFocus;
        this.render();
      },
      { ghost: true },
    );
  }

  /**
   * 专注视图 / the focus view.
   *
   * 一整块覆盖视图：中间大圆环，圆环下面是操作按钮，右侧是标记表。表格的显示由一个按钮控制 ——
   * 悬停偷看（离开就收），点击切换常显示。触屏没有悬停，所以点击那条路必须自己就够用。
   *
   * One overlay: the big ring centred, its buttons underneath, the mark table on the right. The table
   * is controlled by one button — hovering peeks it (and leaving folds it away), clicking toggles
   * whether it stays. A touch screen has no hover, so the click path has to stand on its own.
   */
  private renderManualFocus(root: HTMLElement): void {
    const overlay = root.createDiv({ cls: 'rtt-focus-overlay' });
    if (this.manualFocusTablePinned) overlay.addClass('is-pinned');

    const main = overlay.createDiv({ cls: 'rtt-focus-main' });
    this.renderStopwatch(main);

    const bar = main.createDiv({ cls: 'rtt-timeline-nav' });
    this.renderManualButtons(bar);

    //  表格开关：浮在右下角 —— 它管的是"看什么"，不是计时动作，所以不占按钮那一行。
    //  The table control floats in the bottom-right corner: it decides what is shown, not what is
    //  timed, so it does not take a slot in the button row.
    const tools = overlay.createDiv({ cls: 'rtt-focus-tools' });
    const tableBtn = this.iconButton(
      tools,
      'flag',
      t('manualFocusTable'),
      () => {
        this.manualFocusTablePinned = !this.manualFocusTablePinned;
        overlay.toggleClass('is-pinned', this.manualFocusTablePinned);
        tableBtn.setAttribute('aria-pressed', String(this.manualFocusTablePinned));
      },

      //  不要 ghost：这枚按钮要带强调色圆底，ghost 会把底色和颜色一起抹平
      //  Not ghost: this one carries an accent circle, and ghost would flatten both its fill and colour
      {},
    );
    tableBtn.setAttribute('aria-pressed', String(this.manualFocusTablePinned));

    //  悬停偷看：只动类，不重绘 —— 表格的位置与内容都不用重建
    //  Hover peeks: a class only, never a re-render — neither the table's place nor its content changes.
    tableBtn.addEventListener('mouseenter', () => overlay.addClass('is-peek'));
    tableBtn.addEventListener('mouseleave', () => overlay.removeClass('is-peek'));

    const side = overlay.createDiv({ cls: 'rtt-focus-side' });
    this.renderManualFlagTable(side);
  }

  /**
   * 本轮的标记表 / this round's marks, as a table.
   *
   * 专注视图里用表格而不是胶囊：这里读的是"第几轮、几点、隔了多久"三列对齐的数据，一排圆角小标签
   * 每次都要重新对齐眼睛。
   *
   * A table rather than chips in the focus view: what is read here is three aligned columns — which
   * round, at what time, how long it took — and a row of rounded chips makes the eye re-align them
   * every time.
   */
  private renderManualFlagTable(root: HTMLElement): void {
    const flags = this.deps.store.getState().manual.flags;

    new Setting(root).setName(t('manualFlagsTitle')).setHeading();

    if (flags.length === 0) {
      root.createDiv({ cls: 'rtt-list-empty', text: t('manualNoFlags') });
      return;
    }

    //  三列：标记（带图标）/ 时间差（距上一轮）/ 累计时长（这一轮跑了多久）
    //  Three columns: the mark (with its icon), the gap since the previous one, and how long the
    //  round had been running when it was placed.
    const intervals = flagIntervals(flags);
    const table = root.createEl('table', { cls: 'rtt-flag-table' });
    const head = table.createEl('thead').createEl('tr');
    for (const label of [t('manualFlagCol'), t('manualFlagDiff'), t('manualFlagRecorded')]) {
      head.createEl('th', { text: label });
    }

    const body = table.createEl('tbody');
    for (const [index, mark] of flags.entries()) {
      const row = body.createEl('tr');
      const cell = row.createEl('td', { cls: 'rtt-flag-cell' });
      setIcon(cell.createSpan({ cls: 'rtt-flag-cell-icon' }), 'flag');
      cell.createSpan({ text: t('manualFlagRow').replace('{n}', String(index + 1)) });
      row.createEl('td', { text: formatDurationWithSeconds(intervals[index] ?? 0) });
      row.createEl('td', { text: formatDurationWithSeconds(mark.atSeconds) });
    }
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

    if (state.manual.status === 'idle' && flags.length === 0) return;

    new Setting(root).setName(t('manualFlagsTitle')).setHeading();

    renderManualFlagsTable(root, flags);
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
  private renderOverviewPanel(ovLeft: HTMLElement, ovRight: HTMLElement): void {
    const settings = this.deps.settings();
    if (!settings.documentTrackingEnabled && !settings.manualTimerEnabled) {
      ovLeft.createDiv({ cls: 'rtt-empty-hint', text: t('ovEmpty') });
      return;
    }

    const records = buildFileRecords(
      this.deps.history.getEvents(),
      this.deps.clock.now(),
      todayStr(),
      { countUnfocused: countsUnfocusedAsReading(settings), countPluginViews: countsPluginViewsAsReading(settings) },
    );

    // Records split by kind: notes are one ledger, plugin views (RSS dashboard, translator,
    // canvas) are another. Both are reading, so both count — but they stay separable.
    const entries = Object.entries(records);
    const noteTimelines = entries
      .filter(([key]) => !isPluginViewKey(key))
      .map(([, record]) => record.readTimeLine);
    const viewTimelines = entries
      .filter(([key]) => isPluginViewKey(key))
      .map(([, record]) => record.readTimeLine);

    const manualSessions = this.deps.history.getManualSessions();
    const intervals = [
      ...documentIntervals(noteTimelines, { includeUnfocused: countsUnfocusedAsReading(settings) }),
      ...(countsPluginViewsAsReading(settings) ? documentIntervals(viewTimelines, { source: 'view', includeUnfocused: countsUnfocusedAsReading(settings) }) : []),
      ...manualIntervals(manualSessions),
    ];

    const totals = overviewTotals(intervals, this.day);

    //  本周那一格把"非阅读"也算进去，不看「脱离窗口计入阅读」这个开关：它报的是**记录到的总时间**
    //  （窗口内 + 脱离窗口 + 暂停），而不是"读了多久"。单日那几格跟着开关走，两者含义不同，所以
    //  这里另取一份含窗口外的区间，而不是复用上面那份。
    //  The week cell counts non-reading time too, whatever the "out-of-window counts as reading"
    //  toggle says: it reports **total recorded time** (in-window + away + paused), not "how long
    //  was read". The day cells follow the toggle, so the two mean different things and this takes
    //  its own interval set rather than reusing the one above.
    const weekIntervals = [
      ...documentIntervals(noteTimelines, { includeUnfocused: true }),
      ...documentIntervals(viewTimelines, { source: 'view', includeUnfocused: true }),
      ...manualIntervals(manualSessions),
    ];
    const week = overviewWeekTotals(weekIntervals, this.day);

    //  上：合计；下：日导航 + 热力图 + 明细 —— 导航必须跟着它描述的那张图走
    //  Top: the totals; bottom: day nav, heatmap and detail — the nav has to travel with the chart it
    //  describes
    this.renderStatCards(ovLeft, [
      { label: t('ovUnion'), seconds: Math.round(totals.unionMinutes * 60) },
      { label: t('ovWeekTotal'), seconds: Math.round(week.unionMinutes * 60) },
      { label: t('ovDocument'), seconds: Math.round(totals.documentMinutes * 60) },
      { label: t('ovView'), seconds: Math.round(totals.viewMinutes * 60) },
      { label: t('ovManual'), seconds: Math.round(totals.manualMinutes * 60) },
      { label: t('ovOverlap'), seconds: Math.round(totals.overlapMinutes * 60) },
    ]);

    // day navigation
    const head = ovRight.createDiv({ cls: 'rtt-heatmap-wrap' });
    this.renderDayNav(head);

    const rows = buildOverviewRows(weekIntervals, this.day);
    const hasAny = rows.some((row) => row.segments.length > 0);

    if (!hasAny) {
      head.createDiv({ cls: 'rtt-list-empty', text: t('ovEmpty') });
      return;
    }

    //  图例改由 renderClickableHeatmap 画在图上方，且可点（见 LegendEntry）；原来这里那条只读图例
    //  就不再单独画了。
    //  The legend is now drawn above the chart by renderClickableHeatmap, and is clickable (see
    //  LegendEntry); the read-only one that used to live here is gone.
    const ovLegend: LegendEntry[] = [
      { key: 'rtt-ov-doc', className: 'rtt-ov-doc', label: t('ovDocument') },
      { key: 'rtt-ov-view', className: 'rtt-ov-view', label: t('ovView') },
      { key: 'rtt-ov-manual', className: 'rtt-ov-manual', label: t('ovManual') },
      { key: 'rtt-ov-both', className: 'rtt-ov-both', label: t('ovLegendBoth') },
    ];

    // One thing, one colour: a stretch covered by a single ledger takes that ledger's
    // colour, and anything covered twice gets the striped "both" fill.
    const sourceClass = (source: string): string =>
      source === 'manual' ? 'rtt-ov-manual' : source === 'view' ? 'rtt-ov-view' : 'rtt-ov-doc';
    const sourceLabel = (source: string): string =>
      source === 'manual' ? t('ovManual') : source === 'view' ? t('ovView') : t('ovDocument');

    this.renderClickableHeatmap(
      head,
      rows,
      (segment) =>
        segment.sources.length > 1 ? 'rtt-ov-both' : sourceClass(segment.sources[0]!),
      (segment) =>
        `${formatDurationWithSeconds(Math.round(segment.durationMinutes * 60))} · ` +
        segment.sources.map(sourceLabel).join(' + '),
      (block) => ({
        // Which ledgers covered this stretch *is* the process here, so the detail names them.
        what: [...new Set(block.members.flatMap(segment => segment.sources))].map(sourceLabel).join(' + '),
        icon: 'activity',
        kind: 'overview',
      }),
      this.deps.history.getEvents(),
      this.day,
      ovLegend,
    );

    ovRight.createDiv({ cls: 'rtt-records-meta', text: t('ovExplain') });
    this.renderOverviewList(ovRight, entries);
  }

  /**
   * The day's detail, as one node timeline / 当日明细：一条节点时间轴.
   *
   * Notes, plugin views and manual sessions share one line so the day reads in sequence,
   * with the icon carrying the kind — telling "I read a note" from "I read the RSS pane" at a
   * glance is the whole point of the icons.
   *
   * 三种来源共用一条轴线，图标负责区分种类 —— 这正是图标存在的意义。
   */
  private renderOverviewList(
    root: HTMLElement,
    records: Array<[string, FileRecord]>,
  ): void {
    const mode = this.deps.settings().timeDisplayMode;

    // Declared before the nodes but filled after the timeline: the detail block has to sit
    // below it, while `renderTimelineList` appends the list itself. Safe because the
    // callbacks only run on click, long after the assignment.
    let detail: HTMLElement | null = null;
    const showStretch = (nodes2: TimelineNode[]): void => {
      if (!detail) return;
      detail.empty();
      renderTimelineList(detail, nodes2);
    };

    const nodes: TimelineNode[] = [];

    // Every entry leads with the stretch and only then the total: the line is a record of
    // *when*, and the duration qualifies it. Leading with the total reads as a scoreboard.
    for (const [key, record] of records) {
      if (record.readTimeToday <= 0) continue;
      const isView = isPluginViewKey(key);
      nodes.push({
        icon: isView ? 'app-window' : 'file-text',
        kind: isView ? 'view' : 'document',
        title: record.fileName,
        lines: [
          this.todayRange(record),
          formatReadTimeParts(record.readTimeToday, mode),
        ].filter(Boolean),
        // The row reveals the stretch; opening the note is a different intention, so it gets
        // its own control instead of being what a stray click does.
        onSelect: () => showStretch(this.entryStretchNodes(key, record, isView, mode)),
        onOpen: isView
          ? undefined
          : () => {
              void this.app.workspace.openLinkText(key, '', false);
            },
        openLabel: t('listOpenFile'),
      });
    }

    for (const session of manualSessionsOfDay(this.deps.history.getManualSessions(), this.day)) {
      nodes.push({
        icon: 'timer',
        kind: 'manual',
        title: session.note || t('noteLabel'),
        lines: [
          `${session.startTime.slice(11, 16)} – ${session.endTime.slice(11, 16)}`,
          formatDurationParts(session.durationSeconds),
        ],
        onSelect: () =>
          showStretch([
            {
              icon: 'timer',
              kind: 'manual',
              title: `${session.startTime.slice(11, 16)} – ${session.endTime.slice(11, 16)}`,
              lines: [
                formatDurationParts(session.durationSeconds),
                ...(session.flags.length > 0
                  ? [
                      `${t('manualFlagsTitle')} ${flagIntervals(session.flags)
                        .map((seconds) => formatDurationWithSeconds(seconds))
                        .join(' · ')}`,
                    ]
                  : []),
              ],
            },
          ]),
      });
    }

    new Setting(root).setName(t('ovListTitle')).setHeading();

    if (nodes.length === 0) {
      root.createDiv({ cls: 'rtt-list-empty', text: t('ovEmpty') });
      return;
    }

    const visible = this.overviewExpanded ? nodes : nodes.slice(0, TOP_LIST_ITEMS);
    renderTimelineList(root, visible);
    detail = root.createDiv({ cls: 'rtt-hm-detail' });

    if (nodes.length > TOP_LIST_ITEMS) {
      const more = root.createEl('button', { cls: 'rtt-view-all-btn' });
      setIcon(
        more.createSpan({ cls: 'rtt-view-all-icon' }),
        this.overviewExpanded ? 'chevron-up' : 'chevron-down',
      );
      more.createSpan({
        cls: 'rtt-view-all-label',
        text: this.overviewExpanded ? t('manualShowLess') : t('manualShowMore'),
      });
      more.addEventListener('click', () => {
        this.overviewExpanded = !this.overviewExpanded;
        this.render();
      });
    }
  }

  /**
   * One entry's reading range today, as `HH:MM – HH:MM`.
   *
   * Taken from the session timestamps rather than stored on the record: the range is what the
   * day-detail line leads with, and deriving it keeps `FileRecord` from carrying yet another
   * pair of fields that can fall out of step.
   */
  private todayRange(record: FileRecord): string {
    const day = todayStr();
    const times: string[] = [];

    for (const session of record.readTimeLine) {
      for (const time of Object.keys(session)) {
        if (time.startsWith(day)) times.push(time);
      }
    }
    if (times.length === 0) return '';

    times.sort();
    return `${times[0]!.slice(11, 16)} – ${times[times.length - 1]!.slice(11, 16)}`;
  }

  /** One entry's today stretches, as the nodes of a detail timeline. */
  private entryStretchNodes(
    key: string,
    record: FileRecord,
    isView: boolean,
    mode: string,
  ): TimelineNode[] {
    const day = todayStr();

    // Stretches first, then fused. A file read on and off is recorded as many short sessions —
    // measured on a real vault, eleven nodes for one note, most of them seconds long — and one
    // node per piece is the same noise the process timeline had.
    const spans: Array<{ from: string; to: string; seconds: number }> = [];

    for (const session of record.readTimeLine) {
      const times = Object.keys(session)
        .filter((time) => time.startsWith(day))
        .sort();
      if (times.length < 2) continue;

      const from = times[0]!;
      const to = times[times.length - 1]!;
      const seconds = Math.max(
        0,
        Math.round(
          (parseSessionStartTime(to)?.getTime() ?? 0) -
            (parseSessionStartTime(from)?.getTime() ?? 0),
        ) / 1000,
      );
      spans.push({ from, to, seconds });
    }

    spans.sort((a, b) => a.from.localeCompare(b.from));

    /** Sessions closer together than this belong to the same sitting. */
    const SAME_SITTING_MS = 5 * 60 * 1000;

    const merged: Array<{ from: string; to: string; seconds: number }> = [];
    for (const span of spans) {
      const previous = merged[merged.length - 1];
      const gap =
        previous ? (parseSessionStartTime(span.from)?.getTime() ?? 0) - (parseSessionStartTime(previous.to)?.getTime() ?? 0) : Infinity;
      if (previous && gap >= 0 && gap <= SAME_SITTING_MS) {
        previous.to = span.to;
        previous.seconds += span.seconds;
        continue;
      }
      merged.push({ ...span });
    }

    // A stretch that banked nothing is a boundary, not a sitting.
    const kept = merged.filter((span) => span.seconds > 0);
    const nodes: TimelineNode[] = (kept.length > 0 ? kept : merged).map((span) => ({
      icon: isView ? 'app-window' : 'file-text',
      kind: isView ? 'view' : 'document',
      title: `${span.from.slice(11, 16)} – ${span.to.slice(11, 16)}`,
      lines: [formatDurationParts(span.seconds)],
    }));

    // A run too short to have two timestamps still happened, so it is named rather than
    // dropped — an empty detail block after a click reads as broken.
    if (nodes.length === 0) {
      nodes.push({
        icon: isView ? 'app-window' : 'file-text',
        kind: isView ? 'view' : 'document',
        title: record.fileName || key,
        lines: [formatReadTimeParts(record.readTimeToday, mode)],
      });
    }

    return nodes;
  }

  /** today's manual total. */
  private renderManualStats(root: HTMLElement): void {
    const sessions = this.deps.history.getManualSessions();
    const today = todayStr();
    const todaySessions = manualSessionsOfDay(sessions, today);

    this.renderStatCards(root, [
      {
        label: t('manualTodayTotal'),
        seconds: manualDayTotalSeconds(sessions, today),
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
    const marks = buildManualDayFlags(sessions, this.day);
    const selectRound = (target: HTMLElement, id: string): void => {
      target.addClass('is-clickable');
      target.setAttribute('role', 'button');
      target.tabIndex = 0;
      const select = (): void => {
        const segment = [...head.querySelectorAll<HTMLElement>('.rtt-hm-seg')].find((element) => element.dataset.rttGroup === id);
        segment?.click();
      };
      target.addEventListener('click', select);
      target.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); }
      });
    };

    //  Manual stretches are green, the same colour the overview gives "manual": one thing
    //  must be one colour across panels, or every legend has to be relearned.
    const drawn = this.renderClickableHeatmap(
      head,
      rows,
      () => 'rtt-hm-manual',
      (segment) =>
        `${segment.session.startTime.slice(11)} · ${formatDurationWithSeconds(segment.session.durationSeconds)}` +
        (segment.session.note ? ` · ${segment.session.note}` : ''),
      (block) => ({
        // The note is what the user wrote about this stretch, so it is the most useful line
        // in the detail block; without it the block would only restate the chart.
        what: block.members[0]!.session.note || t('noteLabel'),
        icon: 'timer',
        kind: 'manual',
      }),
      this.deps.history.getEvents(),
      this.day,
      [
        { key: 'rtt-hm-manual', className: 'rtt-hm-manual', label: t('panelManual') },
        { key: 'pause', className: 'rtt-hm-pause-block', label: t('recChannelPaused') },
        { key: 'flag', className: 'rtt-hm-flag', label: t('manualFlag') },
      ],
      (bar, hour) => {
        // 暂停块：橙色的覆盖层。可以重排的元素与热力图同一坐标系，所以用同一套百分比定位。
        // Pause blocks: an orange overlay, positioned with the same percentages as the chart.
        // 覆盖层不是段，所以不在 filterRowsByClass 的管辖里，隐藏与否由这里自己看图例开关。
        // An overlay is not a segment and so falls outside filterRowsByClass; it consults the legend
        // itself.
        if (!this.hiddenHeatmap.has('pause')) {
          for (const pause of rows[hour]!.pauseSegments) {
            const block = bar.createDiv({ cls: 'rtt-hm-pause-block' });
            setTooltip(block, t('evPause'));
            selectRound(block, pause.session.id);
            block.setCssProps({
              left: `${(pause.startMinute / 60) * 100}%`,
              width: `${Math.max(0.4, (pause.durationMinutes / 60) * 100)}%`,
            });
          }
        }

        // 标记：一枚红色竖线，落在它被打下的那一刻
        // Marks: a red tick at the exact minute the mark was placed.
        if (!this.hiddenHeatmap.has('flag')) {
          for (const mark of marks) {
            if (Math.floor(mark.atMinute / 60) !== hour) continue;
            const tick = bar.createDiv({ cls: 'rtt-hm-flag' });
            selectRound(tick, mark.session.id);
            tick.setCssProps({ left: `${((mark.atMinute % 60) / 60) * 100}%` });
            setTooltip(
              tick,
              `${t('manualFlagAt').replace('{n}', String(mark.index))} · ${formatDurationWithSeconds(
                mark.intervalSeconds,
              )}`,
            );
          }
        }
      },
      { groupOf: (segment) => segment.session.id, render: (panel, segment) => renderManualSessionDetail(panel, segment.session) },
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
          formatDurationParts(session.durationSeconds),
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

      // 每一处都走 setReadTime/setClockTime，而不是 setText：数字与单位是两个节点，
      // 只有重建它们才能保持"单位缩小变灰"的样式。
      // Every one goes through the duration renderers rather than setText: the figure and the
      // unit are separate nodes, and only rebuilding them keeps the muted-unit styling.
      const file = filePath ? state.files.get(filePath) : undefined;

      // 主计时只显示有效阅读秒数，失焦或暂停时冻结；负数独立累计未阅读时长。
      // The headline freezes while away or paused; the deduction keeps counting separately.
      if (this.liveNodes.session) {
        setReadTime(this.liveNodes.session, file?.activeSeconds ?? 0, mode);
      }

      if (this.liveNodes.unfocused) {
        const away = file ? liveWallClockSeconds(file, this.deps.clock.now()) - file.activeSeconds : 0;
        const seconds = Math.floor(away);
        this.liveNodes.unfocused.setText(away > 0 ? `-${Math.floor(seconds / 60)}分${seconds % 60}秒` : '');

        //  为 0 时整段收起：常驻的"-0秒"只是噪声
        //  The whole box collapses at zero: a permanent "-0秒" is only noise
        this.liveNodes.unfocusedBox?.toggleClass('is-empty', away <= 0);
      }

      // 圆饼与主计时同步 / The pie follows the headline's reading seconds.
      if (this.liveNodes.pie) {
        const elapsed = file?.activeSeconds ?? 0;
        this.liveNodes.pie.setCssProps({
          '--rtt-pie-pct': String(((elapsed % 60) / 60) * 100),
        });
      }

      if (this.liveNodes.fileToday) {
        setReadTime(
          this.liveNodes.fileToday,
          filePath
            ? getTodaySeconds(
                this.deps.history.getEvents(),
                file ?? null,
                filePath,
                undefined,
                countsUnfocusedAsReading(this.deps.settings()),
                countsPluginViewsAsReading(this.deps.settings()),
              )
            : 0,
          mode,
        );
      }

      //  四宫格里的三个今日数走同一次遍历 / the grid's three today figures share one pass
      if (this.liveNodes.today || this.liveNodes.todayRead || this.liveNodes.todayUnread) {
        const channels = getDayChannelSeconds(
          this.deps.history.getEvents(),
          state.files.values(),
          this.deps.clock.today(),
          this.deps.clock.now(),
        );
        const read = getAllTodaySeconds(this.deps.history.getEvents(), state.files.values(),
          this.deps.clock.today(), countsUnfocusedAsReading(this.deps.settings()),
          countsPluginViewsAsReading(this.deps.settings()));
        const notRead = channels.activeSeconds + channels.unfocusedSeconds + channels.pausedSeconds - read;

        if (this.liveNodes.today) setReadTime(this.liveNodes.today, read + notRead, mode);
        if (this.liveNodes.todayRead) setReadTime(this.liveNodes.todayRead, read, mode);
        if (this.liveNodes.todayUnread) setReadTime(this.liveNodes.todayUnread, notRead, mode);
      }

      if (this.liveNodes.manual) {
        const elapsed = selectManualElapsedSeconds(state, this.deps.clock.now());

        //  With "show seconds" off, the readout stops at the minute so nothing ticks
        if (this.deps.settings().manualShowSeconds !== false) {
          setClockTime(this.liveNodes.manual, elapsed);
        } else {
          setReadTime(this.liveNodes.manual, elapsed, 'compact');
        }

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
