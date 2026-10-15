import { parseSessionStartTime } from './time';
import { UNFOCUSED_ATTRIBUTION_CAP_SECONDS } from './constants';
import type { TimelineEvent } from './types';

export type UnfocusedDisposition = 'reading' | 'paused' | 'unfocused';
export interface UnfocusedInterval {
  index: number;
  filePath: string;
  from: string;
  to: string | null;
  seconds: number;
  disposition: UnfocusedDisposition;
}

/** 原始失焦边界保留，归属可撤销 / retain original boundaries for reversible attribution. */
export function listUnfocusedIntervals(events: readonly TimelineEvent[]): UnfocusedInterval[] {
  const out: UnfocusedInterval[] = [];
  const nextByFile = new Map<string, TimelineEvent>();
  const discarded = new Set<string>();
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === 'switch') { nextByFile.set(event.from, event); continue; }
    const next = nextByFile.get(event.file);
    nextByFile.set(event.file, event);
    if (event.type === 'discard') { discarded.add(event.file); continue; }
    if (event.type === 'start' || event.type === 'save' || event.type === 'auto-save') discarded.delete(event.file);
    if (discarded.has(event.file)) continue;
    if (event.type !== 'blur' && !event.unfocusedDisposition && event.state !== 'inactive') continue;
    const fromMs = parseSessionStartTime(event.time)?.getTime();
    const toMs = next ? parseSessionStartTime(next.time)?.getTime() : undefined;
    const seconds = fromMs !== undefined && toMs !== undefined ? Math.max(0, (toMs - fromMs) / 1000) : 0;
    out.push({ index, filePath: event.file, from: event.time, to: next?.time ?? null,
      seconds, disposition: event.unfocusedDisposition ?? 'unfocused' });
  }
  return out.reverse();
}

export function classifyUnfocusedInterval(
  events: readonly TimelineEvent[], index: number, disposition: UnfocusedDisposition,
): { events: TimelineEvent[]; delta: { activeSeconds: number; unfocusedSeconds: number; pausedSeconds: number } } {
  const interval = listUnfocusedIntervals(events).find((item) => item.index === index);
  if (!interval?.to) throw new Error('Only closed unfocused intervals can be classified');
  if (interval.seconds > UNFOCUSED_ATTRIBUTION_CAP_SECONDS) throw new Error('Interval exceeds the credible duration limit');
  const channel = (kind: UnfocusedDisposition) => kind === 'reading' ? 'activeSeconds' : kind === 'paused' ? 'pausedSeconds' : 'unfocusedSeconds';
  const delta = { activeSeconds: 0, unfocusedSeconds: 0, pausedSeconds: 0 };
  delta[channel(interval.disposition)] -= interval.seconds;
  delta[channel(disposition)] += interval.seconds;
  let settled = false;
  const updated = events.map((event, i): TimelineEvent => {
    if (i === index) return { ...event, unfocusedDisposition: disposition } as TimelineEvent;
    if (i <= index || settled) return { ...event };
    if (event.type === 'switch') {
      if (event.from === interval.filePath) settled = true;
    } else if (event.file === interval.filePath) {
      if (event.type === 'save' || event.type === 'auto-save') {
        settled = true;
        return { ...event,
          ...(event.activeSeconds !== undefined ? { activeSeconds: Math.max(0, event.activeSeconds + delta.activeSeconds) } : {}),
          ...(event.unfocusedSeconds !== undefined ? { unfocusedSeconds: Math.max(0, event.unfocusedSeconds + delta.unfocusedSeconds) } : {}),
        };
      }
      if (event.type === 'start' || event.type === 'discard') settled = true;
    }
    return { ...event };
  });
  return { events: updated, delta };
}
