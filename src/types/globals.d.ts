/**
 * 全局环境声明 / Ambient globals provided by the Obsidian runtime
 *
 * Obsidian 在渲染进程中注入了一些全局符号，官方 obsidian.d.ts 未覆盖，
 * 在此集中声明，避免在业务代码里散落 `as any`。
 *
 * Obsidian injects a few globals into the renderer process that the official
 * obsidian.d.ts does not cover. Declaring them here keeps `as any` out of
 * business code.
 */

export {};

declare global {
  interface Window {
    /**
     * Obsidian 内置的 moment 实例 / The moment instance bundled with Obsidian.
     * 用于读取当前 UI 语言（core/i18n.getLang 依赖它）。
     */
    moment?: {
      locale(): string;
    };
  }

  /**
   * Obsidian 注入的 DOM 便捷函数 / DOM helpers injected by Obsidian.
   * 等价于 `document.createElement('div')`，但更简洁。
   */
  function createDiv(options?: string | DomElementInfo): HTMLDivElement;
  function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: string | DomElementInfo,
  ): HTMLElementTagNameMap[K];
  function createSpan(options?: string | DomElementInfo): HTMLSpanElement;
}
