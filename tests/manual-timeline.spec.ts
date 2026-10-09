/**
 * Manual-timer layout tests
 *
 * The heatmap's positioning is entirely decided by these conversions (left offset and
 * width both = minutes/60), and an error there produces a subtly wrong picture that is
 * hard to spot by eye — hence the case-by-case pinning.
 */

import { describe, expect, it } from 'bun:test';

import {
  buildManualDayRows,
  manualDayTotalSeconds,
  manualSessionsOfDay,
  shiftDay,
} from '../src/core/manualTimeline';
import type { ManualSession } from '../src/core/types';

const D = '2026-09-15';

function session(
  id: string,
  startTime: string,
  endTime: string,
  durationSeconds: number,
  note = '',
): ManualSession {
  return { id, startTime, endTime, durationSeconds, note, flags: [] };
}

describe('buildManualDayRows', () => {
  it('半小时的记录落在半小时那一行，起止分钟正确', () => {
    const rows = buildManualDayRows(
      [session('a', `${D} 09:30:00`, `${D} 10:00:00`, 1800)],
      D,
    );

    expect(rows[9]!.segments).toHaveLength(1);
    expect(rows[9]!.segments[0]!.startMinute).toBe(30);
    expect(rows[9]!.segments[0]!.durationMinutes).toBe(30);
    expect(rows[9]!.totalMinutes).toBe(30);
    expect(rows[10]!.segments).toHaveLength(0);
  });

  it('跨小时的记录被按小时边界切开，两段各自定位', () => {
    const rows = buildManualDayRows(
      [session('a', `${D} 09:50:00`, `${D} 10:20:00`, 1800)],
      D,
    );

    const first = rows[9]!.segments[0]!;
    const second = rows[10]!.segments[0]!;

    expect(first.startMinute).toBe(50);
    expect(first.durationMinutes).toBe(10);
    expect(first.isFirstSlice).toBe(true);
    expect(first.clipped).toBe(true);

    expect(second.startMinute).toBe(0);
    expect(second.durationMinutes).toBe(20);
    expect(second.isFirstSlice).toBe(false);
    expect(second.clipped).toBe(true);

    expect(rows[9]!.totalMinutes + rows[10]!.totalMinutes).toBe(30);
  });

  it('不跨小时的记录不算被切开', () => {
    const rows = buildManualDayRows(
      [session('a', `${D} 09:10:00`, `${D} 09:40:00`, 1800)],
      D,
    );
    expect(rows[9]!.segments[0]!.clipped).toBe(false);
  });

  it('秒级起止被折算为分钟（含小数）', () => {
    const rows = buildManualDayRows(
      [session('a', `${D} 09:00:30`, `${D} 09:01:30`, 60)],
      D,
    );
    expect(rows[9]!.segments[0]!.startMinute).toBeCloseTo(0.5, 5);
    expect(rows[9]!.segments[0]!.durationMinutes).toBeCloseTo(1, 5);
  });

  it('跨午夜的记录按当天 24:00 截断，不摊到第二天', () => {
    const rows = buildManualDayRows(
      [session('a', `${D} 23:40:00`, '2026-09-16 00:20:00', 2400)],
      D,
    );
    expect(rows[23]!.segments).toHaveLength(1);
    expect(rows[23]!.segments[0]!.durationMinutes).toBe(20);
    expect(rows[23]!.totalMinutes).toBe(20);
  });

  it('只画指定日期的记录', () => {
    const rows = buildManualDayRows(
      [
        session('a', `${D} 09:00:00`, `${D} 09:10:00`, 600),
        session('b', '2026-09-14 09:00:00', '2026-09-14 09:10:00', 600),
      ],
      D,
    );
    const total = rows.reduce((sum, row) => sum + row.segments.length, 0);
    expect(total).toBe(1);
  });

  it('极短的记录仍会画出可见的一段', () => {
    const rows = buildManualDayRows(
      [session('a', `${D} 09:00:00`, `${D} 09:00:01`, 1)],
      D,
    );
    expect(rows[9]!.segments[0]!.durationMinutes).toBeGreaterThan(0);
  });

  it('坏时间串被跳过而不是抛异常', () => {
    const rows = buildManualDayRows(
      [session('bad', 'not-a-time', 'also-bad', 600)],
      D,
    );
    expect(rows.every((row) => row.segments.length === 0)).toBe(true);
  });

  it('endTime 早于 startTime 时用 durationSeconds 兜底', () => {
    const rows = buildManualDayRows(
      [session('a', `${D} 09:00:00`, `${D} 08:00:00`, 600)],
      D,
    );
    expect(rows[9]!.totalMinutes).toBe(10);
  });

  it('空输入返回 24 个空行', () => {
    const rows = buildManualDayRows([], D);
    expect(rows).toHaveLength(24);
    expect(rows.every((row) => row.segments.length === 0)).toBe(true);
  });
});

describe('manualDayTotalSeconds / manualSessionsOfDay', () => {
  const sessions = [
    session('a', `${D} 09:00:00`, `${D} 09:10:00`, 600, '早'),
    session('b', `${D} 14:00:00`, `${D} 14:05:00`, 300, '午'),
    session('c', '2026-09-14 09:00:00', '2026-09-14 09:10:00', 999, '昨'),
  ];

  it('合计只算该日', () => {
    expect(manualDayTotalSeconds(sessions, D)).toBe(900);
  });

  it('列表按开始时间升序', () => {
    expect(manualSessionsOfDay(sessions, D).map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('shiftDay', () => {
  it('前后偏移跨月正确', () => {
    expect(shiftDay('2026-09-15', 1)).toBe('2026-09-16');
    expect(shiftDay('2026-09-01', -1)).toBe('2026-08-31');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('坏输入原样返回', () => {
    expect(shiftDay('oops', 1)).toBe('oops');
  });
});
