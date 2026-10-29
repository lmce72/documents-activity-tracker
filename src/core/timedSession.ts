import { toAbsoluteMinutes } from './recordsTimeline';

export interface TimedSession {
  startTime: string;
  endTime?: string;
  durationSeconds: number;
  pauses?: readonly { from: string; to: string }[];
}
export interface SessionSpan { startAbs: number; endAbs: number }

/** Wall-clock extent of a round, including its pauses. */
export function sessionExtent(session: TimedSession): SessionSpan | null {
  const startAbs = toAbsoluteMinutes(session.startTime);
  if (startAbs === null) return null;
  const end = session.endTime ? toAbsoluteMinutes(session.endTime) : null;
  const endAbs = end !== null && end > startAbs ? end : startAbs + Math.max(0, session.durationSeconds) / 60;
  return endAbs > startAbs ? { startAbs, endAbs } : null;
}

/** Actual active positions; the saved net duration caps incomplete legacy pause data. */
export function sessionActiveSpans(session: TimedSession): SessionSpan[] {
  const extent = sessionExtent(session);
  if (!extent || session.durationSeconds <= 0) return [];
  const pauses = (session.pauses ?? []).flatMap(pause => {
    const startAbs = toAbsoluteMinutes(pause.from);
    const endAbs = toAbsoluteMinutes(pause.to);
    return startAbs !== null && endAbs !== null && endAbs > startAbs ? [{ startAbs, endAbs }] : [];
  }).sort((a, b) => a.startAbs - b.startAbs);
  const ranges: SessionSpan[] = [];
  let cursor = extent.startAbs;
  for (const pause of pauses) {
    if (pause.endAbs <= cursor || pause.startAbs >= extent.endAbs) continue;
    if (pause.startAbs > cursor) ranges.push({ startAbs: cursor, endAbs: Math.min(pause.startAbs, extent.endAbs) });
    cursor = Math.min(extent.endAbs, Math.max(cursor, pause.endAbs));
  }
  if (cursor < extent.endAbs) ranges.push({ startAbs: cursor, endAbs: extent.endAbs });
  let remaining = session.durationSeconds / 60;
  return ranges.flatMap(range => {
    const duration = Math.min(remaining, range.endAbs - range.startAbs);
    remaining -= duration;
    return duration > 1e-7 ? [{ startAbs: range.startAbs, endAbs: range.startAbs + duration }] : [];
  });
}
