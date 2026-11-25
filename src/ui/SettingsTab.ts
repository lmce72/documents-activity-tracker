/**
 * Settings tab
 *
 *      The two write-only legacy knobs (autoSaveInterval / trackingMode) are no longer
 *      shown: a control on screen must actually be wired to something.
 *
 */

import { Notice, PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';

import { t } from '../core/i18n';
import { isPluginViewKey, pluginViewLabel } from '../core/activePath';
import { withEntryIgnored } from '../core/ignoreTargets';
import { metricById, normalizeSelection, optionsForSlot } from '../core/statusMetrics';
import type { PluginSettings } from '../core/types';

/** Settings tab dependencies. */
export interface SettingsTabDeps {
  settings: () => PluginSettings;
  /** persist and apply */
  save: (patch: Partial<PluginSettings>) => Promise<void>;
  /** 整表替换忽略列表；装配层负责解除被移除条目的自动开始压制 / replace the ignore list */
  setIgnoredTargets: (next: string[]) => Promise<void>;

  databasePath: () => string;
  /** the legacy JSON path */
  legacyPath: () => string;
}

export class ReadTimeSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly deps: SettingsTabDeps,
  ) {
    super(app, plugin);
  }

  /** 控件回调保持 void，保存失败在界面提示 / keep SDK callbacks void and surface save failures. */
  private save(patch: Partial<PluginSettings>, onSaved?: () => void): void {
    void this.deps.save(patch).then(() => onSaved?.()).catch((error: unknown) => {
      new Notice(error instanceof Error ? error.message : 'Could not save tracker settings');
    });
  }

  /**
   * 写入整份忽略列表并重建 / write the whole ignore list and rebuild.
   *
   * 整表写入而不是逐条 patch：装配层需要对比新旧两份，才知道哪些条目被移出、该给谁解除自动开始
   * 压制。重建放在 Promise 之后，滚动位置由 {@link display} 保存。
   * A whole-list write rather than per-entry patches: the assembly layer diffs old and new to know
   * which entries left and which targets need their auto-start suppression cleared. The rebuild
   * follows the promise; {@link display} preserves the scroll position.
   */
  private setIgnoredTargets(next: string[]): void {
    void this.deps.setIgnoredTargets(next).then(() => { this.display(); }).catch((error: unknown) => {
      new Notice(error instanceof Error ? error.message : 'Could not save tracker settings');
    });
  }

  override display(): void {
    //  设置页经常整块重建（开关、模式、状态栏槽位改变后都要重排），而 `empty()` 会把滚动位置
    //  一并清零 —— 用户每改一次就被弹回页首。重建前记录本元素及所有可滚动祖先的位置，建完还原。
    //  The tab is rebuilt wholesale after toggles and dropdowns, and `empty()` resets scrolling — the
    //  user is thrown back to the top after every edit. Record this element and its scrollable
    //  ancestors before rebuilding, then put every position back.
    const scrollers: Array<{ element: HTMLElement; top: number }> = [];
    for (let element: HTMLElement | null = this.containerEl; element; element = element.parentElement) {
      scrollers.push({ element, top: element.scrollTop });
    }
    try {
      this.renderSettings();
    } finally {
      for (const { element, top } of scrollers) {
        if (element.isConnected) element.scrollTop = top;
      }
    }
  }

  /**
   * 忽略列表区块 / the ignore-list section.
   *
   * 插件视图没有路径，过滤规则表达不了，所以这里保留一份「见过的视图」清单并直接给开关 —— 这就是
   * 用户「复排除时快速选择」的入口。笔记与目录条目则由侧栏菜单写入，只在这里展示与撤销。
   *
   * Plugin views have no path, so filter patterns cannot express them. Keeping every view ever seen
   * here and offering a toggle is the "quickly exclude it again" entry point. Note and folder
   * entries are written by the sidebar menu and merely shown (and removed) here.
   */
  private renderIgnoreSection(containerEl: HTMLElement, settings: PluginSettings): void {
    new Setting(containerEl).setName(t('ignoredSection')).setHeading();
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: t('ignoredSectionDesc'),
    });

    const ignored = settings.ignoredTargets ?? [];
    //  清单 = 见过的视图 ∪ 已忽略的视图键；后者可能在旧配置里直接写过，不能因清单缺失就丢掉。
    //  The list is known views plus ignored view keys: the latter may predate the known list and
    //  must not become invisible just because it was never recorded.
    const views = [...new Set([...(settings.knownViewTargets ?? []), ...ignored.filter(isPluginViewKey)])];
    const entries = ignored.filter((entry) => !isPluginViewKey(entry));

    if (views.length === 0 && entries.length === 0) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: t('ignoredNone'),
      });
      return;
    }

    if (views.length > 0) {
      containerEl.createEl('h4', { text: t('ignoredKnownViews') });
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: t('ignoredKnownViewsDesc'),
      });
      for (const view of views) {
        new Setting(containerEl)
          .setName(pluginViewLabel(view))
          .setDesc(view)
          .addToggle((toggle) =>
            toggle
              .setValue(!ignored.includes(view))
              .onChange((value) => {
                this.setIgnoredTargets(
                  withEntryIgnored(this.deps.settings().ignoredTargets ?? [], view, !value),
                );
              }),
          );
      }
    }

    if (entries.length > 0) {
      containerEl.createEl('h4', { text: t('ignoredEntries') });
      for (const entry of entries) {
        const folder = entry.endsWith('/');
        new Setting(containerEl)
          .setName(folder ? entry.replace(/\/+$/, '') : entry)
          .setDesc(folder ? t('ignoredFolderTag') : t('ignoredNoteTag'))
          .addExtraButton((button) =>
            button
              .setIcon('rotate-ccw')
              .setTooltip(t('ignoredRemove'))
              .onClick(() => {
                this.setIgnoredTargets(
                  withEntryIgnored(this.deps.settings().ignoredTargets ?? [], entry, false),
                );
              }),
          );
      }
    }
  }

  /** 真正构建设置项；滚动位置由 {@link display} 负责保持 / builds the tab; `display` keeps the scroll. */
  private renderSettings(): void {
    const { containerEl } = this;
    containerEl.empty();

    const settings = this.deps.settings();

    new Setting(containerEl).setName(t('settingsTitle')).setHeading();

    // feature toggles ────────────────────────────────────────
    new Setting(containerEl)
      .setName(t('settingDocumentTracking'))
      .setDesc(t('settingDocumentTrackingDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.documentTrackingEnabled !== false)
          .onChange((value) => {
            this.save({ documentTrackingEnabled: value }, () => { this.display(); });
          }),
      );

    new Setting(containerEl)
      .setName(t('settingManualTimer'))
      .setDesc(t('settingManualTimerDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.manualTimerEnabled !== false)
          .onChange((value) => {
            this.save({ manualTimerEnabled: value }, () => { this.display(); });
          }),
      );

    // timing behaviour ──────────────────────────────────────
    new Setting(containerEl)
      .setName(t('autoStart'))
      .setDesc(t('autoStartDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('always', t('autoStartAlways'))
          .addOption('start-only', t('autoStartStartOnly'))
          .addOption('return-only', t('autoStartReturnOnly'))
          .addOption('manual', t('autoStartManual'))
          .setValue(settings.autoStartMode)
          .onChange((value) => {
            // 无感模式依赖全自动，读取最新设置以免闭包过期 / ambient requires Always; read current settings.
            const leftAmbient = this.deps.settings().ambientTracking === true && value !== 'always';
            this.save({
              autoStartMode: value,
              ...(leftAmbient ? { ambientTracking: false, singleThreadTracking: true } : {}),
            }, () => { if (leftAmbient) new Notice(t('ambientExited')); });
          }),
      );

    new Setting(containerEl)
      .setName(t('minRead'))
      .setDesc(t('minReadDesc'))
      .addText((text) =>
        text.setValue(String(settings.minReadSeconds)).onChange((value) => {
          const parsed = parseInt(value, 10);
          this.save({
            minReadSeconds: Number.isFinite(parsed) ? Math.max(0, parsed) : 0,
          });
        }),
      );

    //  「离开窗口算作什么」搬到了侧栏文档面板的「离开与空闲」区块：改这个判断时，人正看着它影响的
    //  那几个数字，隔着一层设置页去改既看不见效果，也容易忘了自己设过什么。空闲超时的开关与秒数
    //  也在同一个弹窗里，设置页不再重复。
    //  "What away time counts as" moved to the document panel's "away and idle" block: the judgement is
    //  made while looking at the numbers it moves, and a settings page both hides the effect and is
    //  easy to forget. The idle switch and seconds live in the same modal; the settings tab no longer
    //  duplicates them.
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: t('settingCountUnfocusedMoved'),
    });

    new Setting(containerEl)
      .setName(t('settingMobileMultiWindow'))
      .setDesc(t('settingMobileMultiWindowDesc'))
      .addToggle(toggle => toggle
        .setValue(settings.mobileMultiWindow === true)
        .onChange(value => { this.save({ mobileMultiWindow: value }); }));

    new Setting(containerEl)
      .setName(t('settingCountPluginViews'))
      .setDesc(t('settingCountPluginViewsDesc'))
      .addToggle(toggle => toggle
        .setValue(settings.countPluginViewsAsReading !== false)
        .onChange((value) => {
          this.save({ countPluginViewsAsReading: value });
        }));

    // 倒计时 / countdown ──────────────────────────────────────────
    //
    //  与正计时分开的一整组：它是另一本账，开关、模式与时长都只属于它。方案在开始时冻结，所以这里
    //  改的东西只影响**下一次**开始。
    //  A group of its own, separate from the count-up: another ledger, with its own toggle, mode and
    //  lengths. The plan is frozen at start, so anything changed here applies to the **next** run.
    new Setting(containerEl)
      .setName(t('settingCountdown'))
      .setDesc(t('settingCountdownDesc'))
      .setHeading();

    new Setting(containerEl)
      .setName(t('countdownEnabledToggle'))
      .setDesc(t('countdownEnabledToggleDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.countdownTimerEnabled !== false)
          .onChange((value) => {
            this.save({ countdownTimerEnabled: value }, () => { this.display(); });
          }),
      );

    //  模式、时长与分段都在倒计时面板里改（类型切换 + 「本次方案」旁的编辑入口）；
    //  设置页只留全局开关与收尾备注，避免同一个值有两套编辑入口。
    //  Mode, lengths and phases are edited in the countdown panel (mode switch plus the plan editor
    //  beside "This plan"); settings keeps only the global toggle and the finish-note prompt.
    new Setting(containerEl)
      .setName(t('countdownPromptNote'))
      .setDesc(t('countdownPromptNoteDesc'))
      .addToggle((toggle) =>
        toggle.setValue(settings.countdownPromptNote === true).onChange((value) => {
          this.save({ countdownPromptNote: value });
        }),
      );

    // 落盘时机 / when the vault file is written ────────────────────
    new Setting(containerEl).setName(t('flushTitle')).setDesc(t('flushDesc')).setHeading();

    new Setting(containerEl)
      .setName(t('flushOnSessionEnd'))
      .setDesc(t('flushOnSessionEndDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.flushOnSessionEnd !== false)
          .onChange((value) => {
            this.save({ flushOnSessionEnd: value });
          }),
      );

    new Setting(containerEl)
      .setName(t('flushOnQuit'))
      .setDesc(t('flushOnQuitDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.flushOnQuit !== false)
          .onChange((value) => {
            this.save({ flushOnQuit: value });
          }),
      );

    new Setting(containerEl)
      .setName(t('flushOnInterval'))
      .setDesc(t('flushOnIntervalDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.flushOnInterval === true)
          .onChange((value) => {
            this.save({ flushOnInterval: value });
          }),
      );

    new Setting(containerEl)
      .setName(t('perDeviceSettings'))
      .setDesc(t('perDeviceSettingsDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.perDeviceSettings === true)
          .onChange((value) => {
            this.save({ perDeviceSettings: value });
          }),
      );

    new Setting(containerEl)
      .setName(t('flushIntervalMinutes'))
      .setDesc(t('flushIntervalMinutesDesc'))
      .addText((text_) =>
        text_
          .setPlaceholder('5')
          .setValue(String(settings.flushIntervalMinutes ?? 5))
          .onChange((value) => {
            const parsed = Number.parseInt(value, 10);
            // 少于一分钟的写盘频率没有意义 / sub-minute flush intervals are not useful.
            const minutes = Number.isFinite(parsed) ? Math.max(1, parsed) : 5;
            this.save({ flushIntervalMinutes: minutes });
          }),
      );

    // display ──────────────────────────────────────────────────
    new Setting(containerEl)
      .setName(t('displayMode'))
      .setDesc(t('displayModeDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('compact', t('displayCompact'))
          .addOption('precise', t('displayPrecise'))
          .setValue(settings.timeDisplayMode)
          .onChange((value) => {
            this.save({ timeDisplayMode: value });
          }),
      );

    new Setting(containerEl)
      .setName(t('useIconize'))
      .setDesc(t('useIconizeDesc'))
      .addToggle((toggle) =>
        toggle.setValue(settings.useIconize !== false).onChange((value) => {
          this.save({ useIconize: value });
        }),
      );

    // status bar ────────────────────────────────────────────────
    //
    //  Four dropdowns over one shared selection. Each offers everything except what the
    //  other slots hold, so the same duration cannot be pinned twice — and re-rendering the
    //  whole tab on every change is what keeps the other three in step.
    new Setting(containerEl)
      .setName(t('settingStatusBar'))
      .setDesc(t('settingStatusBarDesc'))
      .setHeading();

    // 桌面端的纯图标模式；移动端不看这个开关（那里始终只有一个图标）
    // The desktop icon-only mode. Mobile ignores it — there is only ever one icon there.
    new Setting(containerEl)
      .setName(t('settingStatusBarIcons'))
      .setDesc(t('settingStatusBarIconsDesc'))
      .addToggle((toggle) =>
        toggle.setValue(settings.statusBarIconsOnly === true).onChange((value) => {
          this.save({ statusBarIconsOnly: value });
        }),
      );

    const slots = normalizeSelection(settings.statusBarMetrics);
    slots.forEach((value, index) => {
      new Setting(containerEl)
        .setName(t('statusBarSlot').replace('{n}', String(index + 1)))
        .addDropdown((dropdown) => {
          dropdown.addOption('', t('statusBarNone'));
          for (const id of optionsForSlot(slots, index)) {
            const metric = metricById(id);
            if (metric) dropdown.addOption(id, t(metric.labelKey));
          }
          dropdown.setValue(value).onChange((next) => {
            const updated = normalizeSelection(this.deps.settings().statusBarMetrics);
            updated[index] = next;
            this.save({ statusBarMetrics: updated }, () => { this.display(); });
          });
        });
    });

    // filtering ────────────────────────────────────────────────
    new Setting(containerEl)
      .setName(t('filterMode'))
      .setDesc(t('filterModeDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('blacklist', t('filterModeBlacklist'))
          .addOption('whitelist', t('filterModeWhitelist'))
          .setValue(settings.filterMode)
          .onChange((value) => {
            this.save({ filterMode: value });
          }),
      );

    new Setting(containerEl)
      .setName(t('filterPatterns'))
      .setDesc(t('filterPatternsDesc'))
      .addTextArea((text) => {
        text.inputEl.rows = 6;
        text
          .setValue(settings.filterPatterns)
          .onChange((value) => {
            this.save({ filterPatterns: value });
          });
      });

    this.renderIgnoreSection(containerEl, settings);

    // storage ─────────────────────────────────────────────────
    new Setting(containerEl)
      .setName(t('dataPath'))
      .setDesc(t('dataPathDesc'))
      .addText((text) =>
        text.setValue(settings.dataFilePath).onChange((value) => {
          this.save({ dataFilePath: value.trim() });
        }),
      );

    //  The "no migration" fact is stated plainly: historical data must not be touched, and
    //  a vague note would leave the user assuming their old records were carried over.
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        `当前库 / Current database: ${this.deps.databasePath()}\n` +
        `旧数据文件 / Legacy data file: ${this.deps.legacyPath()}（不会被读取或迁移 / never read or migrated）\n` +
        `新库从空开始，只记录从此以后的使用。旧文件原样保留，需要时请自行处置。\n` +
        `The database starts empty and records only what happens from now on; the old file is left exactly as it is.`,
    });
  }

}
