/**
 * Default settings
 *
 * Origin: vault main.js lines 4952-4966.
 *
 * Separated to break a constants <-> types cycle: `PluginSettings` lives in
 * types.ts, which itself needs `FileStatus` / `ActionType` from constants.ts.
 */

import type { PluginSettings } from './types';

/**
 *
 * The first 13 fields match the original exactly, defaults included (autoSaveEnabled /
 * autoSaveInterval / trackingMode are write-only legacy fields, preserved untouched).
 * Every new toggle defaults to on: turning a feature off should be the user's explicit
 * choice, never a surprise after an upgrade.
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
  documentTrackingEnabled: true,
  manualTimerEnabled: true,
  manualShowSeconds: true,
  manualRecordDocActivity: true,
  countUnfocusedAsReading: false,
  // Two of four slots filled: enough to be useful out of the box, without crowding the
  // status bar before the user has asked for anything.
  statusBarMetrics: ['session', 'todayTotal', '', ''],
  statusBarIconsOnly: false,

  //  落盘时机默认全开，行为与本功能引入之前一致；想安静下来的用户自己关。
  //  The flush triggers all default to on, so behaviour matches what this feature replaced; a
  //  user who wants a quieter file turns them off.
  flushOnSessionEnd: true,
  flushOnQuit: true,
  flushOnInterval: false,
  flushIntervalMinutes: 5,
};
