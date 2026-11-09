import { ButtonComponent, Modal, Notice, Setting, TextComponent, type App } from 'obsidian';
import type { RecordEditDraft, SessionEditDraft } from '../core/recordEditing';
import { t } from '../core/i18n';
import { renderDateFields, renderTimeInput, renderTimeRange, type RecordTimeField } from './recordTimeFields';

export interface RecordEditModalOptions {
  draft: RecordEditDraft;
  save: (draft: RecordEditDraft) => Promise<void>;
  onSaved: () => void;
}

/** One editor for a whole round or an individual reading interval. */
export class RecordEditModal extends Modal {
  private readonly draft: RecordEditDraft;
  private saving = false;
  private opened = false;
  constructor(app: App, private readonly options: RecordEditModalOptions) {
    super(app);
    const draft = options.draft;
    this.draft = 'flags' in draft ? { ...draft, pauses: draft.pauses.map(pause => ({ ...pause })), flags: draft.flags.map(flag => ({ ...flag })) } : { ...draft };
  }
  override onOpen(): void {
    this.opened = true;
    this.modalEl.addClass('rtt-record-edit-modal');
    this.titleEl.setText(t('editRecord'));
    const root = this.contentEl;
    const name = new TextComponent(root).setValue(this.draft.note).setPlaceholder(t('editNoteName')).onChange(value => { this.draft.note = value; });
    name.inputEl.addClass('rtt-edit-name');
    name.inputEl.setAttribute('aria-label', t('editNoteName'));
    renderTimeRange(root,
      { label: t('editStart'), read: () => this.draft.startTime, write: value => { this.draft.startTime = value; } },
      { label: t('editEnd'), read: () => this.draft.endTime, write: value => { this.draft.endTime = value; } });
    if ('flags' in this.draft) this.roundFields(root, this.draft);
    else {
      const draft = this.draft;
      new Setting(root).setName(t('editAttribution')).addDropdown(input => input
        .addOptions({ preserve: t('editPreserve'), reading: t('policyReading'), paused: t('policyPaused'), ignored: t('policyIgnored') })
        .setValue(draft.disposition).onChange(value => {
          if (value === 'preserve' || value === 'reading' || value === 'paused' || value === 'ignored') draft.disposition = value;
        }));
    }
    const error = root.createDiv({ cls: 'rtt-edit-error', attr: { role: 'alert', 'aria-live': 'polite' } });
    const actions = root.createDiv({ cls: 'rtt-modal-actions' });
    new ButtonComponent(actions).setButtonText(t('editCancel')).onClick(() => { if (!this.saving) this.close(); });
    const save = new ButtonComponent(actions).setButtonText(t('editSave')).setCta();
    save.onClick(() => {
      if (this.saving) return;
      this.saving = true; save.setDisabled(true); error.empty();
      void this.options.save(this.draft).then(() => { this.options.onSaved(); this.close(); }).catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : t('editSaveFailed');
        if (this.opened) error.setText(message);
        else new Notice(message);
      }).finally(() => { this.saving = false; save.setDisabled(false); });
    });
  }
  override onClose(): void { this.opened = false; this.contentEl.empty(); }
  private removeButton(parent: HTMLElement, remove: () => void): void {
    const button = new ButtonComponent(parent).setIcon('trash-2').setTooltip(t('editRemove')).onClick(remove);
    button.buttonEl.addClass('clickable-icon', 'rtt-edit-remove');
  }
  private roundFields(root: HTMLElement, draft: SessionEditDraft): void {
    const pauses = root.createDiv({ cls: 'rtt-edit-section' });
    const pauseHead = pauses.createDiv({ cls: 'rtt-edit-section-head' });
    new Setting(pauseHead).setName(t('editPauses')).setHeading();
    const pauseList = pauses.createDiv();
    const renderPauses = (): void => {
      pauseList.empty();
      draft.pauses.forEach((pause, index) => {
        const row = pauseList.createDiv({ cls: 'rtt-edit-pause-row' });
        const times = row.createDiv({ cls: 'rtt-edit-pause-times' });
        renderTimeRange(times,
          { label: t('editPauseStart'), read: () => pause.from, write: value => { pause.from = value; } },
          { label: t('editPauseEnd'), read: () => pause.to, write: value => { pause.to = value; } }, index === 0);
        this.removeButton(row, () => { draft.pauses.splice(index, 1); renderPauses(); });
      });
    };
    new ButtonComponent(pauseHead).setIcon('plus').setTooltip(t('editAddPause')).onClick(() => { draft.pauses.push({ from: draft.startTime, to: draft.endTime }); renderPauses(); });
    renderPauses();
    const flags = root.createDiv({ cls: 'rtt-edit-section' });
    const flagHead = flags.createDiv({ cls: 'rtt-edit-section-head' });
    new Setting(flagHead).setName(t('manualFlagsTitle')).setHeading();
    const flagList = flags.createDiv();
    const renderFlags = (): void => {
      flagList.empty();
      draft.flags.forEach((flag, index) => {
        const row = flagList.createDiv({ cls: 'rtt-edit-flag-row' });
        row.createSpan({ cls: 'rtt-edit-flag-number', text: String(index + 1) });
        const time = row.createDiv({ cls: 'rtt-edit-flag-clock' });
        const field: RecordTimeField = { label: t('editFlagTime'), read: () => flag.atTime, write: value => { flag.atTime = value; } };
        renderTimeInput(time, field); renderDateFields(time, [field]);
        const label = new TextComponent(row).setValue(flag.label).onChange(value => { flag.label = value; });
        label.inputEl.setAttribute('aria-label', t('editNote')); label.setPlaceholder(t('editNote'));
        this.removeButton(row, () => { draft.flags.splice(index, 1); renderFlags(); });
      });
    };
    new ButtonComponent(flagHead).setIcon('plus').setTooltip(t('editAddFlag')).onClick(() => { draft.flags.push({ atTime: draft.startTime, label: '' }); renderFlags(); });
    renderFlags();
  }
}
