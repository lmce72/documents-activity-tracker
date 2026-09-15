/**
 * 国际化测试 / i18n tests
 *
 * 固化本次对词条表的两处修正：
 *   1. en 表的 statsToday / statsTodayTotal / statsTodaySessions / statsWeek 原为中文
 *   2. en 表原本缺失 excluded 键，导致英文界面下显示字面量 "excluded"
 *
 * Pins down two fixes to the string tables: four en entries that held Chinese text,
 * and a missing `excluded` key that leaked the raw key into the English UI.
 */

import { describe, expect, it } from 'bun:test';

import { I18N, getLang, t } from '../src/core/i18n';

/** 中日韩统一表意文字 / CJK Unified Ideographs. */
const CJK = /[一-鿿㐀-䶿]/;

const zhKeys = Object.keys(I18N.zh).sort();
const enKeys = Object.keys(I18N.en).sort();

describe('词条表结构 / table structure', () => {
  it('中英两表的键集完全一致', () => {
    expect(enKeys).toEqual(zhKeys);
  });

  it('英文表里不含任何中日韩字符', () => {
    const offenders = Object.entries(I18N.en)
      .filter(([, value]) => CJK.test(value))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it('中文表的关键条目确实是中文（抽样确认没被反向写错）', () => {
    expect(CJK.test(I18N.zh.statsToday)).toBe(true);
    expect(CJK.test(I18N.zh.excluded)).toBe(true);
  });
});

describe('t()', () => {
  it('按语言取词', () => {
    expect(t('pause', 'zh')).toBe('暂停计时');
    expect(t('pause', 'en')).toBe('Pause timer');
  });

  it('excluded 在英文下有真实译文，不会回退成键名', () => {
    // 修复前：I18N.en.excluded 不存在 → 回退返回字符串 'excluded'
    expect(t('excluded', 'en')).not.toBe('excluded');
    expect(t('excluded', 'en')).toBe('This file is filtered out');
  });

  it('原先误填中文的四项已有英文译文', () => {
    for (const key of [
      'statsToday',
      'statsTodayTotal',
      'statsTodaySessions',
      'statsWeek',
    ] as const) {
      expect(CJK.test(t(key, 'en'))).toBe(false);
    }
  });

  it('每个键在两种语言下都有非空取值', () => {
    for (const key of zhKeys as (keyof typeof I18N.zh)[]) {
      expect(t(key, 'zh').length).toBeGreaterThan(0);
      expect(t(key, 'en').length).toBeGreaterThan(0);
    }
  });

  it('带占位符的词条保留 {n} 以便调用方替换', () => {
    expect(t('todaySessions', 'zh')).toContain('{n}');
    expect(t('todaySessions', 'en')).toContain('{n}');
    expect(t('previousSessions', 'en')).toContain('{n}');
  });
});

describe('getLang()', () => {
  it('返回 zh 或 en 之一', () => {
    expect(['zh', 'en']).toContain(getLang());
  });

  it('在没有 window.moment 的环境下不抛异常', () => {
    expect(() => getLang()).not.toThrow();
  });
});
