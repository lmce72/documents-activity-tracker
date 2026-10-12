/**
 * 单行溢出文字的水平滚动 / horizontal marquee for a line that overflows
 *
 * 仿照 PrimeCore 的 TileNavigator（`primecore-tilenavigator.js` 的 ScrollAnimator）：每帧推进
 * 若干像素，滚到底先停一下、淡出、跳回起点、再淡入。不用硬折返 —— 折返会让首尾字符在视觉上撞在
 * 一起，读起来像一串没有断句的字。区别只有轴向：那边滚的是磁贴里纵向溢出的内容，这里是横向的
 * 文件名。
 *
 * Modelled on PrimeCore's TileNavigator (`ScrollAnimator` in `primecore-tilenavigator.js`): advance
 * a few pixels per frame, then at the end pause, fade out, jump back to the start and fade in. Not a
 * bounce: a bounce makes the two ends collide visually and reads as one unpunctuated run of text.
 * The only difference is the axis — that one scrolls a tile's vertically overflowing content, this
 * one a single file name.
 *
 * 每帧都重新量一次溢出量，所以侧栏被拉宽、字体变化、文字变短都会自己停回起点，不需要重建。
 * The overflow is measured on every frame, so widening the sidebar, a font change or a shorter name
 * all make it settle back to the start on their own — no rebuild needed.
 */

/** 帧间隔 / the tick interval. 16ms ≈ 60fps，够顺滑又不至于每秒烧掉一百多次布局测量。 */
const TICK_MS = 16;

/** 溢出量小于这个像素数就不滚：亚像素级的差值是量的误差，不是真的放不下。 */
/** Below this many pixels of overflow nothing scrolls: a sub-pixel difference is measurement noise. */
const OVERFLOW_EPSILON = 2;

/** 到底后多滚一点再收尾，让最后一个字完整露出来 / overshoot so the last glyph is fully shown. */
const END_OVERSHOOT = 10;

/** 滚动参数 / the scroll parameters. */
export interface TickerOptions {
  /** 每秒推进的像素 / pixels per second */
  pixelsPerSecond?: number;
  /** 起步前的停顿，让人先看清开头 / pause before the first move, so the opening is readable */
  startDelayMs?: number;
  /** 到底后的停顿 / pause at the end before fading */
  endDelayMs?: number;
  /** 淡出与淡入的时长 / the fade duration, each way */
  fadeMs?: number;
}

export class HScrollTicker {
  private readonly speed: number;
  private readonly startDelayMs: number;
  private readonly endDelayMs: number;
  private readonly fadeMs: number;

  private currentX = 0;
  private intervalId: number | null = null;
  private timerId: number | null = null;
  private resetting = false;

  constructor(
    /** 看得见的窗口，负责裁切 / the visible window that clips */
    private readonly viewport: HTMLElement,
    /** 里面那条会移动的文字 / the moving text inside it */
    private readonly track: HTMLElement,
    options: TickerOptions = {},
  ) {
    //  TileNavigator 默认每秒 100px；这里同一套默认值，两处的滚动手感才一致。
    //  TileNavigator defaults to 100 px/s and the same defaults are used here, so both surfaces
    //  scroll at the same feel.
    this.speed = (options.pixelsPerSecond ?? 100) / (1000 / TICK_MS);
    this.startDelayMs = options.startDelayMs ?? 1500;
    this.endDelayMs = options.endDelayMs ?? 400;
    this.fadeMs = options.fadeMs ?? 400;
  }

  /**
   * 开始。放不下才真的跑起来。
   *
   * Start. It only actually runs when the text does not fit: a name that fits needs no timer, and a
   * 16ms interval on a phone is a battery cost, not a decoration.
   */
  start(): void {
    //  用户在系统里要求减少动态效果时，静态地显示开头就够。老 WebView 没有 matchMedia，按"没有这个
    //  偏好"处理。
    //  When the system asks for reduced motion, showing the start of the name is enough. An older
    //  WebView without matchMedia means "no such preference".
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    this.timerId = window.setTimeout(() => {
      this.timerId = null;
      if (!this.overflows()) return;
      this.intervalId = window.setInterval(() => this.step(), TICK_MS);
    }, this.startDelayMs);
  }

  /** 停止并清掉所有计时器与内联样式 / stop, and clear every timer and inline style. */
  destroy(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    if (this.timerId !== null) window.clearTimeout(this.timerId);
    this.intervalId = null;
    this.timerId = null;
    this.resetting = false;
    this.currentX = 0;
    this.track.setCssProps({ transition: 'none', transform: 'translateX(0px)', opacity: '1' });
  }

  /** 当前是否放不下 / whether the text currently overflows its window. */
  private overflows(): boolean {
    return this.overflowPx() > OVERFLOW_EPSILON;
  }

  private overflowPx(): number {
    const viewportWidth = this.viewport.getBoundingClientRect().width;
    const trackWidth = this.track.getBoundingClientRect().width;
    return trackWidth - viewportWidth;
  }

  /** 一个帧：推进、收尾或停回起点 / one frame: advance, wrap up, or settle back. */
  private step(): void {
    //  侧栏重绘会把这两个节点换掉；节点一旦脱开文档，这个计时器就必须自己结束，否则每次重绘都留下
    //  一个还在算布局的定时器。
    //  A sidebar re-render replaces both nodes; once they leave the document this timer has to end
    //  itself, or every re-render leaves one behind still measuring layout.
    if (!this.track.isConnected || !this.viewport.isConnected) {
      this.destroy();
      return;
    }

    const overflow = this.overflowPx();
    if (overflow <= OVERFLOW_EPSILON) {
      this.currentX = 0;
      this.track.setCssProps({ transition: 'none', transform: 'translateX(0px)' });
      return;
    }

    if (this.resetting) return;
    this.currentX += this.speed;

    if (this.currentX >= overflow + END_OVERSHOOT) {
      this.wrapUp();
      return;
    }

    this.track.setCssProps({ transform: `translateX(-${this.currentX}px)` });
  }

  /**
   * 到底：停 → 淡出 → 跳回起点 → 淡入。
   * At the end: pause, fade out, jump to the start, fade in.
   */
  private wrapUp(): void {
    this.resetting = true;
    const fadeSeconds = this.fadeMs / 1000;

    this.timerId = window.setTimeout(() => {
      this.track.setCssProps({ transition: `opacity ${fadeSeconds}s ease`, opacity: '0' });

      this.timerId = window.setTimeout(() => {
        this.currentX = 0;
        this.track.setCssProps({ transition: 'none', transform: 'translateX(0px)' });

        this.timerId = window.setTimeout(() => {
          this.track.setCssProps({ transition: `opacity ${fadeSeconds}s ease`, opacity: '1' });

          this.timerId = window.setTimeout(() => {
            this.track.setCssProps({ transition: 'none' });
            this.resetting = false;
            this.timerId = null;
          }, this.fadeMs);
        }, TICK_MS);
      }, this.fadeMs);
    }, this.endDelayMs);
  }
}
