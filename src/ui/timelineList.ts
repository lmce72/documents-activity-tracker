/**
 * Vertical timeline list / 垂直节点时间轴
 *
 * A line down the left with an icon per entry threaded onto it. Used wherever the plugin
 * shows a "what happened" list: the overview's day detail, and the block that opens when a
 * heatmap stretch is clicked.
 *
 * One component rather than two, because both views are the same thing at different lengths —
 * a single stretch is just a one-node timeline, and giving them separate markup would let
 * them drift apart visually.
 *
 * 同一条轴线两处复用：总看板的当日明细，与点击热力图某段后展开的过程。单段就是只有一个
 * 节点的时间轴，因此不必写两套。
 */

import { setIcon, setTooltip } from 'obsidian';

import type { DurationPart } from '../core/time';
import { appendDurationParts } from './durationText';

/** One entry on the line. */
export interface TimelineNode {
  /** Lucide icon name. */
  icon: string;
  /** Optional class modifier, e.g. the kind of entry, for colouring. */
  kind?: string;
  /** The entry's headline. */
  title: string;
  timeRange?: string;
  key?: string;
  renderDetail?: (container: HTMLElement) => void;
  /**
   * Secondary lines under the title. A duration is passed as parts rather than a string, so
   * the muted-unit treatment applies here too — the timeline is one of the places a duration
   * is most often read.
   *
   * Order matters and is the caller's: the day detail leads with the *stretch* and then the
   * duration, because "when" is what the entry is about and the total only qualifies it.
   */
  lines?: ReadonlyArray<string | readonly DurationPart[]>;
  /**
   * When set, the node acts as a button that reveals this entry's stretch.
   *
   * The node's own click shows the stretch rather than opening the file: the timeline is a
   * record of what happened, and jumping out of it is a different intention that deserves its
   * own control (see {@link onOpen}).
   */
  onSelect?: () => void;
  /** When set, a small button on the right opens the underlying file or view. */
  onOpen?: () => void;
  /** Accessible name for the open button. */
  openLabel?: string;
  /**
   * `connector` draws a transition rather than an entry: the icon still sits on the line, but
   * the text is muted and there are no actions. A switch belongs *between* two targets, not
   * inside either, so it must not look like a target of its own.
   */
  variant?: 'connector';
}

export interface TimelineDisclosureState { expanded: Set<string>; scope: string }

/**
 * Render the timeline into `parent`.
 *
 * Entries carry the icon themselves rather than a shared one: telling a manual session from a
 * plugin view at a glance is the point of the design, so the icon is part of the data.
 */
export function renderTimelineList(
  parent: HTMLElement,
  nodes: readonly TimelineNode[],
  state?: TimelineDisclosureState,
): void {
  const list = parent.createDiv({ cls: 'rtt-vtl' });

  for (const node of nodes) {
    const classes = ['rtt-vtl-node'];
    if (node.kind) classes.push(`is-${node.kind}`);
    if (node.variant === 'connector') classes.push('is-connector');
    const row = list.createDiv({ cls: classes.join(' ') });

    const iconHolder = row.createDiv({ cls: 'rtt-vtl-icon' });
    setIcon(iconHolder, node.icon);

    const body = row.createDiv({ cls: 'rtt-vtl-body' });

    if (node.variant === 'connector') {
      body.createDiv({ cls: 'rtt-vtl-connector', text: node.title });
      continue;
    }

    if (node.timeRange) body.createDiv({ cls: 'rtt-vtl-range', text: node.timeRange });
    body.createDiv({ cls: 'rtt-vtl-title', text: node.title });

    if (node.lines && node.lines.length > 0) {
      const meta = body.createDiv({ cls: 'rtt-vtl-meta' });
      for (const line of node.lines) {
        const el = meta.createDiv({ cls: 'rtt-vtl-line' });
        if (typeof line === 'string') el.setText(line);
        else {
          el.addClass('rtt-dur');
          appendDurationParts(el, line);
        }
      }
    }

    // The open control lives outside the body so it can sit hard against the right edge and
    // stay put however long the title wraps.
    if (node.onOpen) {
      const open = row.createEl('button', { cls: 'clickable-icon rtt-icon-btn rtt-vtl-open' });
      setIcon(open, 'external-link');
      const label = node.openLabel ?? '';
      if (label) {
        setTooltip(open, label);
        open.setAttribute('aria-label', label);
      }
      open.addEventListener('click', (event) => {
        event.stopPropagation();
        node.onOpen?.();
      });
    }

    if (node.renderDetail) {
      const detail = body.createDiv({ cls: 'rtt-vtl-inline' });
      const key = (state?.scope ?? '') + '|' + (node.key ?? [node.kind, node.timeRange, node.title].join('|'));
      detail.hidden = !state?.expanded.has(key);
      if (!detail.hidden) node.renderDetail(detail);
      const toggle = body.createEl('button', { cls: 'rtt-process-toggle clickable-icon', attr: { 'aria-expanded': 'false', 'aria-label': node.title } });
      toggle.setAttribute('aria-expanded', String(!detail.hidden));
      setIcon(toggle, detail.hidden ? 'chevron-down' : 'chevron-up');
      toggle.addEventListener('click', event => {
        event.stopPropagation();
        detail.hidden = !detail.hidden;
        if (detail.hidden) state?.expanded.delete(key);
        else state?.expanded.add(key);
        if (!detail.hidden && !detail.hasChildNodes()) node.renderDetail?.(detail);
        toggle.setAttribute('aria-expanded', String(!detail.hidden));
        setIcon(toggle, detail.hidden ? 'chevron-down' : 'chevron-up');
      });
      body.insertBefore(toggle, detail);
      const title = body.querySelector<HTMLElement>('.rtt-vtl-title');
      title?.addEventListener('click', () => toggle.click());
    }

    if (node.onSelect) {
      row.addClass('is-clickable');
      row.addEventListener('click', () => node.onSelect?.());
    }
  }
}
