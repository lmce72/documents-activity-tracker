/**
 * 60 秒圆饼 / the 60-second pie
 *
 * 一个圆环，里面一块按当前这一分钟走的饼：第 60 秒整好转满一圈，然后从头再来。跑没跑起来一眼
 * 就能看出来，不需要读数字 —— 状态卡左边那枚徽标和状态栏的图标槽用的都是它，同一套标记、同一个
 * 更新方式（`--rtt-pie-pct` 驱动 conic-gradient），所以两处不可能长得不一样。
 *
 * A ring with a pie inside that follows progress through the current minute: one full turn every 60
 * seconds, then round again. Whether a clock is running is visible without reading a number. The
 * session card's badge and the status bar's icon slot both use it — one markup, one update path (a
 * `--rtt-pie-pct` custom property driving a conic-gradient), so the two cannot drift apart.
 *
 * 尺寸由宿主决定：环宽与内缩读 `--rtt-pie-ring-w` / `--rtt-pie-inset`，没设就用徽标那一档。
 * The host decides the size: the ring width and the inset come from `--rtt-pie-ring-w` and
 * `--rtt-pie-inset`, falling back to the badge's own values.
 */

/** 一个已经挂上去的圆饼 / a pie that has been mounted. */
export interface SecondPie {
  /** 圆饼的节点 / the pie's element */
  disc: HTMLElement;
  /** 按秒数指向这一分钟里的位置 / point the sweep at a moment within the minute */
  setElapsed(seconds: number): void;
}

/**
 * 建一枚圆饼并把宿主清空 / clear the host and build a pie into it.
 *
 * 宿主必须能被绝对定位（`position: relative` 由 CSS 给），环与饼都靠它定位。
 * The host has to be a positioning context (`position: relative`, set in CSS); both the ring and
 * the pie are placed against it.
 */
export function createSecondPie(host: HTMLElement): SecondPie {
  host.empty();
  host.createDiv({ cls: 'rtt-pie-ring' });
  const disc = host.createDiv({ cls: 'rtt-pie-disc' });

  return {
    disc,
    setElapsed(seconds: number): void {
      //  取模而不是截断：每满 60 秒回到起点，和秒表外圈同一个规矩
      //  Modulo rather than a clamp: it returns to the start every 60 seconds, the same rule the
      //  stopwatch's outer ring follows.
      disc.setCssProps({ '--rtt-pie-pct': String(((seconds % 60) / 60) * 100) });
    },
  };
}

/** 宿主里已有的那枚圆饼，没有就是 null / the pie already mounted in the host, if any. */
export function existingSecondPie(host: HTMLElement): SecondPie | null {
  const disc = host.querySelector<HTMLElement>('.rtt-pie-disc');
  if (!disc) return null;
  return {
    disc,
    setElapsed(seconds: number): void {
      disc.setCssProps({ '--rtt-pie-pct': String(((seconds % 60) / 60) * 100) });
    },
  };
}
