import { TextComponent, setIcon, setTooltip } from 'obsidian';
import { t } from '../core/i18n';

export interface RecordTimeField {
  label: string;
  read: () => string;
  write: (timestamp: string) => void;
}

/** Time controls edit the clock while retaining the separately editable date. */
export function renderTimeInput(parent: HTMLElement, field: RecordTimeField): void {
  const input = new TextComponent(parent);
  input.inputEl.type = 'time';
  input.inputEl.step = '1';
  input.inputEl.addClass('rtt-edit-clock-input');
  input.inputEl.setAttribute('aria-label', field.label);
  input.setValue(field.read().slice(11, 19)).onChange(value => {
    const clock = value.length === 5 ? value + ':00' : value;
    field.write(field.read().slice(0, 10) + ' ' + clock);
  });
}

/** Dates stay available for cross-midnight records without crowding the clock row. */
export function renderDateFields(parent: HTMLElement, fields: readonly RecordTimeField[]): void {
  const details = parent.createEl('details', { cls: 'rtt-edit-dates' });
  const summary = details.createEl('summary');
  setIcon(summary.createSpan({ cls: 'rtt-edit-date-icon' }), 'calendar-days');
  summary.createSpan({ text: t('editDay') });
  const update = (): void => setTooltip(summary, [...new Set(fields.map(field => field.read().slice(0, 10)))].join(' ~ '));
  update();
  const grid = details.createDiv({ cls: 'rtt-edit-date-grid' });
  for (const field of fields) {
    const cell = grid.createEl('label', { cls: 'rtt-edit-field' });
    cell.createSpan({ text: field.label });
    const input = new TextComponent(cell);
    input.inputEl.type = 'date';
    input.inputEl.setAttribute('aria-label', field.label + ' · ' + t('editDay'));
    input.setValue(field.read().slice(0, 10)).onChange(value => {
      field.write(value + ' ' + field.read().slice(11, 19)); update();
    });
  }
}

export function renderTimeRange(parent: HTMLElement, start: RecordTimeField, end: RecordTimeField, showLabels = true): void {
  const range = parent.createDiv({ cls: 'rtt-edit-time-range' });
  for (const [index, field] of [start, end].entries()) {
    if (index === 1) range.createSpan({ cls: 'rtt-edit-range-sep', text: '~', attr: { 'aria-hidden': 'true' } });
    const cell = range.createEl('label', { cls: 'rtt-edit-field' });
    if (showLabels) cell.createSpan({ text: index === 0 ? t('editStartShort') : t('editEndShort') });
    renderTimeInput(cell, field);
  }
  renderDateFields(parent, [start, end]);
}
