/**
 * Ambient globals provided by the Obsidian runtime
 *
 * Obsidian injects a few globals into the renderer process that the official
 * obsidian.d.ts does not cover. Declaring them here keeps `as any` out of
 * business code.
 */

export {};

declare global {
  interface Window {
    /**
     * The moment instance bundled with Obsidian.
     */
    moment?: {
      locale(): string;
    };
  }

  /**
   * DOM helpers injected by Obsidian.
   */
  function createDiv(options?: string | DomElementInfo): HTMLDivElement;
  function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: string | DomElementInfo,
  ): HTMLElementTagNameMap[K];
  function createSpan(options?: string | DomElementInfo): HTMLSpanElement;
}
