/**
 * 忽略列表测试 / ignore-list tests
 *
 * 覆盖三件事：菜单能提供哪些粒度、条目如何匹配目标、设置加载时脏数据如何被净化。忽略列表优先于
 * 过滤规则这一点也在这里钉死 —— 它是最容易被后来的改动悄悄推翻的语义。
 *
 * Covers which granularities the menu offers, how entries match a target, and how dirty entries are
 * sanitised on load. The "ignore list outranks the filter rules" rule is pinned here too, because a
 * later change could silently take it away.
 */

import { describe, expect, it } from 'bun:test';

import { ActionTypes, STATUS } from '../src/core/constants';
import { DEFAULT_SETTINGS } from '../src/core/defaults';
import { isTrackableTarget } from '../src/core/filters';
import {
  coveringIgnoreEntry,
  ignoreTargetsFor,
  isCoveredByEntry,
  isTargetIgnored,
  withEntryIgnored,
} from '../src/core/ignoreTargets';
import { createInitialState, createTimerReducer } from '../src/core/reducer';
import { mergeSettings } from '../src/core/settings';
import { wallClockSeconds, type TimerState } from '../src/core/types';
import { CapturingLogger, FakeClock, testDeps } from './helpers/fake-clock';

const NOTE = 'Notes/alpha.md';

describe('ignoreTargetsFor', () => {
  it('笔记列出自身与从最深到根的各级目录', () => {
    expect(ignoreTargetsFor('A/B/C.md')).toEqual([
      { value: 'A/B/C.md', level: 0, kind: 'note' },
      { value: 'A/B/', level: 2, kind: 'folder' },
      { value: 'A/', level: 1, kind: 'folder' },
    ]);
  });

  it('根目录笔记只有自身，不提供 vault 根', () => {
    expect(ignoreTargetsFor('root.md')).toEqual([
      { value: 'root.md', level: 0, kind: 'note' },
    ]);
  });

  it('插件视图只有自身', () => {
    expect(ignoreTargetsFor('view:rss-dashboard-view')).toEqual([
      { value: 'view:rss-dashboard-view', level: 0, kind: 'view' },
    ]);
  });
});

describe('isCoveredByEntry', () => {
  it('目录按路径边界匹配，不吞掉同前缀的兄弟目录', () => {
    expect(isCoveredByEntry('Notes/a.md', 'Notes/')).toBe(true);
    expect(isCoveredByEntry('Notes/sub/a.md', 'Notes/')).toBe(true);
    expect(isCoveredByEntry('Notes-archive/a.md', 'Notes/')).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(isCoveredByEntry('Notes/a.md', 'notes/')).toBe(true);
    expect(isCoveredByEntry('Notes/A.md', 'Notes/a.md')).toBe(true);
  });

  it('笔记条目只精确匹配，不当目录前缀', () => {
    expect(isCoveredByEntry('Notes/a.md', 'Notes/a.md')).toBe(true);
    expect(isCoveredByEntry('Notes/a.md.bak', 'Notes/a.md')).toBe(false);
  });

  it('视图条目只精确匹配', () => {
    expect(isCoveredByEntry('view:rss-dashboard-view', 'view:rss-dashboard-view')).toBe(true);
    expect(isCoveredByEntry('view:rss-dashboard-view', 'view:rss')).toBe(false);
  });

  it('空条目与空白什么都不覆盖', () => {
    expect(isCoveredByEntry(NOTE, '')).toBe(false);
    expect(isCoveredByEntry(NOTE, '   ')).toBe(false);
  });
});

describe('coveringIgnoreEntry', () => {
  it('返回最长的覆盖条目', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      ignoredTargets: ['Notes/', 'Notes/alpha.md', 'Other/'],
    };
    expect(coveringIgnoreEntry(NOTE, settings)).toBe('Notes/alpha.md');
    expect(coveringIgnoreEntry('Notes/b.md', settings)).toBe('Notes/');
    expect(coveringIgnoreEntry('Elsewhere/b.md', settings)).toBeNull();
  });

  it('isTargetIgnored 与覆盖判断一致', () => {
    const settings = { ...DEFAULT_SETTINGS, ignoredTargets: ['Notes/'] };
    expect(isTargetIgnored(NOTE, settings)).toBe(true);
    expect(isTargetIgnored('Other/b.md', settings)).toBe(false);
  });
});

describe('withEntryIgnored', () => {
  it('加入、移除并保持顺序', () => {
    const list = ['A/', 'B.md'];
    expect(withEntryIgnored(list, 'C.md', true)).toEqual(['A/', 'B.md', 'C.md']);
    expect(withEntryIgnored(list, 'A/', false)).toEqual(['B.md']);
  });

  it('重复加入或移除不存在项时原样返回', () => {
    expect(withEntryIgnored(['A/'], 'A/', true)).toEqual(['A/']);
    expect(withEntryIgnored(['A/'], 'B.md', false)).toEqual(['A/']);
  });
});

describe('isTrackableTarget — 忽略列表优先', () => {
  const whitelist = {
    ...DEFAULT_SETTINGS,
    filterMode: 'whitelist',
    filterPatterns: 'Notes/',
  };

  it('白名单内的笔记被显式忽略后不再追踪', () => {
    expect(isTrackableTarget(NOTE, whitelist)).toBe(true);
    expect(isTrackableTarget(NOTE, { ...whitelist, ignoredTargets: ['Notes/'] })).toBe(false);
  });

  it('插件视图默认追踪，被忽略后不再追踪', () => {
    expect(isTrackableTarget('view:rss-dashboard-view', whitelist)).toBe(true);
    expect(isTrackableTarget('view:rss-dashboard-view', {
      ...whitelist,
      ignoredTargets: ['view:rss-dashboard-view'],
    })).toBe(false);
  });
});

describe('mergeSettings — 两个目标列表的净化', () => {
  it('丢弃非字符串、空白与重复项，目录收成单个结尾斜杠', () => {
    const merged = mergeSettings({
      ignoredTargets: [' Notes/ ', 'Notes/', 42, null, '', 'view:rss-dashboard-view', 'Notes/a.md'],
    });
    expect(merged.ignoredTargets).toEqual(['Notes/', 'view:rss-dashboard-view', 'Notes/a.md']);
    expect(merged.knownViewTargets).toEqual([]);
  });

  it('knownViewTargets 只保留视图键', () => {
    const merged = mergeSettings({
      knownViewTargets: ['view:rss-dashboard-view', 'Notes/a.md', 'view:', 7, 'view:translator-view'],
    });
    expect(merged.knownViewTargets).toEqual(['view:rss-dashboard-view', 'view:translator-view']);
  });

  it('缺省时为空数组且在共享设置往返中保持', () => {
    expect(mergeSettings({}).ignoredTargets).toEqual([]);
    const once = mergeSettings({ ignoredTargets: ['A/'] });
    const twice = mergeSettings(JSON.parse(JSON.stringify(once)));
    expect(twice.ignoredTargets).toEqual(['A/']);
  });
});

/** 最小 reducer 上下文 / minimal reducer context. */
function setup() {
  const clock = new FakeClock('2026-09-15T10:00:00');
  const { deps } = testDeps(clock, new CapturingLogger());
  const reducer = createTimerReducer(deps);
  let state: TimerState = createInitialState(deps);
  const dispatch = (action: Parameters<typeof reducer>[1]): TimerState => {
    state = reducer(state, action);
    return state;
  };
  return { clock, dispatch, getState: () => state };
}

describe('REARM_SESSION', () => {
  it('丢弃写入的压制被解除，计时数据不变', () => {
    const ctx = setup();
    ctx.dispatch({
      type: ActionTypes.SWITCH_FILE,
      payload: { fromPath: null, toPath: NOTE, autoStart: true },
    });
    ctx.dispatch({ type: ActionTypes.DISCARD_SESSION, payload: { filePath: NOTE } });

    const discarded = ctx.getState().files.get(NOTE)!;
    expect(discarded.status).toBe(STATUS.IDLE);
    expect(discarded.discardedByUser).toBe(true);
    expect(wallClockSeconds(discarded)).toBe(0);

    ctx.dispatch({ type: ActionTypes.REARM_SESSION, payload: { filePath: NOTE } });
    const rearmed = ctx.getState().files.get(NOTE)!;
    expect(rearmed.discardedByUser).toBe(false);
    expect(rearmed.status).toBe(STATUS.IDLE);
    expect(wallClockSeconds(rearmed)).toBe(0);
  });

  it('未知目标或未丢弃的目标不改变状态', () => {
    const ctx = setup();
    const before = ctx.getState();
    ctx.dispatch({ type: ActionTypes.REARM_SESSION, payload: { filePath: 'Missing.md' } });
    expect(ctx.getState()).toBe(before);
  });
});
