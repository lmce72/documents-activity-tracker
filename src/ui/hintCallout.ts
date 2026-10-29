import { setIcon } from 'obsidian';
import { t } from '../core/i18n';

/** Native theme callout styling, with a keyboard-accessible collapsed disclosure. */
export function renderHint(parent: HTMLElement, text: string): void {
  const callout = parent.createEl('details', { cls: 'callout is-collapsible is-collapsed rtt-hint-callout', attr: { 'data-callout': 'note', 'data-callout-fold': '-' } });
  const title = callout.createEl('summary', { cls: 'callout-title' });
  setIcon(title.createSpan({ cls: 'callout-icon' }), 'info');
  title.createSpan({ cls: 'callout-title-inner', text: t('hintTitle') });
  setIcon(title.createSpan({ cls: 'callout-fold' }), 'chevron-down');
  callout.createDiv({ cls: 'callout-content', text: text.replace(/\*\*/g, '') });
  callout.addEventListener('toggle', () => callout.toggleClass('is-collapsed', !callout.open));
}
