/**
 * Settings tab
 *
 *      The two write-only legacy knobs (autoSaveInterval / trackingMode) are no longer
 *      shown: a control on screen must actually be wired to something.
 *
 */

import { PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';

import { clampCycles, clampMinutes, normalizeIntervals, normalizeMode } from '../core/countdown';
import { t } from '../core/i18n';
import { metricById, normalizeSelection, optionsForSlot } from '../core/statusMetrics';
import type { PluginSettings } from '../core/types';

/** Settings tab dependencies. */
export interface SettingsTabDeps {
  settings: () => PluginSettings;
  /** persist and apply */
  save: (patch: Partial<PluginSettings>) => Promise<void>;

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

  override display(): void {
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
          .onChange(async (value) => {
            await this.deps.save({ documentTrackingEnabled: value });
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName(t('settingManualTimer'))
      .setDesc(t('settingManualTimerDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.manualTimerEnabled !== false)
          .onChange(async (value) => {
            await this.deps.save({ manualTimerEnabled: value });
            this.display();
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
          .onChange(async (value) => {
            await this.deps.save({ autoStartMode: value });
          }),
      );

    new Setting(containerEl)
      .setName(t('minRead'))
      .setDesc(t('minReadDesc'))
      .addText((text) =>
        text.setValue(String(settings.minReadSeconds)).onChange(async (value) => {
          const parsed = parseInt(value, 10);
          await this.deps.save({
            minReadSeconds: Number.isFinite(parsed) ? Math.max(0, parsed) : 0,
          });
        }),
      );

    new Setting(containerEl)
      .setName(t('idleTimeout'))
      .setDesc(t('idleTimeoutDesc'))
      .addToggle((toggle) =>
        toggle.setValue(settings.idleTimeoutEnabled !== false).onChange(async (value) => {
          await this.deps.save({ idleTimeoutEnabled: value });
        }),
      )
      .addText((text) =>
        text.setValue(String(settings.idleTimeout)).onChange(async (value) => {
          const parsed = parseInt(value, 10);
          await this.deps.save({
            idleTimeout: Number.isFinite(parsed) ? Math.max(1, parsed) : 1,
          });
        }),
      );

    //  「离开窗口算作什么」搬到了侧栏文档面板的「离开与空闲」区块：改这个判断时，人正看着它影响的
    //  那几个数字，隔着一层设置页去改既看不见效果，也容易忘了自己设过什么。
    //  "What away time counts as" moved to the document panel's "away and idle" block: the judgement is
    //  made while looking at the numbers it moves, and a settings page both hides the effect and is
    //  easy to forget.
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: t('settingCountUnfocusedMoved'),
    });

    new Setting(containerEl)
      .setName(t('settingCountPluginViews'))
      .setDesc(t('settingCountPluginViewsDesc'))
      .addToggle(toggle => toggle
        .setValue(settings.countPluginViewsAsReading !== false)
        .onChange(async value => { await this.deps.save({ countPluginViewsAsReading: value }); }));

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
          .onChange(async (value) => {
            await this.deps.save({ countdownTimerEnabled: value });
            this.display();
          }),
      );

    const mode = normalizeMode(settings.countdownMode);
    new Setting(containerEl)
      .setName(t('countdownModeSetting'))
      .setDesc(t('countdownModeSettingDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('down', t('countdownModeDown'))
          .addOption('pomodoro', t('countdownModePomodoro'))
          .addOption('interval', t('countdownModeInterval'))
          .setValue(mode)
          .onChange(async (value) => {
            await this.deps.save({ countdownMode: normalizeMode(value) });
            this.display();
          }),
      );

    if (mode === 'down') {
      this.minutesRow(containerEl, t('countdownMinutes'), 'countdownMinutes', settings.countdownMinutes, 25);
    } else if (mode === 'pomodoro') {
      this.minutesRow(containerEl, t('countdownFocusMinutes'), 'countdownFocusMinutes', settings.countdownFocusMinutes, 25);
      this.minutesRow(containerEl, t('countdownBreakMinutes'), 'countdownBreakMinutes', settings.countdownBreakMinutes, 5);

      new Setting(containerEl)
        .setName(t('countdownRepeat'))
        .setDesc(t('countdownRepeatDesc'))
        .addToggle((toggle) =>
          toggle.setValue(settings.countdownRepeat === true).onChange(async (value) => {
            await this.deps.save({ countdownRepeat: value });
            this.display();
          }),
        );

      if (settings.countdownRepeat === true) {
        this.cyclesRow(containerEl, settings.countdownCycles);
      }

    } else {
      this.intervalRows(containerEl, settings.countdownIntervals);
    }

    new Setting(containerEl)
      .setName(t('countdownPromptNote'))
      .setDesc(t('countdownPromptNoteDesc'))
      .addToggle((toggle) =>
        toggle.setValue(settings.countdownPromptNote === true).onChange(async (value) => {
          await this.deps.save({ countdownPromptNote: value });
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
          .onChange(async (value) => {
            await this.deps.save({ flushOnSessionEnd: value });
          }),
      );

    new Setting(containerEl)
      .setName(t('flushOnQuit'))
      .setDesc(t('flushOnQuitDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.flushOnQuit !== false)
          .onChange(async (value) => {
            await this.deps.save({ flushOnQuit: value });
          }),
      );

    new Setting(containerEl)
      .setName(t('flushOnInterval'))
      .setDesc(t('flushOnIntervalDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.flushOnInterval === true)
          .onChange(async (value) => {
            await this.deps.save({ flushOnInterval: value });
          }),
      );

    new Setting(containerEl)
      .setName(t('perDeviceSettings'))
      .setDesc(t('perDeviceSettingsDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.perDeviceSettings === true)
          .onChange(async (value) => {
            await this.deps.save({ perDeviceSettings: value });
          }),
      );

    new Setting(containerEl)
      .setName(t('flushIntervalMinutes'))
      .setDesc(t('flushIntervalMinutesDesc'))
      .addText((text_) =>
        text_
          .setPlaceholder('5')
          .setValue(String(settings.flushIntervalMinutes ?? 5))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);

            //  少于 1 分钟的写盘频率没有意义，也挡住了手滑输 0
            //  Sub-minute writes are pointless, and this also catches an accidental 0
            const minutes = Number.isFinite(parsed) ? Math.max(1, parsed) : 5;
            await this.deps.save({ flushIntervalMinutes: minutes });
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
          .onChange(async (value) => {
            await this.deps.save({ timeDisplayMode: value });
          }),
      );

    new Setting(containerEl)
      .setName(t('useIconize'))
      .setDesc(t('useIconizeDesc'))
      .addToggle((toggle) =>
        toggle.setValue(settings.useIconize !== false).onChange(async (value) => {
          await this.deps.save({ useIconize: value });
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
        toggle.setValue(settings.statusBarIconsOnly === true).onChange(async (value) => {
          await this.deps.save({ statusBarIconsOnly: value });
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
          dropdown.setValue(value).onChange(async (next) => {
            const updated = [...slots];
            updated[index] = next;
            await this.deps.save({ statusBarMetrics: updated });
            this.display();
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
          .onChange(async (value) => {
            await this.deps.save({ filterMode: value });
          }),
      );

    new Setting(containerEl)
      .setName(t('filterPatterns'))
      .setDesc(t('filterPatternsDesc'))
      .addTextArea((text) => {
        text.inputEl.rows = 6;
        text
          .setValue(settings.filterPatterns)
          .onChange(async (value) => {
            await this.deps.save({ filterPatterns: value });
          });
      });

    // storage ─────────────────────────────────────────────────
    new Setting(containerEl)
      .setName(t('dataPath'))
      .setDesc(t('dataPathDesc'))
      .addText((text) =>
        text.setValue(settings.dataFilePath).onChange(async (value) => {
          await this.deps.save({ dataFilePath: value.trim() });
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

  //  ==========================================================================
  // countdown helpers / 倒计时的几行设置
  //  ==========================================================================

  /** 一个分钟数输入行 / one minutes field. */
  private minutesRow(
    container: HTMLElement,
    name: string,
    key: 'countdownMinutes' | 'countdownFocusMinutes' | 'countdownBreakMinutes',
    value: number,
    fallback: number,
  ): void {
    new Setting(container).setName(name).addText((text) =>
      text
        .setValue(String(clampMinutes(value, fallback)))
        .onChange(async (raw) => {
          const parsed = Number.parseInt(raw, 10);
          const patch: Partial<PluginSettings> = {};
          patch[key] = Number.isFinite(parsed) ? clampMinutes(parsed, fallback) : fallback;
          await this.deps.save(patch);
        }),
    );
  }

  /** 重复轮数 / the cycle count. */
  private cyclesRow(container: HTMLElement, cycles: number): void {
    new Setting(container).setName(t('countdownCycles')).addText((text) =>
      text.setValue(String(clampCycles(cycles))).onChange(async (raw) => {
        const parsed = Number.parseInt(raw, 10);
        await this.deps.save({
          countdownCycles: Number.isFinite(parsed) ? clampCycles(parsed) : 4,
        });
      }),
    );
  }

  /**
   * 不规则周期的分段列表 / the irregular phase list.
   *
   * 每行一个分钟数，右侧是"复制这一段"和"删除这一段"。复制就是用户说的"单周期复用"：把同一段
   * 再排一份在后面，而不是让运行时去循环。
   *
   * One minutes field per row, with "duplicate" and "delete" on the right. Duplicating is the
   * "reuse a single phase" affordance: lay the same phase down again rather than looping at runtime.
   */
  private intervalRows(container: HTMLElement, values: readonly number[]): void {
    const intervals = normalizeIntervals(values);
    const write = async (next: number[]): Promise<void> => {
      await this.deps.save({ countdownIntervals: next });
      this.display();
    };

    intervals.forEach((minutes, index) => {
      new Setting(container)
        .setName(t('countdownSegmentN').replace('{n}', String(index + 1)))
        .addText((text) =>
          text.setValue(String(minutes)).onChange(async (raw) => {
            const parsed = Number.parseInt(raw, 10);
            const next = [...intervals];
            next[index] = Number.isFinite(parsed) ? clampMinutes(parsed, 1) : minutes;
            await this.deps.save({ countdownIntervals: next });
          }),
        )
        .addExtraButton((button) =>
          button
            .setIcon('copy')
            .setTooltip(t('countdownIntervalCopy'))
            .onClick(() => {
              const next = [...intervals];
              next.splice(index + 1, 0, intervals[index] ?? 5);
              void write(next);
            }),
        )
        .addExtraButton((button) =>
          button
            .setIcon('trash-2')
            .setTooltip(t('countdownIntervalDelete'))
            .setDisabled(intervals.length <= 1)
            .onClick(() => {
              const next = [...intervals];
              next.splice(index, 1);
              void write(next);
            }),
        );
    });

    new Setting(container)
      .setName(t('countdownIntervalList'))
      .setDesc(t('countdownIntervalListDesc'))
      .addButton((button) =>
        button.setButtonText(t('countdownIntervalAdd')).onClick(() => {
          const next = [...intervals, intervals[intervals.length - 1] ?? 5];
          void write(next);
        }),
      );

  }
}
