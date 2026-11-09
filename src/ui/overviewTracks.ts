import { Menu, setTooltip } from 'obsidian';
import type { OverviewSource } from '../core/overview';
import type { OverviewProcess, OverviewTrack } from '../core/overviewTracks';
import { sourceClass } from '../core/processPreview';
import { toAbsoluteMinutes } from '../core/recordsTimeline';
import { formatDurationWithSeconds, formatLocalFull } from '../core/time';
import { t } from '../core/i18n';
import { renderHeatmapAxis, renderHeatmapTrack } from './heatmapRender';
import { onHeatmapActivate } from './heatmapActivation';

export interface OverviewTrackLayout {
  placeDetail: (detail: HTMLElement, id: string, hour: number) => boolean;
  /** 整小时选中：详情放在该小时行之下 / an hour selection places its detail under that hour row */
  placeHourDetail: (detail: HTMLElement, hour: number) => boolean;
}

/** 点击是否落在段或详情里 / whether the click landed on a segment or the detail block. */
function insideInteractive(node: EventTarget | null): boolean {
  if (!node || typeof node !== 'object' || !('closest' in node)) return false;
  return (node as { closest(selector: string): Element | null }).closest('.rtt-hm-seg, .rtt-overview-detail') !== null;
}
export function overviewSourceName(source: OverviewSource): string {
  return t(source === 'document' ? 'ovKindDocument' : source === 'view' ? 'ovKindView' : source === 'manual' ? 'ovKindManual' : 'panelCountdown');
}

/** Every surface listing a source uses the same Lucide mark / 各列表共用同一来源图标。 */
export function overviewSourceIcon(source: OverviewSource): string {
  return source === 'document' ? 'file-text' : source === 'view' ? 'app-window' : source === 'manual' ? 'timer' : 'hourglass';
}

/** Same hour/minute coordinates, with a separate lane and selection identity per ledger. */
export function renderOverviewTracks(
  parent: HTMLElement, tracks: readonly OverviewTrack[], day: string,
  sources: ReadonlySet<OverviewSource>, selected: string | null,
  onSelect: (process: OverviewProcess, hour: number) => void,
  onSelectHour: (hour: number) => void,
  wholeHour = false,
): OverviewTrackLayout {
  const visible = tracks.filter(track => sources.has(track.source));
  const hours = visible.flatMap(track => track.rows.filter(row => row.segments.length > 0).map(row => row.hour));
  if (!hours.length) {
    parent.createDiv({ cls: 'rtt-list-empty', text: t('ovEmpty') });
    return { placeDetail: () => false, placeHourDetail: () => false };
  }
  const wrap = parent.createDiv({ cls: 'rtt-heatmap-wrap rtt-overview-tracks' });
  //  行高随可见来源数收缩：被关掉的轨道不能只变透明，还继续占着高度
  //  Row height follows the number of visible sources: a hidden track must not keep reserving space.
  wrap.setCssProps({ '--rtt-visible-tracks': String(Math.max(1, visible.length)) });
  renderHeatmapAxis(wrap);
  const start = 0;
  const end = 23;
  const base = toAbsoluteMinutes(day + ' 00:00:00')!;
  for (let hour = start; hour <= end; hour++) {
    const row = wrap.createDiv({ cls: 'rtt-hm-row rtt-overview-hour' });
    row.dataset.rttHour = String(hour);
    row.createDiv({ cls: 'rtt-hm-hlabel', text: String(hour).padStart(2, '0') });
    const lanes = row.createDiv({ cls: 'rtt-ov-lanes' });
    let touch: { x: number; y: number } | null = null;
    row.addEventListener('pointerdown', event => {
      const detail = row.querySelector('.rtt-overview-detail');
      touch = event.pointerType === 'touch' && !(detail && event.composedPath().includes(detail)) ? { x: event.clientX, y: event.clientY } : null;
    }, true);
    row.addEventListener('keydown', () => { touch = null; }, true);
    // 细轨道在触屏上共用整小时的命中区，再用原生菜单区分重叠来源。
    // Touch uses the whole hour, with a native chooser for overlapping sources.
    onHeatmapActivate(row, () => {
      if (!touch) return;
      const bar = lanes.querySelector<HTMLElement>('.rtt-hm-bar');
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const minute = Math.min(60, Math.max(0, (touch.x - rect.left) / Math.max(1, rect.width) * 60));
      const pieces = visible.flatMap(track => track.rows[hour].segments);
      const near = pieces.filter(segment => minute >= segment.startMinute - 0.4 && minute <= segment.startMinute + segment.durationMinutes + 0.4);
      //  点在空隙里就是选整小时，和鼠标行为一致 / a tap in a gap selects the hour, same as the mouse
      if (!near.length) { onSelectHour(hour); return; }
      const choices = [...new Map(near.map(segment => [segment.process.id, segment.process])).values()];
      if (wholeHour || choices.length === 1) { onSelect(choices[0], hour); return; }
      if (!choices.length) return;
      const menu = new Menu();
      for (const process of choices) {
        const clock = (absolute: number): string => {
          const date = new Date(day + 'T00:00:00');
          date.setSeconds(Math.round((absolute - base) * 60));
          return formatLocalFull(date).slice(11, 19);
        };
        menu.addItem(item => item.setTitle(overviewSourceName(process.source) + ' · ' + clock(process.startAbs) + '–' + clock(process.endAbs) + (process.session?.note ? ' · ' + process.session.note : ''))
          .onClick(() => onSelect(process, hour)));
      }
      menu.showAtPosition(touch);
    });
    row.removeAttribute('role'); row.removeAttribute('tabindex');
    //  鼠标点空隙/小时标签 = 选整小时；点段仍交给段自己
    //  A mouse click on the row's empty space or hour label selects the whole hour; segments keep
    //  their own handlers.
    row.addEventListener('click', event => {
      if (touch || insideInteractive(event.target)) return;
      onSelectHour(hour);
    });
    //  被图例关掉的来源整条轨道都不画：不给灰点，也不留空进度槽
    //  A source switched off by the legend draws no lane at all — no grey dot, no empty track.
    for (const track of visible) {
      const lane = lanes.createDiv({ cls: 'rtt-ov-lane', attr: { 'data-rtt-source': track.source } });
      const dot = lane.createSpan({ cls: 'rtt-ov-lane-dot ' + sourceClass[track.source] });
      setTooltip(dot, overviewSourceName(track.source));
      const bar = lane.createDiv({ cls: 'rtt-hm-bar', attr: { 'aria-label': overviewSourceName(track.source) } });
      renderHeatmapTrack(bar, track.rows[hour], () => sourceClass[track.source],
        segment => overviewSourceName(track.source) + ' · ' + (segment.process.session?.note || day) + ' · ' + formatDurationWithSeconds(Math.round(segment.durationMinutes * 60)),
        block => { if (!touch) onSelect(block.members[0].process, hour); }, segment => segment.process.id);
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
  return {
    placeDetail: (detail, id, hour) => {
      const row = Array.from(wrap.querySelectorAll<HTMLElement>('.rtt-overview-hour')).find(item => item.dataset.rttHour === String(hour));
      const segment = Array.from(row?.querySelectorAll<HTMLElement>('.rtt-hm-seg') ?? []).find(item => item.dataset.rttGroup === id);
      const lane = segment?.closest<HTMLElement>('.rtt-ov-lane');
      if (!lane) return false;
      if (lane.nextElementSibling !== detail) lane.after(detail);
      return true;
    },
    placeHourDetail: (detail, hour) => {
      const row = Array.from(wrap.querySelectorAll<HTMLElement>('.rtt-overview-hour')).find(item => item.dataset.rttHour === String(hour));
      if (!row) return false;
      if (row.nextElementSibling !== detail) row.after(detail);
      return true;
    },
  };
}
