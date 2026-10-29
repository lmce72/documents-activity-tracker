import { setIcon, setTooltip } from 'obsidian';
import type { OverviewSource } from '../core/overview';
import type { OverviewProcess, OverviewTrack } from '../core/overviewTracks';
import { sourceClass } from '../core/processPreview';
import { toAbsoluteMinutes } from '../core/recordsTimeline';
import { formatDurationWithSeconds } from '../core/time';
import { t } from '../core/i18n';
import { renderHeatmapAxis, renderHeatmapTrack } from './heatmapRender';

const icons: Record<OverviewSource, string> = { document: 'file-text', view: 'app-window', manual: 'timer', countdown: 'hourglass' };
export function overviewSourceName(source: OverviewSource): string {
  return t(source === 'document' ? 'ovKindDocument' : source === 'view' ? 'ovKindView' : source === 'manual' ? 'ovKindManual' : 'panelCountdown');
}

/** Same hour/minute coordinates, with a separate lane and selection identity per ledger. */
export function renderOverviewTracks(
  parent: HTMLElement, tracks: readonly OverviewTrack[], day: string,
  sources: ReadonlySet<OverviewSource>, selected: string | null,
  onSelect: (process: OverviewProcess) => void,
): void {
  const visible = tracks.filter(track => sources.has(track.source));
  const hours = visible.flatMap(track => track.rows.filter(row => row.segments.length > 0).map(row => row.hour));
  if (!hours.length) { parent.createDiv({ cls: 'rtt-list-empty', text: t('ovEmpty') }); return; }
  const wrap = parent.createDiv({ cls: 'rtt-heatmap-wrap rtt-overview-tracks' });
  renderHeatmapAxis(wrap);
  const start = Math.max(0, Math.min(...hours) - 1);
  const end = Math.min(23, Math.max(...hours) + 1);
  const base = toAbsoluteMinutes(day + ' 00:00:00')!;
  for (let hour = start; hour <= end; hour++) {
    const row = wrap.createDiv({ cls: 'rtt-hm-row rtt-overview-hour' });
    row.dataset.rttHour = String(hour);
    row.createDiv({ cls: 'rtt-hm-hlabel', text: String(hour).padStart(2, '0') });
    const lanes = row.createDiv({ cls: 'rtt-ov-lanes' });
    for (const track of visible) {
      const lane = lanes.createDiv({ cls: 'rtt-ov-lane', attr: { 'data-rtt-source': track.source } });
      const icon = lane.createSpan({ cls: 'rtt-ov-lane-icon' });
      setIcon(icon, icons[track.source]);
      setTooltip(icon, overviewSourceName(track.source));
      const bar = lane.createDiv({ cls: 'rtt-hm-bar', attr: { 'aria-label': overviewSourceName(track.source) } });
      renderHeatmapTrack(bar, track.rows[hour], () => sourceClass[track.source],
        segment => overviewSourceName(track.source) + ' · ' + (segment.process.session?.note || day) + ' · ' + formatDurationWithSeconds(Math.round(segment.durationMinutes * 60)),
        block => onSelect(block.members[0].process), segment => segment.process.id);
      for (const segment of Array.from(bar.querySelectorAll<HTMLElement>('.rtt-hm-seg'))) {
        const active = segment.dataset.rttGroup === selected;
        segment.toggleClass('is-selected', active);
        segment.setAttribute('aria-pressed', String(active));
      }
      for (const process of new Set(track.rows[hour].segments.map(segment => segment.process))) {
        if (!process.session) continue;
        const overlay = (from: number, to: number, cls: string): void => {
          const left = Math.max(base + hour * 60, from);
          const right = Math.min(base + (hour + 1) * 60, to);
          if (right <= left) return;
          bar.createDiv({ cls }).setCssProps({ left: ((left - base - hour * 60) / 60 * 100) + '%', width: ((right - left) / 60 * 100) + '%' });
        };
        for (const pause of process.session.pauses) {
          const from = toAbsoluteMinutes(pause.from); const to = toAbsoluteMinutes(pause.to);
          if (from !== null && to !== null) overlay(from, to, 'rtt-hm-pause-block');
        }
        for (const flag of process.session.flags) {
          const at = toAbsoluteMinutes(flag.atTime);
          if (at !== null && at >= base + hour * 60 && at < base + (hour + 1) * 60) {
            const tick = bar.createDiv({ cls: 'rtt-hm-flag' });
            tick.setCssProps({ left: ((at - base - hour * 60) / 60 * 100) + '%' });
            setTooltip(tick, flag.label || t('manualFlag'));
          }
        }
      }
    }
  }
}
