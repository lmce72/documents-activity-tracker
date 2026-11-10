import { setIcon, setTooltip } from 'obsidian';
import { t } from '../core/i18n';
import { flagIntervals } from '../core/manualTimeline';
import { buildManualProcess } from '../core/manualProcess';
import { formatDurationParts, formatDurationWithSeconds } from '../core/time';
import type { ManualFlag, ManualSession } from '../core/types';
import { appendDurationParts } from './durationText';
import { renderTimelineList, type TimelineNode } from './timelineList';

/**
 * 当前计时与历史详情共用同一张表 / shared table for live flags and recorded rounds.
 *
 * `onRemove` 只在**运行中**传入：打错的标记可以当场删掉；已经保存的一轮要走记录编辑，
 * 否则这张表就成了绕过保存校验的旁路。
 * `onRemove` is supplied only for a live run: a mistaken mark is dropped on the spot, while a
 * recorded round goes through record editing so this table cannot bypass its conflict checks.
 */
export function renderManualFlagsTable(
  parent: HTMLElement,
  flags: readonly ManualFlag[],
  onRemove?: (index: number) => void,
  onRename?: (index: number, label: string) => void,
): void {
  const columns = onRemove ? 4 : 3;
  const wrap = parent.createDiv({ cls: 'rtt-flag-table-wrap' });
  const table = wrap.createEl('table', { cls: 'rtt-flag-table' });
  table.setAttribute('aria-label', t('manualFlagsTitle'));
  const head = table.createEl('thead').createEl('tr');
  for (const title of [t('manualFlagColumn'), t('manualFlagDifference'), t('manualRecordedTime')]) head.createEl('th', { text: title, attr: { scope: 'col' } });
  if (onRemove) head.createEl('th', { cls: 'rtt-flag-actions-col', attr: { scope: 'col' } });
  const body = table.createEl('tbody');
  if (!flags.length) {
    body.createEl('tr').createEl('td', { text: t('manualNoFlags'), attr: { colspan: String(columns) } });
    return;
  }
  const intervals = flagIntervals(flags);
  flags.forEach((flag, index) => {
    const row = body.createEl('tr');
    const cell = row.createEl('td').createDiv({ cls: 'rtt-flag-cell' });
    setIcon(cell.createSpan({ cls: 'rtt-flag-icon' }), 'flag');
    cell.createSpan({ text: `Flag ${index + 1}` });
    const name = cell.createSpan({ cls: flag.label ? 'rtt-flag-label' : 'rtt-flag-label is-empty' });
    const paintName = (): void => {
      name.setText(flag.label ? ` · ${flag.label}` : ` · ${t('manualFlagUnnamed')}`);
      name.toggleClass('is-empty', !flag.label);
    };
    paintName();
    setTooltip(name, onRename ? t('manualFlagRenameHint') : flag.atTime);
    if (onRename) {
      name.addClass('is-editable');
      name.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        const input = cell.createEl('input', { cls: 'rtt-flag-name-input', type: 'text' });
        input.value = flag.label;
        input.setAttribute('aria-label', t('manualFlagName'));
        name.hidden = true;
        input.focus();
        input.select();
        let settled = false;
        const finish = (commit: boolean): void => {
          if (settled) return;
          settled = true;
          const next = input.value.trim();
          input.remove();
          name.hidden = false;
          name.setText(flag.label ? ` · ${flag.label}` : ` · ${t('manualFlagUnnamed')}`);
          if (commit && next !== flag.label) onRename(index, next);
        };
        input.addEventListener('keydown', (key) => {
          if (key.key === 'Enter') { key.preventDefault(); finish(true); }
          else if (key.key === 'Escape') { key.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('click', (click) => click.stopPropagation());
      });
    }
    appendDurationParts(row.createEl('td', { cls: 'rtt-dur' }), formatDurationParts(intervals[index] ?? 0));
    appendDurationParts(row.createEl('td', { cls: 'rtt-dur' }), formatDurationParts(flag.atSeconds));
    if (!onRemove) return;
    const actions = row.createEl('td', { cls: 'rtt-flag-actions' });
    const remove = actions.createEl('button', { cls: 'clickable-icon rtt-icon-btn is-danger', attr: { 'aria-label': t('manualRemoveFlag') } });
    setIcon(remove, 'x');
    setTooltip(remove, t('manualRemoveFlag'));
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      onRemove(index);
    });
  });
}

export function renderManualSessionDetail(
  parent: HTMLElement,
  session: ManualSession,
  onRenameFlag?: (index: number, label: string) => void,
): void {
  const header = parent.createDiv({ cls: 'rtt-manual-record-header' });
  header.createSpan({ cls: 'rtt-manual-record-name', text: session.note || t('noteLabel') });
  const toggle = header.createEl('button', { cls: 'rtt-nav-btn', text: t('manualCollapseFlags') });
  toggle.setAttribute('aria-expanded', 'true');
  const flags = parent.createDiv({ cls: 'rtt-manual-record-flags' });
  renderManualFlagsTable(flags, session.flags, undefined, onRenameFlag);
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
