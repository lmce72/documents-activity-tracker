/**
 * A yes/no dialog / 确认弹窗
 *
 * Obsidian's public API has no confirm modal, and `window.confirm` blocks the renderer — the
 * one place this plugin must not do that is mid-session, with a timer running. This is the
 * small replacement.
 *
 * 保存记录、丢弃会话这类"不可撤销"的动作都要先过它一次。
 */

import { Modal, Setting, type App } from 'obsidian';

export interface ConfirmModalOptions {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  /** Runs only when the user confirms. */
  onConfirm: () => void;
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly options: ConfirmModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.options.title);

    this.contentEl.createEl('p', { text: this.options.message });

    // 取消在左、确认在右，与 Obsidian 自身的弹窗一致
    // Cancel left, confirm right, matching Obsidian's own dialogs.
    const bar = this.contentEl.createDiv({ cls: 'rtt-confirm-bar' });

    const cancel = new Setting(bar).addButton((button) =>
      button.setButtonText(this.options.cancelText).onClick(() => this.close()),
    );
    void cancel;

    new Setting(bar).addButton((button) =>
      button
        .setButtonText(this.options.confirmText)
        .setCta()
        .onClick(() => {
          this.close();
          this.options.onConfirm();
        }),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
