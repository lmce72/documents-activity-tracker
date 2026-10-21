import { parseSessionStartTime } from './time';
import type { TimelineEvent } from './types';

/** One visit to a target: from becoming active to handing over. */
export interface TargetVisit {
  target: string;
  title?: string;
  from: string;
  to: string;
  activeSeconds: number;
  unfocusedSeconds: number;
  pausedSeconds: number;
  /** Whether a transition out of this visit led to another target. */
  nextTarget: string | null;
}

/** Split a "YYYY-MM-DD HH:mm:ss" into milliseconds for arithmetic. */
function timeMs(value: string): number {
  return parseSessionStartTime(value)?.getTime() ?? 0;
}

/**
 * The stretch as a sequence of visits / 这段时间读过的目标序列.
 *
 * A visit runs from the moment a target became active until it was handed over — by a switch,
 * or by a save that closed it. Blur, focus and pause do not start a visit: they change what the
 * time *means*, so they are accumulated into the visit that contains them rather than becoming
 * nodes of their own.
 */
export function buildVisits(events: readonly TimelineEvent[], from: string, to: string): TargetVisit[] {
  const visits: TargetVisit[] = [];
  // A holder rather than a captured `let`: TypeScript narrows a mutable capture to `never`
  // once a helper assigns null to it, and every read afterwards fails to type-check.
  const holder: { visit: TargetVisit | null } = { visit: null };
  let state: 'active' | 'unfocused' | 'paused' = 'active';
  let stateSince = '';

  const bank = (until: string): void => {
    const visit = holder.visit;
    if (!visit || !stateSince) return;
    const seconds = Math.max(0, (timeMs(until) - Math.max(timeMs(stateSince), timeMs(from))) / 1000);
    if (state === 'active') visit.activeSeconds += seconds;
    else if (state === 'unfocused') visit.unfocusedSeconds += seconds;
    else visit.pausedSeconds += seconds;
  };

  const open = (target: string, at: string, title?: string): void => {
    if (!target) return;

    // Already reading this target: a second `start`, or a `switch` that names the file it is
    // already on. The log really contains those (an older build wrote every switch twice), and
    // honouring them would split one visit into several identical nodes.
    if (holder.visit?.target === target && holder.visit.title === title) return;

    // The file was closed by a save and immediately started again. Reopening the previous visit
    // keeps it one node; anything else would print the same target twice in a row with nothing
    // between them to explain the split.
    const last = visits[visits.length - 1];
    if (!holder.visit && last && last.target === target && last.title === title && last.to === at) {
      holder.visit = last;
      state = 'active';
      stateSince = at;
      return;
    }

    bank(at);
    if (holder.visit) holder.visit.to = at;
    const visit: TargetVisit = {
      target,
      title,
      from: at < from ? from : at,
      to: at,
      activeSeconds: 0,
      unfocusedSeconds: 0,
      pausedSeconds: 0,
      nextTarget: null,
    };
    holder.visit = visit;
    visits.push(visit);
    state = 'active';
    stateSince = at;
  };

  const close = (at: string): void => {
    const visit = holder.visit;
    if (!visit) return;
    bank(at);
    visit.to = at;
    holder.visit = null;
    stateSince = '';
  };

  for (const event of events) {
    if (event.time > to) continue;

    switch (event.type) {
      case 'start':
        open(event.file, event.time, event.activityTitle);
        break;
      case 'activity': {
        const previousState: 'active' | 'unfocused' | 'paused' = state;
        close(event.time);
        open(event.file, event.time, event.activityTitle);
        state = previousState;
        break;
      }
      case 'switch': {
        const previous = holder.visit;
        const next = event.to ?? '';
        close(event.time);
        if (previous && next && previous.target !== next) previous.nextTarget = next;
        open(next, event.time);
        break;
      }
      case 'blur':
        bank(event.time);
        state = event.unfocusedDisposition === 'reading' ? 'active' : event.unfocusedDisposition === 'paused' ? 'paused' : 'unfocused';
        stateSince = event.time;
        break;
      case 'focus':
        bank(event.time);
        state = 'active';
        stateSince = event.time;
        break;
      case 'pause':
        bank(event.time);
        state = 'paused';
        stateSince = event.time;
        break;
      case 'resume':
        bank(event.time);
        state = 'active';
        stateSince = event.time;
        break;
      case 'save':
      case 'auto-save':
      case 'discard':
        close(event.time);
        break;
      default:
        break;
    }
  }

  // The last visit runs to the end of the stretch: nothing closed it.
  if (holder.visit) {
    bank(to);
    holder.visit.to = to;
  }

  // A visit that banked nothing is a leftover boundary, not a reading stretch.
  const withTime = visits.filter((visit) => visit.activeSeconds + visit.unfocusedSeconds + visit.pausedSeconds > 0);
  return withTime;
}

