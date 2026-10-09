/**
 * Internationalisation
 *
 * Origin: vault main.js lines 12-126 (byte-identical across both versions).
 *
 * Changes in this refactor:
 *      Four `en` entries previously held Chinese text; translated.
 *      Typed: keys constrained by `TranslationKey`, so typos fail compilation.
 *      `t()` takes an optional lang so tests need not touch the environment.
 *
 * This is the L0 leaf layer and imports nothing else.
 */

/** Supported languages. */
export type Lang = 'zh' | 'en';

/**
 * The zh+en string table.
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

    sidebarTitle: '活动追踪',
    panelDocument: '文档追踪',
    panelManual: '手动计时',
    openSidebar: '打开活动追踪侧栏',
    tabUnfocused: '脱离窗口',
    tabInWindow: '窗口内',
    trackerOff: '文档追踪已关闭',
    trackerOffDesc: '在设置中开启后才会记录阅读时长。',
    noOpenFile: '当前没有正在追踪的文档',
    btnStart: '开始计时',
    btnPause: '暂停',
    btnResume: '继续',
    btnSave: '保存',
    btnDiscard: '丢弃',
    sessionCount: '今日轮数',
    manualStart: '开始',
    manualPause: '暂停',
    manualResume: '继续',
    manualStop: '停止',
    manualRunning: '计时中',
    manualPaused: '已暂停',
    manualIdle: '未计时',
    manualStopTitle: '这段时间做了什么？',
    manualStopDesc: '写下这段时间的内容。留空则只保存时长。',
    manualStopPlaceholder: '例如：写周报',
    manualSaveSession: '保存记录',
    manualDiscard: '放弃',
    manualTodayTotal: '今日手动计时',
    manualNoRecords: '这一天没有手动计时记录',
    manualListTitle: '手动计时记录',
    manualHeatmapTitle: '手动计时热力图',
    manualTimerOff: '手动计时已关闭',
    manualTimerOffDesc: '在设置中开启后即可使用手动计时。',
    prevDay: '前一天',
    nextDay: '后一天',
    todayLabel: '今天',
    noteLabel: '内容',
    settingDocumentTracking: '文档追踪',
    settingDocumentTrackingDesc: '按文档记录阅读时长。关闭后隐藏文档面板并停止计时。',
    settingManualTimer: '手动计时',
    settingManualTimerDesc:
      '独立于文档追踪的秒表：开始、停止，并写下这段时间做了什么。',

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

    // records browser ───────────────────────────────
    recTitle: '阅读记录',
    recSort: '排序方式',
    recTotalFiles: '共 {n} 个文件有记录',
    recDelete: '删除该文件的全部记录',
    recDeleteConfirm: '确定删除「{name}」的全部阅读记录？此操作不可撤销。',
    recDeleted: '已删除「{name}」的阅读记录',
    recChannelPaused: '暂停',
    recDetailHint: '点击下方任一行，查看该文件当日的阅读热力图',
    recDetailTitle: '当日热力图',
    recNoEvents: '该文件暂无可用的事件记录',

    // manual timer: marks, display, controls ──
    manualFlag: '标记',
    manualFlagsTitle: '本轮标记',
    manualNoFlags: '本轮还没有标记',
    manualFlagAt: '第 {n}',
    manualShowSeconds: '秒表显示秒',
    manualShowSecondsDesc: '关闭后只显示到时和分，长时间专注时少一点跳动的干扰。',
    manualRecordDoc: '记录文档活动',
    manualRecordDocDesc:
      '关闭后，手动计时期间不再写入任何文档的阅读记录（文档面板显示 0 秒），手动计时本身不受影响。',
    manualRingHint: '外圈是本分钟的进度',

    // overview ────────────────────────────────────────────
    panelOverview: '总看板',
    ovUnion: '并集总时长',
    ovDocument: '文档计时合计',
    ovManual: '手动计时合计',
    ovOverlap: '重叠',
    ovEmpty: '这一天没有任何记录',
    ovLegendBoth: '两者同时',
    ovExplain:
      '文档计时与手动计时记的是同一段墙钟时间，因此这里取**并集**：两边同时覆盖的部分只算一次。合计栏仍按各账本自身列出，重叠量说明两手同时在记。',

    // panel list and heatmap copy ──────
    docHeatmapTitle: '当日文档热力图',
    docListTop: '今日时长前三',
    docListEmpty: '今天还没有阅读记录',
    docHeatmapEmpty: '今天还没有可画的阅读时段',
    manualRecent: '最近记录',
    manualShowMore: '显示更多',
    manualShowLess: '收起',
    viewAllRecordsDesc: '打开完整记录面板，可搜索、排序与删除',
    dayPicker: '选择日期',
    dayPickerDesc: '打开日历；只有有记录的日子可以选中',
    dayNoRecords: '这一天没有任何记录',
    prevMonth: '上个月',
    nextMonth: '下个月',
    calNoRecords: '这个月没有记录',
    calOnlyRecorded: '只有有记录的日子可选',
    close: '关闭',
  },
  en: {
    labelPrefix: 'Read',

    //  This key was missing from the original en table, so English users saw the raw
    //  string "excluded" as the message.
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

    //  These four previously held Chinese text; translated here.
    statsToday: 'Read today',
    statsTodayTotal: 'Today total',
    statsTodaySessions: 'Today sessions',
    statsWeek: 'Read this week',

    recTitle: 'Reading records',
    recSort: 'Sort by',
    recTotalFiles: '{n} files with records',
    recDelete: 'Delete every record for this file',
    recDeleteConfirm: 'Delete all reading records for "{name}"? This cannot be undone.',
    recDeleted: 'Deleted reading records for "{name}"',
    recChannelPaused: 'Paused',
    recDetailHint: 'Select a row below to see that file’s heatmap for the day',
    recDetailTitle: 'Daily heatmap',
    recNoEvents: 'No usable events for this file yet',

    manualFlag: 'Mark',
    manualFlagsTitle: 'Marks this run',
    manualNoFlags: 'No marks yet in this run',
    manualFlagAt: 'At {n}',
    manualShowSeconds: 'Show seconds on the stopwatch',
    manualShowSecondsDesc:
      'Turn off to read hours and minutes only, for long focus sessions where a ticking second distracts.',
    manualRecordDoc: 'Record document activity',
    manualRecordDocDesc:
      'Turn off and no reading record is written to any document while manual timing runs (the document panel reads 0s). Manual timing itself is unaffected.',
    manualRingHint: 'The outer ring shows progress through the current minute',

    panelOverview: 'Overview',
    ovUnion: 'Union total',
    ovDocument: 'Document total',
    ovManual: 'Manual total',
    ovOverlap: 'Overlap',
    ovEmpty: 'Nothing recorded on this day',
    ovLegendBoth: 'Both at once',
    ovExplain:
      'Document and manual timing cover the same wall clock, so this panel takes the **union**: time covered by both is counted once. The per-ledger totals are still listed, and the overlap shows where the two ran at the same time.',

    docHeatmapTitle: 'Document heatmap today',
    docListTop: 'Top 3 today',
    docListEmpty: 'Nothing read today yet',
    docHeatmapEmpty: 'No reading stretches to draw for today',
    manualRecent: 'Recent sessions',
    manualShowMore: 'Show more',
    manualShowLess: 'Show less',
    viewAllRecordsDesc: 'Open the full records browser to search, sort and delete',
    dayPicker: 'Pick a date',
    dayPickerDesc: 'Open the calendar; only days that have records can be selected',
    dayNoRecords: 'No records on that day',
    prevMonth: 'Previous month',
    nextMonth: 'Next month',
    calNoRecords: 'No records this month',
    calOnlyRecorded: 'Only days with records can be selected',
    close: 'Close',

    //  New in this refactor: sidebar, manual timer, feature toggles
    sidebarTitle: 'Activity tracker',
    panelDocument: 'Document tracking',
    panelManual: 'Manual timer',
    openSidebar: 'Open activity tracker sidebar',
    tabUnfocused: 'Out of window',
    tabInWindow: 'In window',
    trackerOff: 'Document tracking is off',
    trackerOffDesc: 'Enable it in settings to start recording reading time.',
    noOpenFile: 'No document is being tracked',
    btnStart: 'Start tracking',
    btnPause: 'Pause',
    btnResume: 'Resume',
    btnSave: 'Save',
    btnDiscard: 'Discard',
    sessionCount: 'Rounds today',
    manualStart: 'Start',
    manualPause: 'Pause',
    manualResume: 'Resume',
    manualStop: 'Stop',
    manualRunning: 'Timing',
    manualPaused: 'Paused',
    manualIdle: 'Not timing',
    manualStopTitle: 'What did you work on?',
    manualStopDesc: 'Describe this session. Leave it empty to save without a note.',
    manualStopPlaceholder: 'e.g. writing the weekly report',
    manualSaveSession: 'Save session',
    manualDiscard: 'Discard',
    manualTodayTotal: 'Manual total today',
    manualNoRecords: 'No manual sessions on this day',
    manualListTitle: 'Manual sessions',
    manualHeatmapTitle: 'Manual timing heatmap',
    manualTimerOff: 'Manual timer is off',
    manualTimerOffDesc: 'Enable it in settings to use the manual timer.',
    prevDay: 'Previous day',
    nextDay: 'Next day',
    todayLabel: 'Today',
    noteLabel: 'Note',
    settingDocumentTracking: 'Document tracking',
    settingDocumentTrackingDesc:
      'Track reading time per document. Turning this off hides the document panel and stops the timer.',
    settingManualTimer: 'Manual timer',
    settingManualTimerDesc:
      'An independent stopwatch: start it, stop it, and write down what you did. Unaffected by document tracking.',
  },
} as const;

/** Translation key. */
export type TranslationKey = keyof typeof I18N.zh;

/**
 * Detect the current UI language.
 *
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

    //  A failure here must not break the plugin; degrade to English.
    console.error('[RTT][i18n] 语言探测失败 / language detection failed:', error);
    return 'en';
  }
}

/**
 * Look up a translated string.
 *
 * Three-level fallback: requested lang -> en -> the key itself. Matches the original.
 *
 * the translation key
 * target language; defaults to detection
 */
export function t(key: TranslationKey, lang: Lang = getLang()): string {
  const table = I18N[lang] ?? I18N.en;
  const value = table[key] as string | undefined;
  if (value != null) return value;
  return (I18N.en[key] as string | undefined) ?? key;
}
