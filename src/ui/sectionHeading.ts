import { setIcon } from 'obsidian';

/**
 * 小节标题：图标 + 文字 / a section heading with a leading mark.
 *
 * 原生 `Setting().setHeading()` 会给标题文字留一段内边距，而标题下面的内容是从左边缘开始的，
 * 两者永远错开一截。这里自己画：标题与内容同一条左边线，并让每个小节都有同样的图标节奏。
 *
 * Native `Setting().setHeading()` indents the heading text while the content below starts at the
 * left edge, so the two never line up. Drawing it here keeps one left edge for heading and body,
 * and gives every section the same icon-plus-label rhythm.
 */
export function renderSectionHeading(parent: HTMLElement, icon: string, text: string): HTMLElement {
  const heading = parent.createDiv({ cls: 'rtt-section-heading' });
  setIcon(heading.createSpan({ cls: 'rtt-section-heading-icon' }), icon);
  heading.createSpan({ cls: 'rtt-section-heading-label', text });
  return heading;
}
