/**
 * Status-bar durations / 右下角状态栏时长
 *
 * Three presentations, chosen by platform and setting:
 *
 *   mobile   — a single icon; tapping it opens a floating menu of the checked items. A phone's
 *              status bar has room for one tap target, not four label/value pairs.
 *   desktop, icons only — `[reading][state] | [manual][state]`, the type icons carrying their
 *              timer's state so "am I recording" is answerable without reading a number.
 *   desktop, text — the label and the duration, as before.
 *
 * Only the metrics the user actually pinned are computed: the overview figures need a full pass
 * over the event stream, and paying for that every second to render nothing would be waste.
 */

import { Platform, setIcon, setTooltip } from 'obsidian';

import { isPluginViewKey } from '../core/activePath';
import { eventFileRefs } from '../core/migration';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { manualDayTotalSeconds } from '../core/manualTimeline';
import { dayAccount, RecordsCache } from '../core/account';
import {
  selectDocumentDisplayState,
  selectLiveSessionState,
  selectManualElapsedSeconds,
  selectReadingSeconds,
  selectUnfocusedSeconds,
} from '../core/selectors';
import {
  attributionPolicy,
  countsPluginViewsAsReading,
  countsUnfocusedAsReading,
} from '../core/settings';
import { activeSelection, type PanelId, type StatusMetricDef } from '../core/statusMetrics';
import { todayStr } from '../core/time';
import { buildFileRecords } from '../core/timeline';
import type { PluginSettings } from '../core/types';
import type { Clock } from '../services/clock';
import type { TimerStore } from '../services/TimerStore';
import type { HistoryStore } from '../data/historyStore';
import { setReadTime } from './durationText';
import { createSecondPie, existingSecondPie } from './secondPie';

/** How often the durations are recomputed. */
const REFRESH_MS = 1000;

/** Icons for the icon-only layout / 图标模式用的图标. */
const READING_ICON = 'book-open';
const MANUAL_ICON = 'timer';

export interface StatusBarDeps {
  /** The element Obsidian handed back from `addStatusBarItem()`. */
  el: HTMLElement;
  store: TimerStore;
  history: HistoryStore;
  clock: Clock;
  settings: () => PluginSettings;
  log: Logger;
  /** Reveal a sidebar panel; wired to the plugin's own sidebar. */
  openPanel: (panel: PanelId) => void;
}

/** The metrics that need the full event-stream derivation. */
const OVERVIEW_METRICS = new Set(['union', 'docTotal', 'viewTotal', 'overlap']);

/**
 * A computed metric. Durations carry seconds so the renderer can style number and unit apart;
 * a plain count carries its text.
 */
type Value = { seconds: number } | { text: string };

/** How the bar is currently drawn. */
type Mode = 'text' | 'icons' | 'mobile';

export class StatusBarMetrics {
  private timer: number | null = null;
  private unsubscribe: (() => void) | null = null;
  /** What the DOM was last built for, so a settings change or a platform flip rebuilds it. */
  private renderedSignature = '';
  /** The mobile menu, when open. */
  private menu: HTMLElement | null = null;
  private dismissMenu: (() => void) | null = null;

  constructor(private readonly deps: StatusBarDeps) {}

  /** Begin updating. Safe to call more than once. */
  start(): void {
    this.stop();
    this.deps.el.addClass('rtt-statusbar');
    this.unsubscribe = this.deps.store.subscribe(() => this.refresh());
    this.timer = window.setInterval(() => this.refresh(), REFRESH_MS);
    this.refresh();
  }

  /** Stop updating and clear the item. */
  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.closeMenu();
    this.deps.el.empty();
  }

  /** Recompute and repaint. */
  refresh(): void {
    try {
      const settings = this.deps.settings();
      const selected = activeSelection(settings.statusBarMetrics ?? []);
      const mode: Mode = Platform.isMobile
        ? 'mobile'
        : settings.statusBarIconsOnly
          ? 'icons'
          : 'text';

      const signature = `${mode}|${selected.map((metric) => metric.id).join(',')}`;

      // Rebuild only when the shape changed; otherwise patch in place so a click target is
      // never swapped out from under the pointer.
      if (signature !== this.renderedSignature) {
        this.closeMenu();
        this.build(selected, mode);
        this.renderedSignature = signature;
      }

      this.paint(selected, mode);
    } catch (error) {
      this.deps.log.warn('[RTT][statusbar] 刷新失败 / refresh failed:', error);
    }
  }

  // ==========================================================================
  // 构建 / building
  // ==========================================================================

  private build(selected: readonly StatusMetricDef[], mode: Mode): void {
    this.deps.el.empty();

    //  移动端先于"没钉任何指标"的判断：那一枚图标是浮层的入口，钉了几项只决定浮层里列几行，
    //  不该决定入口在不在。实测（手机 1.2.2）四项全空时状态栏只剩"不显示"三个字，用户既看不到
    //  状态也点不开浮层 —— 入口整个消失。
    //  Mobile comes before the "nothing pinned" check: that one icon is the menu's entry point, and
    //  how many metrics are pinned only decides how many rows the menu lists, never whether the entry
    //  exists. Measured on the phone at 1.2.2: with all four slots empty the bar held nothing but the
    //  word "不显示" — no state, and nothing to tap.
    if (mode === 'mobile') {
      this.buildMobile(selected);
      return;
    }

    if (selected.length === 0) {
      this.deps.el.createSpan({ cls: 'rtt-statusbar-empty', text: t('statusBarNone') });
      return;
    }

    if (mode === 'icons') {
      this.buildIcons(selected);
      return;
    }

    for (const metric of selected) {
      const item = this.makeItem(this.deps.el, metric);
      item.createSpan({ cls: 'rtt-statusbar-label', text: t(metric.labelKey) });
      item.createSpan({ cls: 'rtt-statusbar-value', text: '—' });
    }
  }

  /**
   * 移动端：单个图标 / mobile: one icon.
   * 状态以一个小角标附着在图标上，点开才是明细。
   */
  private buildMobile(selected: readonly StatusMetricDef[]): void {
    const button = this.deps.el.createEl('button', {
      cls: 'clickable-icon rtt-icon-btn rtt-statusbar-single',
    });
    setIcon(button, 'activity');
    button.setAttribute('aria-label', t('statusBarMenuTitle'));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.menu) this.closeMenu();
      else this.openMenu(selected);
    });
    // The state badge rides on the icon, so the bar answers "is it recording" without a tap.
    button.createSpan({ cls: 'rtt-statusbar-badge' });
  }

  /**
   * 桌面端纯图标 / desktop, icons only.
   * 顺序：阅读类型图标 + 状态图标 · 分隔 · 手动类型图标 + 状态图标。
   */
  private buildIcons(selected: readonly StatusMetricDef[]): void {
    const groups: Array<{ group: 'reading' | 'manual'; icon: string }> = [
      { group: 'reading', icon: READING_ICON },
      { group: 'manual', icon: MANUAL_ICON },
    ];

    let first = true;
    for (const { group, icon } of groups) {
      const metrics = selected.filter((metric) => metric.group === group);
      if (metrics.length === 0) continue;

      if (!first) this.deps.el.createSpan({ cls: 'rtt-statusbar-sep', text: '|' });
      first = false;

      const item = this.makeItem(this.deps.el, metrics[0]!);
      item.addClass('rtt-statusbar-group');
      setIcon(item.createSpan({ cls: 'rtt-statusbar-type' }), icon);
      // The state icon is appended after the type icon, so it reads as belonging to it.
      item.createSpan({ cls: 'rtt-statusbar-state' });
    }
  }

  /** One clickable entry that jumps to its panel. */
  private makeItem(parent: HTMLElement, metric: StatusMetricDef): HTMLElement {
    const item = parent.createDiv({ cls: 'rtt-statusbar-item' });
    setTooltip(item, `${t(metric.labelKey)} · ${t('statusBarJump')}`);
    item.setAttribute('aria-label', `${t(metric.labelKey)} · ${t('statusBarJump')}`);
    item.addEventListener('click', () => this.deps.openPanel(metric.panel));
    return item;
  }

  // ==========================================================================
  // 移动端浮层 / the mobile menu
  // ==========================================================================

  /**
   * 浮层：已勾选的显示项目 / the floating menu of checked items.
   *
   * 点击条目跳到对应面板，浮层随之关闭 —— 与日历弹层同一套交互（点外部或 Escape 关）。
   */
  private openMenu(selected: readonly StatusMetricDef[]): void {
    const menu = this.deps.el.createDiv({ cls: 'rtt-statusbar-menu' });
    menu.setAttribute('role', 'menu');
    menu.createDiv({ cls: 'rtt-statusbar-menu-title', text: t('statusBarMenuTitle') });

    // 标签页关掉又打开时，今天的早先几轮不会出现在这里 —— 明说一句并在顶部给出入口，比让用户
    // 对着一个只有本轮计数的菜单猜要诚实。
    // Reopening a tab leaves the day's earlier rounds invisible here; saying so, with an entry
    // point at the top, beats a menu that only ever shows the current run.
    const earlier = this.earlierRounds();
    if (earlier > 0) {
      const hint = menu.createDiv({ cls: 'rtt-statusbar-menu-hint' });
      hint.setText(t('previousSessions').replace('{n}', String(earlier)));
      hint.addEventListener('click', (event) => {
        event.stopPropagation();
        this.closeMenu();
        this.deps.openPanel('document');
      });
    }

    for (const metric of selected) {
      const row = menu.createDiv({ cls: 'rtt-statusbar-menu-row' });
      row.setAttribute('role', 'menuitem');
      const label = row.createSpan({ cls: 'rtt-statusbar-menu-label', text: t(metric.labelKey) });
      row.createSpan({ cls: 'rtt-statusbar-menu-value', text: '—' });
      void label;
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        this.closeMenu();
        this.deps.openPanel(metric.panel);
      });
    }

    this.menu = menu;

    const doc = this.deps.el.ownerDocument;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target && menu.contains(target)) return;
      this.closeMenu();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') this.closeMenu();
    };
    doc.addEventListener('mousedown', onDown);
    doc.addEventListener('keydown', onKey);
    this.dismissMenu = () => {
      doc.removeEventListener('mousedown', onDown);
      doc.removeEventListener('keydown', onKey);
    };
  }

  /** 该文件今天已结算的轮数 / the file's settled rounds today. */
  private earlierRounds(): number {
    const path = this.deps.store.getState().activeFilePath;
    if (!path) return 0;
    const today = todayStr();
    return this.deps.history
      .getEvents()
      .filter(
        (event) =>
          // `switch` carries from/to rather than `file`, so ask the shared helper rather than
          // reading the field off a union member that does not have it
          eventFileRefs(event).includes(path) &&
          event.time.startsWith(today) &&
          (event.type === 'save' || event.type === 'auto-save'),
      ).length;
  }

  private closeMenu(): void {
    this.dismissMenu?.();
    this.dismissMenu = null;
    this.menu?.remove();
    this.menu = null;
  }

  // ==========================================================================
  // 绘制 / painting
  // ==========================================================================

  private paint(selected: readonly StatusMetricDef[], mode: Mode): void {
    const needed = new Set(selected.map((metric) => metric.id));
    const values = this.computeValues(needed);

    if (mode === 'mobile') {
      this.paintMobile(selected, values);
      return;
    }

    if (mode === 'icons') {
      this.paintIcons(selected, values);
      return;
    }

    const nodes = this.deps.el.querySelectorAll<HTMLElement>('.rtt-statusbar-value');
    if (nodes.length !== selected.length) {
      this.renderedSignature = '';
      this.refresh();
      return;
    }

    selected.forEach((metric, index) => {
      const node = nodes[index];
      const value = values[metric.id];
      if (!node || !value) return;
      if ('text' in value) node.setText(value.text);
      else setReadTime(node, value.seconds, this.deps.settings().timeDisplayMode);
    });
  }

  /** 移动端：图标角标 + 浮层里的数值 / the badge and the menu's values. */
  private paintMobile(
    selected: readonly StatusMetricDef[],
    values: Record<string, Value>,
  ): void {
    const state = this.deps.store.getState();
    const badge = this.deps.el.querySelector<HTMLElement>('.rtt-statusbar-badge');
    if (badge) {
      const docRunning = docState(state) === 'running';
      const manualRunning = manualState(state) === 'running';

      //  计时中这一角标画 60 秒圆饼，而不是 play 字形 —— 与桌面状态槽、状态卡徽标共用同一个组件
      //  （secondPie.ts）：跑没跑起来一眼可见，不必去读数字。两本账同时在跑时先看文档那本。
      //
      //  While a clock runs this badge holds the 60-second pie rather than the play glyph — the same
      //  shared part (secondPie.ts) as the desktop state slot and the session card, so "is it running"
      //  is visible without reading a number. With both ledgers running the document one leads.
      if (docRunning || manualRunning) {
        const pie = existingSecondPie(badge) ?? createSecondPie(badge);
        pie.setElapsed(this.elapsedSecondsFor(docRunning ? 'reading' : 'manual'));
      } else {
        badge.empty();
        setIcon(badge, stateIcon(docState(state), manualState(state)));
      }
    }

    const rows = this.menu?.querySelectorAll<HTMLElement>('.rtt-statusbar-menu-value');
    if (!rows) return;
    selected.forEach((metric, index) => {
      const node = rows[index];
      const value = values[metric.id];
      if (!node || !value) return;
      if ('text' in value) node.setText(value.text);
      else setReadTime(node, value.seconds, this.deps.settings().timeDisplayMode);
    });
  }

  /**
   * 桌面端图标：状态图标跟着类型图标 / the desktop state icons.
   *
   * 阅读那一组显示文档计时的状态，手动那一组显示秒表的状态 —— 两个计时器是独立的，各自有各自的
   * 状态，共用一个会误导。
   * The reading group carries the document timer's state and the manual group the stopwatch's:
   * the two are independent and each has its own, so one shared icon would mislead.
   */
  private paintIcons(
    selected: readonly StatusMetricDef[],
    values: Record<string, Value>,
  ): void {
    const state = this.deps.store.getState();
    type TState = 'running' | 'paused' | 'idle' | 'unfocused';
    const byGroup: Record<'reading' | 'manual', TState> = {
      reading: docState(state),
      manual: manualState(state),
    };

    const groups = this.deps.el.querySelectorAll<HTMLElement>('.rtt-statusbar-group');
    let index = 0;
    for (const group of ['reading', 'manual'] as const) {
      const metrics = selected.filter((metric) => metric.group === group);
      if (metrics.length === 0) continue;
      const node = groups[index++];
      if (!node) continue;

      const holder = node.querySelector<HTMLElement>('.rtt-statusbar-state');
      if (holder) {
        const groupState = byGroup[group];

        //  计时中这一槽位画 60 秒圆饼，别的状态画图标 —— 圆饼自己在转，所以"跑没跑起来"不用去读
        //  数字；饼只建一次，之后每秒只改一个 CSS 变量。
        //  While a clock runs this slot holds the 60-second pie instead of a glyph: the sweep says
        //  "running" without reading a number. The pie is built once and only a CSS variable is
        //  rewritten each second afterwards.
        if (groupState === 'running') {
          const pie = existingSecondPie(holder) ?? createSecondPie(holder);
          pie.setElapsed(this.elapsedSecondsFor(group));
        } else {
          holder.empty();
          setIcon(holder, stateIcon(groupState));
        }
      }

      // The tooltip carries what the icon cannot: which durations are pinned and their values.
      const summary = metrics
        .map((metric) => {
          const value = values[metric.id];
          if (!value) return t(metric.labelKey);
          return `${t(metric.labelKey)} ${
            'text' in value
              ? value.text
              : readableDuration(value.seconds, this.deps.settings().timeDisplayMode)
          }`;
        })
        .join(' · ');
      setTooltip(node, summary);
      node.setAttribute('aria-label', summary);
    }
  }

  /**
   * 该组计时器本轮走了多少秒 / how long that group's clock has been running this round.
   *
   * 文档圆饼跟随有效阅读时长；手动圆饼跟随秒表净时长。
   * Document progress follows reading seconds; manual progress follows net stopwatch time.
   */
  private elapsedSecondsFor(group: 'reading' | 'manual'): number {
    const state = this.deps.store.getState();

    if (group === 'manual') {
      return selectManualElapsedSeconds(state, this.deps.clock.now());
    }

    const path = state.activeFilePath;
    const file = path ? state.files.get(path) : undefined;
    return file?.activeSeconds ?? 0;
  }

  // ==========================================================================
  // 数值 / values
  // ==========================================================================

  /** Compute just the requested metrics. */
  /** 账本 records 的缓存 / cache for the account's derived records. */
  private readonly recordsCache = new RecordsCache();

  private computeValues(needed: Set<string>): Record<string, Value> {
    const state = this.deps.store.getState();
    const settings = this.deps.settings();
    const today = todayStr();
    const values: Record<string, Value> = {};

    if (needed.has('session')) {
      const path = state.activeFilePath;
      values['session'] = {
        seconds: path && (countsPluginViewsAsReading(settings) || !isPluginViewKey(path))
          ? selectReadingSeconds(state, path, countsUnfocusedAsReading(settings)) : 0,
      };
    }

    if (needed.has('unfocused')) {
      const path = state.activeFilePath;
      values['unfocused'] = {
        seconds: path ? selectUnfocusedSeconds(state, path) : 0,
      };
    }

    //  今日的三个数从同一份账本出：以前「今日总时长」在这里是"专注（+离开）"，在面板上是
    //  "专注 + 离开 + 暂停"，同一个标签两个数。
    //  Today's three figures come from one account. "Today's total" used to mean "focus (+away)"
    //  here and "focus + away + paused" on the panel — one label, two numbers.
    if (needed.has('todayTotal') || needed.has('todayRead') || needed.has('idleToday')) {
      const path = state.activeFilePath;
      const file = path ? state.files.get(path) : undefined;
      const policy = attributionPolicy(settings);
      const records = this.recordsCache.get(this.deps.history.getRevision(), () =>
        buildFileRecords(this.deps.history.getEvents(), this.deps.clock.now(), today, {}),
      );

      const account = dayAccount({
        records,
        manual: this.deps.history.getManualSessions(),
        countdown: this.deps.history.getCountdownSessions(),
        day: today,
        nowMs: this.deps.clock.now(),
        policy: { ...policy, pluginViews: countsPluginViewsAsReading(settings) },
        live: path && file && file.status !== 'idle'
          ? { filePath: path, state: selectLiveSessionState(state, file) }
          : null,
      });

      values['todayTotal'] = { seconds: account.total };
      values['todayRead'] = { seconds: account.reading };
      values['idleToday'] = { seconds: account.idle };
    }

    if (needed.has('rounds')) {
      // Vault-wide, matching the records browser rather than the per-file sidebar card: a
      // single number in the status bar should answer "how much have I read today".
      const rounds = this.deps.history
        .getEvents()
        .filter(
          (event) =>
            event.time.startsWith(today) &&
            (event.type === 'save' || event.type === 'auto-save'),
        ).length;
      // A count is not a duration, so it gets no unit to mute.
      values['rounds'] = { text: String(rounds) };
    }

    if (needed.has('manualToday')) {
      values['manualToday'] = {
        seconds: manualDayTotalSeconds(this.deps.history.getManualSessions(), today),
      };
    }

    const wantsOverview = [...needed].some((id) => OVERVIEW_METRICS.has(id));
    if (wantsOverview) {
      const path = state.activeFilePath;
      const file = path ? state.files.get(path) : undefined;
      const policy = attributionPolicy(settings);
      const account = dayAccount({
        events: this.deps.history.getEvents(),
        manual: this.deps.history.getManualSessions(),
        countdown: this.deps.history.getCountdownSessions(),
        day: today,
        nowMs: this.deps.clock.now(),
        policy: { ...policy, pluginViews: countsPluginViewsAsReading(settings) },
        live: path && file && file.status !== 'idle'
          ? { filePath: path, state: selectLiveSessionState(state, file) }
          : null,
      });

      values['union'] = { seconds: account.union };
      values['docTotal'] = { seconds: account.document };
      values['viewTotal'] = { seconds: account.view };
      values['overlap'] = { seconds: account.overlap };
    }

    return values;
  }
}

/**
 * 文档计时的状态 / the document timer's state, as a badge icon name.
 *
 * 导出是因为侧栏的当前计时状态卡用同一套判定与同一个图标 —— 同一个状态在两处必须是同一个
 * 图标，否则用户得重新学一遍。
 * Exported because the sidebar's current-session card uses the same mapping and the same icon:
 * one state must look the same in both places, or it has to be learned twice.
 */
export function docState(state: ReturnType<TimerStore['getState']>): ReturnType<typeof selectDocumentDisplayState> {
  return selectDocumentDisplayState(state);
}

/** 手动计时的状态 / the manual timer's state. */
function manualState(state: ReturnType<TimerStore['getState']>): 'running' | 'paused' | 'idle' {
  if (state.manual.status === 'running') return 'running';
  if (state.manual.status === 'paused') return 'paused';
  return 'idle';
}

/**
 * 状态 → 图标 / state to icon.
 * 运行=play、暂停=pause、停止=square；两个计时器都在跑时取 play（两个都一样，无歧义）。
 * 侧栏的当前计时状态卡也用它 / the sidebar's current-session card uses it too.
 */
export function stateIcon(...states: Array<'running' | 'paused' | 'idle' | 'unfocused'>): string {
  if (states.includes('running')) return 'play';
  if (states.includes('unfocused')) return 'eye-off';
  if (states.includes('paused')) return 'pause';
  return 'square';
}

/**
 * A duration as plain text, for tooltips and menu rows.
 *
 * `textContent`, not `innerText`: the element is detached, and `innerText` needs layout — it
 * returns an empty string for a node that was never in the document.
 */
function readableDuration(seconds: number, mode: string): string {
  const el = createDiv();
  setReadTime(el, seconds, mode);
  return el.textContent ?? '';
}
