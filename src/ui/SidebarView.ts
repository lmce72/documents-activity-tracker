import { chooseFileInterval } from './recordEditActions';
import { draftForSession, draftForVisit, editsOf, type RecordEditDraft } from '../core/recordEditing';
import { buildVisits, type TargetVisit } from '../core/activityVisits';
import { RecordEditingService } from '../services/RecordEditingService';
import { RecordEditModal } from './RecordEditModal';
import { visibleSources, previewVisits, sourceClass } from '../core/processPreview';
import type { OverviewSource } from '../core/overview';
import { visitNodes } from './processList';
import { AwayIdleModal } from './AwayIdleModal';
import { renderHint } from './hintCallout';
import { renderSectionHeading } from './sectionHeading';
import { loadPele, type PeleMounted, type PeleMountOptions } from './pele';
import { CountdownPlanModal } from './CountdownPlanModal';
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

import { DropdownComponent, ItemView, Notice, Setting, setIcon, setTooltip, type WorkspaceLeaf } from 'obsidian';

import { STATUS } from '../core/constants';
import {
  formatDurationParts,
  formatLocalFull,
  formatDurationWithSeconds,
  formatReadTimeParts,
  parseSessionStartTime,
  todayStr,
  type DurationPart,
} from '../core/time';
import { getLang, t } from '../core/i18n';
import {
  attributionPolicy,
  countsPluginViewsAsReading,
  countsUnfocusedAsReading,
  recordName,
} from '../core/settings';
import type { Logger } from '../core/logger';
import {
  buildManualDayFlags,
  buildManualDayRows,
  manualDayTotalSeconds,
  manualSessionsOfDay,
  shiftDay,
} from '../core/manualTimeline';
import {
  selectCountdownElapsedSeconds,
  selectLiveSessionState,
  selectManualElapsedMs,
  selectManualElapsedSeconds,
} from '../core/selectors';
import {
  accountIntervals,
  dayAccount,
  weekAccount,
  RecordsCache,
  type AccountInput,
} from '../core/account';
import type { ManualSession } from '../core/types';
import { buildOverviewTracks, type OverviewProcess, type OverviewTrack } from '../core/overviewTracks';
import { overviewSourceIcon, overviewSourceName, renderOverviewTracks } from './overviewTracks';
import { buildDocumentDayRows, toAbsoluteMinutes } from '../core/recordsTimeline';
import { isPluginViewKey, pluginViewLabel } from '../core/activePath';
import {
  CHANNEL_CLASSES,
  filterRowsByClass,
  readingChannelClass,
  readingChannelLabel,
  renderHeatmap,
  renderHeatmapLegend,
  renderSegmentDetail,
  readingChannelName,
  setProcessMarkers,
  toggleProcessMarkers,
  type HeatmapBlock,
  type HeatmapRow,
  type HeatmapSegment,
  type LegendEntry,
} from './heatmapRender';
import { renderTimelineList, type TimelineNode, type TimelineDisclosureState } from './timelineList';
import { HScrollTicker } from './hScrollTicker';
import { createSecondPie } from './secondPie';
import { docState, stateIcon } from './StatusBar';
import { renderManualFlagsTable, renderManualSessionDetail } from './manualSessionDetail';
import { ConfirmModal } from './ConfirmModal';
import { appendDurationParts, setClockTime, setClockTimeMs, setReadTime } from './durationText';
import {
  buildFileRecords,
  getTodaySeconds,
  getTodaySessionCount,
} from '../core/timeline';
import { liveWallClockSeconds } from '../core/types';
import type {
  FileRecord,
  PluginSettings,
  TimerState,
  TimelineEvent,
} from '../core/types';
import type { Clock } from '../services/clock';
import type { ManualTimerService } from '../services/ManualTimerService';
import type { CountdownTimerService } from '../services/CountdownTimerService';
import type { LiveTimerEntry } from '../data/liveTimerSnapshot';
import {
  buildCountdownPlan,
  countdownConfigFrom,
  locatePhase,
  modeLabelKey,
  normalizeMode,
  phaseLabelKey,
  planTotalSeconds,
  type CountdownPosition,
} from '../core/countdown';
import type { CountdownPlan, CountdownSession } from '../core/types';
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
type Panel = 'document' | 'manual' | 'countdown' | 'overview';


/** the numbers updated in place every second. */
type LiveKey =
  | 'session'
  | 'unfocused'
  | 'fileToday'
  | 'todayTotal'
  | 'weekRead'
  | 'weekTotal'
  | 'todayAway'
  | 'todayIdle'
  | 'todayPaused'
  | 'todayRead'
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

  /** 统计格 / the stat grid */
  todayTotal?: HTMLElement;
  weekRead?: HTMLElement;
  weekTotal?: HTMLElement;
  todayAway?: HTMLElement;
  todayIdle?: HTMLElement;
  todayPaused?: HTMLElement;
  todayRead?: HTMLElement;

  manual?: HTMLElement;
  /** the ring, driven by a CSS variable */
  ring?: HTMLElement;

  manualLabel?: HTMLElement;
  /** 圆环内的状态行（图标 + 文字）/ the state line inside the ring (icon plus text) */
  manualState?: HTMLElement;

  /** 倒计时的读数是"还剩多久"，与正计时的方向相反，所以单独一组节点 */
  countdown?: HTMLElement;
  /** 第一行：相位名（或 Paused / Not started）/ line 1: the phase name (or the state) */
  countdownPhase?: HTMLElement;
  /** 第二行：第几段 / line 2: which phase of how many */
  countdownProgress?: HTMLElement;
  countdownState?: HTMLElement;
  countdownRing?: HTMLElement;
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
  countdown: CountdownTimerService;
  /**
   * 未保存计时的临时快照 / the snapshots of runs that were never saved.
   * 视图只负责展示与按钮，读写都在装配层 —— 快照不属于状态树。
   * The view only shows it and offers the buttons; reading and writing live in the assembly layer,
   * because the snapshot is not part of the state tree.
   */
  recovery: {
    pending: (kind: 'manual' | 'countdown') => LiveTimerEntry | null;
    restore: () => void;
    discard: () => void;
  };
  /** storage degradation notice, null when healthy */
  storageWarning: () => string | null;
  /** prompt for the note; null = cancelled */
  promptNote: (onDone: (note: string | null) => void) => void;
  /** open the records panel; null follows the file */
  openRecords: (filePath: string | null) => void;
  /** persist a settings patch and apply it at once */
  saveSetting: (patch: Partial<PluginSettings>) => Promise<void>;
  /** this plugin's manifest id, for opening the settings tab */
  pluginId: string;
}

export class ActivitySidebarView extends ItemView {
  private panel: Panel = 'document';
  private day: string = todayStr();

  /** whether the manual list is expanded to everything */
  private manualExpanded = false;

  /** 倒计时记录列表是否展开 / whether the countdown list is expanded */
  private countdownExpanded = false;

  /** Whether the overview's day detail is expanded past its first few entries. */
  private overviewSelection: { day: string; id: string; hour: number; hourOnly?: boolean } | null = null;
  private readonly overviewSourcesExpanded = new Set<string>();
  private readonly timelineExpanded = new Set<string>();
  private readonly overviewPreviewExpanded = new Set<string>();

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

  /**
   * 区间选择 / range selection.
   *
   * 只影响日历本身：先点起点、再点终点；点反了自动调换，保证 start ≤ end。数据侧的口径还没定，
   * 所以这里只记住区间、在日历上标出来，不改变任何统计。
   *
   * The calendar only: click a start, then an end; if they are clicked the other way round the pair is
   * swapped so start ≤ end. How the range should affect the data is still undecided, so this only keeps
   * and draws the selection and changes no totals.
   */
  private rangeMode = false;
  private rangeStart: string | null = null;
  private rangeEnd: string | null = null;

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
  private placeOverviewDetail: (() => void) | null = null;

  /** 折成两列所需的宽度 / the width at which the fold makes sense. */
  private static readonly WIDE_PX = 760;

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

    //  秒表读数是时间戳推导的，不经过任何 dispatch，所以要有自己的刷新。显示毫秒时刷新间隔缩到
    //  100 毫秒，否则最后三位永远只跳整数 —— 开着毫秒却看不出毫秒，会被当成 bug。
    //  The readout is timestamp-derived and reaches no dispatch, so it needs its own refresh. With
    //  milliseconds on, the interval drops to 100ms, or the last three digits would only move in
    //  whole seconds — which reads as a bug.
    this.startLiveClock();
    this.register(() => this.stopLiveClock());

    this.render();

    //  宽度变了只切一个类，不重绘：两列是纯排版，重建 DOM 会把滚动位置和选中状态一起丢掉。
    //  A width change only flips a class, never re-renders: the fold is pure layout, and rebuilding the
    //  DOM would throw away scroll position and selection with it.
    this.widthObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      this.contentEl.toggleClass('is-wide', width >= ActivitySidebarView.WIDE_PX);
      this.placeOverviewDetail?.();
    });
    this.widthObserver.observe(this.contentEl);
  }

  /**
   * 事件流的短命缓存 / a short-lived cache for the event log.
   *
   * SQLite 的 getEvents() 每次都要把整张表读出来、逐行 JSON.parse；真实库上万条时单次就要几十毫秒。
   * 版本号没变就复用同一份数组 —— 事件只在追加/替换时变，版本号正是这件事的信号。
   *
   * SQLite's getEvents() reads the whole table and JSON-parses every row; on a real vault with tens of
   * thousands of events that is tens of milliseconds per call. The same array is reused until the
   * revision moves, which happens exactly when events are appended or replaced.
   */
  private eventsCache: TimelineEvent[] = [];
  private eventsRevision = -1;

  private cachedEvents(): TimelineEvent[] {
    const revision = this.deps.history.getRevision();
    if (revision !== this.eventsRevision) {
      this.eventsCache = this.deps.history.getEvents();
      this.eventsRevision = revision;
    }
    return this.eventsCache;
  }

  /** 账本 records 的缓存 / cache for the account derived records. */
  /**
   * 当前选中的过程 / the process currently selected.
   *
   * 选中状态必须自己记着：事件流一变（一次自动保存、一次空闲边界）签名就变，整块重绘会把标记与详情
   * 一起抹掉 —— 用户刚点了一下，一秒后高亮就没了。重绘后按这里复原。
   *
   * The selection has to be remembered: any event append (an auto-save, an idle boundary) changes the
   * signature and re-renders the panel, which used to wipe both markers and detail one second after the
   * click. It is reapplied after every render.
   */
  private selection: {
    panel: Panel;
    day: string;
    spans: Array<{ start: number; end: number }>;
    hour: number;
    group?: string;
  } | null = null;


  private readonly recordsCache = new RecordsCache();

  /** 当前的读数刷新定时器 / the current readout timer. */
  private liveTimer: number | null = null;

  /**
   * 起一个自调度的读数刷新 / start the self-scheduling readout refresh.
   * 用 setTimeout 而不是 setInterval：间隔要跟着"是否显示毫秒"变，自调度最省事。
   * A recursive timeout rather than an interval, because the period depends on whether milliseconds
   * are shown.
   */
  private startLiveClock(): void {
    this.stopLiveClock();
    const tick = (): void => {
      this.updateLiveNumbers();
      this.liveTimer = window.setTimeout(tick, this.liveClockPeriod());
    };
    tick();
  }

  private stopLiveClock(): void {
    if (this.liveTimer !== null) {
      window.clearTimeout(this.liveTimer);
      this.liveTimer = null;
    }
  }

  /** 读数刷新周期 / how often the readout refreshes. */
  private liveClockPeriod(): number {
    if (this.deps.settings().manualShowMilliseconds !== true) return 1000;
    if (this.deps.store.getState().manual.status === 'idle') return 1000;
    return this.panel === 'manual' ? 100 : 1000;
  }

  override async onClose(): Promise<void> {
    this.stopLiveClock();
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

  /** 所选过程紧跟轨道，宽栏移到右侧 / selected processes sit under their track or alongside it. */
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
    detail?: {
      groupOf: (segment: S) => string;
      render: (panel: HTMLElement, segment: S) => void;
    },
  ): boolean {
    let panel: HTMLElement | null = null;

    //  图例在图上方，与图共用同一套取色类：点名字隐藏那一类，段被滤掉但行与坐标不动，再点回原位。
    //  The legend sits above the chart and shares its colouring classes: clicking a name hides that
    //  kind, the rows and their coordinates stay put, and clicking again restores the exact picture.
    if (legend && legend.length > 0) {
      renderHeatmapLegend(parent, legend, this.hiddenHeatmap, (key) => this.toggleHeatmapClass(key));
    }

    const shown = filterRowsByClass(rows, classOf, this.hiddenHeatmap);

    const layout = parent.createDiv({ cls: 'rtt-overview-layout' });
    const chart = layout.createDiv({ cls: 'rtt-overview-chart' });
    const aside = layout.createDiv({ cls: 'rtt-overview-aside' });

    const runs = activityRuns(shown);
    const groupOf = detail?.groupOf ?? ((segment: S) => runs.get(segment)!.id);
    /**
     * 按当前选中重画详情 / render the detail for the current selection.
     * 重绘会清空详情容器，所以它既在点击时调用，也在每次渲染后调用。
     * A re-render empties the detail container, so this runs both on click and after every render.
     */
    const paintSelection = (): void => {
      if (!panel) return;
      panel.empty();
      this.placeOverviewDetail?.();

      const selection = this.selection;
      if (!selection || selection.panel !== this.panel || selection.day !== day) return;

      const spans = selection.spans;
      const members = shown
        .flatMap((row) => row.segments)
        .filter((segment) => {
          if (detail && selection.group !== undefined) return groupOf(segment) === selection.group;
          const run = runs.get(segment);
          return run !== undefined && spans.some((span) => run.start < span.end && run.end > span.start);
        });

      if (!members.length) { this.selection = null; setProcessMarkers(parent, []); return; }
      const visibleSpans = detail ? shown.flatMap(row => row.segments.filter(segment => members.includes(segment))
        .map(segment => ({ start: row.hour * 60 + segment.startMinute, end: row.hour * 60 + segment.startMinute + segment.durationMinutes })))
        : [...new Set(members.map(segment => runs.get(segment)!))].map(run => ({ start: run.start, end: run.end }));
      selection.spans = visibleSpans;
      setProcessMarkers(parent, visibleSpans);
      this.placeOverviewDetail?.();
      if (detail) { detail.render(panel, members[0]!); this.placeOverviewDetail?.(); return; }

      const startAbs = Math.min(...visibleSpans.map((span) => span.start));
      const endAbs = Math.max(...visibleSpans.map((span) => span.end));
      const processBlock: HeatmapBlock<S> = {
        startMinute: 0,
        durationMinutes: endAbs - startAbs,
        clipped: false,
        members: members as S[],
      };
      const info = describe(processBlock, selection.hour);
      renderSegmentDetail(panel, {
        hour: selection.hour,
        segment: processBlock,
        what: info.what,
        icon: info.icon,
        kind: info.kind,
        pieces: members.length,
        events,
        day,
        //  起止按过程本身给，允许越过被点的那一小时
        //  The range is the process's own, allowed to extend past the hour that was clicked
        absStartMinute: startAbs,
        absEndMinute: endAbs,
        //  汇总行必须留着：它写的是整个过程的起止与合计
        //  The summary stays: it carries the whole process's range and total
        forceSummary: true,
      });
      this.placeOverviewDetail?.();
    };

    const drawn = renderHeatmap(
      chart,
      shown,
      classOf,
      labelOf,
      (block, hour, element) => {
        if (!panel) return;

        //  自动活动按连续过程、手动按同一轮选择 / automatic runs and explicit rounds keep their identities.
        const group = groupOf(block.members[0]!);
        const selected = shown.flatMap(row => row.segments.map(segment => ({ segment, hour: row.hour })))
          .filter(item => groupOf(item.segment) === group);
        const spans = detail
          ? selected.map(({ segment, hour }) => ({ start: hour * 60 + segment.startMinute, end: hour * 60 + segment.startMinute + segment.durationMinutes }))
          : [...new Set(block.members.map(segment => runs.get(segment)!))].map(run => ({ start: run.start, end: run.end }));

        const isSelected = this.selection?.hour === hour ? toggleProcessMarkers(parent, spans) : true;
        if (this.selection?.hour !== hour) setProcessMarkers(parent, spans);
        void element;
        this.selection = isSelected
          ? { panel: this.panel, day, spans, hour, group }
          : null;
        paintSelection();
      },
      overlay,
      groupOf,
      (segment: S) => runs.get(segment)!.id,
    );

    if (!drawn) return false;
    panel = aside.createDiv({ cls: 'rtt-hm-detail rtt-overview-detail' });
    this.placeOverviewDetail = () => {
      if (!panel) return;
      layout.toggleClass('has-selection', panel.hasChildNodes());
      const selected = this.selection;
      const wide = layout.clientWidth >= ActivitySidebarView.WIDE_PX && !this.contentEl.ownerDocument.body.hasClass('is-mobile');
      layout.toggleClass('is-wide', wide);
      const row = !wide && selected?.day === day && selected.panel === this.panel && panel.hasChildNodes()
        ? Array.from(chart.querySelectorAll<HTMLElement>('.rtt-hm-row')).find(row => Number(row.dataset.rttHour) === selected.hour) : undefined;
      if (row) { if (row.nextElementSibling !== panel) row.after(panel); }
      else if (panel.parentElement !== aside) aside.appendChild(panel);
    };

    //  重绘后复原选中：标记与详情一起回来
    //  Restore the selection after a re-render: markers and detail come back together
    const selection = this.selection;
    if (selection && selection.panel === this.panel && selection.day === day) {
      setProcessMarkers(parent, selection.spans);
      paintSelection();
    }
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
      settings.countdownTimerEnabled,
      //  模式只影响倒计时面板里的方案标题，但它属于结构，进签名最省心
      //  The mode only changes the plan caption, but it is structure — simplest to sign it
      settings.countdownMode,

      //  It changes the card count, so it must be in the signature or the structure sticks
      //  It changes every duration shown, so flipping it must recompute at once; without it
      //  the panels keep displaying the old accounting until some unrelated state change
      //  happens to trigger a re-render.
      settings.countUnfocusedAsReading,
      settings.countPluginViewsAsReading,
      //  版本号而不是长度：SQLite 的 getEvents() 会把整张表读出来解析一遍，每秒一次太贵
      //  A revision rather than a length: SQLite getEvents() reads and parses the whole table, which
      //  is too expensive once a second.
      String(this.deps.history.getRevision()),
      state.activeFilePath ?? '-',
      state.isWindowFocused,
      state.files.get(state.activeFilePath ?? '')?.splitReading,
      state.isIdle,
      state.manual.status,

      //  The mark count belongs in the signature: it shapes the marks section, and leaving
      //  it out means marks placed through the service never appear.
      String(state.manual.flags.length),
      state.countdown.status,
      String(state.countdown.flags.length),

      //  Expanding the manual list changes how many rows it has, so it belongs here
      String(this.manualExpanded),
      String(this.countdownExpanded),
      String(this.manualFocus),

      //  The calendar's open state shapes the DOM; without it turning pages would not redraw
      String(this.calendarOpen),
      this.calendarMonth,
      String(this.rangeMode),
      this.rangeStart ?? '',
      this.rangeEnd ?? '',
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
    if (this.panel === 'countdown') {
      parts.push(String(this.deps.history.getCountdownSessions().length));
    }

    return parts.join('|');
  }

  //  ==========================================================================
  // rendering
  //  ==========================================================================

  private render(): void {
    try {
      const root = this.contentEl;

      //  重绘会重建整棵 DOM，滚动位置随之归零 —— 选个日期就跳回首行正是这个原因。先记下来再放回去。
      //  A re-render rebuilds the whole tree and resets the scroll — which is why picking a date jumped
      //  back to the first row. It is remembered and put back.
      const scrollTop = root.scrollTop;

      //  The previous calendar listeners must come off before the DOM is torn down, or every
      //  re-render adds another pair holding already-detached nodes. The name ticker goes the same
      //  way: its nodes are about to be replaced.
      this.calendarDismiss?.();
      this.nameTicker?.destroy();
      this.nameTicker = null;
      this.placeOverviewDetail = null;
      //  离开倒计时面板时释放流程图的尺寸监听 / release the flow diagram when leaving its panel
      if (this.panel !== 'countdown') {
        this.countdownFlow?.mounted?.destroy();
        this.countdownFlow = null;
      }
      root.empty();
      root.toggleClass('is-overview', this.panel === 'overview');
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
      else if (this.panel === 'countdown') this.renderCountdownPanel(left, right);
      else this.renderOverviewPanel(left, right);

      this.updateLiveNumbers();
      root.scrollTop = scrollTop;
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
    //  菜单左侧：计时器入口 + 插件设置；两者都是透明底的图标按钮
    //  Left of the menu: a timer entry and plugin settings, both transparent icon buttons.
    const head = root.createDiv({ cls: 'rtt-panel-head' });
    const tools = head.createDiv({ cls: 'rtt-panel-tools' });
    const state = this.deps.store.getState();
    const manualRunning = state.manual.status !== 'idle';
    const countdownRunning = state.countdown.status !== 'idle';
    const timerPanel: Panel = !manualRunning && countdownRunning ? 'countdown' : 'manual';
    const timer = this.iconButton(tools, countdownRunning && !manualRunning ? 'hourglass' : 'timer', t('panelManual'), () => this.setPanel(timerPanel), { ghost: true });
    timer.toggleClass('is-live', manualRunning || countdownRunning);
    this.iconButton(tools, 'settings', t('openPluginSettings'), () => this.openPluginSettings(), { ghost: true });

    const picker = head.createDiv({ cls: 'rtt-mobile-panel-picker' });
    const choices: Record<string, string> = { document: t('panelDocument'), manual: t('panelManual'), countdown: t('panelCountdown'), overview: t('panelOverview') };
    new DropdownComponent(picker).addOptions(choices).setValue(this.panel).onChange(value => {
      if (value === 'document' || value === 'manual' || value === 'countdown' || value === 'overview') this.setPanel(value);
    }).selectEl.setAttribute('aria-label', t('viewSelect'));
    const bar = head.createDiv({ cls: 'rtt-panel-tabs' });
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
    //  倒计时用沙漏而不是第二个 timer：两个一模一样的图标在窄侧栏里分不出来
    //  An hourglass rather than a second clock: two identical glyphs are indistinguishable in a
    //  narrow sidebar.
    if (this.deps.settings().countdownTimerEnabled !== false) {
      addTab('countdown', 'hourglass', t('panelCountdown'));
    }
    addTab('overview', 'gauge', t('panelOverview'));
  }

  /** 打开本插件的设置页 / open this plugin's settings tab. */
  private openPluginSettings(): void {
    try {
      const setting = (this.app as unknown as {
        setting?: { open(): void; openTabById(id: string): void };
      }).setting;
      if (!setting) return;
      setting.open();
      setting.openTabById(this.deps.pluginId);
    } catch (error) {
      this.deps.log.warn('[RTT][sidebar] 打开设置失败 / open settings failed:', error);
    }
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
      /** 主数字：强调底色 / the headline figure: accent tint */
      emphasis?: boolean;
    }>,
  ): void {
    const mode = this.deps.settings().timeDisplayMode;
    //  六格以上收紧为"密集"版式：奇数张时最后一张横跨两列，不留一格孤零零的尾巴
    //  Six cards or more use the dense layout: with an odd count the last one spans both columns
    //  instead of leaving a lonely tail cell.
    const bar = parent.createDiv({
      cls: cards.length >= 6 ? 'rtt-stats-bar is-dense' : 'rtt-stats-bar',
    });

    for (const card of cards) {
      const el = bar.createDiv({
        cls: card.emphasis ? 'rtt-stats-card is-primary' : 'rtt-stats-card',
      });
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
      this.cachedEvents(),
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
    this.renderAwaySection(left);
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
  /**
   * 组装一份账本输入 / assemble one account input.
   *
   * 正在跑的会话作为「活尾巴」传进去：事件流停在最后一个事件，不补这一段，正在读的那一分钟要等到
   * 下一次事件才会出现在格子里。
   *
   * The running session is passed as a live tail: the event stream stops at the last event, and
   * without it the minute being read would only show up at the next event.
   */
  private accountInput(day: string): AccountInput {
    const state = this.deps.store.getState();
    const settings = this.deps.settings();
    const filePath = state.activeFilePath;
    const file = filePath ? state.files.get(filePath) : undefined;
    const policy = attributionPolicy(settings);

    const nowMs = this.deps.clock.now();

    //  records 只随事件版本变；把推导结果缓存起来，否则每秒都要把整段历史重算一遍
    //  Records change only with the event revision; caching them keeps the whole log from being
    //  re-derived every second.
    const records = this.recordsCache.get(this.deps.history.getRevision(), () =>
      buildFileRecords(this.cachedEvents(), nowMs, day, {}),
    );

    return {
      manual: this.deps.history.getManualSessions(),
      countdown: this.deps.history.getCountdownSessions(),
      day,
      nowMs,
      policy: { ...policy, pluginViews: countsPluginViewsAsReading(settings) },
      live: filePath && file && file.status !== STATUS.IDLE
        ? { filePath, state: selectLiveSessionState(state, file) }
        : null,
      records,
    };
  }

  private renderDocumentStats(
    root: HTMLElement,
    records: Record<string, FileRecord>,
    settings: PluginSettings,
  ): void {
    //  四条通道并列，不再把"离开"和"暂停"合成一个减号：它们对"刚才在做什么"的回答完全不同。
    //  Four channels side by side instead of folding away and paused into one deduction: they answer
    //  "what was I doing" differently.
    //
    //  Placeholder zeros: updateLiveNumbers overwrites them before the paint settles.
    void records;
    void settings;
    const week = weekAccount(this.accountInput(todayStr()));

    this.renderStatCards(root, [
      { label: t('statsTodayRead'), seconds: 0, liveKey: 'todayRead' },
      { label: t('statsTodayTotal'), seconds: 0, liveKey: 'todayTotal' },
      { label: t('statsTodayAway'), seconds: 0, liveKey: 'todayAway' },
      { label: t('statsTodayPaused'), seconds: 0, liveKey: 'todayPaused' },
      { label: t('statsTodayIdle'), seconds: 0, liveKey: 'todayIdle' },
      { label: t('statsWeekRead'), seconds: week.reading, liveKey: 'weekRead' },
      { label: t('statsWeekTotal'), seconds: week.total, liveKey: 'weekTotal' },
    ]);
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

    renderSectionHeading(root, 'flame', t('docHeatmapTitle'));

    const drawn = this.renderClickableHeatmap(
      root,
      rows,
      readingChannelClass,
      readingChannelLabel,
      (block) => ({
        //  一小时的详情要把这一小时出现过的通道都点名，而不是只报第一段属于哪一类
        //  The hour's detail names every channel it contains, not just the first segment's
        what: [...new Set(block.members.map((member) => readingChannelName(member.channel)))].join(' + '),
        icon: 'file-text',
        kind: 'document',
      }),
      this.cachedEvents(),
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
    //  卡片上的名字也尊重别名：同一条记录在两处显示不同的名字才是真的乱
    //  The card honours the alias too: one record showing two names would be the real confusion.
    const name = recordName(this.deps.settings(), filePath, record?.fileName ?? filePath);
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
        String(getTodaySessionCount(this.cachedEvents(), filePath)),
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

      //  不再弹窗：同一面板里就是那一段的归属，跳过去比另开一层更近
      // Open the same attribution editor as the away/idle button.
      this.liveNodes.unfocused.addEventListener('click', () => {
        this.openAwayModal();
      });
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
      onShowStretch?: (container: HTMLElement) => void;
      /** The right-edge control that opens the underlying file. */
      onOpen?: () => void;
      /** 改名 / rename: a display alias or a note, never the target itself. */
      onEdit?: () => void;
      editLabel?: string;
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
      const detail = list.createDiv({ cls: 'rtt-record-inline rtt-hm-detail' });
      detail.hidden = true;
      item.addEventListener('click', () => {
        detail.hidden = !detail.hidden;
        if (!detail.hidden && !detail.hasChildNodes()) options.onShowStretch?.(detail);
      });
    } else {

      //  The base rule gives every row a pointer cursor; a row that cannot be clicked has to
      //  correct that, or the cursor is lying.
      item.addClass('is-static');
    }

    //  改名放在最前：它改的是这一行怎么读，其它几个按钮都是动作
    //  Rename comes first: it changes how the row reads, while the rest are actions.
    if (options.onEdit) {
      this.iconButton(item, 'pencil', options.editLabel ?? t('recordEditName'), options.onEdit, {
        ghost: true,
        stopPropagation: true,
      });
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
    options: { ghost?: boolean; stopPropagation?: boolean; danger?: boolean; primary?: boolean } = {},
  ): HTMLButtonElement {
    const cls = ['clickable-icon', 'rtt-icon-btn'];
    if (options.ghost) cls.push('is-ghost');
    if (options.danger) cls.push('is-danger');
    if (options.primary) cls.push('is-primary');

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

    renderSectionHeading(root, 'trophy', t('docListTop'));

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
          //  显示别名，但打开、删除、统计都仍用 filePath —— 改名只是备注
          //  The alias is shown, while opening, deleting and totalling all still use filePath.
          name: recordName(this.deps.settings(), filePath, record.fileName),
          stats,
          meta,
          onShowStretch: container => renderTimelineList(container, this.entryStretchNodes(filePath, record, false, mode)),
          onEdit: () => this.promptRecordAlias(filePath),
          editLabel: t('editRecord'),
          onOpen: () => {
            void this.app.workspace.openLinkText(filePath, '', false);
          },
          onDelete: () => this.confirmDeleteRecord(filePath, record),
        });
      }
    }


    //  The entry stays even with nothing today: otherwise "nothing today" reads as "nothing
    //  at all".
    this.renderViewAllButton(root);
  }

  /** 选择文档或视图的实际记录时段 / choose the recorded interval for a document or view. */
  private promptRecordAlias(key: string): void {
    chooseFileInterval(this.app, this.deps.history, key, this.deps.clock.today(), this.deps.clock.now(), () => this.refresh());
  }

  /** 完整编辑一轮手动计时 / edit an entire saved manual round. */
  private promptManualNote(session: ManualSession): void {
    this.editRecord(draftForSession('manual', session, this.deps.history.getRevision()));
  }

  private confirmDeleteRecord(key: string, record: FileRecord): void {
    new ConfirmModal(this.app, {
      title: t('recDelete'),
      message: t('recDeleteConfirm').replace(
        '{name}',
        recordName(this.deps.settings(), key, record.fileName),
      ),
      confirmText: t('deleteAction'),
      cancelText: t('cancel'),
      onConfirm: () => {
        this.deps.history.deleteFileEvents(key);
        const aliases = { ...(this.deps.settings().recordAliases ?? {}) };
        if (aliases[key] !== undefined) {
          delete aliases[key];
          void this.deps.saveSetting({ recordAliases: aliases });
        }
        void this.deps.history.flushNow({ force: true });
        this.render();
      },
    }).open();
  }

  /** The manual-timer panel. */
  private renderManualPanel(left: HTMLElement, right: HTMLElement): void {
    if (!this.deps.settings().manualTimerEnabled) {
      left.createDiv({ cls: 'rtt-empty-hint', text: t('manualTimerOff') });
      left.createDiv({ cls: 'rtt-empty-hint', text: t('manualTimerOffDesc') });
      return;
    }

    //  上一轮没保存的计时先亮出来：它随时可能被新的开始覆盖掉
    //  The unsaved run from last time comes first: a fresh start would cover it up for good
    this.renderRecoveryCard(left, 'manual');

    //  上：秒表与开关；下：这一天的热力图与记录
    //  Top: the stopwatch and its switches; bottom: the day's heatmap and sessions
    this.renderManualControls(left);
    this.renderManualToggles(left);
    this.renderManualStats(left);
    this.renderManualHeatmap(right);
    this.renderManualList(right);
  }

  /**
   * 未保存计时的恢复卡 / the recovery card.
   *
   * 之前那一轮不在状态树里，所以它既不占秒表、也不会随重绘消失：一张独立的卡，摆在计时器上方，
   * 两个按钮就够 —— 恢复（停在当时的时长、保持暂停）或丢弃。
   *
   * The previous run is not in the state tree, so it neither takes over the stopwatch nor disappears
   * on a re-render: a card of its own above the timer, with the two buttons that matter — restore
   * (held at the elapsed time, paused) or discard.
   */
  private renderRecoveryCard(root: HTMLElement, kind: 'manual' | 'countdown'): void {
    const entry = this.deps.recovery.pending(kind);
    if (!entry) return;

    const card = root.createDiv({ cls: 'rtt-recovery-card' });

    const head = card.createDiv({ cls: 'rtt-recovery-head' });
    setIcon(head.createSpan({ cls: 'rtt-recovery-icon' }), 'history');
    head.createSpan({ cls: 'rtt-recovery-title', text: t('recoveryTitle') });

    const elapsed = formatDurationWithSeconds(Math.round(entry.elapsedMs / 1000));
    const lineKey = kind === 'manual' ? 'recoveryManual' : 'recoveryCountdown';
    card.createDiv({
      cls: 'rtt-live-line',
      text: t(lineKey)
        .replace('{time}', entry.startedAt.slice(0, 16))
        .replace('{duration}', elapsed),
    });
    renderHint(card, t('recoveryDesc'));

    const bar = card.createDiv({ cls: 'rtt-timeline-nav' });
    this.iconButton(
      bar,
      'rotate-ccw',
      t('recoveryRestore').replace('{duration}', elapsed),
      () => {
        this.deps.recovery.restore();
        this.render();
      },
    );
    this.iconButton(
      bar,
      'trash-2',
      t('recoveryDiscard'),
      () => {
        this.deps.recovery.discard();
        this.render();
      },
      { danger: true },
    );
  }

  /**
   * 离开与空闲的统一入口 / one entry for away and idle time.
   *
   * 以前"离开窗口算不算阅读"是设置页里的一个布尔值，逐段归类藏在一个按文件弹出的 Modal 里 ——
   * 想看一眼"今天到底离开了多久"没有地方可看。这里把三件事放在一起：口径（新的时段按什么算）、
   * 今天的每一段（可逐段改判）、以及空闲这条以前被直接丢弃的通道。
   *
   * "Whether away time reads" used to be a boolean in the settings tab, and per-stretch reclassification
   * hid in a per-file modal — there was nowhere to see "how long was I away today". Three things sit
   * together here: the policy for new stretches, today's stretches (each reclassifiable), and the idle
   * channel that used to be discarded outright.
   */
  private editVisit(visit: TargetVisit): void {
    this.editRecord(draftForVisit(visit, this.deps.history.getRevision()));
  }

  private editRecord(draft: RecordEditDraft): void {
    new RecordEditModal(this.app, { draft, save: value => new RecordEditingService(this.deps.history).save(value), onSaved: () => this.refresh() }).open();
  }

  private openAwayModal(): void {
    new AwayIdleModal(this.app, { ...this.deps, onChanged: () => this.refresh() }, this.deps.clock.today()).open();
  }

  private renderAwaySection(root: HTMLElement): void {
    const button = root.createEl('button', { cls: 'rtt-view-all-btn', text: t('awaySectionTitle') });
    button.addEventListener('click', () => this.openAwayModal());
  }

  /** manual timer controls. */
  private renderManualControls(root: HTMLElement): void {
    //  面板名已经写在顶部标签上，这里不再重复一遍
    //  The active tab already names the panel; a second heading only costs vertical space.
    const section = root.createDiv({ cls: 'rtt-heatmap-wrap' });

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
      //  空闲时的开始是这一屏唯一的主动作，给成强调色圆形按钮
      //  Idle's start is the only primary action on screen: give it the accent circle.
      this.iconButton(bar, 'play', t('manualStart'), () => {
        this.deps.manual.start();
        this.render();
      }, { primary: true });
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

    renderSectionHeading(root, 'flag', t('manualFlagsTitle'));

    if (flags.length === 0) {
      root.createDiv({ cls: 'rtt-list-empty', text: t('manualNoFlags') });
      return;
    }

    //  与面板里的表共用同一份实现：运行中可改名、可即时移除
    //  Shares the panel's table implementation: rename in place, remove without stopping.
    renderManualFlagsTable(
      root,
      flags,
      index => { if (this.deps.manual.removeFlag(index)) this.render(); },
      (index, label) => { if (this.deps.manual.renameFlag(index, label)) this.render(); },
    );
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
    const stateLine = face.createDiv({ cls: 'rtt-stopwatch-state' });
    stateLine.createSpan({ cls: 'rtt-state-icon' });
    this.liveNodes.manualState = stateLine;
    this.liveNodes.manualLabel = stateLine.createSpan({
      cls: 'rtt-state-text',
      text: t('manualIdle'),
    });
    this.liveNodes.manual = face.createDiv({
      cls: 'rtt-stopwatch-time',
      text: formatDurationWithSeconds(0),
    });
    renderHint(parent, t('manualRingHint'));
  }

  /** the marks placed during this run. */
  private renderManualFlags(root: HTMLElement): void {
    const state = this.deps.store.getState();
    const flags = state.manual.flags;

    if (state.manual.status === 'idle' && flags.length === 0) return;

    renderSectionHeading(root, 'flag', t('manualFlagsTitle'));

    renderManualFlagsTable(
      root,
      flags,
      index => { if (this.deps.manual.removeFlag(index)) this.render(); },
      (index, label) => { if (this.deps.manual.renameFlag(index, label)) this.render(); },
    );
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

    //  毫秒只影响读数，不影响存储：记录本来就带 durationMs
    //  Milliseconds affect the readout only; the record carries durationMs either way
    new Setting(root)
      .setName(t('manualShowMilliseconds'))
      .setDesc(t('manualShowMillisecondsDesc'))
      .addToggle((toggle) =>
        toggle.setValue(settings.manualShowMilliseconds === true).onChange((value) => {
          void this.deps.saveSetting({ manualShowMilliseconds: value }).then(() => this.render());
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

  //  ==========================================================================
  // countdown panel
  //  ==========================================================================

  /**
   * 倒计时面板 / the countdown panel.
   *
   * 与手动计时面板并列而不是塞进它：两本账各有各的记录与统计，塞在一起就又要解释"这里显示的是
   * 哪一种"。
   * A panel beside the manual one rather than a mode inside it: each ledger has its own records and
   * totals, and a shared panel would have to keep explaining which one is on screen.
   */
  private renderCountdownPanel(left: HTMLElement, right: HTMLElement): void {
    if (!this.deps.settings().countdownTimerEnabled) {
      left.createDiv({ cls: 'rtt-empty-hint', text: t('countdownTimerOff') });
      left.createDiv({ cls: 'rtt-empty-hint', text: t('countdownTimerOffDesc') });
      return;
    }

    //  空闲时圆环显示"本次要跑多久"，所以先把方案备好 / idle, the ring previews the plan, so build it first
    this.countdownPreview = buildCountdownPlan(countdownConfigFrom(this.deps.settings()));

    this.renderRecoveryCard(left, 'countdown');
    this.renderCountdownModeSwitch(left);
    this.renderCountdownControls(left);
    this.renderCountdownStats(left);
    this.renderCountdownToggles(left);
    this.renderCountdownPlan(right);
    this.renderCountdownList(right);
  }

  /** 空转时用来预览的方案 / the plan previewed while idle. */
  private countdownPreview: CountdownPlan | null = null;

  /** 方案流程图 / the plan's flow diagram. */
  private countdownFlow: {
    container: HTMLElement;
    mounted: PeleMounted | null;
    source: string;
    phase: number | null;
    /** 生成图表时的分钟刻度：运行中每分钟重画一次，起点才一直是「现在」 */
    minute: number;
    options: PeleMountOptions;
    /** 时间轴两端 / the two ends of the timeline */
    range: { now: HTMLElement; finish: HTMLElement };
  } | null = null;

  /** countdown controls: the ring and its buttons. */
  private renderCountdownControls(root: HTMLElement): void {
    //  与手动计时一致：面板名由顶部标签承担 / the tab names the panel, as on the manual side
    const section = root.createDiv({ cls: 'rtt-heatmap-wrap' });

    this.renderCountdownRing(section);

    const bar = section.createDiv({ cls: 'rtt-timeline-nav' });
    this.renderCountdownButtons(bar);
    this.renderCountdownFlags(section);
  }

  /** 圆环与读数 / the ring and its readout. */
  private renderCountdownRing(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: 'rtt-stopwatch' });
    this.liveNodes.countdownRing = wrap.createDiv({ cls: 'rtt-stopwatch-ring' });

    const face = wrap.createDiv({ cls: 'rtt-stopwatch-face' });
    const stateLine = face.createDiv({ cls: 'rtt-stopwatch-state is-stacked' });
    this.liveNodes.countdownState = stateLine;

    //  图标只属于第一行：◌ Focus 一行，下面单独一行「第 n / 共 m 段」。
    //  The icon belongs to the first line only: "◌ Focus" on one line, "phase n of m" on the next.
    const firstLine = stateLine.createDiv({ cls: 'rtt-state-line' });
    firstLine.createSpan({ cls: 'rtt-state-icon' });
    this.liveNodes.countdownPhase = firstLine.createSpan({
      cls: 'rtt-state-phase',
      text: t('countdownIdle'),
    });
    this.liveNodes.countdownProgress = stateLine.createDiv({ cls: 'rtt-state-progress' });
    this.liveNodes.countdown = face.createDiv({ cls: 'rtt-stopwatch-time' });
    this.paintCountdownTime(this.liveNodes.countdown, 0);
    renderHint(parent, t('countdownRingHint'));
  }

  /** the countdown's button row. */
  private renderCountdownButtons(bar: HTMLElement): void {
    const status = this.deps.store.getState().countdown.status;

    if (status === 'idle') {
      //  与手动计时同一套主动作样式 / same primary-action treatment as the manual timer
      this.iconButton(bar, 'play', t('countdownStart'), () => {
        this.startCountdown();
        this.render();
      }, { primary: true });
      return;
    }

    const paused = status === 'paused';
    this.iconButton(
      bar,
      paused ? 'play' : 'pause',
      paused ? t('manualResume') : t('manualPause'),
      () => {
        if (paused) this.deps.countdown.resume();
        else this.deps.countdown.pause();
        this.render();
      },
    );

    this.iconButton(bar, 'flag', t('manualFlag'), () => {
      if (this.deps.countdown.flag()) this.render();
    });

    //  跳段只取消本段剩下的等待，已跑的时长照常计入 / skipping cuts the wait, not the elapsed time
    this.iconButton(bar, 'skip-forward', t('countdownSkip'), () => {
      if (this.deps.countdown.skipPhase()) this.render();
    });

    //  手动停止走备注框，与正计时一致；自动跑完那一次由设置决定，见 main.ts
    //  A manual stop asks for a note, as the count-up does; the automatic finish is governed by
    //  the setting, see main.ts
    this.iconButton(bar, 'square', t('manualStop'), () => {
      this.deps.promptNote((note) => {
        if (note === null) return;
        void this.deps.countdown.stop(note).then(() => this.render());
      });
    });

    this.iconButton(
      bar,
      'x',
      t('manualDiscard'),
      () => {
        this.deps.countdown.discard();
        this.render();
      },
      { danger: true },
    );
  }

  /**
   * 开始一次倒计时 / start a run.
   *
   * 方案在这里按当前设置生成，交给服务之后就不再回头读设置 —— 运行中改设置不该改变这一次。
   * The plan is built from the current settings here and handed to the service, which never reads
   * settings again: editing them mid-run must not alter this run.
   */
  private startCountdown(): void {
    const plan = buildCountdownPlan(countdownConfigFrom(this.deps.settings()));
    if (!this.deps.countdown.start(plan)) {
      this.deps.log.warn('[RTT][countdown] 无法开始 / cannot start: empty plan or already running');
    }
  }

  /** 界面内切换倒计时类型 / switch the countdown mode from the panel. */
  private renderCountdownModeSwitch(root: HTMLElement): void {
    const settings = this.deps.settings();
    const active = this.deps.store.getState().countdown.status !== 'idle';
    new Setting(root)
      .setName(t('countdownModeSetting'))
      .setDesc(active ? t('countdownModeSwitchNextRun') : t('countdownModeSettingDesc'))
      .addDropdown(dropdown => dropdown
        .addOption('down', t('countdownModeDown'))
        .addOption('pomodoro', t('countdownModePomodoro'))
        .addOption('interval', t('countdownModeInterval'))
        .setValue(normalizeMode(settings.countdownMode))
        .setDisabled(active)
        .onChange(value => {
          void this.deps.saveSetting({ countdownMode: normalizeMode(value) }).then(() => this.render());
        }));
  }

  /** 直接打开流程编辑器 / open the plan editor directly. */
  private openPlanEditor(): void {
    new CountdownPlanModal(this.app, {
      settings: this.deps.settings(),
      save: patch => this.deps.saveSetting(patch),
      onSaved: () => this.render(),
    }).open();
  }

  /** 倒计时的显示开关 / the countdown's display switch. */
  private renderCountdownToggles(root: HTMLElement): void {
    const settings = this.deps.settings();
    new Setting(root)
      .setName(t('countdownShowSeconds'))
      .setDesc(t('countdownShowSecondsDesc'))
      .addToggle(toggle => toggle
        .setValue(settings.countdownShowSeconds !== false)
        .onChange(value => {
          void this.deps.saveSetting({ countdownShowSeconds: value }).then(() => this.render());
        }));
  }

  /** 今日倒计时合计 / today's countdown totals. */
  private renderCountdownStats(root: HTMLElement): void {
    const sessions = this.deps.history.getCountdownSessions();
    const today = todayStr();
    const todaySessions = manualSessionsOfDay(sessions, today);

    this.renderStatCards(root, [
      { label: t('countdownTodayTotal'), seconds: manualDayTotalSeconds(sessions, today) },
      { label: t('countdownTodayCount'), value: String(todaySessions.length) },
    ]);
  }

  /**
   * 本次方案 / the plan.
   *
   * 运行中显示的是开始时冻结的那份，空闲时显示按当前设置生成的那份 —— 这样"改完设置先看一眼"
   * 与"这一轮到底在跑什么"是两个不会互相冒充的问题。
   * While running this is the plan frozen at start; while idle it is what the current settings would
   * produce. "What did I configure" and "what is actually running" are two questions that must not
   * answer for each other.
   */
  private renderCountdownPlan(root: HTMLElement): void {
    const state = this.deps.store.getState();
    const plan = state.countdown.plan ?? this.countdownPreview;

    const heading = renderSectionHeading(root, 'list-checks', t('countdownPlanTitle'));
    //  直通入口：不必绕去设置页，标题右侧就能编辑流程
    //  Direct entry: edit the plan from the heading without detouring through settings.
    this.iconButton(heading, 'pencil', t('editPlan'), () => this.openPlanEditor(), { ghost: true }).addClass('rtt-section-action');

    if (!plan || plan.phases.length === 0) {
      root.createDiv({ cls: 'rtt-list-empty', text: t('countdownPlanEmpty') });
      return;
    }

    const total = planTotalSeconds(plan);
    //  时长与统计卡、记录行使用同一种「数字 + 小号单位」排版，不再混用紧凑字符串
    //  Durations use the same figure-plus-muted-unit treatment as the stat cards and lists.
    const summary = root.createDiv({ cls: 'rtt-cd-plan-summary' });
    const template = t('countdownPlanSummary').replace('{count}', String(plan.phases.length));
    const [before = '', after = ''] = template.split('{total}');
    summary.createSpan({ text: `${t(modeLabelKey(plan.mode))} · ${before}` });
    appendDurationParts(summary, formatDurationParts(total));
    if (after) summary.createSpan({ text: after });

    //  方案画成一行色块时间轴：起点固定为「现在」，终点是理想状态下的预计完成时刻。
    //  甘特图每段各占一行，纵向会随分段数增长；block 图始终只有一行，色块按阶段类型着色。
    //  One row of coloured blocks from "now" to the ideal finish. A Gantt gives every phase its own
    //  row and grows vertically; a block diagram stays one row while the blocks still carry phases.
    this.countdownFlow?.mounted?.destroy();
    const nowMs = this.deps.clock.now();
    const position = state.countdown.status === 'idle'
      ? null
      : locatePhase(plan, selectCountdownElapsedSeconds(state, nowMs) + (state.countdown.skippedSeconds ?? 0));
    const built = this.countdownFlowSource(plan, position, nowMs);
    const showSeconds = this.deps.settings().countdownShowSeconds !== false;
    const range = root.createDiv({ cls: 'rtt-cd-range' });
    const nowLabel = range.createSpan({ cls: 'rtt-cd-range-now' });
    range.createSpan({ cls: 'rtt-cd-range-arrow', text: '→' });
    const finishLabel = range.createSpan({ cls: 'rtt-cd-range-finish' });
    this.paintCountdownRange(nowLabel, finishLabel, nowMs, built.finishMs, showSeconds);
    const flow = root.createDiv({ cls: 'rtt-cd-flow' });
    const kinds = new Set(plan.phases.map(phase => phase.kind));
    if (kinds.size > 0) {
      const legend = root.createDiv({ cls: 'rtt-cd-legend' });
      for (const kind of kinds) legend.createSpan({ cls: `rtt-cd-key rtt-cd-key-${kind}`, text: t(phaseLabelKey(kind)) });
    }
    this.countdownFlow = {
      container: flow,
      mounted: null,
      source: built.source,
      phase: position && !position.completed ? position.index : null,
      minute: Math.floor(nowMs / 60000),
      options: { zoom: false, fontSize: 10, padding: 2 },
      range: { now: nowLabel, finish: finishLabel },
    };
    void this.mountCountdownFlow(flow, built.source);
  }

  /** 时间轴两端的读数 / the two ends of the timeline. */
  private paintCountdownRange(now: HTMLElement, finish: HTMLElement, nowMs: number, finishMs: number, showSeconds: boolean): void {
    const clock = (ms: number): string => formatLocalFull(new Date(ms)).slice(11, showSeconds ? 19 : 16);
    now.setText(`${t('countdownNow')} ${clock(nowMs)}`);
    finish.setText(t('countdownEta').replace('{time}', clock(finishMs)));
  }

  /**
   * 方案时间轴 / the plan's timeline.
   *
   * 起点是当前时刻，终点是「理想状态下」的预计完成：运行中只排剩余部分，暂停不计入预计 ——
   * 这张图回答的是"继续跑下去什么时候结束"，不是"暂停了多久"。
   *
   * Starts at the present and ends at the ideal finish: a running plan schedules only what is left,
   * and pauses are excluded. The question is "when will this end if I keep going", not "how long
   * was I paused".
   */
  private countdownFlowSource(
    plan: CountdownPlan,
    position: CountdownPosition | null,
    nowMs: number,
  ): { source: string; finishMs: number } {
    const schedule = this.countdownSchedule(plan, position, nowMs);
    const remainingSeconds = position
      ? (position.completed ? 0 : Math.max(0, position.total - position.elapsed))
      : planTotalSeconds(plan);
    const finishMs = nowMs + remainingSeconds * 1000;
    if (schedule.length === 0) {
      return {
        source: `block-beta\n    columns 1\n    done["${t('countdownCompleted')}"]`,
        finishMs,
      };
    }

    //  时间按比例换成列：目标总列数固定，块宽仍随真实时长变化，且始终只占一行
    //  Time becomes columns on a fixed scale: block widths still follow real durations while the
    //  diagram stays a single row.
    const totalSeconds = schedule.reduce((sum, item) => sum + item.seconds, 0) || 1;
    const targetColumns = Math.max(schedule.length, 48);
    const spans = schedule.map(item => Math.max(1, Math.round((item.seconds / totalSeconds) * targetColumns)));
    const columns = spans.reduce((sum, span) => sum + span, 0);
    const lines = ['block-beta', `    columns ${columns}`];
    schedule.forEach((item, index) => {
      //  只留阶段名：条太窄，完整时长已经写在摘要里 / name only: bars are narrow and the summary has durations
      lines.push(`    p${index}["${item.label.split(' · ')[0]}"]:${spans[index]}`);
    });
    lines.push('    classDef rttFocus fill:var(--interactive-accent),stroke:var(--interactive-accent)');
    lines.push('    classDef rttBreak fill:var(--color-green),stroke:var(--color-green)');
    lines.push('    classDef rttSegment fill:var(--color-blue),stroke:var(--color-blue)');
    schedule.forEach((item, index) => {
      const cls = item.kind === 'focus' ? 'rttFocus' : item.kind === 'break' ? 'rttBreak' : 'rttSegment';
      lines.push(`    class p${index} ${cls}`);
    });
    return { source: lines.join('\n'), finishMs };
  }

  /** 从「现在」开始的剩余排程 / the remaining schedule starting at the present. */
  private countdownSchedule(
    plan: CountdownPlan,
    position: CountdownPosition | null,
    nowMs: number,
  ): Array<{
    label: string;
    phaseIndex: number;
    kind: 'focus' | 'break' | 'segment';
    startMs: number;
    seconds: number;
  }> {
    const out: Array<{
      label: string;
      phaseIndex: number;
      kind: 'focus' | 'break' | 'segment';
      startMs: number;
      seconds: number;
    }> = [];
    const phases = plan.phases;
    let cursor = nowMs;
    const push = (index: number, seconds: number): void => {
      const phase = phases[index];
      if (!phase || seconds < 1) return;
      const name = phase.kind === 'segment'
        ? t('countdownSegmentN').replace('{n}', String(index + 1))
        : t(phaseLabelKey(phase.kind));
      const duration = formatDurationWithSeconds(Math.round(seconds));
      const label = position && index === position.index && !position.completed
        ? `${name} · ${t('countdownRemainingLabel').replace('{time}', duration)}`
        : `${name} · ${duration}`;
      out.push({ label, phaseIndex: index, kind: phase.kind, startMs: cursor, seconds });
      cursor += seconds * 1000;
    };

    if (position?.completed) return out;
    //  空闲排完整方案；运行中从当前段排到结束 —— 后续轮次同样要有色块
    //  Idle lays out the whole plan; running lays out from the current phase to the end — later
    //  cycles keep their bars too.
    const start = position ? position.index : 0;
    for (let index = start; index < phases.length; index++) {
      push(index, position && index === position.index ? position.remaining : phases[index]!.seconds);
    }
    return out;
  }

  /** 挂载/更新流程图 / mount the flow chart, then let phase changes update it in place. */
  private async mountCountdownFlow(container: HTMLElement, source: string): Promise<void> {
    const pele = await loadPele();
    const flow = this.countdownFlow;
    if (!pele || !flow || flow.container !== container || !container.isConnected) return;
    try {
      flow.mounted = pele.mount(container, flow.source || source, flow.options);
    } catch (error) {
      this.deps.log.warn('[RTT][sidebar] 方案流程图渲染失败 / plan flow render failed:', error);
    }
  }

  /**
   * 段切换或整分钟推进时重画时间轴 / redraw on a phase turn or a whole-minute advance.
   *
   * 甘特图的起点是「现在」：运行中每分钟重画一次，跑久了也不会留下一条从旧时刻开始的条。
   * 暂停与空闲不推进刻度，预计完成时刻因此保持不动。
   *
   * The Gantt starts at "now": while running it redraws once a minute so a long run does not keep
   * a bar anchored to a stale start. Paused and idle keep the tick still, so the estimate stays put.
   */
  private syncCountdownFlow(
    plan: CountdownPlan,
    position: CountdownPosition | null,
    nowMs: number,
    advanceMinute: boolean,
  ): void {
    const flow = this.countdownFlow;
    if (!flow) return;
    const phase = position && !position.completed ? position.index : null;
    const minute = advanceMinute ? Math.floor(nowMs / 60000) : flow.minute;
    if (flow.phase === phase && flow.minute === minute) return;
    flow.phase = phase;
    flow.minute = minute;
    const built = this.countdownFlowSource(plan, position, nowMs);
    flow.source = built.source;
    flow.mounted?.update(flow.source);
    this.paintCountdownRange(flow.range.now, flow.range.finish, nowMs, built.finishMs,
      this.deps.settings().countdownShowSeconds !== false);
  }

  /** 这一天的倒计时记录 / that day's countdown runs. */
  private renderCountdownList(root: HTMLElement): void {
    const all = manualSessionsOfDay(this.deps.history.getCountdownSessions(), this.day)
      .slice()
      .reverse();

    renderSectionHeading(root, 'history', t('countdownRecent'));

    if (all.length === 0) {
      root.createDiv({ cls: 'rtt-list-empty', text: t('countdownNoRecords') });
      return;
    }

    const visible = this.countdownExpanded ? all : all.slice(0, TOP_LIST_ITEMS);
    const list = root.createDiv({ cls: 'rtt-list' });

    for (const session of visible as CountdownSession[]) {
      this.renderRecordRow(list, {
        name: session.note || t(modeLabelKey(session.mode)),
        onEdit: () => this.editRecord(draftForSession('countdown', session, this.deps.history.getRevision())),
        editLabel: t('editRecord'),
        stats: [
          formatDurationParts(session.durationSeconds),
          `${session.startTime.slice(11, 19)} – ${session.endTime.slice(11, 19)}`,
        ],
        meta: [
          session.completed ? t('countdownCompleted') : t('countdownStoppedEarly'),
          `${t('countdownPlanTitle')} ${formatDurationWithSeconds(session.plannedSeconds)}`,
        ],
        onDelete: () => {
          this.deps.history.deleteCountdownSession(session.id);
          void this.deps.history.flushNow();
          this.render();
        },
        deleteLabel: t('btnDiscard'),
      });
    }

    if (all.length > TOP_LIST_ITEMS) {
      const more = root.createEl('button', { cls: 'rtt-view-all-btn' });
      setIcon(
        more.createSpan({ cls: 'rtt-view-all-icon' }),
        this.countdownExpanded ? 'chevron-up' : 'chevron-down',
      );
      more.createSpan({
        cls: 'rtt-view-all-label',
        text: this.countdownExpanded ? t('manualShowLess') : t('manualShowMore'),
      });
      more.addEventListener('click', () => {
        this.countdownExpanded = !this.countdownExpanded;
        this.render();
      });
    }
  }

  /** 本轮倒计时的标记 / this run's marks. */
  private renderCountdownFlags(root: HTMLElement): void {
    const state = this.deps.store.getState();
    if (state.countdown.status === 'idle' && state.countdown.flags.length === 0) return;
    renderSectionHeading(root, 'flag', t('manualFlagsTitle'));
    renderManualFlagsTable(
      root,
      state.countdown.flags,
      index => { if (this.deps.countdown.removeFlag(index)) this.render(); },
      (index, label) => { if (this.deps.countdown.renameFlag(index, label)) this.render(); },
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
    if (!settings.documentTrackingEnabled && !settings.manualTimerEnabled && settings.countdownTimerEnabled === false) {
      ovLeft.createDiv({ cls: 'rtt-empty-hint', text: t('ovEmpty') });
      return;
    }

    //  一份账本同时给出今日与本周，两者只差窗口长度 —— 以前周格走的是另一套"含非阅读"的区间，
    //  于是同一个"周"在两块面板上是两个数。
    //  One account answers for both today and the week, differing only in window length. The week
    //  cell used to use a separate "includes non-reading" interval set, so one word meant two
    //  numbers on two panels.
    const input = this.accountInput(this.day);
    const today = dayAccount(input);
    const week = weekAccount(input);
    const weekIntervals = accountIntervals(input);

    //  上：合计；下：日导航 + 热力图 + 明细 —— 导航必须跟着它描述的那张图走
    //  Top: the totals; bottom: day nav, heatmap and detail — the nav has to travel with the chart it
    //  describes
    this.renderStatCards(ovLeft, [
      { label: t('ovUnion'), seconds: today.union, emphasis: true },
      { label: t('ovWeekTotal'), seconds: week.union },
      { label: t('ovDocument'), seconds: today.document },
      { label: t('ovView'), seconds: today.view },
      { label: t('ovManual'), seconds: today.manual },
      { label: t('ovCountdown'), seconds: today.countdown },
      { label: t('ovOverlap'), seconds: today.overlap },
    ]);

    // day navigation
    const layout = ovRight.createDiv({ cls: 'rtt-overview-layout' });
    const head = layout.createDiv({ cls: 'rtt-heatmap-wrap rtt-overview-chart' });
    const aside = layout.createDiv({ cls: 'rtt-overview-aside' });
    this.renderDayNav(head);

    const sources = visibleSources(this.hiddenHeatmap);
    const tracks = buildOverviewTracks(weekIntervals, input.manual, input.countdown, this.day);
    renderHeatmapLegend(head, tracks.map(track => ({ key: sourceClass[track.source], className: sourceClass[track.source], label: overviewSourceName(track.source) })), this.hiddenHeatmap, key => this.toggleHeatmapClass(key));
    const sourcePicker = head.createDiv({ cls: 'rtt-mobile-source-picker' });
    const sourceOptions: Record<string, string> = { all: t('ovAllSources') };
    for (const track of tracks) sourceOptions[track.source] = overviewSourceName(track.source);
    const selectedSources = [...sources];
    const selectionValue = selectedSources.length === 4 ? 'all' : selectedSources.length === 1 ? selectedSources[0] : 'custom';
    if (selectionValue === 'custom') sourceOptions.custom = selectedSources.map(overviewSourceName).join(' + ') || t('ovEmpty');
    new DropdownComponent(sourcePicker).addOptions(sourceOptions).setValue(selectionValue).onChange(value => {
      if (value === 'custom') return;
      for (const track of tracks) {
        if (value === 'all' || value === track.source) this.hiddenHeatmap.delete(sourceClass[track.source]);
        else this.hiddenHeatmap.add(sourceClass[track.source]);
      }
      this.render();
    }).selectEl.setAttribute('aria-label', t('ovSources'));

    let detail: HTMLElement | null = null;
    const dayBase = toAbsoluteMinutes(this.day + ' 00:00:00')!;
    const paintSelection = (): void => {
      if (!detail) return;
      detail.empty();
      const selected = this.overviewSelection;
      const hourOnly = selected?.day === this.day && selected.hourOnly === true;
      const process = selected && !hourOnly && selected.day === this.day
        ? tracks.flatMap(track => track.processes).find(item => item.id === selected.id && sources.has(item.source))
        : undefined;
      // 点到的过程跨出本小时，就按整个过程展开；完整落在这小时里的过程则退回整小时合看。
      // 与是否筛选无关：筛选只决定"看哪些来源"，不改变"这一段属于哪个小时"。
      // A clicked process reaching outside the hour opens as a whole process; one confined to the hour
      // falls back to the hourly view — the same rule with or without a source filter.
      const hourStart = selected ? dayBase + selected.hour * 60 : dayBase;
      const whole = process !== undefined
        && (process.startAbs < hourStart - 1e-6 || process.endAbs > hourStart + 60 + 1e-6);
      const sameHour = (element: HTMLElement): boolean =>
        Number(element.closest<HTMLElement>('.rtt-overview-hour')?.dataset.rttHour) === selected?.hour;
      for (const element of Array.from(head.querySelectorAll<HTMLElement>('.rtt-hm-seg'))) {
        const active = selected?.day === this.day && (hourOnly
          ? sameHour(element)
          : process !== undefined && (whole ? element.dataset.rttGroup === process.id : sameHour(element)));
        element.toggleClass('is-selected', active);
        element.setAttribute('aria-pressed', String(active));
      }
      if (selected?.day === this.day) {
        if (hourOnly) this.renderOverviewHour(detail, tracks, selected.hour, sources);
        else if (process) {
          if (whole) this.renderOverviewProcess(detail, process);
          else this.renderOverviewHour(detail, tracks, selected.hour, sources);
        }
      }
      this.placeOverviewDetail?.();
    };
    const chart = renderOverviewTracks(head, tracks, this.day, sources,
      this.overviewSelection?.day === this.day && !this.overviewSelection.hourOnly ? this.overviewSelection.id : null,
      (process, hour) => {
        this.overviewSelection = this.overviewSelection?.day === this.day && !this.overviewSelection.hourOnly
          && this.overviewSelection.id === process.id && this.overviewSelection.hour === hour
          ? null : { day: this.day, id: process.id, hour };
        paintSelection();
      },
      hour => {
        this.overviewSelection = this.overviewSelection?.day === this.day && this.overviewSelection.hourOnly === true
          && this.overviewSelection.hour === hour ? null : { day: this.day, id: '', hour, hourOnly: true };
        paintSelection();
      },
      sources.size === 4);
    detail = aside.createDiv({ cls: 'rtt-hm-detail rtt-overview-detail' });
    this.placeOverviewDetail = () => {
      if (!detail) return;
      const selected = this.overviewSelection;
      const wide = layout.clientWidth >= ActivitySidebarView.WIDE_PX && !this.contentEl.ownerDocument.body.hasClass('is-mobile');
      layout.toggleClass('is-wide', wide);
      layout.toggleClass('has-selection', detail.hasChildNodes());
      if (wide || !selected || selected.day !== this.day || !detail.hasChildNodes()) { if (detail.parentElement !== aside) aside.appendChild(detail); }
      else {
        const placed = selected.hourOnly
          ? chart.placeHourDetail(detail, selected.hour)
          : chart.placeDetail(detail, selected.id, selected.hour);
        if (!placed && detail.parentElement !== aside) aside.appendChild(detail);
      }
    };
    paintSelection();
    renderHint(ovRight, t('ovExplain'));
    this.renderOverviewList(ovRight, tracks);
  }

  private overviewTimestamp(absolute: number): string {
    const base = toAbsoluteMinutes(this.day + ' 00:00:00')!;
    const date = new Date(this.day + 'T00:00:00');
    date.setSeconds(Math.round((absolute - base) * 60));
    return formatLocalFull(date);
  }

  private renderOverviewProcess(parent: HTMLElement, process: OverviewProcess, summary = true): void {
    if (process.session) {
      this.renderEditableSession(parent, process.session, process.source === 'countdown' ? 'countdown' : 'manual'); return;
    }
    const from = this.overviewTimestamp(process.startAbs);
    const to = this.overviewTimestamp(process.endAbs);
    const now = formatLocalFull(new Date(this.deps.clock.now()));
    const until = to < now ? to : now;
    const visits = previewVisits(this.cachedEvents(), from, until, accountIntervals(this.accountInput(this.day)), new Set([process.source]));
    const state: TimelineDisclosureState = { expanded: this.timelineExpanded, scope: this.day + ':' + (summary ? 'selected:' : 'day:') + process.id };
    const nodes = visitNodes(visits, true, state, visit => this.editVisit(visit));
    const key = state.scope;
    const paint = (): void => {
      parent.empty();
      const shown = this.overviewPreviewExpanded.has(key) ? nodes : nodes.slice(0, 8);
      const header: TimelineNode = { icon: overviewSourceIcon(process.source), kind: process.source,
        title: this.processTitle(process, visits), timeRange: from.slice(11, 19) + ' – ' + to.slice(11, 19),
        lines: [formatDurationParts(Math.round((process.endAbs - process.startAbs) * 60))] };
      renderTimelineList(parent, summary && nodes.length > 1 ? [header, ...shown] : shown, state);
      if (nodes.length > 8) {
        const more = parent.createEl('button', { cls: 'rtt-view-all-btn', text: this.overviewPreviewExpanded.has(key) ? t('manualShowLess') : t('processMore').replace('{n}', String(nodes.length - 8)) });
        more.addEventListener('click', () => { if (this.overviewPreviewExpanded.has(key)) this.overviewPreviewExpanded.delete(key); else this.overviewPreviewExpanded.add(key); paint(); });
      }
    };
    paint();
  }

  /** 视图/文档过程用真实标题，不再回落到「插件视图」「文档」 / real titles instead of source labels. */
  private visitDisplayTitle(visit: TargetVisit): string {
    return visit.title?.trim() || (isPluginViewKey(visit.target) ? pluginViewLabel(visit.target) : visit.target.split('/').pop() ?? visit.target);
  }

  /** 取过程范围内停留最久的那一段作为标题 / the longest stay names the process. */
  private processTitle(process: OverviewProcess, visits: readonly TargetVisit[]): string {
    if (process.session) return process.session.note || overviewSourceName(process.source);
    const from = parseSessionStartTime(this.overviewTimestamp(process.startAbs))?.getTime();
    const to = parseSessionStartTime(this.overviewTimestamp(process.endAbs))?.getTime();
    let best: TargetVisit | null = null;
    let bestOverlap = 0;
    for (const visit of visits) {
      if ((isPluginViewKey(visit.target) ? 'view' : 'document') !== process.source) continue;
      const start = parseSessionStartTime(visit.from)?.getTime();
      const end = parseSessionStartTime(visit.to)?.getTime();
      if (start === undefined || end === undefined) continue;
      const overlap = Math.min(end, to ?? end) - Math.max(start, from ?? start);
      if (overlap > bestOverlap) { best = visit; bestOverlap = overlap; }
    }
    return best ? this.visitDisplayTitle(best) : overviewSourceName(process.source);
  }

  /**
   * 整小时视图：列出与该小时相交的全部过程 / every process overlapping the hour.
   *
   * 过程跨出小时时按它的真实起止显示，不在整点被截断 —— 这正是"被断片了就持续显示直到结束"：
   * 一行读到的始终是同一个过程，而不是按小时切开的几段。
   *
   * A process crossing the hour is shown over its real extent instead of being cut at the hour:
   * a row always reads as one process, never as slices split by clock boundaries.
   */
  private renderOverviewHour(
    parent: HTMLElement, tracks: readonly OverviewTrack[], hour: number,
    sources: ReadonlySet<OverviewSource>,
  ): void {
    const dayBase = toAbsoluteMinutes(this.day + ' 00:00:00')!;
    const hourStartAbs = dayBase + hour * 60;
    const hourEndAbs = hourStartAbs + 60;
    const hourStart = this.overviewTimestamp(hourStartAbs);
    const hourEnd = this.overviewTimestamp(hourEndAbs);
    parent.createDiv({ cls: 'rtt-vtl-range', text: hourStart.slice(11, 19) + ' – ' + hourEnd.slice(11, 19) });

    const overlapping = tracks
      .filter(track => sources.has(track.source))
      .flatMap(track => track.processes.filter(process => process.endAbs > hourStartAbs && process.startAbs < hourEndAbs));
    const rangeStart = overlapping.length > 0 ? Math.min(hourStartAbs, ...overlapping.map(process => process.startAbs)) : hourStartAbs;
    const rangeEnd = overlapping.length > 0 ? Math.max(hourEndAbs, ...overlapping.map(process => process.endAbs)) : hourEndAbs;
    const from = this.overviewTimestamp(rangeStart);
    const toFull = this.overviewTimestamp(rangeEnd);
    const now = formatLocalFull(new Date(this.deps.clock.now()));
    const to = toFull < now ? toFull : now;

    const state: TimelineDisclosureState = { expanded: this.timelineExpanded, scope: this.day + ':hour:' + hour };
    const documentSources = new Set([...sources].filter(source => source === 'document' || source === 'view'));
    const visits = previewVisits(this.cachedEvents(), from, to, accountIntervals(this.accountInput(this.day)), documentSources)
      .filter(visit => visit.to > hourStart && visit.from < hourEnd);
    const items = visitNodes(visits, true, state, visit => this.editVisit(visit)).map(node => ({
      at: toAbsoluteMinutes(this.day + ' ' + (node.timeRange?.slice(0, 8) ?? hourStart.slice(11, 19))) ?? hourStartAbs, node,
    }));

    for (const process of overlapping) {
      const session = process.session;
      if (!session) continue;
      const kind = process.source === 'countdown' ? 'countdown' : 'manual';
      const node: TimelineNode = { icon: kind === 'countdown' ? 'hourglass' : 'timer', kind,
        key: 'hour:' + process.id, title: session.note || overviewSourceName(process.source),
        timeRange: session.startTime.slice(11, 19) + ' – ' + session.endTime.slice(11, 19),
        lines: [formatDurationParts(session.durationSeconds)],
        onEdit: () => this.editRecord(draftForSession(kind, session, this.deps.history.getRevision())),
        renderDetail: container => renderManualSessionDetail(container, session, (index, label) => this.renameSavedFlag(session, kind, index, label)) };
      items.push({ at: process.startAbs, node });
    }
    renderTimelineList(parent, items.sort((left, right) => left.at - right.at).map(item => item.node), state);
  }

  private renderEditableSession(parent: HTMLElement, session: ManualSession, kind: 'manual' | 'countdown'): void {
    const toolbar = parent.createDiv({ cls: 'rtt-process-toolbar' });
    this.iconButton(toolbar, 'pencil', t('editRecord'), () => this.editRecord(draftForSession(kind, session, this.deps.history.getRevision())), { ghost: true });
    renderManualSessionDetail(parent, session, (index, label) => this.renameSavedFlag(session, kind, index, label));
  }

  /**
   * 修改已保存一轮里的标记名称 / rename a mark on a recorded round.
   *
   * 走记录编辑的版本化更正，而不是直接改源行：这样与冲突检测、同步合并保持同一套语义。
   * Goes through the versioned correction ledger rather than editing the source row, keeping
   * conflict detection and sync merging on the same semantics.
   */
  private renameSavedFlag(session: ManualSession, kind: 'manual' | 'countdown', index: number, label: string): void {
    try {
      const draft = draftForSession(kind, session, this.deps.history.getRevision());
      const flag = draft.flags[index];
      if (!flag) return;
      const next = label.trim();
      if (next === flag.label) return;
      flag.label = next;
      void new RecordEditingService(this.deps.history).save(draft)
        .then(() => this.refresh())
        .catch((error: unknown) => { new Notice(error instanceof Error ? error.message : String(error)); });
    } catch (error) {
      this.deps.log.warn('[RTT][sidebar] 修改标记名称失败 / rename mark failed:', error);
    }
  }

  private renderOverviewList(root: HTMLElement, tracks: readonly OverviewTrack[]): void {
    renderSectionHeading(root, 'list-tree', t('ovListTitle'));
    const sources = visibleSources(this.hiddenHeatmap);
    // 一天只推导一次访问，供所有分组取真实标题 / derive the day's visits once for every group title.
    //  absoluteOf() 的零点不是午夜，端点必须同样用「当天零点 + 1440 分钟」换算
    //  absoluteOf() has an arbitrary origin, so the end must use the same day-base conversion.
    const dayStartAbs = toAbsoluteMinutes(this.day + ' 00:00:00')!;
    const dayVisits = buildVisits(this.cachedEvents(), this.day + ' 00:00:00', this.overviewTimestamp(dayStartAbs + 1440), false);
    //  每个来源的总时长先算好，按降序排，并以此为分母给出占比
    //  Totals are computed first, sorted descending, and used as the denominator for each share.
    const entries = tracks
      .filter(track => sources.has(track.source) && track.processes.length > 0)
      .map(track => ({
        track,
        totalSeconds: track.processes.reduce((sum, process) => sum + (process.session?.durationSeconds ?? Math.round((process.endAbs - process.startAbs) * 60)), 0),
      }))
      .sort((left, right) => right.totalSeconds - left.totalSeconds);
    const sumSeconds = entries.reduce((sum, entry) => sum + entry.totalSeconds, 0);
    for (const { track, totalSeconds } of entries) {
      const key = this.day + ':' + track.source;
      const open = this.overviewSourcesExpanded.has(key);
      const group = root.createDiv({ cls: 'rtt-source-processes' });
      const summary = group.createEl('button', { cls: 'rtt-source-header ' + sourceClass[track.source], attr: { type: 'button', 'aria-expanded': String(open) } });
      const share = sumSeconds > 0 ? (totalSeconds / sumSeconds) * 100 : 0;
      summary.setCssProps({ '--rtt-share': `${share}%` });
      const icon = summary.createSpan({ cls: 'rtt-source-icon ' + sourceClass[track.source] });
      setIcon(icon, overviewSourceIcon(track.source));
      summary.createSpan({ cls: 'rtt-source-name', text: overviewSourceName(track.source) });
      const metrics = summary.createSpan({ cls: 'rtt-source-metrics' });
      metrics.createSpan({ cls: 'rtt-source-total', text: formatDurationWithSeconds(totalSeconds) });
      metrics.createSpan({ cls: 'rtt-source-share', text: share > 0 && share < 1 ? '<1%' : `${Math.round(share)}%` });
      const chevron = summary.createSpan({ cls: 'rtt-source-chevron' });
      const content = group.createDiv({ cls: 'rtt-source-content' });
      let expanded = open;
      content.hidden = !expanded;
      const paintChevron = (): void => setIcon(chevron, expanded ? 'chevron-down' : 'chevron-right');
      paintChevron();
      const render = (): void => {
        if (content.hasChildNodes()) return;
        const state: TimelineDisclosureState = { expanded: this.timelineExpanded, scope: key };
        const nodes: TimelineNode[] = track.processes.map(process => ({
          key: process.id, icon: overviewSourceIcon(track.source), kind: track.source,
          timeRange: this.overviewTimestamp(process.startAbs).slice(11, 19) + ' – ' + this.overviewTimestamp(process.endAbs).slice(11, 19),
          title: this.processTitle(process, dayVisits),
          lines: [formatDurationParts(process.session?.durationSeconds ?? Math.round((process.endAbs - process.startAbs) * 60))],
          onEdit: process.session ? () => this.editRecord(draftForSession(process.source === 'countdown' ? 'countdown' : 'manual', process.session!, this.deps.history.getRevision())) : undefined,
          renderDetail: container => this.renderOverviewProcess(container, process, false),
        }));
        renderTimelineList(content, nodes, state);
      };
      const setOpen = (next: boolean): void => {
        expanded = next;
        content.hidden = !next;
        summary.setAttribute('aria-expanded', String(next));
        paintChevron();
        if (next) { this.overviewSourcesExpanded.add(key); render(); }
        else this.overviewSourcesExpanded.delete(key);
      };
      summary.addEventListener('click', () => setOpen(!expanded));
      if (open) render();
    }
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
      title: `${span.from.slice(11, 19)} – ${span.to.slice(11, 19)}`,
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
    const selectRound = (target: HTMLElement, id: string, hour: number): void => {
      target.addClass('is-clickable');
      target.setAttribute('role', 'button');
      target.tabIndex = 0;
      const select = (): void => {
        const segment = [...head.querySelectorAll<HTMLElement>('.rtt-hm-seg')].find((element) => element.dataset.rttGroup === id && Number(element.closest<HTMLElement>('.rtt-hm-row')?.dataset.rttHour) === hour);
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
      this.cachedEvents(),
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
            selectRound(block, pause.session.id, hour);
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
            selectRound(tick, mark.session.id, hour);
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
      { groupOf: (segment) => segment.session.id, render: (panel, segment) => this.renderEditableSession(panel, segment.session, 'manual') },
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
    //  开关摆在日期选择器**上面**：它决定下面那个日历点一下是选一天，还是选区间的一端
    //  The switch sits above the date picker: it decides whether a click in the calendar below picks one
    //  day or one end of a range.
    const nav = parent.createDiv({ cls: 'rtt-timeline-nav' });

    //  区间模式下箭头没有意义（点日历两端即可），收起来免得和区间标签打架
    //  Arrows are meaningless in range mode (the calendar picks both ends), so they fold away rather
    //  than fight with the range label.
    if (!this.rangeMode) {
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
    }

    const trigger = nav.createEl('button', { cls: 'rtt-day-trigger' });
    setIcon(trigger.createSpan({ cls: 'rtt-day-trigger-icon' }), 'calendar');
    trigger.createSpan({
      cls: 'rtt-day-trigger-label',
      text: this.dayLabelText(),
    });
    trigger.setAttribute('aria-label', t('dayPicker'));
    trigger.setAttribute('aria-expanded', String(this.calendarOpen));
    setTooltip(trigger, t('dayPickerDesc'));
    trigger.addEventListener('click', () => {
      this.calendarOpen = !this.calendarOpen;

      //  Every open starts from the selected day's month, not wherever the last browse ended
      this.calendarMonth = this.day.slice(0, 7);
      this.render();
    });

    if (!this.rangeMode) {
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
    }

    if (this.calendarOpen) this.renderCalendar(nav, trigger);
  }

  /**
   * 日期触发器上的文字 / the text on the date trigger.
   * 区间模式下显示「起点 – 终点」，只选了起点时显示「起点 – …」。
   * In range mode it reads "start – end", or "start – …" while only the start is picked.
   */
  private dayLabelText(): string {
    if (!this.rangeMode) return this.day;
    if (this.rangeStart && this.rangeEnd) return `${this.rangeStart} – ${this.rangeEnd}`;
    if (this.rangeStart) return `${this.rangeStart} – …`;
    return t('rangePickStart');
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

      //  区间的两端与中间各自标出来：两端实心，中间一条浅带
      //  Both ends and everything between are marked: solid ends, a light band between.
      if (this.rangeStart && value === this.rangeStart) cell.addClass('is-range-start');
      if (this.rangeEnd && value === this.rangeEnd) cell.addClass('is-range-end');
      if (this.rangeStart && this.rangeEnd
        && value > this.rangeStart && value < this.rangeEnd) cell.addClass('is-in-range');

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
        if (this.rangeMode) {
          //  先点起点、再点终点；点反了就调换，保证 start ≤ end
          //  First click is the start, second the end; if they arrive the other way round the pair is
          //  swapped so start ≤ end.
          if (!this.rangeStart || this.rangeEnd) {
            this.rangeStart = value;
            this.rangeEnd = null;
            this.day = value;
            this.calendarOpen = true;
          } else {
            const start = this.rangeStart;
            this.rangeStart = start < value ? start : value;
            this.rangeEnd = start < value ? value : start;
            this.day = this.rangeEnd;
            this.calendarOpen = false;
          }
          this.render();
          return;
        }

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
    const addRange = (from: string, to: string): void => {
      const start = parseSessionStartTime(from);
      const end = parseSessionStartTime(to);
      if (!start || !end || end <= start) return;
      const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      while (cursor < end) { days.add(formatLocalFull(cursor).slice(0, 10)); cursor.setDate(cursor.getDate() + 1); }
    };
    for (const event of this.cachedEvents()) {
      const day = event.time.slice(0, 10);
      if (day) days.add(day);
    }
    for (const session of this.deps.history.getManualSessions()) {
      addRange(session.startTime, session.endTime);
    }
    //  倒计时也是可翻阅的一天 / countdown days are browsable too
    for (const session of this.deps.history.getCountdownSessions()) {
      addRange(session.startTime, session.endTime);
    }
    // 更正后移到的新日期也须能从日历进入 / corrected dates remain reachable in the calendar.
    for (const edit of editsOf(this.cachedEvents())) addRange(edit.visit.startTime, edit.visit.endTime);
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

    renderSectionHeading(root, 'history', t('manualRecent'));

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
        onEdit: () => this.promptManualNote(session),
        editLabel: t('recordEditNote'),
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
                this.cachedEvents(),
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

      //  统计格：一份账本，五条通道 / the grid: one account, five channels
      if (
        this.liveNodes.todayAway
        || this.liveNodes.todayIdle
        || this.liveNodes.todayPaused
        || this.liveNodes.todayRead
      ) {
        const account = dayAccount(this.accountInput(this.deps.clock.today()));

        const week = weekAccount(this.accountInput(this.deps.clock.today()));
        if (this.liveNodes.todayTotal) setReadTime(this.liveNodes.todayTotal, account.total, mode);
        if (this.liveNodes.weekRead) setReadTime(this.liveNodes.weekRead, week.reading, mode);
        if (this.liveNodes.weekTotal) setReadTime(this.liveNodes.weekTotal, week.total, mode);
        if (this.liveNodes.todayAway) setReadTime(this.liveNodes.todayAway, account.away, mode);
        if (this.liveNodes.todayIdle) setReadTime(this.liveNodes.todayIdle, account.idle, mode);
        if (this.liveNodes.todayPaused) setReadTime(this.liveNodes.todayPaused, account.paused, mode);
        if (this.liveNodes.todayRead) setReadTime(this.liveNodes.todayRead, account.reading, mode);
      }

      if (this.liveNodes.manualState) {
        this.paintStateIcon(this.liveNodes.manualState, state.manual.status);
      }
      if (this.liveNodes.countdownState) {
        this.paintStateIcon(this.liveNodes.countdownState, state.countdown.status);
      }

      if (this.liveNodes.manual) {
        const nowMs = this.deps.clock.now();
        const elapsed = selectManualElapsedSeconds(state, nowMs);
        const settings = this.deps.settings();

        //  毫秒优先于"显示秒"：开着毫秒却只显示到分，等于两个开关打架
        //  Milliseconds beat "show seconds": showing only minutes while milliseconds are on would be
        //  two switches fighting each other.
        if (settings.manualShowMilliseconds === true && state.manual.status !== 'idle') {
          setClockTimeMs(this.liveNodes.manual, selectManualElapsedMs(state, nowMs));
        } else if (settings.manualShowSeconds !== false) {
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
          this.liveNodes.ring.setCssProps({ '--rtt-ring-pct': String(percent) });
        }
      }

      //  倒计时：读数方向相反（还剩多久），环画的是本段进度
      //  Countdown: the readout runs the other way (how much is left) and the ring shows this phase
      if (this.liveNodes.countdown) {
        this.updateCountdownLive(state, this.deps.clock.now());
      }
    } catch (error) {

      //  A failed number update must not break the view; the next heartbeat retries
      this.deps.log.warn('[RTT][sidebar] 数字刷新失败 / live update failed:', error);
    }
  }

  /**
   * 圆环内的状态图标 / the state icon inside the ring.
   *
   * 运行中是一个转圈，暂停是闪烁的暂停键 —— 不必读文字就知道秒表在不在走。只在状态真的变了时重建
   * SVG：每秒重建会把旋转动画打断，看起来像卡住。
   *
   * Running spins, paused flashes — whether the clock is moving is visible without reading. The SVG is
   * rebuilt only when the state actually changes: rebuilding it every second restarts the animation,
   * which reads as a stutter.
   */
  private paintStateIcon(
    stateEl: HTMLElement,
    status: 'idle' | 'running' | 'paused',
  ): void {
    stateEl.toggleClass('is-running', status === 'running');
    stateEl.toggleClass('is-paused', status === 'paused');

    const icon = stateEl.querySelector<HTMLElement>('.rtt-state-icon');
    if (!icon) return;

    const wanted = status === 'idle' ? '' : status === 'running' ? 'loader-circle' : 'pause';
    if (icon.dataset.rttIcon === wanted) return;
    icon.dataset.rttIcon = wanted;
    icon.empty();
    if (wanted) setIcon(icon, wanted);
  }

  /**
   * 倒计时的每秒刷新 / the countdown's once-a-second update.
   *
   * 空闲时预览方案总长（"这次要跑多久"），运行中显示本段剩余。环画的是**本段**进度而不是整轮：
   * 番茄钟的"整轮还剩多久"在环上是一段连续的、看不出段的线。
   *
   * Idle previews the plan's total ("how long this one will be"); running shows what is left in the
   * current phase. The ring is the **phase**, not the whole run: a pomodoro's "how far through
   * everything" is one continuous line that says nothing about which phase you are in.
   */
  /** 倒计时读数：秒开关只影响显示，记录仍是毫秒 / display only; records keep milliseconds. */
  private paintCountdownTime(el: HTMLElement, seconds: number): void {
    if (this.deps.settings().countdownShowSeconds !== false) setClockTime(el, seconds);
    else setReadTime(el, seconds, 'compact');
  }

  private updateCountdownLive(state: TimerState, nowMs: number): void {
    const countdown = state.countdown;
    const idle = countdown.status === 'idle';
    const plan = idle ? this.countdownPreview : countdown.plan;

    if (!plan || plan.phases.length === 0) {
      this.liveNodes.countdownPhase?.setText(t('countdownIdle'));
      this.liveNodes.countdownProgress?.setText('');
      if (this.liveNodes.countdown) this.paintCountdownTime(this.liveNodes.countdown, 0);
      this.liveNodes.countdownRing?.setCssProps({ '--rtt-ring-pct': '0' });
      return;
    }

    const total = planTotalSeconds(plan);
    //  跳段记录的有效偏移只影响定位，实际读数与记录时长始终来自已过时间
    //  The skip offset affects phase location only; readings and saved durations stay real elapsed time.
    const position: CountdownPosition | null = idle
      ? null
      : locatePhase(plan, selectCountdownElapsedSeconds(state, nowMs) + (countdown.skippedSeconds ?? 0));

    const remaining = position ? position.remaining : total;
    const phaseIndex = position ? position.index : 0;

    if (this.liveNodes.countdown) this.paintCountdownTime(this.liveNodes.countdown, remaining);

    if (this.liveNodes.countdownRing) {
      const percent = position && position.phaseSeconds > 0
        ? (position.phaseElapsed / position.phaseSeconds) * 100
        : 0;
      this.liveNodes.countdownRing.setCssProps({ '--rtt-ring-pct': String(percent) });
    }

    if (this.liveNodes.countdownPhase) {
      const progress = t('countdownPhaseProgress')
        .replace('{n}', String(phaseIndex + 1))
        .replace('{total}', String(plan.phases.length));

      if (idle) {
        this.liveNodes.countdownPhase.setText(t('countdownIdle'));
        this.liveNodes.countdownProgress?.setText('');
      } else if (countdown.status === 'paused') {
        //  暂停时第一行说明状态，第二行仍报进度 —— 否则"停在哪一段"就丢了
        //  While paused line 1 states the state and line 2 keeps the progress, so "which phase" is
        //  not lost.
        this.liveNodes.countdownPhase.setText(t('manualPaused'));
        this.liveNodes.countdownProgress?.setText(progress);
      } else {
        const phase = plan.phases[phaseIndex];
        const name = phase
          ? phase.kind === 'segment'
            ? t('countdownSegmentN').replace('{n}', String(phaseIndex + 1))
            : t(phaseLabelKey(phase.kind))
          : '';
        this.liveNodes.countdownPhase.setText(name);
        this.liveNodes.countdownProgress?.setText(progress);
      }
    }

    //  段切换与整分钟推进只更新甘特图，不重绘整块面板
    //  A phase turn or a minute tick only updates the Gantt, never re-renders the whole panel.
    this.syncCountdownFlow(plan, position, nowMs, countdown.status === 'running');
  }
}
