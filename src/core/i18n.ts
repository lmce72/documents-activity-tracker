/**
 * 国际化 / Internationalisation
 *
 * 来源：vault 版 main.js 第 12-126 行（两版逐字节相同）。
 * Origin: vault main.js lines 12-126 (byte-identical across both versions).
 *
 * 本次改动 / Changes in this refactor:
 *   1. `en` 分支的 statsToday / statsTodayTotal / statsTodaySessions / statsWeek
 *      四项原为中文，已补为英文译文。
 *      Four `en` entries previously held Chinese text; translated.
 *   2. 补上类型：key 受 `TranslationKey` 约束，拼错即是编译错误。
 *      Typed: keys constrained by `TranslationKey`, so typos fail compilation.
 *   3. `t()` 增加可选 lang 参数，便于测试直接指定语言、不依赖运行时环境。
 *      `t()` takes an optional lang so tests need not touch the environment.
 *
 * 本模块是第 0 层（叶子），不 import 任何其他模块。
 * This is the L0 leaf layer and imports nothing else.
 */

/** 支持的语言 / Supported languages. */
export type Lang = 'zh' | 'en';

/**
 * 中英词条表 / The zh+en string table.
 * 导出是为了让测试能校验两表键集一致、且英文表里不含中日韩字符。
 * Exported so tests can assert key parity and the absence of CJK text in the en table.
 */
export const I18N = {
  zh: {
    labelPrefix: '阅览了',
    pause: '暂停计时',
    resume: '继续计时',
    discard: '丢弃本轮阅读记录',
    excluded: '此文件已被过滤排除',
    cmdAllRecords: '查看阅读记录',
    cmdFileRecords: '查看当前文件阅读记录',
    settingsTitle: 'Documents Activity Tracker 设置',
    filterMode: '过滤模式',
    filterModeDesc: '黑名单：匹配规则的路径不追踪；白名单：仅追踪匹配规则的路径',
    filterModeBlacklist: '黑名单（排除匹配路径）',
    filterModeWhitelist: '白名单（仅追踪匹配路径）',
    filterPatterns: '过滤规则',
    filterPatternsDesc: '每行或逗号分隔一条规则。路径前缀：Templates/   正则：/^Daily\\//',
    filterPickTooltip: '从 Vault 选择路径',
    idleEnabled: '启用空闲超时',
    idleEnabledDesc: '关闭后无论是否有交互都持续计时，直至切换标签页或手动舍弃',
    idleTimeout: '空闲超时（秒）',
    idleTimeoutDesc: '无交互多少秒后暂停计时，最小 1 秒，默认 20 秒',
    minRead: '起步阈值（秒）',
    minReadDesc: '单次会话低于此秒数时不写入记录，0 表示不限制，默认 20 秒',
    displayMode: '时长显示模式',
    displayModeDesc: 'compact：满分钟省略秒；precise：精确到秒',
    displayCompact: '省略秒（5 分钟）',
    displayPrecise: '精确到秒（5 分 30 秒）',
    autoStart: '自动计时模式',
    autoStartDesc: '控制打开文件和切换回来时的计时行为',
    autoStartAlways: '全程（包括开始时）',
    autoStartStartOnly: '仅在开始时',
    autoStartReturnOnly: '不在开始时',
    autoStartManual: '不自动',
    useIconize: '读取 Iconize 图标',
    useIconizeDesc:
      '开启后，阅读记录列表将显示 Iconize 插件为文件/文件夹配置的自定义图标（需已安装 obsidian-icon-folder 插件）。',
    sortLastReadDesc: '最近阅读（最新在前）',
    sortLastReadAsc: '最早阅读（最旧在前）',
    sortTotalDesc: '阅读时长（最多在前）',
    sortTotalAsc: '阅读时长（最少在前）',
    dataPath: '自定义数据文件路径',
    dataPathDesc:
      '相对 Vault 根目录的路径（如 60-数据库/rtt-data.json）。留空使用默认 data.json。建议将此路径加入 Obsidian Excluded Files。',
    searchPlaceholder: '搜索文件名…',
    noRecords: '暂无阅读记录',
    thisSession: '本轮阅读: ',
    total: '总计: ',
    lastRead: '最后阅读: ',
    noTimeline: '暂无阅读记录',
    noDay: '当日无记录',
    pickerPlaceholder: '搜索有阅读记录的文件…',
    filterPickerPlaceholder: '选择文件或文件夹路径添加到过滤规则…',
    today: '今日',
    startedAt: '开始时间',
    minute: '分钟',
    second: '秒',
    inactiveTab: '标签页未激活',
    showTodayInWidget: '在计时器显示今日总时长',
    showTodayInWidgetDesc:
      '开启后，计时器右侧显示今日累计阅读时长按钮，点击可查看今日所有阅读轮次。',
    recordsSaved: '阅览记录已完整保存',
    manualSave: '手动保存阅读记录',
    manualSaveConfirm: '保存记录时将重置目前所有计时器，确定现在进行手动保存吗？',
    todaySessions: '今日共 {n} 轮',
    previousSessions: '之前还有 {n} 轮记录',
    viewAllRecords: '查看更多历史记录',
    now: '现在',
    todayTotalDisplay: '今日总计显示模式',
    todayTotalDisplayDesc:
      '空闲/暂停时显示：暂停时第二段显示文档今日总计，第三段显示全库今日总计；始终显示：第三段始终显示全库今日总计；不显示：不显示今日总计。',
    todayTotalIdle: '空闲/暂停时显示',
    todayTotalAlways: '始终显示',
    todayTotalNever: '不显示',
    fileToday: '文档今日',
    vaultToday: '全库今日',
    statsToday: '今日阅读',
    statsTodayTotal: '今日总时长',
    statsTodaySessions: '今日轮数',
    statsWeek: '本周阅读',
  },
  en: {
    labelPrefix: 'Read',
    // 原 en 表缺失此键，导致英文界面下 t('excluded') 回退成字面量 "excluded"
    // This key was missing from the original en table, so English users saw the raw
    // string "excluded" as the message.
    excluded: 'This file is filtered out',
    pause: 'Pause timer',
    resume: 'Resume timer',
    discard: 'Discard this session',
    cmdAllRecords: 'View reading records',
    cmdFileRecords: 'View current file reading records',
    settingsTitle: 'Documents Activity Tracker Settings',
    filterMode: 'Filter mode',
    filterModeDesc:
      'Blacklist: matched paths excluded; Whitelist: only matched paths tracked',
    filterModeBlacklist: 'Blacklist (exclude matched paths)',
    filterModeWhitelist: 'Whitelist (track matched paths only)',
    filterPatterns: 'Filter rules',
    filterPatternsDesc: 'One rule per line or comma-separated. Prefix: Templates/   Regex: /^Daily\\//',
    filterPickTooltip: 'Pick from Vault',
    idleEnabled: 'Enable idle timeout',
    idleEnabledDesc:
      'When off, timer runs continuously until you switch tabs or discard manually',
    idleTimeout: 'Idle timeout (seconds)',
    idleTimeoutDesc: 'Pause after N seconds without interaction. Min 1s, default 20s',
    minRead: 'Min session threshold (seconds)',
    minReadDesc: 'Sessions shorter than this are not saved. 0 = no limit, default 20s',
    displayMode: 'Duration display mode',
    displayModeDesc: 'compact: omit seconds when ≥1 min; precise: always show seconds',
    displayCompact: 'Compact (5 minutes)',
    displayPrecise: 'Precise (5 min 30 sec)',
    autoStart: 'Auto-start mode',
    autoStartDesc:
      'Control timing behavior when opening files and returning to them',
    autoStartAlways: 'Always (including on open)',
    autoStartStartOnly: 'Only on open',
    autoStartReturnOnly: 'Not on open',
    autoStartManual: 'Manual',
    useIconize: 'Show Iconize icons',
    useIconizeDesc:
      'When enabled, reading record list shows custom icons configured in obsidian-icon-folder. Requires the Iconize plugin to be installed.',
    sortLastReadDesc: 'Last read (newest first)',
    sortLastReadAsc: 'Last read (oldest first)',
    sortTotalDesc: 'Total time (most first)',
    sortTotalAsc: 'Total time (least first)',
    dataPath: 'Custom data file path',
    dataPathDesc:
      'Path relative to Vault root. Leave blank for default data.json. Add to Excluded Files to avoid index rebuilds.',
    searchPlaceholder: 'Search files…',
    noRecords: 'No reading records yet',
    thisSession: 'This session: ',
    total: 'Total: ',
    lastRead: 'Last read: ',
    noTimeline: 'No reading records',
    noDay: 'No records for this day',
    pickerPlaceholder: 'Search files with reading records…',
    filterPickerPlaceholder: 'Pick a file or folder to add as filter rule…',
    today: 'Today',
    startedAt: 'Started',
    minute: 'min',
    second: 'sec',
    inactiveTab: 'Tab inactive',
    showTodayInWidget: 'Show today total in widget',
    showTodayInWidgetDesc:
      "When enabled, widget shows a button with today's total reading time. Click to view all sessions.",
    recordsSaved: 'Reading records saved successfully',
    manualSave: 'Save reading records',
    manualSaveConfirm: 'Saving will reset all active timers. Continue?',
    todaySessions: '{n} sessions today',
    previousSessions: '{n} more sessions',
    viewAllRecords: 'View all records',
    now: 'now',
    todayTotalDisplay: 'Today Total Display Mode',
    todayTotalDisplayDesc:
      'Idle: When paused, segment 2 shows file today total, segment 3 shows vault today total; Always: segment 3 always shows vault today total; Never: hide today totals.',
    todayTotalIdle: 'Show when idle/paused',
    todayTotalAlways: 'Always show',
    todayTotalNever: 'Never show',
    fileToday: 'File Today',
    vaultToday: 'Vault Today',
    // 原文这四项误填了中文，此处补为英文译文
    // These four previously held Chinese text; translated here.
    statsToday: 'Read today',
    statsTodayTotal: 'Today total',
    statsTodaySessions: 'Today sessions',
    statsWeek: 'Read this week',
  },
} as const;

/** 词条键 / Translation key. */
export type TranslationKey = keyof typeof I18N.zh;

/**
 * 探测当前界面语言 / Detect the current UI language.
 *
 * 依次尝试 Obsidian 内置 moment 的 locale、浏览器语言，兜底 'en'。
 * Falls back through Obsidian's bundled moment locale, then navigator, then 'en'.
 */
export function getLang(): Lang {
  try {
    const fromMoment =
      typeof window !== 'undefined' && window.moment?.locale
        ? window.moment.locale()
        : undefined;
    const fromNavigator =
      typeof navigator !== 'undefined' ? navigator.language : undefined;
    const locale = fromMoment || fromNavigator || 'en';
    return locale.startsWith('zh') ? 'zh' : 'en';
  } catch (error) {
    // 读取语言失败不应影响插件运行，静默降级为英文
    // A failure here must not break the plugin; degrade to English.
    console.error('[RTT][i18n] 语言探测失败 / language detection failed:', error);
    return 'en';
  }
}

/**
 * 取词 / Look up a translated string.
 *
 * 三级回退：指定语言 → en → 键名本身。与原实现一致。
 * Three-level fallback: requested lang -> en -> the key itself. Matches the original.
 *
 * @param key  词条键 / the translation key
 * @param lang 目标语言；默认按环境探测 / target language; defaults to detection
 */
export function t(key: TranslationKey, lang: Lang = getLang()): string {
  const table = I18N[lang] ?? I18N.en;
  const value = table[key] as string | undefined;
  if (value != null) return value;
  return (I18N.en[key] as string | undefined) ?? key;
}
