/**
 * Heatmap rendering
 *
 * The sidebar's document, manual and overview panels plus the records modal all draw the
 * *same* chart: one row per hour, a 60-minute track inside it, segments positioned by
 * left/width percentages. That DOM was copy-pasted three times, so any change had to be
 * made three times. It lives here once; the four call sites differ only in two callbacks —
 * which class a segment gets, and what its label says.
 *
 * The generic covers both segment shapes: reading records carry `channel`, the overview
 * carries `sources`. Both need only the same three geometric fields.
 *
 */

import { setTooltip } from 'obsidian';

import { isPluginViewKey, pluginViewLabel } from '../core/activePath';
import { t } from '../core/i18n';
import type { RecordChannel } from '../core/recordsTimeline';
import {
  formatDurationParts,
  formatDurationWithSeconds,
  parseSessionStartTime,
  type DurationPart,
} from '../core/time';
import type { TimelineEvent } from '../core/types';
import { renderTimelineList, type TimelineNode } from './timelineList';

/** the minimal geometry a segment must expose. */
export interface HeatmapSegment {

  startMinute: number;

  durationMinutes: number;
  /** clipped by an hour boundary or midnight */
  clipped: boolean;
}

/** the minimal shape a row must expose. */
export interface HeatmapRow<S extends HeatmapSegment> {
  /** 0–23 */
  hour: number;
  segments: S[];
}

/**
 * Touching, same-class segments fused into one clickable block.
 *
 * A run of activity is usually stored as many short segments — a blur/focus flicker, or a
 * session the tick kept re-opening — and drawn one-per-segment the chart reads as noise while
 * every target is a sliver too small to hit and too short to be worth a detail panel. Fusing
 * them means one click selects the whole run.
 *
 * `members` keeps the originals, so a call site can still describe what it was looking at.
 */
export interface HeatmapBlock<S extends HeatmapSegment> extends HeatmapSegment {
  members: S[];
}

const TICKS = [0, 15, 30, 45] as const;

/** 判定"相接"的容差（分钟）/ tolerance for calling two segments touching. */
const TOUCH_EPSILON = 1e-6;

/**
 * Fuse touching, same-class segments.
 *
 * Only same-class runs fuse: an in-window stretch and an out-of-window one that happen to
 * touch are different things and stay separately visible, for the colour and for the union
 * maths behind the overview.
 */
export function mergeSegments<S extends HeatmapSegment>(
  segments: readonly S[],
  classOf: (segment: S) => string,
  groupOf?: (segment: S) => string,
): Array<HeatmapBlock<S>> {
  const blocks: Array<HeatmapBlock<S>> = [];

  for (const segment of [...segments].sort((a, b) => a.startMinute - b.startMinute)) {
    const cls = classOf(segment);
    const last = blocks[blocks.length - 1];

    if (last && classOf(last.members[0]!) === cls && (!groupOf || groupOf(last.members[0]!) === groupOf(segment))) {
      const lastEnd = last.startMinute + last.durationMinutes;
      if (segment.startMinute <= lastEnd + TOUCH_EPSILON) {
        last.durationMinutes =
          Math.max(lastEnd, segment.startMinute + segment.durationMinutes) -
          last.startMinute;
        last.clipped = last.clipped || segment.clipped;
        last.members.push(segment);
        continue;
      }
    }

    blocks.push({
      startMinute: segment.startMinute,
      durationMinutes: segment.durationMinutes,
      clipped: segment.clipped,
      members: [segment],
    });
  }

  return blocks;
}

/** Shared by both reading-record call sites so the colouring cannot drift apart. */
export const CHANNEL_CLASSES: Record<RecordChannel, string> = {
  'in-window': 'rtt-hm-in',
  'out-of-window': 'rtt-hm-out',
  paused: 'rtt-hm-paused',
};

/** the class for a reading-record segment. */
export function readingChannelClass(segment: { channel: RecordChannel }): string {
  return CHANNEL_CLASSES[segment.channel];
}

/** the accessible label for a reading-record segment. */
export function readingChannelLabel(segment: {
  channel: RecordChannel;
  durationMinutes: number;
  sessionStart: string;
}): string {
  const channel =
    segment.channel === 'out-of-window'
      ? t('tabUnfocused')
      : segment.channel === 'paused'
        ? t('recChannelPaused')
        : t('tabInWindow');
  const duration = formatDurationWithSeconds(Math.round(segment.durationMinutes * 60));
  const at = segment.sessionStart.slice(11, 16);
  return `${channel} · ${duration} · ${at}`;
}

/**
 * Highlight the clicked segment and clear the previous one.
 *
 * Clicking the same segment again clears the highlight, so the detail block can be dismissed
 * without hunting for a close button.
 */
export function selectSegment(scope: HTMLElement, element: HTMLElement, group?: string): boolean {
  const wasSelected = element.hasClass('is-selected');
  for (const previous of Array.from(scope.querySelectorAll('.rtt-hm-seg.is-selected'))) {
    previous.removeClass('is-selected');
  }
  if (wasSelected) return false;
  if (group === undefined) element.addClass('is-selected');
  else for (const candidate of Array.from(scope.querySelectorAll<HTMLElement>('.rtt-hm-seg'))) {
    if (candidate.dataset.rttGroup === group) candidate.addClass('is-selected');
  }
  return true;
}

/**
 * Render the "what happened during this stretch" block.
 *
 * A segment knows only its offset inside its hour, so the hour is required to recover the
 * wall clock — which is the part a user actually wants ("09:40–09:52"), not a percentage.
 */
export interface SegmentDetail {
  hour: number;
  segment: HeatmapSegment;
  what: string;
  icon: string;
  /** Class modifier for the summary node. */
  kind?: string;
  /** How many recorded pieces the run was fused from; omitted for a single one. */
  pieces?: number;
  /**
   * The whole event log. When given, every operation recorded inside the stretch is listed
   * under the summary — a stretch is not just "how long", it is what happened: a file switch,
   * the window losing focus, a pause.
   */
  events?: readonly TimelineEvent[];
  /** The day the chart was drawn for, as YYYY-MM-DD. */
  day: string;
}

/**
 * Render the "what happened during this stretch" block.
 *
 * A segment knows only its offset inside its hour, so the hour and the day are both required to
 * recover the wall clock — which is the part a user actually wants ("09:40–09:52"), not a
 * percentage.
 */
export function renderSegmentDetail(container: HTMLElement, options: SegmentDetail): void {
  const { hour, segment, what, icon, kind, pieces, events, day } = options;

  const pad = (value: number): string => String(Math.floor(value)).padStart(2, '0');
  const clock = (minutes: number): string => `${pad((minutes / 60) % 24)}:${pad(minutes % 60)}`;
  const startMinute = hour * 60 + segment.startMinute;
  const endMinute = startMinute + segment.durationMinutes;

  const summaryLines: Array<string | readonly DurationPart[]> = [
    `${t('heatmapDetailDuration')} ${formatDurationWithSeconds(
      Math.round(segment.durationMinutes * 60),
    )}`,
    what,
  ];
  // 合并来的一整段说明它是由多少小段拼的，否则用户会以为记录本身就这么粗
  // A fused run says how many pieces it came from, or the record looks coarser than it is
  if (pieces !== undefined && pieces > 1) {
    summaryLines.push(t('heatmapDetailPieces').replace('{n}', String(pieces)));
  }

  const summary: TimelineNode = {
    icon,
    kind,
    title: `${clock(startMinute)} – ${clock(endMinute)}`,
    lines: summaryLines,
  };

  let visits: TimelineNode[] = [];

  if (events) {
    // The window is widened to whole minutes on both ends. A stretch is measured in minutes and
    // then rounded, so an exact comparison would drop the very events that define it — measured:
    // a stretch labelled 14:20–14:20 matched nothing, because its events sit at 14:20:06.
    const at = (minutes: number, seconds: number): string =>
      `${day} ${pad((minutes / 60) % 24)}:${pad(minutes % 60)}:${pad(seconds)}`;

    visits = processNodes(events, at(Math.floor(startMinute), 0), at(Math.ceil(endMinute), 59), clock);
  }

  // A single visit already says everything the summary would: its own node carries the range and
  // the duration, and the icon carries the source. Printing both put the same two values on two
  // consecutive lines.
  const nodes = visits.length === 1 ? visits : [summary, ...visits];
  if (visits.length === 0) nodes.push(summary);

  // One timeline: the summary and every visit hang off the same line, so the run reads as a
  // sequence rather than a fact plus an appendix.
  renderTimelineList(container, nodes);
}

/** One visit to a target: from becoming active to handing over. */
interface TargetVisit {
  target: string;
  from: string;
  to: string;
  activeSeconds: number;
  unfocusedSeconds: number;
  pausedSeconds: number;
  /** Whether a transition out of this visit led to another target. */
  nextTarget: string | null;
}

/** Split a "YYYY-MM-DD HH:mm:ss" into milliseconds for arithmetic. */
function timeMs(value: string): number {
  return parseSessionStartTime(value)?.getTime() ?? 0;
}

/**
 * The stretch as a sequence of visits / 这段时间读过的目标序列.
 *
 * A visit runs from the moment a target became active until it was handed over — by a switch,
 * or by a save that closed it. Blur, focus and pause do not start a visit: they change what the
 * time *means*, so they are accumulated into the visit that contains them rather than becoming
 * nodes of their own.
 */
function buildVisits(events: readonly TimelineEvent[], from: string, to: string): TargetVisit[] {
  const visits: TargetVisit[] = [];
  // A holder rather than a captured `let`: TypeScript narrows a mutable capture to `never`
  // once a helper assigns null to it, and every read afterwards fails to type-check.
  const holder: { visit: TargetVisit | null } = { visit: null };
  let state: 'active' | 'unfocused' | 'paused' = 'active';
  let stateSince = '';

  const bank = (until: string): void => {
    const visit = holder.visit;
    if (!visit || !stateSince) return;
    const seconds = Math.max(0, (timeMs(until) - timeMs(stateSince)) / 1000);
    if (state === 'active') visit.activeSeconds += seconds;
    else if (state === 'unfocused') visit.unfocusedSeconds += seconds;
    else visit.pausedSeconds += seconds;
  };

  const open = (target: string, at: string): void => {
    if (!target) return;

    // Already reading this target: a second `start`, or a `switch` that names the file it is
    // already on. The log really contains those (an older build wrote every switch twice), and
    // honouring them would split one visit into several identical nodes.
    if (holder.visit?.target === target) return;

    // The file was closed by a save and immediately started again. Reopening the previous visit
    // keeps it one node; anything else would print the same target twice in a row with nothing
    // between them to explain the split.
    const last = visits[visits.length - 1];
    if (!holder.visit && last && last.target === target) {
      holder.visit = last;
      state = 'active';
      stateSince = at;
      return;
    }

    bank(at);
    const visit: TargetVisit = {
      target,
      from: at,
      to: at,
      activeSeconds: 0,
      unfocusedSeconds: 0,
      pausedSeconds: 0,
      nextTarget: null,
    };
    holder.visit = visit;
    visits.push(visit);
    state = 'active';
    stateSince = at;
  };

  const close = (at: string): void => {
    const visit = holder.visit;
    if (!visit) return;
    bank(at);
    visit.to = at;
    holder.visit = null;
    stateSince = '';
  };

  for (const event of events) {
    if (event.time < from || event.time > to) continue;

    switch (event.type) {
      case 'start':
        open((event as { file?: string }).file ?? '', event.time);
        break;
      case 'switch': {
        const previous = holder.visit;
        const next = event.to ?? '';
        close(event.time);
        if (previous && next && previous.target !== next) previous.nextTarget = next;
        open(next, event.time);
        break;
      }
      case 'blur':
        bank(event.time);
        state = event.unfocusedDisposition === 'reading' ? 'active' : event.unfocusedDisposition === 'paused' ? 'paused' : 'unfocused';
        stateSince = event.time;
        break;
      case 'focus':
        bank(event.time);
        state = 'active';
        stateSince = event.time;
        break;
      case 'pause':
        bank(event.time);
        state = 'paused';
        stateSince = event.time;
        break;
      case 'resume':
        bank(event.time);
        state = 'active';
        stateSince = event.time;
        break;
      case 'save':
      case 'auto-save':
      case 'discard':
        close(event.time);
        break;
      default:
        break;
    }
  }

  // The last visit runs to the end of the stretch: nothing closed it.
  if (holder.visit) {
    bank(to);
    holder.visit.to = to;
  }

  // A visit that banked nothing is a leftover boundary, not a reading stretch.
  const withTime = visits.filter((visit) => visit.activeSeconds + visit.unfocusedSeconds + visit.pausedSeconds > 0);
  return withTime.length > 0 ? withTime : visits;
}

/**
 * Render the stretch's visits as timeline nodes, with a connector between them.
 *
 * The connector carries the switch — it belongs *between* two targets, not inside either, and
 * drawing it beside the line keeps the target sequence as the thing the eye follows.
 */
function processNodes(
  events: readonly TimelineEvent[],
  from: string,
  to: string,
  clock: (minutes: number) => string,
): TimelineNode[] {
  const nodes: TimelineNode[] = [];

  for (const visit of buildVisits(events, from, to)) {
    const isView = isPluginViewKey(visit.target);
    const total = visit.activeSeconds + visit.unfocusedSeconds;

    const lines: Array<string | readonly DurationPart[]> = [
      `${visit.from.slice(11, 16)} – ${visit.to.slice(11, 16)}`,
      formatDurationParts(Math.round(total)),
    ];

    // A visit that was interrupted explains itself: without the split the number looks low for
    // the span it covers.
    if (visit.unfocusedSeconds > 0 || visit.pausedSeconds > 0) {
      const parts = [`${t('tabInWindow')} ${formatDurationWithSeconds(Math.round(visit.activeSeconds))}`];
      if (visit.unfocusedSeconds > 0) {
        parts.push(`${t('tabUnfocused')} ${formatDurationWithSeconds(Math.round(visit.unfocusedSeconds))}`);
      }
      if (visit.pausedSeconds > 0) {
        parts.push(`${t('recChannelPaused')} ${formatDurationWithSeconds(Math.round(visit.pausedSeconds))}`);
      }
      lines.push(parts.join(' · '));
    }

    nodes.push({
      icon: isView ? 'app-window' : 'file-text',
      kind: isView ? 'view' : 'document',
      title: isView
        ? `${t('ovView')} · ${pluginViewLabel(visit.target)}`
        : `${t('ovKindDocument')} · ${visit.target.split('/').pop() ?? visit.target}`,
      lines,
    });

    if (visit.nextTarget) {
      const nextIsView = isPluginViewKey(visit.nextTarget);
      nodes.push({
        icon: 'arrow-right-left',
        variant: 'connector',
        title: `${t('evSwitchTo')} ${
          nextIsView
            ? `${t('ovView')} · ${pluginViewLabel(visit.nextTarget)}`
            : (visit.nextTarget.split('/').pop() ?? visit.nextTarget)
        }`,
      });
    }
  }

  void clock;
  return nodes;
}

/**
 * Draw the heatmap.
 *
 * Only hours with segments and their neighbours are drawn: most of the 24 rows are empty and
 * unreadable in a narrow sidebar.
 *
 * @param parent the container, written into directly
 * @param rows   the 24 rows
 * @param classOf  extra classes for a segment
 * @param labelOf  the accessible label for a segment
 * @param onSelect called when a block is clicked, with the hour it belongs to. Passing the hour
 *                 matters: a block knows only its offset inside its hour, so the wall clock of
 *                 a stretch can only be recovered by the caller.
 * @returns whether anything was drawn
 */
/**
 * 热力图上方的图例 / the legend above a heatmap.
 *
 * 一条颜色对应一个类型名，点名字可以把这一类从图里去掉 —— 密集的图里只想看某几类时用；再点一次
 * 放回来。色块用的是图表自己那套取色类，所以图例与图永远不会对不上。
 *
 * One colour per type, named above the chart. Clicking a name drops that kind from the chart —
 * what a dense chart needs when only part of it is interesting — and clicking again brings it
 * back. The swatch reuses the chart's own colouring classes, so legend and chart cannot disagree.
 */
export interface LegendEntry {
  /** 切换用的键；段用取色类做键，覆盖层（暂停块、标记）用自报名 / the toggle key */
  key: string;
  /** 取色用的类 / the class that carries the colour */
  className: string;
  label: string;
}

export function renderHeatmapLegend(
  parent: HTMLElement,
  entries: readonly LegendEntry[],
  hidden: ReadonlySet<string>,
  onToggle: (key: string) => void,
): void {
  const bar = parent.createDiv({ cls: 'rtt-hm-legend' });
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', t('heatmapLegend'));

  for (const entry of entries) {
    const off = hidden.has(entry.key);
    const chip = bar.createEl('button', {
      cls: off ? 'rtt-hm-legend-item is-off' : 'rtt-hm-legend-item',
    });
    //  色块连图表自己的取色类一起带上（rtt-hm-seg + 通道类）：配色规则只有一份，图例与图不可能对不上。
    //  这里只另写几何（压成 10px 小方块、去掉绝对定位），颜色一个字不重写。
    //  The swatch carries the chart's own colouring classes (rtt-hm-seg plus the channel class), so
    //  there is exactly one palette and legend and chart cannot disagree. Only the geometry is
    //  overridden here — flattened to a 10px chip, no absolute positioning — never the colours.
    chip.createSpan({ cls: `rtt-hm-seg rtt-hm-legend-swatch ${entry.className}` });
    chip.createSpan({ cls: 'rtt-hm-legend-label', text: entry.label });
    chip.setAttribute('aria-pressed', String(!off));
    setTooltip(chip, off ? t('legendShow') : t('legendHide'));
    chip.setAttribute('aria-label', `${entry.label} — ${off ? t('legendShow') : t('legendHide')}`);
    chip.addEventListener('click', () => onToggle(entry.key));
  }
}

/**
 * 把隐藏的类从行里滤掉 / drop the hidden classes from the rows.
 *
 * 只换段、不换行：热力图的行结构（每小时一行、60 分钟轨道）与坐标都保持不变，于是隐藏某一类不会
 * 让别的类挪动位置，关掉再打开也是原位。
 *
 * Only the segments are filtered, never the rows: the chart keeps its one-row-per-hour shape and
 * its coordinates, so hiding a kind cannot move the others and turning it back on restores the
 * exact same picture.
 */
export function filterRowsByClass<S extends HeatmapSegment>(
  rows: readonly HeatmapRow<S>[],
  classOf: (segment: S) => string,
  hidden: ReadonlySet<string>,
): HeatmapRow<S>[] {
  if (hidden.size === 0) return [...rows];
  return rows.map((row) =>
    row.segments.length === 0
      ? row
      : { ...row, segments: row.segments.filter((segment) => !hidden.has(classOf(segment))) },
  );
}

export function renderHeatmap<S extends HeatmapSegment>(
  parent: HTMLElement,
  rows: readonly HeatmapRow<S>[],
  classOf: (segment: S) => string,
  labelOf: (segment: S) => string,
  onSelect?: (block: HeatmapBlock<S>, hour: number, element: HTMLElement) => void,
  /**
   * Draw an extra layer inside a row's track, after its segments.
   *
   * The manual panel overlays pause blocks and flag marks this way rather than post-processing
   * the DOM: the track element exists only here, and finding it again by selector would break
   * the moment this markup changes.
   */
  overlay?: (bar: HTMLElement, hour: number) => void,
  groupOf?: (segment: S) => string,
): boolean {
  const interesting = rows.filter((row) => row.segments.length > 0);
  if (interesting.length === 0) return false;

  const wrap = parent.createDiv({ cls: 'rtt-heatmap-wrap' });

  // x-axis ticks every 15 minutes
  const axis = wrap.createDiv({ cls: 'rtt-hm-xaxis' });
  axis.createDiv({ cls: 'rtt-hm-hlabel', text: '' });
  const tickWrap = axis.createDiv({ cls: 'rtt-hm-tick-wrap' });
  for (const minute of TICKS) {
    const tick = tickWrap.createDiv({ cls: 'rtt-hm-tick', text: `${minute}` });
    // setCssProps, not `style.left = ...`: Obsidian's review rejects direct style assignment,
    // and the helper writes through the same style object.
    tick.setCssProps({ left: `${(minute / 60) * 100}%` });
  }

  const firstHour = Math.max(0, interesting[0]!.hour - 1);
  const lastHour = Math.min(23, interesting[interesting.length - 1]!.hour + 1);

  for (let hour = firstHour; hour <= lastHour; hour++) {
    const row = rows[hour]!;
    const rowEl = wrap.createDiv({ cls: 'rtt-hm-row' });
    rowEl.createDiv({ cls: 'rtt-hm-hlabel', text: String(hour).padStart(2, '0') });

    const bar = rowEl.createDiv({ cls: 'rtt-hm-bar' });

    // Touching same-class segments become one block: a run of activity is stored as many short
    // pieces, and one-click-per-piece is both unreadable and unhittable.
    for (const block of mergeSegments(row.segments, classOf, groupOf)) {
      const representative = block.members[0]!;
      const seg = bar.createDiv({ cls: `rtt-hm-seg ${classOf(representative)}` });
      if (groupOf) seg.dataset.rttGroup = groupOf(representative);

      // Geometry is per-segment data, not a style variant, so it cannot live in a CSS class;
      // `setCssProps` is the sanctioned way to write it. Keys are kebab-case because the helper
      // writes through `style.setProperty`.
      const props: Record<string, string> = {
        left: `${(block.startMinute / 60) * 100}%`,
        // A very short block gets a floor width, or it is invisible on screen
        width: `${Math.max(0.4, (block.durationMinutes / 60) * 100)}%`,
      };
      // A clipped slice loses its rounding so the stretch still reads as one
      if (block.clipped) props['border-radius'] = '0';

      seg.setCssProps(props);
      seg.setAttribute('aria-label', labelOf(representative));

      if (onSelect) {
        seg.addClass('is-clickable');
        seg.addEventListener('click', () => onSelect(block, hour, seg));
        if (groupOf) {
          seg.setAttribute('role', 'button');
          seg.tabIndex = 0;
          seg.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(block, hour, seg); }
          });
        }
      }
    }

    overlay?.(bar, hour);
  }

  return true;
}
