import { setIcon, setTooltip } from 'obsidian';
import { t } from '../core/i18n';
import { flagIntervals } from '../core/manualTimeline';
import { buildManualProcess } from '../core/manualProcess';
import { formatDurationParts, formatDurationWithSeconds } from '../core/time';
import type { ManualFlag, ManualSession } from '../core/types';
import { appendDurationParts } from './durationText';
import { renderTimelineList, type TimelineNode } from './timelineList';

/** 当前计时与历史详情共用同一张表 / shared table for live flags and recorded rounds. */
export function renderManualFlagsTable(parent: HTMLElement, flags: readonly ManualFlag[]): void {
  const wrap = parent.createDiv({ cls: 'rtt-flag-table-wrap' });
  const table = wrap.createEl('table', { cls: 'rtt-flag-table' });
  table.setAttribute('aria-label', t('manualFlagsTitle'));
  const head = table.createEl('thead').createEl('tr');
  for (const title of [t('manualFlagColumn'), t('manualFlagDifference'), t('manualRecordedTime')]) head.createEl('th', { text: title, attr: { scope: 'col' } });
  const body = table.createEl('tbody');
  if (!flags.length) {
    body.createEl('tr').createEl('td', { text: t('manualNoFlags'), attr: { colspan: '3' } });
    return;
  }
  const intervals = flagIntervals(flags);
  flags.forEach((flag, index) => {
    const row = body.createEl('tr');
    const cell = row.createEl('td').createDiv({ cls: 'rtt-flag-cell' });
    setIcon(cell.createSpan({ cls: 'rtt-flag-icon' }), 'flag');
    cell.createSpan({ text: `Flag ${index + 1}${flag.label ? ` · ${flag.label}` : ''}` });
    setTooltip(cell, flag.atTime);
    appendDurationParts(row.createEl('td', { cls: 'rtt-dur' }), formatDurationParts(intervals[index] ?? 0));
    appendDurationParts(row.createEl('td', { cls: 'rtt-dur' }), formatDurationParts(flag.atSeconds));
  });
}

export function renderManualSessionDetail(parent: HTMLElement, session: ManualSession): void {
  const header = parent.createDiv({ cls: 'rtt-manual-record-header' });
  header.createSpan({ cls: 'rtt-manual-record-name', text: session.note || t('noteLabel') });
  const toggle = header.createEl('button', { cls: 'rtt-nav-btn', text: t('manualCollapseFlags') });
  toggle.setAttribute('aria-expanded', 'true');
  const flags = parent.createDiv({ cls: 'rtt-manual-record-flags' });
  renderManualFlagsTable(flags, session.flags);
  toggle.addEventListener('click', () => {
    flags.hidden = !flags.hidden;
    toggle.setAttribute('aria-expanded', String(!flags.hidden));
    toggle.setText(t(flags.hidden ? 'manualExpandFlags' : 'manualCollapseFlags'));
  });
  renderTimelineList(parent, [{ icon: 'timer', kind: 'manual', title: `${session.startTime.slice(11)} – ${session.endTime.slice(11)}`,
    lines: [`${t('manualRecordedTime')} ${formatDurationWithSeconds(session.durationSeconds)}`] }]);
  const icons = { start: 'play', pause: 'pause', resume: 'play', flag: 'flag', stop: 'square' };
  const titles = { start: t('evStart'), pause: t('evPause'), resume: t('evResume'), flag: t('manualFlag'), stop: t('manualStopRecorded') };
  const nodes: TimelineNode[] = buildManualProcess(session).filter((step) => step.kind !== 'resume').map((step) => {
    if (step.kind === 'pause') return {
      icon: 'pause', kind: 'pause',
      title: `${t('evPause')} (${step.time.slice(11)}-${(step.endTime ?? step.time).slice(11)}) · ${formatDurationWithSeconds(step.durationSeconds ?? 0)}`,
    };
    return {
    icon: icons[step.kind], kind: step.kind === 'flag' ? 'flag' : 'manual',
    title: step.kind === 'flag' ? `Flag ${step.flagIndex}${step.label ? ` · ${step.label}` : ''}` : titles[step.kind],
    lines: [step.kind === 'flag'
      ? (step.activeRanges?.map((range) => `(${range.from.slice(11)}-${range.to.slice(11)})`).join(' · ') || '—')
      : step.time.slice(11),
      `${t(step.kind === 'flag' ? 'manualAtRecorded' : 'manualRecordedTime')} ${formatDurationWithSeconds(step.recordedSeconds)}`,
      ...(step.intervalSeconds === undefined ? [] : [`${t('manualFlagRoundTime')} ${formatDurationWithSeconds(step.intervalSeconds)}`])],
    };
  });
  renderTimelineList(parent.createDiv({ cls: 'rtt-manual-process' }), nodes);
}
