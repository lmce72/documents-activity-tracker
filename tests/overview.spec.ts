/**
 * Overview union tests
 *
 * The entire point of this module is not double counting, so the edges are pinned one by
 * one: full overlap, partial overlap, touching endpoints (which are *not* an overlap), and
 * midnight clipping.
 */

import { describe, expect, it } from 'bun:test';

import {
  buildOverviewRows,
  documentIntervals,
  manualIntervals,
  mergeIntervals,
  overviewTotals,
  type OverviewInterval,
} from '../src/core/overview';
import { toAbsoluteMinutes } from '../src/core/recordsTimeline';
import type { ManualSession, SessionStateMap } from '../src/core/types';

const D = '2026-09-15';

/**
 * build an interval from minutes into the day.
 * The base comes from the module's own conversion, so the test cannot drift onto its own
 * coordinate system and disagree with the implementation.
 */
const BASE_ABS = toAbsoluteMinutes(`${D} 00:00`)!;

function iv(
  startMinute: number,
  durationMinutes: number,
  source: 'document' | 'manual' = 'document',
): OverviewInterval {
  return {
    startAbs: BASE_ABS + startMinute,
    endAbs: BASE_ABS + startMinute + durationMinutes,
    source,
  };
}

function session(startMinute: number, endMinute: number, state = 'tracking'): ManualSession {
  const fmt = (m: number): string =>
    `${D} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
  return {
    id: `s${startMinute}`,
    startTime: fmt(startMinute),
    endTime: fmt(endMinute),
    durationSeconds: (endMinute - startMinute) * 60,
    note: '',
    flags: [],
  };
}

describe('mergeIntervals / 求并集', () => {
  it('空输入返回空', () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  it('完全重叠的两段合成一段，且标出来源是两个', () => {
    const merged = mergeIntervals([iv(600, 30, 'document'), iv(600, 30, 'manual')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sources).toEqual(['document', 'manual']);
    expect(merged[0]!.endAbs - merged[0]!.startAbs).toBeCloseTo(30, 5);
  });

  it('部分重叠切成三段，各段来源不同', () => {

    const merged = mergeIntervals([iv(600, 30, 'document'), iv(615, 30, 'manual')]);
    expect(merged).toHaveLength(3);
    expect(merged[0]!.sources).toEqual(['document']);
    expect(merged[1]!.sources).toEqual(['document', 'manual']);
    expect(merged[2]!.sources).toEqual(['manual']);
    expect(merged[1]!.endAbs - merged[1]!.startAbs).toBeCloseTo(15, 5);
  });

  it('首尾相接不算重叠', () => {

    const merged = mergeIntervals([iv(600, 30, 'document'), iv(630, 30, 'manual')]);
    expect(merged).toHaveLength(2);
    expect(merged.every((m) => m.sources.length === 1)).toBe(true);
  });

  it('完全分离的两段保持分离', () => {
    const merged = mergeIntervals([iv(600, 30, 'document'), iv(700, 30, 'manual')]);
    expect(merged).toHaveLength(2);
  });
});

describe('overviewTotals / 当日合计', () => {
  it('无记录时全为 0', () => {
    expect(overviewTotals([], D)).toEqual({
      unionMinutes: 0,
      documentMinutes: 0,
      manualMinutes: 0,
      overlapMinutes: 0,
    });
  });

  it('完全重叠：并集只算一次，重叠等于两边的量', () => {
    const totals = overviewTotals([iv(600, 30, 'document'), iv(600, 30, 'manual')], D);
    expect(totals.documentMinutes).toBeCloseTo(30, 5);
    expect(totals.manualMinutes).toBeCloseTo(30, 5);
    expect(totals.unionMinutes).toBeCloseTo(30, 5);
    expect(totals.overlapMinutes).toBeCloseTo(30, 5);
  });

  it('部分重叠：并集 = 两边合计 − 重叠', () => {
    const totals = overviewTotals([iv(600, 30, 'document'), iv(615, 30, 'manual')], D);
    expect(totals.documentMinutes).toBeCloseTo(30, 5);
    expect(totals.manualMinutes).toBeCloseTo(30, 5);
    expect(totals.overlapMinutes).toBeCloseTo(15, 5);
    expect(totals.unionMinutes).toBeCloseTo(45, 5);
  });

  it('互不重叠：并集 = 两边之和', () => {
    const totals = overviewTotals([iv(600, 30, 'document'), iv(700, 30, 'manual')], D);
    expect(totals.overlapMinutes).toBe(0);
    expect(totals.unionMinutes).toBeCloseTo(60, 5);
  });

  it('并集永不超过两边合计（重复相加的回归守卫）', () => {
    const intervals = [
      iv(600, 30, 'document'),
      iv(610, 30, 'manual'),
      iv(620, 30, 'document'),
      iv(630, 30, 'manual'),
    ];
    const totals = overviewTotals(intervals, D);
    expect(totals.unionMinutes).toBeLessThanOrEqual(
      totals.documentMinutes + totals.manualMinutes + 1e-9,
    );
    // 60 minutes covered in total
    expect(totals.unionMinutes).toBeCloseTo(60, 5);
  });

  it('落在该日之外的区间不计入', () => {
    const totals = overviewTotals([iv(600, 30, 'document')], '2026-09-20');
    expect(totals.unionMinutes).toBe(0);
  });
});

describe('buildOverviewRows / 热力图行', () => {
  it('跨小时的段被切到两行', () => {
    const rows = buildOverviewRows([iv(590, 20, 'document')], D); //  09:50–10:10
    expect(rows[9]!.segments).toHaveLength(1);
    expect(rows[9]!.segments[0]!.startMinute).toBeCloseTo(50, 5);
    expect(rows[10]!.segments[0]!.startMinute).toBeCloseTo(0, 5);
    expect(rows[10]!.segments[0]!.durationMinutes).toBeCloseTo(10, 5);
  });

  it('重叠段的 sources 同时含两个来源', () => {
    const rows = buildOverviewRows([iv(600, 30, 'document'), iv(615, 30, 'manual')], D);
    const all = rows[10]!.segments;
    const both = all.find((s) => s.sources.length === 2);
    expect(both).toBeDefined();
    expect(both!.startMinute).toBeCloseTo(15, 5);
  });
});

describe('从时间轴收集区间 / collecting from timelines', () => {
  it('documentIntervals 由相邻状态时刻夹出区间', () => {
    const readTimeLine: SessionStateMap = {
      [`${D} 10:00:00`]: 'tracking',
      [`${D} 10:10:00`]: 'saved',
    };

    //  The parameter is one timeline per file, each of which is a list of session maps
    const intervals = documentIntervals([[readTimeLine]]);
    expect(intervals).toHaveLength(1);
    expect((intervals[0]!.endAbs - intervals[0]!.startAbs)).toBeCloseTo(10, 5);
    expect(intervals[0]!.source).toBe('document');
  });

  it('manualIntervals 用净时长从起点铺开', () => {
    const intervals = manualIntervals([session(600, 630)]);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]!.endAbs - intervals[0]!.startAbs).toBeCloseTo(30, 5);
    expect(intervals[0]!.source).toBe('manual');
  });

  it('边读边计时：文档与手动区间确实重叠，并集小于两者之和', () => {
    const readTimeLine: SessionStateMap = {
      [`${D} 10:00:00`]: 'tracking',
      [`${D} 10:30:00`]: 'saved',
    };
    const intervals = [
      ...documentIntervals([[readTimeLine]]),
      ...manualIntervals([session(600, 630)]),
    ];
    const totals = overviewTotals(intervals, D);

    expect(totals.documentMinutes).toBeCloseTo(30, 5);
    expect(totals.manualMinutes).toBeCloseTo(30, 5);
    expect(totals.overlapMinutes).toBeCloseTo(30, 5);
    expect(totals.unionMinutes).toBeCloseTo(30, 5);
  });
});
