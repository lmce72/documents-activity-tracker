/**
 * Duration rendering / 时长渲染
 *
 * A duration reads as one thought but is two kinds of thing: the figure is what the user is
 * looking for, and the unit is only there to qualify it. Rendering them at the same weight
 * makes every number feel equally loud. So the number keeps whatever emphasis its container
 * gives it (accent colour in a stat card, error colour in a warning) and the unit is drawn
 * smaller and muted.
 *
 * Both forms come from `core/time`'s part-based formatters, so there is exactly one place
 * that decides how a duration is spelled.
 */

import { setTooltip } from 'obsidian';

import {
  formatDurationParts,
  formatDurationWithSeconds,
  formatReadTimeParts,
  type DurationPart,
} from '../core/time';

/**
 * 悬浮显示精确到秒的时长 / hover shows the exact time, to the second.
 *
 * 卡片上写的是"2 小时 20 分钟"，用户想知道确切秒数时就悬停一下。只在秒数真的变化时才写 ——
 * 这些元素每秒都会重画，每次都改 aria-label 会在提示管理器里反复登记同一条。
 *
 * The card reads "2 小时 20 分钟"; hovering answers "exactly how long". Written only when the
 * seconds actually change: these elements are rebuilt every second, and rewriting the
 * aria-label each time would re-register the same entry in the tooltip manager.
 */
function applyPreciseTooltip(el: HTMLElement, seconds: number): void {
  const rounded = Math.round(seconds);
  if (el.dataset.rttPrecise === String(rounded)) return;
  el.dataset.rttPrecise = String(rounded);

  const precise = formatDurationWithSeconds(rounded);
  setTooltip(el, precise);
  el.setAttribute('aria-label', precise);
}

/** Append number/unit spans for already-computed parts. */
export function appendDurationParts(
  parent: HTMLElement,
  parts: readonly DurationPart[],
  spaced = true,
): void {
  parts.forEach((part, index) => {
    // 空格用独立节点而不是写进文本，折行时才不会把空格留在行尾。
    // Gaps are their own nodes rather than part of the text, so a wrap cannot leave a trailing
    // space stranded at the end of a line.
    if (spaced && index > 0) parent.createSpan({ cls: 'rtt-dur-gap', text: ' ' });
    const group = parent.createSpan({ cls: 'rtt-dur-part' });
    group.createSpan({ cls: 'rtt-dur-num', text: part.value });
    // 数字与它自己的单位之间也留空 —— 读作 `10 分 25 秒`，而不是 `10分 25秒`。
    // A gap between a number and *its* unit too: the duration reads `10 分 25 秒`, not
    // `10分 25秒`.
    if (spaced) group.createSpan({ cls: 'rtt-dur-gap', text: ' ' });
    group.createSpan({ cls: 'rtt-dur-unit', text: part.unit });
  });
}

/** Replace an element's content with a styled duration (the `X 分钟` form). */
export function setReadTime(el: HTMLElement, seconds: number, mode: string): void {
  el.empty();
  el.addClass('rtt-dur');
  appendDurationParts(el, formatReadTimeParts(seconds, mode));
  applyPreciseTooltip(el, seconds);
}

/** Replace an element's content with a styled duration (the `M分N秒` form). */
export function setClockTime(el: HTMLElement, seconds: number): void {
  el.empty();
  el.addClass('rtt-dur');
  appendDurationParts(el, formatDurationParts(seconds));
  applyPreciseTooltip(el, seconds);
}

/**
 * 毫秒级秒表读数 / a millisecond stopwatch readout, as `MM:SS.mmm`.
 *
 * 刻意不用"X 分 Y 秒"那套中文单位：末位每 100 毫秒都在变，单位字样反复重排只会让数字跳动得更明显。
 * 固定宽度的时间串读起来稳，小数部分照旧压小、压灰。
 *
 * Deliberately not the "X 分 Y 秒" wording: the last digits change every 100ms, and repeated unit
 * reflow makes the number jump more, not less. A fixed-width clock reads steadily, with the fraction
 * still smaller and muted.
 */
export function setClockTimeMs(el: HTMLElement, ms: number): void {
  el.empty();
  el.addClass('rtt-dur', 'rtt-clock');

  const total = Math.max(0, Math.floor(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  const pad = (value: number): string => String(value).padStart(2, '0');

  const main = hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;

  el.createSpan({ cls: 'rtt-clock-main', text: main });
  el.createSpan({ cls: 'rtt-clock-ms', text: `.${String(millis).padStart(3, '0')}` });
}

/** Create an element holding a styled `X 分钟` duration. */
export function renderReadTime(
  parent: HTMLElement,
  cls: string,
  seconds: number,
  mode: string,
): HTMLElement {
  const el = parent.createSpan({ cls: `${cls} rtt-dur` });
  appendDurationParts(el, formatReadTimeParts(seconds, mode));
  return el;
}
