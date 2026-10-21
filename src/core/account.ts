/**
 * 时间账本 / the time account
 *
 * 在它出现之前，同一批事件被六处各遍历一遍（`getDayChannelSeconds`、`getAllTodaySeconds`、
 * `buildFileRecords`、`documentIntervals`、`weekReadingSeconds`、`manualDayTotalSeconds`），每一处
 * 自己决定「离开窗口算不算」「暂停算不算」，于是同一个词在两块面板上是两个数。
 *
 * Before this module the same events were walked in six places, each deciding for itself whether
 * away time counts and whether paused time counts — so one word meant two numbers on two panels.
 *
 * 这里只有一个窗口函数，日与周只差窗口长度。面板、状态栏、记录浏览器都读它。
 * One window function here; a day and a week differ only in the window. Panels, the status bar and
 * the records browser all read it.
 *
 * 词表 / vocabulary:
 *   专注 focus   窗口内、有输入
 *   离开 away    窗口失焦
 *   空闲 idle    窗口有焦点但无输入（空闲超时）
 *   暂停 paused  显式暂停（以及被归类为暂停的离开/空闲段）
 *   阅读 reading = 专注 + 按口径算作阅读的离开与空闲
 *   合计 total   = 这四条通道之和（被标为「不记录」的不进）
 *   并集 union   = 跨账本去重后的覆盖时长
 */

import {
  countdownIntervals,
  documentIntervals,
  manualIntervals,
  mergeIntervals,
  type OverviewInterval,
  type OverviewSource,
} from './overview';
import { isPluginViewKey } from './activePath';
import { MINUTES_PER_DAY, toAbsoluteMinutes, weekStart } from './recordsTimeline';
import { formatLocalFull } from './time';
import { buildFileRecords } from './timeline';
import type {
  AttributionPolicy,
  CountdownSession,
  FileRecord,
  ManualSession,
  SessionState,
  TimelineEvent,
  TimerFileState,
} from './types';

/** 口径 / the policy in force. */
export interface AccountPolicy {
  away: AttributionPolicy;
  idle: AttributionPolicy;
  /** 插件视图是否算阅读、进不进并集 / whether plugin views read and join the union */
  pluginViews: boolean;
}

/** 一天的输入 / everything one window needs. */
export interface AccountInput {
  events: readonly TimelineEvent[];
  manual: readonly ManualSession[];
  countdown: readonly CountdownSession[];
  /** 锚点日期 "YYYY-MM-DD" / the anchor day */
  day: string;
  nowMs: number;
  policy: AccountPolicy;
  /**
   * 正在跑的那一轮会话，用来把最后一个区间延长到"现在"。
   * 事件流只到最后一个事件为止，不延长的话正在读的这一分钟要等下一次事件才出现。
   *
   * The running session, so its last stretch reaches "now": the event stream stops at the last
   * event, and without this the minute being read would only appear at the next event.
   */
  live?: { filePath: string; state: SessionState } | null;
}

/** 一份账 / one account. All values are seconds. */
export interface AccountTotals {
  focus: number;
  away: number;
  idle: number;
  paused: number;
  manual: number;
  countdown: number;
  /** 文档笔记这一本的自身覆盖 / the notes ledger's own coverage */
  document: number;
  /** 插件视图这一本的自身覆盖 / the plugin views ledger's own coverage */
  view: number;
  /** 阅读 = 专注 + 按口径算作阅读的离开与空闲 / reading */
  reading: number;
  /** 记录到的墙钟 = 四条通道之和（不含被标为不记录的） */
  total: number;
  /** 跨账本去重覆盖 / covered by any ledger, counted once */
  union: number;
  /** 多本账同时覆盖 / covered by more than one ledger */
  overlap: number;
}

/** 空账 / a zeroed account. */
export const EMPTY_ACCOUNT: AccountTotals = {
  focus: 0,
  away: 0,
  idle: 0,
  paused: 0,
  manual: 0,
  countdown: 0,
  document: 0,
  view: 0,
  reading: 0,
  total: 0,
  union: 0,
  overlap: 0,
};

/** 当天的账 / the day's account. */
export function dayAccount(input: AccountInput): AccountTotals {
  return computeAccount(input, input.day, 1);
}

/** 该日所在整周的账，口径与日完全相同 / the week containing `day`, same rules as a day. */
export function weekAccount(input: AccountInput): AccountTotals {
  return computeAccount(input, weekStart(input.day), 7);
}

/**
 * 该窗口的原始区间，供热力图使用 / the window's raw intervals, for the heatmap.
 *
 * 与 `dayAccount` 同源，所以图上画出来的与格子里读到的不会打架。
 * The same source as `dayAccount`, so what the chart draws and what the cells read cannot disagree.
 */
export function accountIntervals(input: AccountInput): OverviewInterval[] {
  return collectIntervals(input);
}

/** 收集所有账本的区间 / collect every ledger's intervals. */
function collectIntervals(input: AccountInput): OverviewInterval[] {
  const records = buildRecords(input);
  const entries = Object.entries(records);

  const noteTimelines = entries
    .filter(([key]) => !isPluginViewKey(key))
    .map(([, record]) => record.readTimeLine);
  const viewTimelines = entries
    .filter(([key]) => isPluginViewKey(key))
    .map(([, record]) => record.readTimeLine);

  const out: OverviewInterval[] = [
    ...documentIntervals(noteTimelines, { includePaused: true, includeUnfocused: true, includeIdle: true }),
    ...documentIntervals(viewTimelines, {
      includePaused: true,
      includeUnfocused: true,
      includeIdle: true,
      source: 'view',
    }),
    ...manualIntervals(input.manual),
    ...countdownIntervals(input.countdown),
  ];

  return out;
}

/**
 * 建 records，并把正在跑的那一轮延长到 now / build the records and stretch the live session to now.
 *
 * readTimeLine 的最后一个键是最后一个事件；不补一个"现在"，正在读的这段就落在图外。
 * The last key in a readTimeLine is the last event; without a "now" entry the stretch being read
 * now falls outside the chart.
 */
function buildRecords(input: AccountInput): Record<string, FileRecord> {
  const records = buildFileRecords(input.events, input.nowMs, input.day, {});
  const live = input.live;
  if (!live) return records;

  const record = records[live.filePath];
  const session = record?.readTimeLine[record.readTimeLine.length - 1];
  if (!session) return records;

  const nowKey = formatLocalFull(new Date(input.nowMs));
  if (!(nowKey in session)) session[nowKey] = live.state;
  return records;
}

/** 窗口内的秒数 / seconds of an interval inside the window. */
function overlapSeconds(interval: OverviewInterval, fromAbs: number, toAbs: number): number {
  const start = Math.max(interval.startAbs, fromAbs);
  const end = Math.min(interval.endAbs, toAbs);
  return end > start ? (end - start) * 60 : 0;
}

/**
 * 计算一个窗口 / compute one window.
 *
 * @param anchor 起始日 / first day
 * @param days   窗口天数 / how many days
 */
function computeAccount(input: AccountInput, anchor: string, days: number): AccountTotals {
  const startAbs = toAbsoluteMinutes(`${anchor} 00:00:00`);
  if (startAbs === null) return { ...EMPTY_ACCOUNT };
  const endAbs = startAbs + days * MINUTES_PER_DAY;

  const intervals = collectIntervals(input);
  const policy = input.policy;

  const included = intervals.filter((interval) => {
    if (interval.source === 'view' && !policy.pluginViews) return false;
    if (interval.channel === 'away' && policy.away === 'ignored') return false;
    if (interval.channel === 'idle' && policy.idle === 'ignored') return false;
    return true;
  });

  const totals: AccountTotals = { ...EMPTY_ACCOUNT };
  const ledger = new Map<OverviewSource, OverviewInterval[]>();

  for (const interval of intervals) {
    const seconds = overlapSeconds(interval, startAbs, endAbs);
    if (seconds <= 0) continue;

    if (interval.source === 'manual') totals.manual += seconds;
    else if (interval.source === 'countdown') totals.countdown += seconds;
    else if (interval.channel === 'focus') totals.focus += seconds;
    else if (interval.channel === 'away') totals.away += seconds;
    else if (interval.channel === 'idle') totals.idle += seconds;
    else if (interval.channel === 'paused') totals.paused += seconds;
  }

  for (const interval of included) {
    const seconds = overlapSeconds(interval, startAbs, endAbs);
    if (seconds <= 0) continue;
    const list = ledger.get(interval.source) ?? [];
    list.push(interval);
    ledger.set(interval.source, list);
  }

  //  并集：去重后的覆盖；重叠：各账本自身覆盖之和减去并集
  //  Union: covered once. Overlap: per-ledger coverage minus the union.
  let covered = 0;
  for (const [source, list] of ledger) {
    let own = 0;
    for (const piece of mergeIntervals(list)) {
      const start = Math.max(piece.startAbs, startAbs);
      const end = Math.min(piece.endAbs, endAbs);
      if (end > start) own += (end - start) * 60;
    }
    covered += own;
    if (source === 'document') totals.document = own;
    else if (source === 'view') totals.view = own;
  }

  const unionPieces = mergeIntervals(included);
  let union = 0;
  for (const piece of unionPieces) {
    const start = Math.max(piece.startAbs, startAbs);
    const end = Math.min(piece.endAbs, endAbs);
    if (end > start) union += (end - start) * 60;
  }

  totals.union = union;
  totals.overlap = Math.max(0, covered - union);

  //  阅读与合计按口径推导；「不记录」的通道既不进阅读也不进合计
  //  Reading and total follow the policy; an "ignored" channel enters neither.
  totals.reading =
    totals.focus
    + (policy.away === 'reading' ? totals.away : 0)
    + (policy.idle === 'reading' ? totals.idle : 0);

  totals.total =
    totals.focus
    + (policy.away === 'ignored' ? 0 : totals.away)
    + (policy.idle === 'ignored' ? 0 : totals.idle)
    + totals.paused;

  return totals;
}
