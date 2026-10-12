/**
 * Status-bar selection tests
 *
 * The rule worth pinning is the exclusion one: a dropdown must offer everything except what
 * the *other* slots hold, while keeping its own value so the control does not clear itself
 * on render.
 */

import { describe, expect, it } from 'bun:test';

import { mergeSettings } from '../src/core/settings';
import {
  MAX_STATUS_METRICS,
  STATUS_METRICS,
  activeSelection,
  metricById,
  normalizeSelection,
  optionsForSlot,
} from '../src/core/statusMetrics';

describe('normalizeSelection', () => {
  it('总是补齐到固定槽位数', () => {
    expect(normalizeSelection(undefined)).toHaveLength(MAX_STATUS_METRICS);
    expect(normalizeSelection(['session'])).toEqual(['session', '', '', '']);
  });

  it('丢弃未知 id 与重复项', () => {
    expect(normalizeSelection(['session', 'session', 'nope', 'union'])).toEqual([
      'session',
      'union',
      '',
      '',
    ]);
  });

  it('非数组与非法元素都被忽略', () => {
    expect(normalizeSelection('session')).toEqual(['', '', '', '']);
    expect(normalizeSelection([1, null, 'union'])).toEqual(['union', '', '', '']);
  });

  it('超出槽位数的部分被截断', () => {
    const all = STATUS_METRICS.map((m) => m.id);
    expect(normalizeSelection(all)).toHaveLength(MAX_STATUS_METRICS);
  });
});

describe('optionsForSlot', () => {
  const all = STATUS_METRICS.map((m) => m.id);

  it('排除其他槽位已选的项', () => {
    const selection = ['session', '', '', ''];
    const options = optionsForSlot(selection, 1);
    expect(options).not.toContain('session');
    expect(options).toContain('union');
  });

  it('保留自己的当前值，否则下拉会在渲染时把自己清空', () => {
    const selection = ['session', '', '', ''];
    expect(optionsForSlot(selection, 0)).toContain('session');
  });

  it('多个槽位已选时一并排除', () => {
    const selection = ['session', 'union', 'viewTotal', ''];
    const options = optionsForSlot(selection, 3);
    expect(options).not.toContain('session');
    expect(options).not.toContain('union');
    expect(options).not.toContain('viewTotal');
    expect(options).toEqual(all.filter((id) => !selection.slice(0, 3).includes(id)));
  });

  it('空选择时每个槽位都提供全部选项', () => {
    const empty = ['', '', '', ''];
    expect(optionsForSlot(empty, 0)).toEqual(all);
    expect(optionsForSlot(empty, 3)).toEqual(all);
  });
});

describe('与设置合并 / merging through settings', () => {
  it('旧安装没有这个键时保留默认选择，而不是被抹成空槽', () => {
    // 归一化 `undefined` 会得到四个空槽；若直接用它覆盖自然会把默认选择清掉，
    // 于是状态栏在所有早于本设置的安装上什么都不显示。
    // Normalising `undefined` yields four empty slots; assigning that over the default wipes
    // the selection, and the status bar renders nothing on every pre-setting install.
    const merged = mergeSettings({ filterMode: 'blacklist' });
    expect(merged.statusBarMetrics).toEqual(['session', 'todayTotal', '', '']);
  });

  it('用户手动清空为空数组时保持清空', () => {
    expect(mergeSettings({ statusBarMetrics: [] }).statusBarMetrics).toEqual([
      '',
      '',
      '',
      '',
    ]);
  });

  it('磁盘上的重复项与未知 id 会被清理', () => {
    expect(
      mergeSettings({ statusBarMetrics: ['union', 'union', 'nope'] }).statusBarMetrics,
    ).toEqual(['union', '', '', '']);
  });
});

describe('activeSelection / metricById', () => {
  it('跳过空槽位并保持槽位顺序', () => {
    const metrics = activeSelection(['union', '', 'session', '']);
    expect(metrics.map((m) => m.id)).toEqual(['union', 'session']);
  });

  it('每个指标都指向一个已知面板', () => {
    for (const metric of STATUS_METRICS) {
      expect(['document', 'manual', 'overview']).toContain(metric.panel);
      expect(metricById(metric.id)).toEqual(metric);
    }
  });

  it('未知 id 返回 null', () => {
    expect(metricById('nope')).toBeNull();
  });

  it('手动计时与插件视图指向不同面板（状态栏跳转才有意义）', () => {
    expect(metricById('manualToday')!.panel).toBe('manual');
    expect(metricById('viewTotal')!.panel).toBe('overview');
  });
});
