/**
 * 记录编辑 / editing records
 *
 * 改名是**备注**：只改显示，不改变指向。这里钉住三件事 —— 别名的读写与回退、备注的更新、
 * 以及别名在设置加载时不会被丢掉。
 * A rename is a **remark**: it changes what is displayed, never what is pointed at. Pinned here: alias
 * lookup and fallback, updating a note, and the alias map surviving settings load.
 */

import { describe, expect, it } from 'bun:test';

import { DEFAULT_SETTINGS } from '../src/core/defaults';
import { mergeSettings, recordName } from '../src/core/settings';
import type { ManualSession } from '../src/core/types';
import { VolatileHistoryStore } from '../src/data/VolatileHistoryStore';

describe('recordName / 显示名', () => {
  it('有别名用别名', () => {
    const settings = { ...DEFAULT_SETTINGS, recordAliases: { 'a.md': '英语卷 4 解析' } };
    expect(recordName(settings, 'a.md', 'a.md')).toBe('英语卷 4 解析');
  });

  it('没有别名、或别名只有空白：用默认名', () => {
    expect(recordName(DEFAULT_SETTINGS, 'a.md', 'a.md')).toBe('a.md');
    const blank = { ...DEFAULT_SETTINGS, recordAliases: { 'a.md': '   ' } };
    expect(recordName(blank, 'a.md', 'a.md')).toBe('a.md');
  });

  it('别名与键一一对应，不会串到别的记录', () => {
    const settings = { ...DEFAULT_SETTINGS, recordAliases: { 'view:rss': 'RSS' } };
    expect(recordName(settings, 'a.md', 'a.md')).toBe('a.md');
    expect(recordName(settings, 'view:rss', 'Plugin view')).toBe('RSS');
  });
});

describe('设置加载 / settings load', () => {
  it('别名表能原样读回，不会被当成字符串丢掉', () => {
    const loaded = mergeSettings({ recordAliases: { 'a.md': '备注名' } });
    expect(loaded.recordAliases).toEqual({ 'a.md': '备注名' });
  });

  it('坏数据退回空表', () => {
    expect(mergeSettings({ recordAliases: 'oops' }).recordAliases).toEqual({});
    expect(mergeSettings({ recordAliases: ['a'] }).recordAliases).toEqual({});
    expect(mergeSettings({}).recordAliases).toEqual({});
  });
});

describe('手动计时备注 / manual notes', () => {
  function session(note: string): ManualSession {
    return {
      id: 'm1',
      startTime: '2026-10-24 10:00:00',
      endTime: '2026-10-24 10:05:00',
      durationSeconds: 300,
      note,
      flags: [],
      pauses: [],
    };
  }

  it('改备注只动备注', () => {
    const store = new VolatileHistoryStore();
    store.appendManualSession(session('旧备注'));

    expect(store.updateManualSessionNote('m1', '新备注')).toBe(true);
    const [updated] = store.getManualSessions();
    expect(updated?.note).toBe('新备注');
    expect(updated?.durationSeconds).toBe(300);
    expect(updated?.startTime).toBe('2026-10-24 10:00:00');
  });

  it('不存在的 id 返回 false', () => {
    const store = new VolatileHistoryStore();
    expect(store.updateManualSessionNote('nope', 'x')).toBe(false);
  });
});
