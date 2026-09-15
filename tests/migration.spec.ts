/**
 * 迁移无损性测试 / Migration non-destructiveness tests
 *
 * 这是本次重构最重要的一组断言。原实现的迁移会静默丢弃真实数据中 41 个事件
 * （blur 19 + focus 14 + switch 8），并把 switch 事件的 from/to、blur/focus 的
 * reason 一并抹掉。下面的测试把「一条都不能少、一个字段都不能丢、连跑两次结果
 * 相同」固化下来，任何回归都会立刻失败。
 *
 * The most important assertions in this refactor. The original migration silently
 * dropped 41 real events and erased switch's from/to and blur/focus's reason. These
 * tests pin down "nothing lost, no field erased, idempotent".
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { migrateV2ToV3, eventFileRefs } from '../src/core/migration';
import { DATA_VERSION } from '../src/core/constants';
import type { HistoryCache, TimelineEvent } from '../src/core/types';

const FIXTURE = path.join(import.meta.dir, 'fixtures', 'readTimeHistory.v2.synthetic.json');

function loadFixture(): HistoryCache {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as HistoryCache;
}

function countByType(events: readonly TimelineEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}

describe('migrateV2ToV3 — 无损性 / non-destructiveness', () => {
  it('一条事件都不丢（138 → 138）', () => {
    const { cache, report } = migrateV2ToV3(loadFixture());

    expect(report.timelineBefore).toBe(138);
    expect(report.timelineAfter).toBe(138);
    expect(cache.timeline).toHaveLength(138);
    expect(report.droppedMalformed).toBe(0);
  });

  it('九种事件类型的分布逐项保持不变（这是原实现丢数据的直接对照）', () => {
    const before = countByType(loadFixture().timeline);
    const { cache } = migrateV2ToV3(loadFixture());
    const after = countByType(cache.timeline);

    expect(after).toEqual(before);
    // 原白名单会丢掉的三种类型
    expect(after.blur).toBe(19);
    expect(after.focus).toBe(14);
    expect(after.switch).toBe(8);
  });

  it('switch 事件保留 from/to/fromState/toState，且不被硬塞 file 字段', () => {
    const { cache } = migrateV2ToV3(loadFixture());
    const switches = cache.timeline.filter((e) => e.type === 'switch');

    expect(switches).toHaveLength(8);
    for (const s of switches) {
      const e = s as unknown as Record<string, unknown>;
      expect(typeof e.from).toBe('string');
      expect(typeof e.to).toBe('string');
      expect(e.fromState).toBe('tracking');
      expect(e.toState).toBe('tracking');
      // 原实现的 .map() 会写 file: event.file || event.to || event.from
      expect('file' in e).toBe(false);
    }
  });

  it('blur / focus 事件保留 reason', () => {
    const { cache } = migrateV2ToV3(loadFixture());
    const blurs = cache.timeline.filter((e) => e.type === 'blur');
    const focuses = cache.timeline.filter((e) => e.type === 'focus');

    expect(blurs.every((e) => (e as { reason?: string }).reason === 'window-blur')).toBe(true);
    expect(focuses.every((e) => (e as { reason?: string }).reason === 'window-focus')).toBe(true);
  });

  it('幂等：连跑两次的结果与跑一次完全相同', () => {
    const once = migrateV2ToV3(loadFixture());
    const twice = migrateV2ToV3(once.cache);

    expect(JSON.stringify(twice.cache.timeline)).toBe(JSON.stringify(once.cache.timeline));
    expect(JSON.stringify(twice.cache.records)).toBe(JSON.stringify(once.cache.records));
    expect(twice.cache.version).toBe(DATA_VERSION);
    // 第二次已无版本变化，migrated 应为 false
    expect(twice.report.migrated).toBe(false);
  });

  it('不修改入参', () => {
    const fixture = loadFixture();
    const snapshot = JSON.stringify(fixture);

    migrateV2ToV3(fixture);

    expect(JSON.stringify(fixture)).toBe(snapshot);
  });

  it('版本号升到 v3', () => {
    const { cache, report } = migrateV2ToV3(loadFixture());
    expect(cache.version).toBe(3);
    expect(report.fromVersion).toBe(2);
    expect(report.toVersion).toBe(3);
    expect(report.migrated).toBe(true);
  });
});

describe('migrateV2ToV3 — 边界 / edge cases', () => {
  it('丢弃结构不可用的事件（缺 time）并计入报告', () => {
    const dirty = {
      version: 2,
      records: {},
      timeline: [
        { time: '2026-09-07 08:00:00', type: 'start', file: 'a.md', state: 'tracking' },
        { type: 'start', file: 'b.md' }, // 缺 time
        { time: '', type: 'start', file: 'c.md' }, // 空 time
        null,
      ],
    } as unknown as HistoryCache;

    const { cache, report } = migrateV2ToV3(dirty);
    expect(cache.timeline).toHaveLength(1);
    expect(report.droppedMalformed).toBe(3);
  });

  it('未知事件类型保留而非丢弃，只在报告里列出', () => {
    const weird = {
      version: 2,
      records: {},
      timeline: [
        { time: '2026-09-07 08:00:00', type: 'some-future-type', file: 'a.md' },
        { time: '2026-09-07 08:01:00', type: 'start', file: 'a.md', state: 'tracking' },
      ],
    } as unknown as HistoryCache;

    const { cache, report } = migrateV2ToV3(weird);
    expect(cache.timeline).toHaveLength(2);
    expect(report.unknownEventTypes).toEqual(['some-future-type']);
  });

  it('records 归一化为三个统计字段', () => {
    const withRecords = {
      version: 2,
      timeline: [],
      records: {
        'Notes/a.md': {
          fileName: 'a.md',
          totalReadTime: 120,
          lastReadAt: '2026-09-07',
          readTimeToday: 60, // 派生字段，应被移除
          readTimeLine: [{ '2026-09-07 08:00': 'tracking' }], // 派生字段，应被移除
        },
      },
    } as unknown as HistoryCache;

    const { cache, report } = migrateV2ToV3(withRecords);
    const rec = cache.records['Notes/a.md']!;

    expect(Object.keys(rec).sort()).toEqual(['fileName', 'lastReadAt', 'totalReadTime']);
    expect(rec.totalReadTime).toBe(120);
    expect(report.recordsBefore).toBe(1);
    expect(report.recordsAfter).toBe(1);
  });

  it('空输入不抛异常', () => {
    expect(() => migrateV2ToV3(null)).not.toThrow();
    expect(() => migrateV2ToV3(undefined)).not.toThrow();
    const { cache } = migrateV2ToV3(null);
    expect(cache.timeline).toEqual([]);
  });
});

describe('eventFileRefs', () => {
  it('普通事件取 file，switch 事件取 from/to', () => {
    expect(
      eventFileRefs({ time: 't', type: 'start', file: 'a.md' } as TimelineEvent),
    ).toEqual(['a.md']);

    expect(
      eventFileRefs({
        time: 't',
        type: 'switch',
        from: 'a.md',
        to: 'b.md',
      } as TimelineEvent),
    ).toEqual(['a.md', 'b.md']);
  });
});

/**
 * 可选：对真实数据跑同一组不变量。
 *
 * 真实文件含个人阅读历史，故不提交进仓库。本地想校验时：
 *   RTT_REAL_DATA="/path/to/readTimeHistory.json" bun test
 *
 * Optional: run the same invariants against the real file when explicitly pointed at it.
 */
const REAL = process.env.RTT_REAL_DATA;
describe.if(!!REAL)('真实数据校验 / real-data check', () => {
  it('真实文件迁移后事件数不变', () => {
    if (!REAL || !existsSync(REAL)) return;
    const raw = JSON.parse(readFileSync(REAL, 'utf8')) as HistoryCache;
    const before = raw.timeline.length;
    const { cache } = migrateV2ToV3(raw);

    console.log(`[real-data] ${before} → ${cache.timeline.length} 事件`);
    expect(cache.timeline).toHaveLength(before);
    expect(cache.version).toBe(DATA_VERSION);
  });
});
