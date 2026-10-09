/**
 * Settings tab
 *
 *      The two write-only legacy knobs (autoSaveInterval / trackingMode) are no longer
 *      shown: a control on screen must actually be wired to something.
 *
 */

import { PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';

import { t } from '../core/i18n';
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
      .setName(t('todayTotalDisplay'))
      .setDesc(t('todayTotalDisplayDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('idle', t('todayTotalIdle'))
          .addOption('always', t('todayTotalAlways'))
          .addOption('never', t('todayTotalNever'))
          .setValue(settings.todayTotalDisplay)
          .onChange(async (value) => {
            await this.deps.save({ todayTotalDisplay: value });
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
}
