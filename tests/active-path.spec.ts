/**
 * Active-path resolution tests
 *
 * Two opposite bugs shipped from misreading `getActiveViewOfType(MarkdownView)`'s null:
 * plugin views were billed to the previous note, and clicking our own sidebar unbound the
 * file. Both are pinned here.
 */

import { describe, expect, it } from 'bun:test';

import {
  isPluginViewKey,
  pluginViewKey,
  pluginViewLabel,
  resolveActiveTarget,
} from '../src/core/activePath';

const OWN = ['documents-activity-tracker-sidebar'];
const NOTE = 'Notes/alpha.md';

/** A case with sensible defaults, overridden per test. */
function input(over: Partial<Parameters<typeof resolveActiveTarget>[0]> = {}) {
  return {
    markdownPath: null,
    focusedViewType: null,
    ownViewTypes: OWN,
    recentViewType: 'markdown',
    recentMarkdownPath: NOTE,
    ...over,
  };
}

describe('resolveActiveTarget', () => {
  it('markdown 视图获得焦点时用它的文件', () => {
    expect(
      resolveActiveTarget(input({ markdownPath: NOTE, focusedViewType: 'markdown' })),
    ).toBe(NOTE);
  });

  it('焦点在计时侧栏时保留最近内容叶子的文件', () => {
    expect(
      resolveActiveTarget(
        input({ focusedViewType: 'documents-activity-tracker-sidebar' }),
      ),
    ).toBe(NOTE);
  });

  it('插件视图单独记为一类，而不是丢掉或算到笔记头上', () => {
    // 读 RSS / 翻译面板也是读，所以计时，但归入自己的通道
    expect(resolveActiveTarget(input({ focusedViewType: 'rss-dashboard-view' }))).toBe(
      'view:rss-dashboard-view',
    );
    expect(resolveActiveTarget(input({ focusedViewType: 'translator-view' }))).toBe(
      'view:translator-view',
    );
  });

  it('文件浏览器 / 搜索 / 图谱是导航外壳，不读内容，不计时', () => {
    for (const type of ['file-explorer', 'search', 'graph', 'outline', 'backlink', 'tag']) {
      expect(resolveActiveTarget(input({ focusedViewType: type }))).toBeNull();
    }
  });

  it('canvas 这类文件型视图也算插件视图', () => {
    expect(resolveActiveTarget(input({ focusedViewType: 'canvas' }))).toBe('view:canvas');
  });

  it('没有任何叶子获得焦点且没有当前文件时返回 null', () => {
    expect(
      resolveActiveTarget(input({ focusedViewType: null, recentMarkdownPath: null })),
    ).toBeNull();
  });

  it('计时侧栏保留最近 RSS 视图，不误用旧笔记', () => {
    expect(resolveActiveTarget(input({ focusedViewType: OWN[0], recentViewType: 'rss-dashboard-view', recentMarkdownPath: null }))).toBe('view:rss-dashboard-view');
  });

  it('没有最近内容视图时不猜测旧笔记或计时侧栏本身', () => {
    expect(resolveActiveTarget(input({ focusedViewType: OWN[0], recentViewType: null }))).toBeNull();
    expect(resolveActiveTarget(input({ focusedViewType: OWN[0], recentViewType: OWN[0] }))).toBeNull();
  });

  it('ownViewTypes 为空时不会把侧栏当成自己的视图', () => {
    // 未声明的视图按"插件视图"处理：不是导航外壳，故计时
    expect(
      resolveActiveTarget(
        input({
          ownViewTypes: [],
          focusedViewType: 'documents-activity-tracker-sidebar',
        }),
      ),
    ).toBe('view:documents-activity-tracker-sidebar');
  });

  it('markdownPath 优先于焦点类型（两者同时给出时）', () => {
    expect(
      resolveActiveTarget(input({ markdownPath: NOTE, focusedViewType: 'graph' })),
    ).toBe(NOTE);
  });
});

describe('插件视图的键与显示名 / view keys and labels', () => {
  it('key 往返一致', () => {
    const key = pluginViewKey('rss-dashboard-view');
    expect(key).toBe('view:rss-dashboard-view');
    expect(isPluginViewKey(key)).toBe(true);
    expect(isPluginViewKey('Notes/a.md')).toBe(false);
  });

  it('显示名去掉 -view 后缀并把连字符换成空格', () => {
    expect(pluginViewLabel('view:rss-dashboard-view')).toBe('rss dashboard');
    expect(pluginViewLabel('view:canvas')).toBe('canvas');
    // 非插件视图键原样返回
    expect(pluginViewLabel('Notes/a.md')).toBe('Notes/a.md');
  });
});
