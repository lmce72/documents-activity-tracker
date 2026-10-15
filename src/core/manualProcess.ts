import { parseSessionStartTime } from './time';
import { flagIntervals } from './manualTimeline';
import type { ManualSession } from './types';

export interface ManualProcessStep {
  kind: 'start' | 'pause' | 'resume' | 'flag' | 'stop';
  time: string;
  endTime?: string;
  recordedSeconds: number;
  durationSeconds?: number;
  flagIndex?: number;
  label?: string;
  intervalSeconds?: number;
  activeRanges?: Array<{ from: string; to: string }>;
}

/** 相邻 flag 之间的实际计时时段，扣除所有暂停 / active ranges between flags, excluding pauses. */
export function manualFlagActiveRanges(session: ManualSession, index: number): Array<{ from: string; to: string }> {
  const from = index > 0 ? session.flags[index - 1]?.atTime : session.startTime;
  const to = session.flags[index]?.atTime;
  if (!from || !to) return [];
  const fromMs = parseSessionStartTime(from)?.getTime();
  const toMs = parseSessionStartTime(to)?.getTime();
  if (fromMs === undefined || toMs === undefined || toMs <= fromMs) return [];
  const pauses = session.pauses.flatMap((pause) => {
    const start = parseSessionStartTime(pause.from)?.getTime();
    const end = parseSessionStartTime(pause.to)?.getTime();
    return start !== undefined && end !== undefined && end > start ? [{ ...pause, start, end }] : [];
  }).sort((a, b) => a.start - b.start);
  const ranges: Array<{ from: string; to: string }> = [];
  let cursor = fromMs;
  let cursorTime = from;
  for (const pause of pauses) {
    if (pause.end <= cursor || pause.start >= toMs) continue;
    if (pause.start > cursor) ranges.push({ from: cursorTime, to: pause.from });
    if (pause.end >= toMs) { cursor = toMs; break; }
    cursor = pause.end;
    cursorTime = pause.to;
  }
  if (cursor < toMs) ranges.push({ from: cursorTime, to });
  return ranges;
}

/** 一轮的完整操作过程，暂停不计入累计时间 / full round, with pauses excluded from net time. */
export function buildManualProcess(session: ManualSession): ManualProcessStep[] {
  const start = parseSessionStartTime(session.startTime)?.getTime();
  const end = parseSessionStartTime(session.endTime)?.getTime();
  if (start === undefined || end === undefined || end < start) return [];
  const pauses = session.pauses.flatMap((pause) => {
    const from = parseSessionStartTime(pause.from)?.getTime();
    const to = parseSessionStartTime(pause.to)?.getTime();
    return from !== undefined && to !== undefined && from >= start && to <= end && to >= from
      ? [{ ...pause, fromMs: from, toMs: to }] : [];
  });
  const netAt = (time: string): number => {
    const at = parseSessionStartTime(time)?.getTime() ?? start;
    const paused = pauses.reduce((sum, pause) => sum + Math.max(0, Math.min(at, pause.toMs) - pause.fromMs), 0);
    return Math.max(0, Math.floor((at - start - paused) / 1000));
  };
  const steps: ManualProcessStep[] = [{ kind: 'start', time: session.startTime, recordedSeconds: 0 }];
  for (const pause of pauses) {
    steps.push({ kind: 'pause', time: pause.from, endTime: pause.to, recordedSeconds: netAt(pause.from), durationSeconds: Math.floor((pause.toMs - pause.fromMs) / 1000) });
    // 停止时闭合的暂停不表示用户按过继续 / closing a pause at stop is not a resume.
    if (pause.toMs < end) steps.push({ kind: 'resume', time: pause.to, recordedSeconds: netAt(pause.to) });
  }
  const intervals = flagIntervals(session.flags);
  session.flags.forEach((flag, index) => steps.push({ kind: 'flag', time: flag.atTime,
    recordedSeconds: flag.atSeconds, flagIndex: index + 1, label: flag.label, intervalSeconds: intervals[index], activeRanges: manualFlagActiveRanges(session, index) }));
  steps.push({ kind: 'stop', time: session.endTime, recordedSeconds: session.durationSeconds });
  const order = { start: 0, pause: 1, flag: 2, resume: 3, stop: 4 };
  return steps.sort((a, b) => (parseSessionStartTime(a.time)?.getTime() ?? start) - (parseSessionStartTime(b.time)?.getTime() ?? start) || order[a.kind] - order[b.kind]);
}
