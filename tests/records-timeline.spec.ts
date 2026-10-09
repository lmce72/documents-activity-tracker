/**
 * Reading-record timeline tests
 *
 * Three things are pinned here because they are easy to get wrong and hard to see:
 * adjacent timestamps bound each interval with the *earlier* state's channel; slices cut
 * by an hour boundary or midnight land in the right row and start minute; and an
 * out-of-window stretch past the attribution cap is drawn nowhere.
 */

import { describe, expect, it } from 'bun:test';

import { UNFOCUSED_ATTRIBUTION_CAP_SECONDS } from '../src/core/constants';
import {
  buildDocumentDayRows,
  buildRecordDayRows,
  isInWeekOf,
  recordDayChannels,
  recordDaySeconds,
  weekStart,
} from '../src/core/recordsTimeline';
import type { SessionStateMap } from '../src/core/types';

const D = '2026-09-15';

/** the segments of one hour's row. */
function row(rows: ReturnType<typeof buildRecordDayRows>, hour: number) {
  return rows[hour]!.segments;
}

describe('区间归属 / interval attribution', () => {
  it('相邻两个时刻夹出一个区间，长度与起始分钟正确', () => {
    const session: SessionStateMap = {
      [`${D} 10:30:00`]: 'tracking',
      [`${D} 10:45:00`]: 'saved',
    };
    const segments = row(buildRecordDayRows([session], D), 10);

    expect(segments).toHaveLength(1);
    expect(segments[0]!.startMinute).toBeCloseTo(30, 5);
    expect(segments[0]!.durationMinutes).toBeCloseTo(15, 5);
    expect(segments[0]!.channel).toBe('in-window');
  });

  it('通道取**前一个**时刻的状态，而不是后一个', () => {
    const session: SessionStateMap = {
      [`${D} 10:00:00`]: 'tracking',
      [`${D} 10:05:00`]: 'pausing',
      [`${D} 10:09:00`]: 'saved',
    };
    const segments = row(buildRecordDayRows([session], D), 10);

    expect(segments).toHaveLength(2);
    expect(segments[0]!.channel).toBe('in-window');
    expect(segments[0]!.durationMinutes).toBeCloseTo(5, 5);

    expect(segments[1]!.channel).toBe('paused');
    expect(segments[1]!.durationMinutes).toBeCloseTo(4, 5);
  });

  it('inactive 归入脱离窗口通道', () => {
    const session: SessionStateMap = {
      [`${D} 10:00:00`]: 'inactive',
      [`${D} 10:02:00`]: 'saved',
    };
    const segments = row(buildRecordDayRows([session], D), 10);

    expect(segments).toHaveLength(1);
    expect(segments[0]!.channel).toBe('out-of-window');
  });

  it('闭合事件（saved）本身不产生区间', () => {
    const session: SessionStateMap = { [`${D} 10:00:00`]: 'saved' };
    expect(buildRecordDayRows([session], D).every((r) => r.segments.length === 0)).toBe(true);
  });

  it('单个时刻无法夹出区间', () => {
    const session: SessionStateMap = { [`${D} 10:00:00`]: 'tracking' };
    expect(buildRecordDayRows([session], D).every((r) => r.segments.length === 0)).toBe(true);
  });
});

describe('跨行与跨日裁剪 / splitting and clipping', () => {
  it('跨小时边界的段被切成两行，且两段都标记为被切开', () => {
    const session: SessionStateMap = {
      [`${D} 10:50:00`]: 'tracking',
      [`${D} 11:10:00`]: 'saved',
    };
    const rows = buildRecordDayRows([session], D);

    expect(row(rows, 10)).toHaveLength(1);
    expect(row(rows, 10)[0]!.startMinute).toBeCloseTo(50, 5);
    expect(row(rows, 10)[0]!.durationMinutes).toBeCloseTo(10, 5);
    expect(row(rows, 10)[0]!.clipped).toBe(true);

    expect(row(rows, 11)).toHaveLength(1);
    expect(row(rows, 11)[0]!.startMinute).toBeCloseTo(0, 5);
    expect(row(rows, 11)[0]!.durationMinutes).toBeCloseTo(10, 5);
    expect(row(rows, 11)[0]!.clipped).toBe(true);
  });

  it('跨午夜的段在两天里各画属于自己的一段', () => {
    const session: SessionStateMap = {
      [`${D} 23:50:00`]: 'tracking',
      [`2026-09-16 00:10:00`]: 'saved',
    };

    const day1 = buildRecordDayRows([session], D);
    expect(row(day1, 23)).toHaveLength(1);
    expect(row(day1, 23)[0]!.startMinute).toBeCloseTo(50, 5);
    expect(row(day1, 23)[0]!.durationMinutes).toBeCloseTo(10, 5);

    const day2 = buildRecordDayRows([session], '2026-09-16');
    expect(row(day2, 0)).toHaveLength(1);
    expect(row(day2, 0)[0]!.startMinute).toBeCloseTo(0, 5);
    expect(row(day2, 0)[0]!.durationMinutes).toBeCloseTo(10, 5);
  });

  it('不落在该日的区间完全不出现', () => {
    const session: SessionStateMap = {
      [`${D} 10:00:00`]: 'tracking',
      [`${D} 10:05:00`]: 'saved',
    };
    const rows = buildRecordDayRows([session], '2026-09-20');
    expect(rows.every((r) => r.segments.length === 0)).toBe(true);
  });
});

describe('脱离窗口的归因上限 / out-of-window attribution cap', () => {
  it('超过上限的失焦段不计入任何一档', () => {
    // one minute past the cap
    const tooLong = UNFOCUSED_ATTRIBUTION_CAP_SECONDS / 60 + 1;
    const start = 0;
    const end = start + tooLong;
    const pad = (n: number): string => String(Math.floor(n)).padStart(2, '0');
    const fmt = (minutes: number): string =>
      `${D} ${pad(minutes / 60)}:${pad(minutes % 60)}:00`;

    const session: SessionStateMap = {
      [fmt(start)]: 'inactive',
      [fmt(end)]: 'saved',
    };
    const rows = buildRecordDayRows([session], D);
    expect(rows.every((r) => r.segments.length === 0)).toBe(true);
  });

  it('恰好等于上限的失焦段仍然计入', () => {
    const exact = UNFOCUSED_ATTRIBUTION_CAP_SECONDS / 60;
    const pad = (n: number): string => String(Math.floor(n)).padStart(2, '0');
    const fmt = (minutes: number): string =>
      `${D} ${pad(minutes / 60)}:${pad(minutes % 60)}:00`;

    const session: SessionStateMap = {
      [fmt(0)]: 'inactive',
      [fmt(exact)]: 'saved',
    };
    const rows = buildRecordDayRows([session], D);
    const total = rows.reduce((sum, r) => sum + r.totalMinutes, 0);
    expect(total).toBeCloseTo(exact, 5);
  });
});

describe('按日口径 / per-day totals', () => {
  const sessions: SessionStateMap[] = [
    {
      [`${D} 10:00:00`]: 'tracking',
      [`${D} 10:06:00`]: 'inactive',
      [`${D} 10:10:00`]: 'pausing',
      [`${D} 10:12:00`]: 'saved',
    },
  ];

  it('三通道各自结算，暂停单列', () => {
    const channels = recordDayChannels(sessions, D);
    expect(channels.inWindow).toBe(360);
    expect(channels.outOfWindow).toBe(240);
    expect(channels.paused).toBe(120);
  });

  it('净阅读秒数 = 窗口内 + 脱离窗口（不含暂停）', () => {
    expect(recordDaySeconds(sessions, D)).toBe(600);
  });
});

describe('全库合并 / merging every document', () => {
  it('把多个文件的段归并到同一张图上，各自落在自己那一小时', () => {
    const a: SessionStateMap = { [`${D} 09:10:00`]: 'tracking', [`${D} 09:20:00`]: 'saved' };
    const b: SessionStateMap = { [`${D} 14:30:00`]: 'tracking', [`${D} 14:45:00`]: 'saved' };

    //  Each element is one file's readTimeLine, so a single-session file is [sessionMap]
    const rows = buildDocumentDayRows([[a], [b]], D);
    expect(row(rows, 9)).toHaveLength(1);
    expect(row(rows, 9)[0]!.durationMinutes).toBeCloseTo(10, 5);
    expect(row(rows, 14)).toHaveLength(1);
    expect(row(rows, 14)[0]!.durationMinutes).toBeCloseTo(15, 5);
  });

  it('同一小时内的多个文件按起始分钟排序，叠加顺序稳定', () => {
    const early: SessionStateMap = { [`${D} 10:05:00`]: 'tracking', [`${D} 10:10:00`]: 'saved' };
    const late: SessionStateMap = { [`${D} 10:40:00`]: 'tracking', [`${D} 10:50:00`]: 'saved' };

    //  The later one is passed first on purpose, so this tests the sort and not luck
    const rows = buildDocumentDayRows([[late], [early]], D);
    const starts = row(rows, 10).map((s) => s.startMinute);
    expect(starts).toEqual([...starts].sort((x, y) => x - y));
    expect(starts[0]).toBeCloseTo(5, 5);
  });

  it('没有任何时间轴时整张图是空的', () => {
    const rows = buildDocumentDayRows([], D);
    expect(rows.every((r) => r.segments.length === 0)).toBe(true);
  });
});

describe('周口径 / week boundaries', () => {
  it('周一为一周之首', () => {

    expect(weekStart('2026-09-15')).toBe('2026-09-14');
    expect(weekStart('2026-09-14')).toBe('2026-09-14');

    expect(weekStart('2026-09-20')).toBe('2026-09-14');
    expect(weekStart('2026-09-21')).toBe('2026-09-21');
  });

  it('isInWeekOf 含周首、不含次周周首', () => {
    const anchor = '2026-09-15';
    expect(isInWeekOf('2026-09-14', anchor)).toBe(true);
    expect(isInWeekOf('2026-09-20', anchor)).toBe(true);
    expect(isInWeekOf('2026-09-21', anchor)).toBe(false);
    expect(isInWeekOf('2026-09-13', anchor)).toBe(false);
  });
});
