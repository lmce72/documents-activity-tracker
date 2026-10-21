/**
 * 时间账本 / the time account
 *
 * 这一层存在的理由，是把"同一个词两处两个数"钉死：日与周、面板与状态栏，都只能从这里取数。
 * This layer exists to kill "one word, two numbers": day and week, panel and status bar all read here.
 */

import { describe, expect, it } from 'bun:test';

import { dayAccount, weekAccount } from '../src/core/account';
import type { AccountPolicy } from '../src/core/account';
import type { ManualSession, TimelineEvent } from '../src/core/types';

const D = '2026-09-15';
const P = (now: number): number => new Date(`${D}T${String(now).padStart(2, '0')}:00:00`).getTime();

/** 10:00 开始，10:05 失焦，10:10 回来，10:15 保存：专注 10 分钟、离开 5 分钟 */
const events: TimelineEvent[] = [
  { time: `${D} 10:00:00`, type: 'start', file: 'Notes/a.md', state: 'tracking' },
  { time: `${D} 10:05:00`, type: 'blur', file: 'Notes/a.md', state: 'inactive' },
  { time: `${D} 10:10:00`, type: 'focus', file: 'Notes/a.md', state: 'tracking' },
  {
    time: `${D} 10:15:00`,
    type: 'save',
    file: 'Notes/a.md',
    state: 'saved',
    duration: 900,
    activeSeconds: 600,
    unfocusedSeconds: 300,
  },
];

const manual: ManualSession[] = [
  {
    id: 'm1',
    startTime: `${D} 10:12:00`,
    endTime: `${D} 10:22:00`,
    durationSeconds: 600,
    note: '',
    flags: [],
    pauses: [],
  },
];

function input(overrides: { away?: AccountPolicy['away']; idle?: AccountPolicy['idle']; pluginViews?: boolean } = {}) {
  return {
    events,
    manual,
    countdown: [],
    day: D,
    nowMs: P(11),
    policy: {
      away: overrides.away ?? 'paused',
      idle: overrides.idle ?? 'paused',
      pluginViews: overrides.pluginViews ?? true,
    },
    live: null,
  };
}

describe('dayAccount / 一天的四条通道', () => {
  it('专注与离开按事件类型分', () => {
    const account = dayAccount(input());
    expect(account.focus).toBe(600);
    expect(account.away).toBe(300);
    expect(account.idle).toBe(0);
    expect(account.paused).toBe(0);
  });

  it('离开「算作暂停」：不算阅读，但仍在合计里', () => {
    const account = dayAccount(input({ away: 'paused' }));
    expect(account.reading).toBe(600);
    expect(account.total).toBe(900);
  });

  it('离开「计入阅读」：阅读与合计都是 900', () => {
    const account = dayAccount(input({ away: 'reading' }));
    expect(account.reading).toBe(900);
    expect(account.total).toBe(900);
  });

  it('离开「不记录」：合计里也没有它，并集随之缩短', () => {
    const account = dayAccount(input({ away: 'ignored' }));
    expect(account.reading).toBe(600);
    expect(account.total).toBe(600);
    // 文档只剩 10:00–10:05 + 10:10–10:15，再加手动的 10 分钟；重叠仍是 3 分钟
    expect(account.union).toBe(17 * 60);
  });

  it('手动是另一本账：并集去重，重叠单列', () => {
    const account = dayAccount(input());
    expect(account.manual).toBe(600);
    expect(account.document).toBe(900);
    // 文档 10:00–10:15，手动 10:12–10:22 → 并集 22 分钟，重叠 3 分钟
    expect(account.union).toBe(22 * 60);
    expect(account.overlap).toBe(3 * 60);
  });

  it('倒计时作为第四本账进入并集', () => {
    const withCountdown = {
      ...input(),
      countdown: [{
        id: 'c1',
        mode: 'down' as const,
        startTime: `${D} 10:20:00`,
        endTime: `${D} 10:25:00`,
        plannedSeconds: 300,
        durationSeconds: 300,
        completed: true,
        note: '',
        flags: [],
        pauses: [],
        phases: [{ kind: 'focus' as const, seconds: 300 }],
      }],
    };
    const account = dayAccount(withCountdown);
    expect(account.countdown).toBe(300);
    // 文档 10:00–10:15 ∪ 手动 10:12–10:22 ∪ 倒计时 10:20–10:25 = 10:00–10:25
    expect(account.union).toBe(25 * 60);
  });

  it('只算窗口内的那一段', () => {
    const account = dayAccount({ ...input(), day: '2026-09-16' });
    expect(account.focus).toBe(0);
    expect(account.union).toBe(0);
  });
});

describe('weekAccount / 周与日同一口径', () => {
  it('跨两天的事件都算进来，规则与单日相同', () => {
    const twoDays: TimelineEvent[] = [
      ...events,
      { time: `2026-09-16 09:00:00`, type: 'start', file: 'Notes/b.md', state: 'tracking' },
      {
        time: `2026-09-16 09:10:00`,
        type: 'save',
        file: 'Notes/b.md',
        state: 'saved',
        duration: 600,
        activeSeconds: 600,
        unfocusedSeconds: 0,
      },
    ];

    const week = weekAccount({ ...input(), events: twoDays, manual: [] });
    expect(week.focus).toBe(600 + 600);
    expect(week.away).toBe(300);
    // 离开算作暂停时，周的阅读只含专注
    expect(week.reading).toBe(1200);
    expect(week.total).toBe(1500);
  });
});

describe('逐段「不记录」/ an explicitly ignored stretch', () => {
  const ignoredEvents: TimelineEvent[] = [
    { time: `${D} 10:00:00`, type: 'start', file: 'Notes/a.md', state: 'tracking' },
    {
      time: `${D} 10:05:00`,
      type: 'blur',
      file: 'Notes/a.md',
      state: 'inactive',
      unfocusedDisposition: 'ignored',
    },
    { time: `${D} 10:10:00`, type: 'focus', file: 'Notes/a.md', state: 'tracking' },
    {
      time: `${D} 10:15:00`,
      type: 'save',
      file: 'Notes/a.md',
      state: 'saved',
      duration: 900,
      activeSeconds: 600,
      unfocusedSeconds: 300,
    },
  ];

  it('既不算离开，也不进合计与并集', () => {
    const account = dayAccount({
      events: ignoredEvents,
      manual: [],
      countdown: [],
      day: D,
      nowMs: P(11),
      policy: { away: 'paused', idle: 'paused', pluginViews: true },
      live: null,
    });

    expect(account.focus).toBe(600);
    expect(account.away).toBe(0);
    expect(account.total).toBe(600);
    expect(account.union).toBe(600);
  });

  it('旧数据的 unfocused 仍按未归类处理，跟随口径', () => {
    const legacy = ignoredEvents.map((event, index) =>
      index === 1 ? { ...event, unfocusedDisposition: 'unfocused' as const } : event,
    );
    const account = dayAccount({
      events: legacy,
      manual: [],
      countdown: [],
      day: D,
      nowMs: P(11),
      policy: { away: 'paused', idle: 'paused', pluginViews: true },
      live: null,
    });

    expect(account.away).toBe(300);
    expect(account.total).toBe(900);
  });
});
