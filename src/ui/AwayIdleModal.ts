import { Modal, Setting, setIcon, type App } from 'obsidian';
import { t } from '../core/i18n';
import { attributionPolicy } from '../core/settings';
import { formatDurationWithSeconds } from '../core/time';
import { listIdleIntervals, listUnfocusedIntervals } from '../core/unfocused';
import type { AttributionPolicy, PluginSettings } from '../core/types';
import type { HistoryStore } from '../data/historyStore';
import type { TimerService } from '../services/TimerService';
import type { Logger } from '../core/logger';

interface AwayIdleDeps {
  settings: () => PluginSettings;
  saveSetting: (patch: Partial<PluginSettings>) => Promise<void>;
  history: HistoryStore;
  service: TimerService;
  log: Logger;
  onChanged: () => void;
}
export class AwayIdleModal extends Modal {
  private awayExpanded = false;
  constructor(app: App, private readonly deps: AwayIdleDeps, private readonly day: string) { super(app); }
  override onOpen(): void { this.titleEl.setText(t('awaySectionTitle')); this.render(); }
  override onClose(): void { this.contentEl.empty(); }
  private render(): void {
    this.contentEl.empty();
    const root = this.contentEl;
    const section = root.createDiv({ cls: 'rtt-heatmap-wrap' });

    const settings = this.deps.settings();
    const policy = attributionPolicy(settings);

    new Setting(section)
      .setName(t('awayPolicyLabel'))
      .setDesc(t('awayPolicyDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('reading', t('policyReading'))
          .addOption('paused', t('policyPaused'))
          .addOption('ignored', t('policyIgnored'))
          .setValue(policy.away)
          .onChange((value) => {
            void this.deps
              .saveSetting({ awayPolicy: value as AttributionPolicy })
              .then(() => { this.deps.onChanged(); this.render(); })
              .catch((error: unknown) => { this.deps.log.warn('[RTT] Policy update failed:', error); this.render(); });
          }),
      );

    new Setting(section)
      .setName(t('idlePolicyLabel'))
      .setDesc(t('idlePolicyDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('reading', t('policyReading'))
          .addOption('paused', t('policyPaused'))
          .addOption('ignored', t('policyIgnored'))
          .setValue(policy.idle)
          .onChange((value) => {
            void this.deps
              .saveSetting({ idlePolicy: value as AttributionPolicy })
              .then(() => { this.deps.onChanged(); this.render(); })
              .catch((error: unknown) => { this.deps.log.warn('[RTT] Policy update failed:', error); this.render(); });
          }),
      );

    const today = this.day;
    const intervals = listUnfocusedIntervals(this.deps.history.getEvents())
      .filter((item) => item.from.slice(0, 10) === today)
      .slice()
      .reverse();

    const idleIntervals = listIdleIntervals(this.deps.history.getEvents())
      .filter((item) => item.from.slice(0, 10) === today)
      .reverse();

    if (intervals.length === 0 && idleIntervals.length === 0) {
      section.createDiv({ cls: 'rtt-list-empty', text: t('awayTodayEmpty') });
      return;
    }

    const shownAway = this.awayExpanded ? intervals : intervals.slice(0, 3);
    for (const interval of shownAway) {
      const closed = interval.to !== null;
      const editable = closed && this.deps.service.canClassifyUnfocused(interval.filePath, interval.from);
      const name = interval.filePath.split('/').pop() ?? interval.filePath;

      //  旧数据里每个 blur 都写着 'unfocused'（未归类），显示成当前口径才与实际记账一致；
      //  选「不记录」写入的是新值 'ignored'，两者不能混为一谈
      //  Older data wrote 'unfocused' on every blur (unclassified); showing the policy is what the
      //  accounting actually does. Choosing "do not record" writes the new 'ignored' value.
      const shownDisposition = interval.disposition === 'unfocused' ? policy.away : interval.disposition;

      const row = new Setting(section)
        .setName(
          `${interval.from.slice(11)} – ${closed ? interval.to!.slice(11) : '…'}`,
        )
        .setDesc(`${name} · ${formatDurationWithSeconds(interval.seconds)}`);

      row.addDropdown((dropdown) =>
        dropdown
          .addOption('reading', t('policyReading'))
          .addOption('paused', t('policyPaused'))
          .addOption('ignored', t('policyIgnored'))
          .setValue(shownDisposition)
          .setDisabled(!editable)
          .onChange((value) => {
            dropdown.setDisabled(true);
            void this.deps.service
              .classifyUnfocused(interval.index, interval.from, value as 'reading' | 'paused' | 'ignored')
              .then(() => { this.deps.onChanged(); this.render(); })
              .catch((error: unknown) => {
                this.deps.log.warn('[RTT] 失焦归类失败 / classification failed:', error);
                this.render();
              });
          }),
      );
    }

    //  空闲时段并列在这张表里：同一种"没在读"，两种来源，分成两处看等于没统一
    //  Idle stretches sit in the same list: two sources of the same "not reading", and splitting
    //  them across two places would defeat the point of one entry.
    if (idleIntervals.length > 0) {
      section.createDiv({ cls: 'rtt-live-line is-muted', text: t('awayIdleHint') });

      const shownIdle = this.awayExpanded ? idleIntervals : idleIntervals.slice(0, 3);
      for (const idle of shownIdle) {
        const name = idle.filePath.split('/').pop() ?? idle.filePath;
        new Setting(section)
          .setName(
            `${t('awayKindIdle')} · ${idle.from.slice(11)} – ${idle.to ? idle.to.slice(11) : '…'}`,
          )
          .setDesc(`${name} · ${formatDurationWithSeconds(idle.seconds)}`);
      }
    }

    //  默认只摆三段：手机上一天能积十几段，全摊开会把热力图挤出屏幕
    //  Three rows by default: a day can accumulate a dozen stretches, and on a phone the heatmap would
    //  be pushed off the screen.
    if (intervals.length + idleIntervals.length <= 3) return;

    const more = section.createEl('button', { cls: 'rtt-view-all-btn' });
    setIcon(
      more.createSpan({ cls: 'rtt-view-all-icon' }),
      this.awayExpanded ? 'chevron-up' : 'chevron-down',
    );
    more.createSpan({
      cls: 'rtt-view-all-label',
      text: this.awayExpanded ? t('manualShowLess') : t('manualShowMore'),
    });
    more.addEventListener('click', () => {
      this.awayExpanded = !this.awayExpanded;
      this.render();
    });
  }

}
