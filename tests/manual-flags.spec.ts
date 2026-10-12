/**
 * Manual-timer marks and pauses / 手动计时的标记与暂停
 *
 * Two things the heatmap needs and the old model could not supply: where a pause happened (it
 * only kept a total) and how long each mark's own stretch lasted (it only kept a cumulative
 * offset).
 */

import { describe, expect, it } from 'bun:test';

import {
  buildManualDayFlags,
  buildManualDayRows,
  flagIntervals,
} from '../src/core/manualTimeline';
import type { ManualFlag, ManualPause, ManualSession } from '../src/core/types';

const D = '2026-09-15';

function mark(atSeconds: number, atTime: string): ManualFlag {
  return { atSeconds, atTime, label: '' };
}

function session(
  startTime: string,
  endTime: string,
  durationSeconds: number,
  flags: ManualFlag[] = [],
  pauses: ManualPause[] = [],
): ManualSession {
  return {
    id: `s-${startTime}`,
    startTime,
    endTime,
    durationSeconds,
    note: '',
    flags,
    pauses,
  };
}

describe('flagIntervals / 每枚标记自己的时长', () => {
  it('第 1 枚从本轮开始算', () => {
    expect(flagIntervals([mark(10, `${D} 09:00:10`)])).toEqual([10]);
  });

  it('之后每枚是与上一枚的差值', () => {
    const flags = [
      mark(10, `${D} 09:00:10`),
      mark(25, `${D} 09:00:25`),
      mark(90, `${D} 09:01:30`),
    ];
    expect(flagIntervals(flags)).toEqual([10, 15, 65]);
  });

  it('空数组返回空', () => {
    expect(flagIntervals([])).toEqual([]);
  });

  it('差值恒不为负（标记按时间递增）', () => {
    const intervals = flagIntervals([
      mark(5, `${D} 09:00:05`),
      mark(5, `${D} 09:00:05`),
      mark(40, `${D} 09:00:40`),
    ]);
    expect(intervals.every((seconds) => seconds >= 0)).toBe(true);
  });
});

describe('buildManualDayFlags / 当日标记', () => {
  it('把每枚标记定位到当天已过的分钟数，并带上自己的时长', () => {
    const s = session(`${D} 09:00:00`, `${D} 09:10:00`, 600, [
      mark(60, `${D} 09:01:00`),
      mark(180, `${D} 09:03:00`),
    ]);
    const marks = buildManualDayFlags([s], D);

    expect(marks).toHaveLength(2);
    expect(marks[0]!.atMinute).toBeCloseTo(9 * 60 + 1, 5);
    expect(marks[0]!.index).toBe(1);
    expect(marks[0]!.intervalSeconds).toBe(60);
    expect(marks[1]!.intervalSeconds).toBe(120);
  });

  it('只收该日的标记', () => {
    const s = session(
      '2026-09-14 09:00:00',
      '2026-09-14 09:10:00',
      600,
      [mark(60, '2026-09-14 09:01:00')],
    );
    expect(buildManualDayFlags([s], D)).toEqual([]);
  });
});

describe('暂停区间 / pause spans', () => {
  it('暂停段落在它所在的小时行里', () => {
    const s = session(`${D} 09:50:00`, `${D} 10:10:00`, 1200, [], [
      { from: `${D} 09:55:00`, to: `${D} 10:05:00` },
    ]);
    const rows = buildManualDayRows([s], D);

    expect(rows[9]!.pauseSegments).toHaveLength(1);
    expect(rows[9]!.pauseSegments[0]!.startMinute).toBeCloseTo(55, 5);
    expect(rows[9]!.pauseSegments[0]!.durationMinutes).toBeCloseTo(5, 5);
    expect(rows[9]!.pauseSegments[0]!.clipped).toBe(true);

    expect(rows[10]!.pauseSegments).toHaveLength(1);
    expect(rows[10]!.pauseSegments[0]!.startMinute).toBeCloseTo(0, 5);
    expect(rows[10]!.pauseSegments[0]!.durationMinutes).toBeCloseTo(5, 5);
  });

  it('没有暂停时各行都是空的', () => {
    const s = session(`${D} 09:00:00`, `${D} 09:10:00`, 600);
    const rows = buildManualDayRows([s], D);
    expect(rows.every((row) => row.pauseSegments.length === 0)).toBe(true);
  });

  it('别的日子的暂停不画进来', () => {
    const s = session(`${D} 09:00:00`, `${D} 09:10:00`, 600, [], [
      { from: '2026-09-14 09:02:00', to: '2026-09-14 09:04:00' },
    ]);
    const rows = buildManualDayRows([s], D);
    expect(rows.every((row) => row.pauseSegments.length === 0)).toBe(true);
  });
});
