import { ButtonComponent, Modal, Notice, Setting, type App } from 'obsidian';
import {
  clampCycles,
  clampMinutes,
  normalizeIntervals,
  normalizeMode,
} from '../core/countdown';
import { t } from '../core/i18n';
import type { CountdownMode, PluginSettings } from '../core/types';

export interface CountdownPlanModalOptions {
  settings: PluginSettings;
  save: (patch: Partial<PluginSettings>) => Promise<void>;
  onSaved?: () => void;
}

/**
 * 倒计时流程编辑器 / the countdown plan editor.
 *
 * 侧栏与设置页共用这一处：两处各写一份表单，迟早会漏掉某个模式或某个夹取规则。
 * 编辑的是**下一次**运行的方案；当前一轮在开始时已经冻结，不会被这里改动。
 *
 * One editor for both the panel and the settings tab: two hand-written forms would eventually
 * disagree about a mode or a clamp. It edits the **next** run; the current plan is frozen at start.
 */
export class CountdownPlanModal extends Modal {
  private mode: CountdownMode;
  private downMinutes: number;
  private focusMinutes: number;
  private breakMinutes: number;
  private repeat: boolean;
  private cycles: number;
  private intervals: number[];
  private saving = false;

  constructor(app: App, private readonly options: CountdownPlanModalOptions) {
    super(app);
    const settings = options.settings;
    this.mode = normalizeMode(settings.countdownMode);
    this.downMinutes = clampMinutes(settings.countdownMinutes, 25);
    this.focusMinutes = clampMinutes(settings.countdownFocusMinutes, 25);
    this.breakMinutes = clampMinutes(settings.countdownBreakMinutes, 5);
    this.repeat = settings.countdownRepeat === true;
    this.cycles = clampCycles(settings.countdownCycles);
    this.intervals = normalizeIntervals(settings.countdownIntervals);
  }

  override onOpen(): void {
    this.modalEl.addClass('rtt-plan-editor');
    this.titleEl.setText(t('countdownPlanEditorTitle'));
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();

    new Setting(root)
      .setName(t('countdownModeSetting'))
      .setDesc(t('countdownModeSwitchNextRun'))
      .addDropdown(dropdown => dropdown
        .addOption('down', t('countdownModeDown'))
        .addOption('pomodoro', t('countdownModePomodoro'))
        .addOption('interval', t('countdownModeInterval'))
        .setValue(this.mode)
        .onChange(value => { this.mode = normalizeMode(value); this.render(); }));

    if (this.mode === 'down') {
      this.minutesField(root, t('countdownMinutes'), () => this.downMinutes, value => { this.downMinutes = value; });
    } else if (this.mode === 'pomodoro') {
      this.minutesField(root, t('countdownFocusMinutes'), () => this.focusMinutes, value => { this.focusMinutes = value; });
      this.minutesField(root, t('countdownBreakMinutes'), () => this.breakMinutes, value => { this.breakMinutes = value; });
      new Setting(root)
        .setName(t('countdownRepeat'))
        .setDesc(t('countdownRepeatDesc'))
        .addToggle(toggle => toggle
          .setValue(this.repeat)
          .onChange(value => { this.repeat = value; this.render(); }));
      if (this.repeat) {
        new Setting(root)
          .setName(t('countdownCycles'))
          .addText(text => {
            text.inputEl.type = 'number';
            text.inputEl.min = '1';
            text.setValue(String(this.cycles)).onChange(raw => {
              const parsed = Number.parseInt(raw, 10);
              if (Number.isFinite(parsed)) this.cycles = clampCycles(parsed);
            });
          });
      }
    } else {
      this.renderPhases(root);
    }

    const error = root.createDiv({ cls: 'rtt-edit-error', attr: { role: 'alert', 'aria-live': 'polite' } });
    const actions = root.createDiv({ cls: 'rtt-modal-actions' });
    new ButtonComponent(actions).setButtonText(t('editCancel')).onClick(() => { if (!this.saving) this.close(); });
    const save = new ButtonComponent(actions).setButtonText(t('editSave')).setCta();
    save.onClick(() => {
      if (this.saving) return;
      this.saving = true;
      save.setDisabled(true);
      error.empty();
      void this.options.save({
        countdownMode: this.mode,
        countdownMinutes: clampMinutes(this.downMinutes, 25),
        countdownFocusMinutes: clampMinutes(this.focusMinutes, 25),
        countdownBreakMinutes: clampMinutes(this.breakMinutes, 5),
        countdownRepeat: this.repeat,
        countdownCycles: clampCycles(this.cycles),
        countdownIntervals: normalizeIntervals(this.intervals),
      }).then(() => {
        this.options.onSaved?.();
        this.close();
      }).catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (this.contentEl.isConnected) error.setText(message);
        else new Notice(message);
      }).finally(() => {
        this.saving = false;
        save.setDisabled(false);
      });
    });
  }

  private minutesField(
    parent: HTMLElement,
    name: string,
    read: () => number,
    write: (value: number) => void,
  ): void {
    new Setting(parent).setName(name).addText(text => {
      text.inputEl.type = 'number';
      text.inputEl.min = '1';
      text.setValue(String(read())).onChange(raw => {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) write(clampMinutes(parsed, 1));
      });
    });
  }

  private renderPhases(root: HTMLElement): void {
    const list = root.createDiv({ cls: 'rtt-plan-phases' });
    this.intervals.forEach((minutes, index) => {
      new Setting(list)
        .setName(t('countdownSegmentN').replace('{n}', String(index + 1)))
        .addText(text => {
          text.inputEl.type = 'number';
          text.inputEl.min = '1';
          text.setValue(String(minutes)).onChange(raw => {
            const parsed = Number.parseInt(raw, 10);
            if (Number.isFinite(parsed)) this.intervals[index] = clampMinutes(parsed, 1);
          });
        })
        .addExtraButton(button => button
          .setIcon('copy')
          .setTooltip(t('countdownIntervalCopy'))
          .onClick(() => {
            this.intervals.splice(index + 1, 0, this.intervals[index] ?? 5);
            this.render();
          }))
        .addExtraButton(button => button
          .setIcon('trash-2')
          .setTooltip(t('countdownIntervalDelete'))
          .setDisabled(this.intervals.length <= 1)
          .onClick(() => {
            this.intervals.splice(index, 1);
            this.render();
          }));
    });
    new Setting(list).addButton(button => button
      .setButtonText(t('countdownIntervalAdd'))
      .onClick(() => {
        this.intervals.push(this.intervals[this.intervals.length - 1] ?? 5);
        this.render();
      }));
  }
}
