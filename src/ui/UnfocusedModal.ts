import { Modal, Notice, Setting, type App } from 'obsidian';
import { t } from '../core/i18n';
import { listUnfocusedIntervals, type UnfocusedDisposition } from '../core/unfocused';
import { formatDurationWithSeconds } from '../core/time';
import type { Logger } from '../core/logger';
import type { HistoryStore } from '../data/historyStore';
import type { TimerService } from '../services/TimerService';

interface UnfocusedModalDeps {
  history: HistoryStore;
  service: TimerService;
  log: Logger;
  filePath: string;
  day?: string;
  onChanged: () => void;
}

/** 当前卡片与历史记录共用入口 / shared by the live card and records browser. */
export class UnfocusedModal extends Modal {
  constructor(app: App, private readonly deps: UnfocusedModalDeps) { super(app); }
  override onOpen(): void { this.render(); }
  private render(): void {
    this.contentEl.empty();
    new Setting(this.contentEl).setName(t('unfocusedManage')).setHeading();
    const intervals = listUnfocusedIntervals(this.deps.history.getEvents()).filter((item) =>
      item.filePath === this.deps.filePath && (!this.deps.day || item.from.slice(0, 10) <= this.deps.day && (!item.to || item.to.slice(0, 10) >= this.deps.day)));
    if (!intervals.length) this.contentEl.createDiv({ text: t('unfocusedEmpty') });
    for (const interval of intervals.slice().reverse()) {
      const editable = this.deps.service.canClassifyUnfocused(interval.filePath, interval.from);
      const row = new Setting(this.contentEl)
        .setName(`${interval.from} – ${interval.to ?? '…'}`)
        .setDesc(!interval.to ? t('unfocusedOpen') : !editable ? t('unfocusedPausePending') : formatDurationWithSeconds(interval.seconds));
      row.addDropdown((dropdown) => dropdown
        .addOption('unfocused', t('unfocusedKeep'))
        .addOption('reading', t('unfocusedReading'))
        .addOption('paused', t('unfocusedPaused'))
        .setValue(interval.disposition)
        .setDisabled(!interval.to || !editable)
        .onChange(async (value) => {
          dropdown.setDisabled(true);
          try {
            await this.deps.service.classifyUnfocused(interval.index, interval.from, value as UnfocusedDisposition);
            this.deps.onChanged();
            this.render();
          } catch (error) {
            this.deps.log.warn('[RTT] 失焦归类失败 / classification failed:', error);
            new Notice(String(error));
            dropdown.setValue(interval.disposition).setDisabled(false);
          }
        }));
    }
  }
}
