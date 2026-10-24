/**
 * 单行文字输入弹窗 / a one-line text prompt.
 *
 * 改名与改备注都只要一句话，用一个通用的输入框而不是每处各写一个弹窗：两处的确定/取消语义、
 * 空值与取消的区分完全一样，分开写迟早各漏一边。
 *
 * Renaming and editing a note both need a single sentence, so they share one prompt instead of a dialog
 * per caller: the confirm/cancel semantics and the empty-versus-cancelled distinction are identical, and
 * two copies would eventually disagree.
 */

import { App, Modal, Setting } from 'obsidian';

import { t } from '../core/i18n';

export interface TextPromptOptions {
  title: string;
  /** 说明文字，画在输入框上方 / explanatory line above the field */
  description?: string;
  placeholder?: string;
  /** 初始值 / the starting value */
  initial?: string;
  /**
   * 结果：字符串（可能为空）或 null（取消）。
   * 空串是"清空"，null 是"什么都没做" —— 调用方要能区分这两者。
   * The result: a string (possibly empty) or null for cancel. An empty string means "clear it"; null
   * means nothing happened, and callers must be able to tell them apart.
   */
  onDone: (value: string | null) => void;
}

export class TextPromptModal extends Modal {
  private value: string;
  private settled = false;

  constructor(app: App, private readonly options: TextPromptOptions) {
    super(app);
    this.value = options.initial ?? '';
  }

  override onOpen(): void {
    this.titleEl.setText(this.options.title);

    if (this.options.description) {
      this.contentEl.createEl('p', { text: this.options.description });
    }

    const input = this.contentEl.createEl('input', {
      type: 'text',
      cls: 'rtt-text-prompt-input',
      attr: {
        ...(this.options.placeholder ? { placeholder: this.options.placeholder } : {}),
      },
    });
    input.value = this.value;

    input.addEventListener('input', () => {
      this.value = input.value;
    });

    //  Enter 提交：这是一个单行输入，回车就是"确定"
    //  Enter submits: it is a one-line field, and Enter means "done"
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.finish(this.value);
      }
    });

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);

    const bar = this.contentEl.createDiv({ cls: 'rtt-confirm-bar' });
    new Setting(bar)
      .addButton((button) =>
        button.setButtonText(t('save')).setCta().onClick(() => {
          this.finish(this.value);
        }),
      )
      .addButton((button) =>
        button.setButtonText(t('cancel')).onClick(() => {
          this.finish(null);
        }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
    this.finish(null);
  }

  private finish(value: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.options.onDone(value);
    this.close();
  }
}
