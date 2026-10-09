/**
 * Heatmap rendering
 *
 * The sidebar's document, manual and overview panels plus the records modal all draw the
 * *same* chart: one row per hour, a 60-minute track inside it, segments positioned by
 * left/width percentages. That DOM was copy-pasted three times, so any change had to be
 * made three times. It lives here once; the four call sites differ only in two callbacks —
 * which class a segment gets, and what its label says.
 *
 * The generic covers both segment shapes: reading records carry `channel`, the overview
 * carries `sources`. Both need only the same three geometric fields.
 *
 */

import { t } from '../core/i18n';
import type { RecordChannel } from '../core/recordsTimeline';
import { formatDurationWithSeconds } from '../core/time';

/** the minimal geometry a segment must expose. */
export interface HeatmapSegment {

  startMinute: number;

  durationMinutes: number;
  /** clipped by an hour boundary or midnight */
  clipped: boolean;
}

/** the minimal shape a row must expose. */
export interface HeatmapRow<S extends HeatmapSegment> {
  /** 0–23 */
  hour: number;
  segments: S[];
}

const TICKS = [0, 15, 30, 45] as const;

/** Shared by both reading-record call sites so the colouring cannot drift apart. */
export const CHANNEL_CLASSES: Record<RecordChannel, string> = {
  'in-window': 'rtt-hm-in',
  'out-of-window': 'rtt-hm-out',
  paused: 'rtt-hm-paused',
};

/** the class for a reading-record segment. */
export function readingChannelClass(segment: { channel: RecordChannel }): string {
  return CHANNEL_CLASSES[segment.channel];
}

/** the accessible label for a reading-record segment. */
export function readingChannelLabel(segment: {
  channel: RecordChannel;
  durationMinutes: number;
  sessionStart: string;
}): string {
  const channel =
    segment.channel === 'out-of-window'
      ? t('tabUnfocused')
      : segment.channel === 'paused'
        ? t('recChannelPaused')
        : t('tabInWindow');
  const duration = formatDurationWithSeconds(Math.round(segment.durationMinutes * 60));
  const at = segment.sessionStart.slice(11, 16);
  return `${channel} · ${duration} · ${at}`;
}

/**
 * Draw the heatmap.
 *
 * Only hours with segments and their neighbours are drawn: most of the 24 rows are empty
 * and unreadable in a narrow sidebar.
 *
 * the 24 rows
 * extra classes for a segment
 * the accessible label for a segment
 * whether anything was drawn
 */
export function renderHeatmap<S extends HeatmapSegment>(
  parent: HTMLElement,
  rows: readonly HeatmapRow<S>[],
  classOf: (segment: S) => string,
  labelOf: (segment: S) => string,
): boolean {
  const interesting = rows.filter((row) => row.segments.length > 0);
  if (interesting.length === 0) return false;

  const wrap = parent.createDiv({ cls: 'rtt-heatmap-wrap' });

  // x-axis ticks every 15 minutes
  const axis = wrap.createDiv({ cls: 'rtt-hm-xaxis' });
  axis.createDiv({ cls: 'rtt-hm-hlabel', text: '' });
  const tickWrap = axis.createDiv({ cls: 'rtt-hm-tick-wrap' });
  for (const minute of TICKS) {
    const tick = tickWrap.createDiv({ cls: 'rtt-hm-tick', text: `${minute}` });
    tick.style.left = `${(minute / 60) * 100}%`;
  }

  const firstHour = Math.max(0, interesting[0]!.hour - 1);
  const lastHour = Math.min(23, interesting[interesting.length - 1]!.hour + 1);

  for (let hour = firstHour; hour <= lastHour; hour++) {
    const row = rows[hour]!;
    const rowEl = wrap.createDiv({ cls: 'rtt-hm-row' });
    rowEl.createDiv({ cls: 'rtt-hm-hlabel', text: String(hour).padStart(2, '0') });

    const bar = rowEl.createDiv({ cls: 'rtt-hm-bar' });
    for (const segment of row.segments) {
      const seg = bar.createDiv({ cls: `rtt-hm-seg ${classOf(segment)}` });
      seg.style.left = `${(segment.startMinute / 60) * 100}%`;

      //  A very short segment gets a floor width, or it is invisible on screen
      seg.style.width = `${Math.max(0.4, (segment.durationMinutes / 60) * 100)}%`;

      //  A clipped slice loses its rounding so the stretch still reads as one
      if (segment.clipped) seg.style.borderRadius = '0';
      seg.setAttribute('aria-label', labelOf(segment));
    }
  }

  return true;
}
