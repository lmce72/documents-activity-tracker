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
  //  毫秒默认不显示：多数时候那是干扰，需要的人自己打开
  //  Milliseconds off by default: usually noise, and whoever needs them can switch them on
  manualShowMilliseconds: false,
  manualRecordDocActivity: true,
  countUnfocusedAsReading: false,
  //  默认「算作暂停」：既不算阅读，也仍然留在合计里 —— 与旧的「不计入阅读但计入总时长」一致
  //  Default "counts as paused": not reading, still in the total — matching the old behaviour of
  //  "not reading but still recorded".
  awayPolicy: 'paused',
  idlePolicy: 'paused',
  countPluginViewsAsReading: true,
  // Two of four slots filled: enough to be useful out of the box, without crowding the
  // status bar before the user has asked for anything.
  statusBarMetrics: ['session', 'todayTotal', '', ''],
  statusBarIconsOnly: false,

  //  落盘时机默认全开，行为与本功能引入之前一致；想安静下来的用户自己关。
  //  The flush triggers all default to on, so behaviour matches what this feature replaced; a
  //  user who wants a quieter file turns them off.
  flushOnSessionEnd: true,
  flushOnQuit: true,
  flushOnInterval: true,
  flushIntervalMinutes: 5,

  //  默认共用一套设置：各设备显示口径一致，才不会「同一批数据两个数」
  //  One shared set of settings by default, so the same data does not read two ways
  perDeviceSettings: false,

  //  倒计时默认开着，但停在最朴素的「倒计时 25 分钟」：番茄钟与不规则周期要用的人自己切。
  //  Countdown is on by default but idle at the plainest mode — a 25-minute countdown; pomodoro and
  //  irregular phases are there for whoever switches to them.
  countdownTimerEnabled: true,
  countdownMode: 'down',
  countdownMinutes: 25,
  countdownFocusMinutes: 25,
  countdownBreakMinutes: 5,
  countdownCycles: 4,
  countdownRepeat: false,
  countdownIntervals: [25, 5, 25],
  //  收尾备注默认不问：跑完直接保存，想要备注的人自己打开
  //  No note prompt by default: the run saves itself, and whoever wants a note turns it on
  countdownPromptNote: false,
};
