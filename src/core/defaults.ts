/**
 * 默认设置 / Default settings
 *
 * 来源：vault 版 main.js 第 4952-4966 行。
 * Origin: vault main.js lines 4952-4966.
 *
 * 单独成文件是为了打破 constants ↔ types 的循环 import：
 * `PluginSettings` 定义在 types.ts，而 types.ts 需要从 constants.ts 取
 * `FileStatus` / `ActionType`。若把 DEFAULT_SETTINGS 放进 constants.ts，
 * 两个模块就会互相引用。
 *
 * Separated to break a constants <-> types cycle: `PluginSettings` lives in
 * types.ts, which itself needs `FileStatus` / `ActionType` from constants.ts.
 */

import type { PluginSettings } from './types';

/**
 * 13 项与原实现逐字段相同，一个不加、一个不减、默认值不改。
 * 其中 autoSaveEnabled / autoSaveInterval / trackingMode 是「只写不读」的遗留项，
 * 本次重构刻意原样保留（既不实现也不删除）。
 *
 * All 13 fields are identical to the original — none added, removed, or changed.
 * autoSaveEnabled / autoSaveInterval / trackingMode are write-only legacy fields,
 * intentionally preserved untouched.
 */
export const DEFAULT_SETTINGS: PluginSettings = {
  filterMode: 'blacklist',
  filterPatterns: '',
  idleTimeoutEnabled: true,
  idleTimeout: 20,
  minReadSeconds: 20,
  timeDisplayMode: 'compact',
  autoStartMode: 'manual',
  useIconize: true,
  dataFilePath: '',
  todayTotalDisplay: 'idle',
  autoSaveEnabled: false,
  autoSaveInterval: 60,
  trackingMode: 'focus',
};
