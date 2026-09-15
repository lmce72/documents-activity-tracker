/**
 * 时间轴派生计算测试 / Timeline derivation tests
 *
 * 覆盖从 UI 抽取到 core 的纯函数：buildFileRecords / getTodaySeconds /
 * getTodaySessionCount / getAllTodaySeconds / removeFileEvents，以及过滤器与时间工具。
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { shouldTrackFile } from '../src/core/filters';
import {
  buildFileRecords,
  getAllTodaySeconds,
  getFileEvents,
  getTodaySeconds,
  getTodaySessionCount,
  recalcAggregates,
  removeFileEvents,
} from '../src/core/timeline';
import { formatDurationWithSeconds, formatReadTime, parseSessionStartTime } from '../src/core/time';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import type { HistoryCache, TimelineEvent, TimerFileState } from '../src/core/types';

const FIXTURE = path.join(import.meta.dir, 'fixtures', 'readTimeHistory.v2.synthetic.json');

function loadEvents(): TimelineEvent[] {
  return (JSON.parse(readFileSync(FIXTURE, 'utf8')) as HistoryCache).timeline;
}

/** 造一个进行中的文件状态 / Build an in-progress file state. */
function fakeFile(overrides: Partial<TimerFileState> = {}): TimerFileState {
  return {
    filePath: 'Notes/alpha.md',
    status: 'tracking',
    sessionStartTime: '2026-09-07 08:00',
    activeSeconds: 42,
    pausedSeconds: 0,
    lastTickTimestamp: null,
    pauseStartTimestamp: null,
    sessionObject: null,
    pausedRanges: [],
    ...overrides,
  };
}

describe('buildFileRecords', () => {
  const TODAY = '2026-09-07';
  // 用一个远晚于夹具数据的时间，模拟「这些会话早已闭合」
  const NOW = new Date('2026-09-20T00:00:00').getTime();

  it('能从 138 个事件里构建出文件记录', () => {
    const records = buildFileRecords(loadEvents(), NOW, TODAY);
    expect(Object.keys(records).length).toBeGreaterThan(0);
  });

  it('不把 switch 事件当成某个文件的会话起点', () => {
    // switch 事件没有 file 字段，只有 from/to；它不应产生独立的文件记录键
    const records = buildFileRecords(loadEvents(), NOW, TODAY);
    for (const filePath of Object.keys(records)) {
      expect(filePath.length).toBeGreaterThan(0);
      expect(filePath).not.toBe('undefined');
    }
  });

  it('每条记录都带齐视图模型要求的字段', () => {
    const records = buildFileRecords(loadEvents(), NOW, TODAY);
    for (const rec of Object.values(records)) {
      expect(typeof rec.fileName).toBe('string');
      expect(typeof rec.totalReadTime).toBe('number');
      expect(typeof rec.readTimeToday).toBe('number');
      expect(typeof rec.lastReadAt).toBe('string');
      expect(Array.isArray(rec.readTimeLine)).toBe(true);
      expect(typeof rec.hasAbnormalSession).toBe('boolean');
    }
  });

  it('空时间轴返回空对象', () => {
    expect(buildFileRecords([], NOW, TODAY)).toEqual({});
  });

  it('超过 24 小时的未闭合会话被标记为异常且不计时长', () => {
    const open = [
      { time: '2026-09-01 08:00:00', type: 'start', file: 'Notes/alpha.md', state: 'tracking' },
    ] as TimelineEvent[];
    const now = new Date('2026-09-07T08:00:00').getTime(); // 6 天后
    const records = buildFileRecords(open, now, '2026-09-07');
    const rec = records['Notes/alpha.md']!;

    expect(rec.hasAbnormalSession).toBe(true);
    expect(rec.totalReadTime).toBe(0);
  });
});

describe('removeFileEvents', () => {
  it('移除该文件的全部事件', () => {
    const events = loadEvents();
    const target = 'Notes/alpha.md';
    const before = getFileEvents(events, target).length;
    expect(before).toBeGreaterThan(0);

    const after = removeFileEvents(events, target);
    expect(getFileEvents(after, target)).toHaveLength(0);
    expect(after.length).toBe(events.length - before);
  });

  it('同时清理以该文件为 from / to 的 switch 事件（避免孤儿）', () => {
    const events: TimelineEvent[] = [
      { time: 't1', type: 'start', file: 'a.md', state: 'tracking' },
      { time: 't2', type: 'switch', from: 'a.md', to: 'b.md' },
      { time: 't3', type: 'start', file: 'b.md', state: 'tracking' },
    ];

    const after = removeFileEvents(events, 'a.md');
    expect(after).toHaveLength(1);
    expect((after[0] as { file?: string }).file).toBe('b.md');
  });

  it('不修改原数组', () => {
    const events = loadEvents();
    const lengthBefore = events.length;
    removeFileEvents(events, 'Notes/alpha.md');
    expect(events).toHaveLength(lengthBefore);
  });
});

describe('今日统计 / today figures', () => {
  const TODAY = '2026-09-07';

  it('getTodaySeconds 只累计 save / auto-save 的 activeSeconds', () => {
    const events: TimelineEvent[] = [
      { time: `${TODAY} 08:00:00`, type: 'save', file: 'a.md', state: 'saved', activeSeconds: 30 },
      { time: `${TODAY} 09:00:00`, type: 'auto-save', file: 'a.md', state: 'saved', activeSeconds: 12 },
      { time: `${TODAY} 10:00:00`, type: 'pause', file: 'a.md', state: 'pausing' },
      { time: '2026-09-06 08:00:00', type: 'save', file: 'a.md', state: 'saved', activeSeconds: 999 },
      { time: `${TODAY} 11:00:00`, type: 'save', file: 'b.md', state: 'saved', activeSeconds: 500 },
    ];

    expect(getTodaySeconds(events, null, 'a.md', TODAY)).toBe(42);
  });

  it('把进行中的会话也算进今日', () => {
    const events: TimelineEvent[] = [
      { time: `${TODAY} 08:00:00`, type: 'save', file: 'a.md', state: 'saved', activeSeconds: 30 },
    ];
    const file = fakeFile({ sessionStartTime: `${TODAY} 09:00`, activeSeconds: 25 });

    expect(getTodaySeconds(events, file, 'a.md', TODAY)).toBe(55);
  });

  it('会话不是今天开始则不计入今日', () => {
    const file = fakeFile({ sessionStartTime: '2026-09-01 09:00', activeSeconds: 25 });
    expect(getTodaySeconds([], file, 'a.md', TODAY)).toBe(0);
  });

  it('getTodaySessionCount 统计已结算轮次并加上进行中的一轮', () => {
    const events: TimelineEvent[] = [
      { time: `${TODAY} 08:00:00`, type: 'save', file: 'a.md', state: 'saved' },
      { time: `${TODAY} 09:00:00`, type: 'auto-save', file: 'a.md', state: 'saved' },
    ];
    expect(getTodaySessionCount(events, null, 'a.md', TODAY)).toBe(2);
    // 进行中的一轮 +1
    expect(getTodaySessionCount(events, fakeFile(), 'a.md', TODAY)).toBe(3);
  });

  it('毫无记录时至少返回 1（与原实现的 || 1 兜底一致）', () => {
    expect(getTodaySessionCount([], null, 'a.md', TODAY)).toBe(1);
  });

  it('getAllTodaySeconds 汇总全库并忽略 switch 事件', () => {
    const events: TimelineEvent[] = [
      { time: `${TODAY} 08:00:00`, type: 'save', file: 'a.md', state: 'saved', activeSeconds: 30 },
      { time: `${TODAY} 08:30:00`, type: 'save', file: 'b.md', state: 'saved', activeSeconds: 20 },
      { time: `${TODAY} 08:40:00`, type: 'switch', from: 'a.md', to: 'b.md' },
    ];
    expect(getAllTodaySeconds(events, [], TODAY)).toBe(50);
  });
});

describe('recalcAggregates', () => {
  it('从会话列表算出总时长与今日时长', () => {
    const sessions = [
      { '2026-09-07 08:00:00': 'tracking', '2026-09-07 08:00:30': 'saved' },
      { '2026-09-06 08:00:00': 'tracking', '2026-09-06 08:01:00': 'saved' },
    ] as const;

    const result = recalcAggregates([...sessions], '2026-09-07');
    expect(result.totalReadTime).toBe(90); // 30 + 60
    expect(result.readTimeToday).toBe(30);
  });

  it('空列表返回全 0', () => {
    expect(recalcAggregates([], '2026-09-07')).toEqual({
      totalReadTime: 0,
      readTimeToday: 0,
    });
  });
});

describe('shouldTrackFile', () => {
  // 取自真实配置：白名单模式下一长串路径前缀
  const whitelist = {
    ...DEFAULT_SETTINGS,
    filterMode: 'whitelist',
    filterPatterns: '10-Planner/8-日常记录\n20-Inbox储件箱\nCLAUDE.md',
  };

  it('白名单模式下命中前缀的路径才追踪', () => {
    expect(shouldTrackFile('20-Inbox储件箱/note.md', whitelist)).toBe(true);
    expect(shouldTrackFile('10-Planner/8-日常记录/a.md', whitelist)).toBe(true);
    expect(shouldTrackFile('CLAUDE.md', whitelist)).toBe(true);
    expect(shouldTrackFile('99-Other/note.md', whitelist)).toBe(false);
  });

  it('黑名单模式下命中规则的路径不追踪', () => {
    const blacklist = {
      ...DEFAULT_SETTINGS,
      filterMode: 'blacklist',
      filterPatterns: 'Templates/',
    };
    expect(shouldTrackFile('Templates/daily.md', blacklist)).toBe(false);
    expect(shouldTrackFile('Notes/a.md', blacklist)).toBe(true);
  });

  it('无规则时：黑名单全追踪，白名单全不追踪', () => {
    const empty = { ...DEFAULT_SETTINGS, filterPatterns: '' };
    expect(shouldTrackFile('any.md', { ...empty, filterMode: 'blacklist' })).toBe(true);
    expect(shouldTrackFile('any.md', { ...empty, filterMode: 'whitelist' })).toBe(false);
  });

  it('支持正则规则，非法正则不致命', () => {
    const regex = {
      ...DEFAULT_SETTINGS,
      filterMode: 'blacklist',
      filterPatterns: '/^Daily\\//,\n/[unclosed/',
    };
    expect(shouldTrackFile('Daily/2026-09-07.md', regex)).toBe(false);
    expect(shouldTrackFile('Notes/a.md', regex)).toBe(true);
  });
});

describe('时间工具 / time helpers', () => {
  it('parseSessionStartTime 兼容本地格式与 ISO', () => {
    const local = parseSessionStartTime('2026-09-07 08:30');
    expect(local?.getFullYear()).toBe(2026);
    expect(local?.getHours()).toBe(8);
    expect(local?.getMinutes()).toBe(30);

    const iso = parseSessionStartTime('2026-09-07T08:30:15.000Z');
    expect(iso).not.toBeNull();

    expect(parseSessionStartTime('')).toBeNull();
    expect(parseSessionStartTime(null)).toBeNull();
  });

  it('formatReadTime 的既有文案不变', () => {
    expect(formatReadTime(0)).toBe('0 秒');
    expect(formatReadTime(45)).toBe('45 秒');
    expect(formatReadTime(300)).toBe('5 分钟');
    expect(formatReadTime(300, 'precise')).toBe('5 分钟');
    expect(formatReadTime(330, 'precise')).toBe('5 分 30 秒');
    expect(formatReadTime(3600)).toBe('1 小时');
    expect(formatReadTime(3900)).toBe('1 小时 5 分钟');
  });

  it('formatDurationWithSeconds 的既有文案不变', () => {
    expect(formatDurationWithSeconds(0)).toBe('0秒');
    expect(formatDurationWithSeconds(45)).toBe('45秒');
    expect(formatDurationWithSeconds(90)).toBe('1分30秒');
    expect(formatDurationWithSeconds(3661)).toBe('1小时1分1秒');
  });
});
