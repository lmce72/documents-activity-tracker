/**
 * Note prompt for a manual session
 *
 * Shown when a manual session stops so the user can write what they did. A null callback
 * means the user cancelled (Esc, backdrop, or Discard) and nothing is persisted.
 *
 * The note may be empty: forcing it only produces filler typed to dismiss the dialog.
 */

import { App, Modal, Setting } from 'obsidian';

import { t } from '../core/i18n';

export class ManualNoteModal extends Modal {
  private note = '';
  private settled = false;

  constructor(
    app: App,
    private readonly onDone: (note: string | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(t('manualStopTitle'));
    this.contentEl.createEl('p', { text: t('manualStopDesc') });

    const input = this.contentEl.createEl('textarea', {
      cls: 'rtt-manual-note-input',
      attr: { rows: '3', placeholder: t('manualStopPlaceholder') },
    });
    input.addEventListener('input', () => {
      this.note = input.value;
    });
    // focus immediately to save a click
    window.setTimeout(() => input.focus(), 0);

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText(t('manualSaveSession')).setCta().onClick(() => {
          this.finish(this.note.trim());
        }),
      )
      .addButton((button) =>
        button.setButtonText(t('manualDiscard')).onClick(() => {
          this.finish(null);
        }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();

    //  Closing outright (Esc / backdrop) counts as a discard, so no session is left hanging
    this.finish(null);
  }

  /**
   * Settle exactly once.
   * `close()` re-enters `onClose()`, which `settled` guards; closing an already-closed
   * modal is a safe no-op.
   */
  private finish(note: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.onDone(note);
    this.close();
  }
}
