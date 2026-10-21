/**
 * Timeline-derived computations
 *
 * Origins:
 *
 * Changes:
 *      All turned into pure functions taking the timeline as a parameter.
 *      `buildFileRecords` takes `now` as a parameter for deterministic testing.
 *      `removeFileEvents` keeps the original's switch-aware reference check.
 *
 */

import { isPluginViewKey, pluginViewLabel } from './activePath';
import { UNFOCUSED_ATTRIBUTION_CAP_SECONDS } from './constants';
import { calculateSessionDuration } from './session';
import { parseSessionStartTime, todayStr } from './time';
import type {
  FileRecord,
  SessionStateMap,
  TimelineEvent,
  TimerFileState,
} from './types';
import { eventFileRefs } from './migration';
import { liveWallClockSeconds } from './types';

/** Max credible unfinished session: 24h. */
export const MAX_SESSION_DURATION = 24 * 60 * 60;

/** Whether an event closes a session. */
function isSaveLike(event: TimelineEvent): boolean {
  return event.type === 'save' || event.type === 'auto-save';
}

/** A session's three-channel durations. */
export interface SessionDurations {
  /** in-window active seconds */
  activeSeconds: number;
  /** out-of-window seconds */
  unfocusedSeconds: number;
  /** focused-but-idle seconds / 有焦点但无输入 */
  idleSeconds: number;
  /** paused seconds */
  pausedSeconds: number;
  /** an unclosed session older than 24h */
  abnormal: boolean;
}

function eventState(event: TimelineEvent): string | undefined {
  return (event as { state?: string }).state;
}

/**
 * Whether an event can start an attributed interval.
 */
function isAttributable(event: TimelineEvent): boolean {
  if (event.type === 'switch') return false;
  if (isSaveLike(event) || event.type === 'discard') return false;
  return eventState(event) !== undefined || event.type === 'blur' || event.type === 'focus';
}

/**
 * Attribute one session's durations from its event stream.
 *
 * This is the key handling for unfocused time and also fixes an existing defect: the old
 * implementation counted blur stretches as active, because a blur event carries the state
 * it had *before* blurring (`tracking` in real data) and `calculateSessionDuration` looks
 * only at states. Here the event type wins: an interval starting at a blur goes to
 * `unfocusedSeconds` regardless of its `state`, so old and new data agree.
 *
 *               the end to extrapolate to for an open session; null when closed
 * whether the session is still open
 */
export function computeSessionDurations(
  events: readonly TimelineEvent[],
  nowMs: number | null,
  isOpen: boolean,
  endBoundMs: number | null = null,
): SessionDurations {
  const empty: SessionDurations = {
    activeSeconds: 0,
    unfocusedSeconds: 0,
    idleSeconds: 0,
    pausedSeconds: 0,
    abnormal: false,
  };
  if (events.length === 0) return empty;

  const boundaries = events.filter((e) => isAttributable(e) || isSaveLike(e) || e.type === 'discard');
  if (boundaries.length === 0) return empty;

  let activeSeconds = 0;
  let unfocusedSeconds = 0;
  let idleSeconds = 0;
  let pausedSeconds = 0;
  let abnormal = false;

  for (let i = 0; i < boundaries.length; i++) {
    const current = boundaries[i]!;

    if (isSaveLike(current) || current.type === 'discard') continue;

    const startMs = parseSessionStartTime(current.time);
    if (!startMs) continue;

    let endMs: number | null = null;
    let extrapolated = false;
    const next = boundaries[i + 1];
    if (next) {
      endMs = parseSessionStartTime(next.time)?.getTime() ?? null;
    } else if (isOpen && nowMs !== null) {
      endMs = nowMs;
      extrapolated = true;
    } else if (endBoundMs !== null) {
      // A session that never received a closing event, but which a later event superseded.
      // Ending the tail here is measured evidence; extrapolating it to `now` would invent
      // whatever time passed since — hours, for a session that ended in the morning.
      endMs = endBoundMs;
    }
    if (endMs === null) continue;

    const gap = (endMs - startMs.getTime()) / 1000;
    if (gap <= 0) continue;

    //  Only the extrapolated tail is guarded by the 24h rule. An interval bounded by two
    //  real events is measured evidence and must be kept even if the session never
    //  closed; zeroing the whole session would discard real readings.
    if (extrapolated && gap > MAX_SESSION_DURATION) {
      console.warn(
        '[RTT][timeline] 跳过异常未闭合会话 / skipping abnormal open session:',
        current.time,
      );
      abnormal = true;
      continue;
    }

    const state = eventState(current);

    if ('unfocusedDisposition' in current && current.unfocusedDisposition) {
      if (gap <= UNFOCUSED_ATTRIBUTION_CAP_SECONDS) {
        //  归类优先：显式的「算作阅读/暂停」压过事件类型；显式的「不算」在空闲段里落回空闲通道，
        //  而不是失焦通道 —— 那一段本来就是空闲，不是离开窗口。
        //  Classification wins: an explicit reading/paused overrides the event type, and an explicit
        //  "not counted" on an idle stretch falls back to the idle channel — that stretch was idle,
        //  not out-of-window.
        if (current.unfocusedDisposition === 'reading') activeSeconds += gap;
        else if (current.unfocusedDisposition === 'paused') pausedSeconds += gap;
        //  明确的「不记录」：哪条通道都不进 / an explicit "do not record" enters no channel
        else if (current.unfocusedDisposition === 'ignored') { /* nowhere */ }
        else if (current.type === 'idle' || state === 'idle') idleSeconds += gap;
        else unfocusedSeconds += gap;
      }
      continue;
    }
    if (current.type === 'idle' || state === 'idle') {

      //  空闲不做 4h 上限裁剪：它是有焦点但不动的时段，长也仍然可信
      //  Idle is not capped at 4h: it means "focused but still", and a long stretch is credible
      idleSeconds += gap;
      continue;
    }
    if (current.type === 'blur' || state === 'inactive') {

      if (gap <= UNFOCUSED_ATTRIBUTION_CAP_SECONDS) unfocusedSeconds += gap;
      continue;
    }

    if (current.type === 'pause' || state === 'pausing') {
      pausedSeconds += gap;
    } else if (current.type === 'focus' || state === 'tracking') {
      activeSeconds += gap;
    }
  }

  return { activeSeconds, unfocusedSeconds, idleSeconds, pausedSeconds, abnormal };
}

/**
 * Build the per-file view records in a single pass over the timeline.
 *
 * Single pass: split the event stream into sessions with `currentSession`, then
 * aggregate per file — O(events + sessions), independent of file count.
 *
 * current time for open sessions
 * today's date string
 */
export function buildFileRecords(
  timeline: readonly TimelineEvent[],
  nowMs: number,
  today: string = todayStr(),
  options: { countUnfocused?: boolean; countPluginViews?: boolean } = {},
): Record<string, FileRecord> {
  //  Reading is "in-window plus out-of-window" unless the user turned that off. The
  //  out-of-window figures are still collected either way — the toggle changes what counts
  //  toward a total, never what is recorded or shown on its own.
  const countUnfocused = options.countUnfocused !== false;
  const fileRecords: Record<string, FileRecord> = {};
  if (timeline.length === 0) return fileRecords;

  interface OpenSession {
    filePath: string;
    events: TimelineEvent[];
    /**
     * When the session was observed to end, i.e. the timestamp of the event that superseded
     * it; null while it is still the running session.
     */
    endedAt: string | null;
  }
  const fileSessions: Record<string, OpenSession[]> = {};

  const closeSession = (session: OpenSession, endedAt: string | null): void => {
    session.endedAt = endedAt;
    (fileSessions[session.filePath] ??= []).push(session);
  };

  let currentSession: OpenSession | null = null;

  for (const event of timeline) {
    const filePath =
      event.type === 'switch' ? event.to : (event as { file?: string }).file;
    if (!filePath) continue;

    if (event.type === 'start') {
      // A new session begins, so whatever was running ended at this instant. Recording
      // *when* it ended is what keeps a superseded session from being mistaken for a live
      // one and extrapolated to `now` (see computeSessionDurations).
      if (currentSession) closeSession(currentSession, event.time);
      currentSession = { filePath: event.file, events: [event], endedAt: null };
      continue;
    }

    if (!currentSession) continue;

    if (
      (event.type !== 'switch' && event.file === currentSession.filePath) ||
      (event.type === 'switch' && event.to === currentSession.filePath)
    ) {
      currentSession.events.push(event);
    }

    // A switch AWAY from the running file ends that session.
    //
    // The service normally writes an auto-save first, but that save is skipped when the
    // session falls below `minReadSeconds`, leaving the switch as the only evidence that
    // the session ended. Without this, such a session stays "unclosed" for the rest of the
    // day and its tail is extrapolated to `now` — measured on real data: two sessions whose
    // combined span was under two seconds were reported as 12.6 hours.
    const switchedAway =
      event.type === 'switch' &&
      event.from === currentSession.filePath &&
      event.to !== currentSession.filePath;

    if (isSaveLike(event) || event.type === 'discard' || switchedAway) {
      const belongsToCurrent =
        event.type === 'switch' ? switchedAway : event.file === currentSession.filePath;
      if (belongsToCurrent) {
        // discard drops the session wholesale, so it never needs an end bound.
        if (event.type === 'discard') currentSession = null;
        else {
          closeSession(currentSession, event.time);
          currentSession = null;
        }
      }
    }
  }

  // Only this last session is genuinely still running, and only it may be extrapolated.
  if (currentSession) closeSession(currentSession, null);

  for (const [filePath, sessions] of Object.entries(fileSessions)) {
    const readTimeLine: SessionStateMap[] = [];
    let totalReadTime = 0;
    let unfocusedReadTime = 0;
    let unfocusedReadTimeToday = 0;
    let readTimeToday = 0;
    let lastReadAt = '';
    let hasAbnormalSession = false;
    let activityTitle: string | undefined;

    for (const session of sessions) {
      if (session.events.length === 0) continue;

      const sessionObj: SessionStateMap = {};

      for (const event of session.events) {
        if ('activityTitle' in event && event.activityTitle) activityTitle = event.activityTitle;
        const disposition = 'unfocusedDisposition' in event ? event.unfocusedDisposition : undefined;
        const state = disposition
          ? disposition === 'reading' ? 'tracking'
            : disposition === 'paused' ? 'pausing'
              : disposition === 'ignored' ? 'ignored'
                : 'inactive'
          : event.type === 'blur' ? 'inactive' : (event as { state?: string }).state;
        if (state) {
          sessionObj[event.time] = state as SessionStateMap[string];
        } else if (event.type === 'save' || event.type === 'auto-save') {
          sessionObj[event.time] = 'saved';
        } else if (event.type === 'discard') {

          //  The original wrote 'discarded' here, but this branch is unreachable: a session
          //  closed by discard is dropped wholesale and never enters readTimeLine, so the
          //  value is never read. 'saved' keeps it inside SessionState's domain.
          sessionObj[event.time] = 'saved';
        }
      }

      //  A session that ended because a later event superseded it carries no closing entry
      //  of its own, so `sessionObj` holds a single timestamp. Every interval walk needs a
      //  pair, so the final stretch would be invisible: missing from the heatmaps, and
      //  missing from the overview's ledgers — measured, a six-second canvas session that
      //  `computeSessionDurations` counted correctly showed as 0 in the overview.
      //  Recording the observed end the way a save does closes that gap, and keeps the two
      //  accounting paths agreeing.
      if (session.endedAt !== null && !(session.endedAt in sessionObj)) {
        sessionObj[session.endedAt] = 'saved';
      }

      const keys = Object.keys(sessionObj);
      if (keys.length === 0) continue;

      readTimeLine.push(sessionObj);

      //  Three-channel attribution, event-type driven. This also replaces the old
      //  "extrapolate only for a lone start" special case: once the service logs
      //  blur/focus/pause/resume, an in-progress session is no longer a lone start and
      //  that special case would report 0 for it.
      //
      //  `isOpen` is decided by `endedAt`, not by whether a save event was seen. A session
      //  with no closing event that a later event superseded is finished — it just was not
      //  worth a save (below `minReadSeconds`) — and must not be extrapolated to `now`.
      const durations = computeSessionDurations(
        session.events,
        nowMs,
        session.endedAt === null,
        session.endedAt ? (parseSessionStartTime(session.endedAt)?.getTime() ?? null) : null,
      );
      if (durations.abnormal) hasAbnormalSession = true;

      //  Total reading time = in-window + out-of-window, the second half only when the user
      //  counts it as reading.
      const sessionDuration =
        options.countPluginViews === false && isPluginViewKey(filePath) ? 0
          : durations.activeSeconds + (countUnfocused ? durations.unfocusedSeconds : 0);
      totalReadTime += sessionDuration;
      unfocusedReadTime += durations.unfocusedSeconds;

      const sorted = keys.slice().sort();
      const firstTime = sorted[0]!;
      if (firstTime.startsWith(today)) {
        readTimeToday += sessionDuration;
        // Scoped to today like `readTimeToday`, so a today-only view never pairs a
        // today figure with an all-time one.
        unfocusedReadTimeToday += durations.unfocusedSeconds;
      }

      const lastTime = sorted[sorted.length - 1]!;
      if (lastTime > lastReadAt) lastReadAt = lastTime;
    }

    fileRecords[filePath] = {
      //  Plugin views have no filename; naming them here means every consumer (lists, the
      //  records browser, its search box, modal headings) reads well without special cases.
      fileName: isPluginViewKey(filePath)
        ? activityTitle || pluginViewLabel(filePath)
        : (filePath.split('/').pop() ?? filePath).replace(/\.md$/, ''),
      totalReadTime,
      unfocusedReadTime,
      unfocusedReadTimeToday,
      readTimeToday,
      lastReadAt: lastReadAt.slice(0, 10),
      readTimeLine,
      hasAbnormalSession,
    };
  }

  return fileRecords;
}

/**
 * Recompute aggregates from a session list.
 */
export function recalcAggregates(
  readTimeLine: readonly SessionStateMap[],
  today: string = todayStr(),
): { totalReadTime: number; readTimeToday: number } {
  let totalReadTime = 0;
  let readTimeToday = 0;

  for (const session of readTimeLine) {
    const activeSec = calculateSessionDuration(session);
    totalReadTime += activeSec;

    const timestamps = Object.keys(session).sort();
    if (timestamps.length > 0 && timestamps[0]!.startsWith(today)) {
      readTimeToday += activeSec;
    }
  }

  return { totalReadTime, readTimeToday };
}

/**
 * Today's reading seconds for one file.
 *
 * Two parts — settled events today plus the in-progress session — both counted as
 * in-window + out-of-window, since unfocused time is reading time too.
 */
export function getTodaySeconds(
  timeline: readonly TimelineEvent[],
  file: TimerFileState | null | undefined,
  filePath: string,
  today: string = todayStr(),
  countUnfocused = true,
  countPluginViews = true,
): number {
  if (!countPluginViews && isPluginViewKey(filePath)) return 0;
  let total = 0;

  for (const event of timeline) {
    if (event.type === 'switch') continue;
    if (event.file !== filePath || !event.time.startsWith(today)) continue;
    if (isSaveLike(event)) {
      const e = event as { activeSeconds?: number; unfocusedSeconds?: number };
      total += (e.activeSeconds ?? 0) + (countUnfocused ? (e.unfocusedSeconds ?? 0) : 0);
    }
  }

  if (file?.sessionStartTime?.startsWith(today)) {
    total += file.activeSeconds + (countUnfocused ? file.unfocusedSeconds : 0);
  }

  return total;
}

/**
 * 该文件今天的第几轮 / which round of the day this file is on.
 *
 * 返回的是**轮号**（从 1 起），不是"已完成的轮数"：已结算的轮次加一。正在计时时那加的一轮就是眼
 * 下这一轮，没在计时时它就是接下来要开始的那一轮 —— 两种情况必须给出同一个数，否则按下开始的
 * 瞬间数字会跳一下（3 → 4），看上去像丢了一轮。
 *
 * The **round number** (1-based), not a count of finished rounds: settled rounds plus one. While a
 * session runs that one is the round in progress; while nothing runs it is the round about to start.
 * Both cases have to name the same number, or the figure jumps the moment the user presses start
 * (3 → 4) and reads as a lost round.
 */
export function getTodaySessionCount(
  timeline: readonly TimelineEvent[],
  filePath: string,
  today: string = todayStr(),
): number {
  let count = 0;

  for (const event of timeline) {
    if (event.type === 'switch') continue;
    if (event.file !== filePath || !event.time.startsWith(today)) continue;
    if (isSaveLike(event)) count++;
  }

  //  会话状态不再参与：轮号只由已结算的事件决定，于是"正在跑"和"还没开始"自动给出同一个数 ——
  //  不必再区分，也就不会出现两处算法各自漂移。
  //  The session state no longer takes part: the round number comes only from settled events, so
  //  "running" and "not started yet" agree by construction rather than by two branches kept in step.
  return count + 1;
}

/**
 * Vault-wide reading seconds today.
 * Same basis as getTodaySeconds: in-window + out-of-window.
 */
export function getAllTodaySeconds(
  timeline: readonly TimelineEvent[],
  files: Iterable<TimerFileState>,
  today: string = todayStr(),
  countUnfocused = true,
  countPluginViews = true,
): number {
  let total = 0;

  for (const event of timeline) {
    if (event.type === 'switch') continue;
    if (!countPluginViews && isPluginViewKey(event.file)) continue;
    if (event.time.startsWith(today) && isSaveLike(event)) {
      const e = event as { activeSeconds?: number; unfocusedSeconds?: number };
      total += (e.activeSeconds ?? 0) + (countUnfocused ? (e.unfocusedSeconds ?? 0) : 0);
    }
  }

  for (const file of files) {
    if (!countPluginViews && isPluginViewKey(file.filePath)) continue;
    if (file.sessionStartTime?.startsWith(today)) {
      total += file.activeSeconds + (countUnfocused ? file.unfocusedSeconds : 0);
    }
  }

  return total;
}

/**
 * 某一天三种渠道的秒数 / one day's seconds, split by channel.
 *
 * 统计卡要把"今日总时长"拆成阅读与非阅读，而 `getAllTodaySeconds` 只给合计，所以这里按渠道返回。
 * 两个来源与它一致：已结算的保存事件，以及正在进行中的会话（其尾段尚未落盘）。
 *
 * The stat grid has to split "today total" into reading and non-reading, and
 * `getAllTodaySeconds` only yields the sum, so this returns the channels. Same two sources as
 * it: settled save events plus the session still in progress (whose tail is not on disk yet).
 */
export interface DayChannelSeconds {
  /** 窗口内专注 / in-window focused seconds */
  activeSeconds: number;
  /** 脱离窗口 / out-of-window seconds */
  unfocusedSeconds: number;
  /** 有焦点但空闲 / focused-but-idle seconds */
  idleSeconds: number;
  /** 暂停 / paused seconds */
  pausedSeconds: number;
}

export function getDayChannelSeconds(
  timeline: readonly TimelineEvent[],
  files: Iterable<TimerFileState>,
  day: string = todayStr(),
  nowMs?: number,
): DayChannelSeconds {
  const totals: DayChannelSeconds = {
    activeSeconds: 0,
    unfocusedSeconds: 0,
    idleSeconds: 0,
    pausedSeconds: 0,
  };

  for (const event of timeline) {
    if (event.type === 'switch' || event.type === 'discard') continue;
    if (!event.time.startsWith(day) || !isSaveLike(event)) continue;

    const e = event as {
      activeSeconds?: number;
      unfocusedSeconds?: number;
      idleSeconds?: number;
      duration?: number;
    };
    const active = e.activeSeconds ?? 0;
    const unfocused = e.unfocusedSeconds ?? 0;
    const idle = e.idleSeconds ?? 0;

    totals.activeSeconds += active;
    totals.unfocusedSeconds += unfocused;
    totals.idleSeconds += idle;

    //  duration 是这次会话的墙钟总时长，减去三条已知渠道，剩下的就是暂停；旧事件没有
    //  duration，按"没有暂停"处理，不猜。
    //  `duration` is the session's wall clock, so whatever is left after the known channels is
    //  paused time. Older events carry no `duration` and are treated as having no paused part
    //  rather than being guessed at.
    totals.pausedSeconds += Math.max(0, (e.duration ?? active + unfocused + idle) - active - unfocused - idle);
  }

  for (const file of files) {
    if (!file.sessionStartTime?.startsWith(day)) continue;
    totals.activeSeconds += file.activeSeconds;
    totals.unfocusedSeconds += file.unfocusedSeconds;
    totals.idleSeconds += file.idleSeconds ?? 0;
    totals.pausedSeconds += nowMs === undefined ? file.pausedSeconds
      : liveWallClockSeconds(file, nowMs) - file.activeSeconds - file.unfocusedSeconds - (file.idleSeconds ?? 0);
  }

  return totals;
}

/**
 * Remove every event referring to a file.
 *
 * Replaces the direct `_cache.timeline` assignment at ReadRecordsModal:4541.
 * The reference check must cover a switch event's from/to, or those become orphans.
 */
export function removeFileEvents(
  timeline: readonly TimelineEvent[],
  filePath: string,
): TimelineEvent[] {
  return timeline.filter((event) => !eventFileRefs(event).includes(filePath));
}

/**
 */
export function getFileEvents(
  timeline: readonly TimelineEvent[],
  filePath: string,
): TimelineEvent[] {
  return timeline.filter((event) => eventFileRefs(event).includes(filePath));
}

/**
 * Filter events into a time range (inclusive on both ends).
 */
export function getTimeRangeEvents(
  timeline: readonly TimelineEvent[],
  start: string,
  end: string,
): TimelineEvent[] {
  return timeline.filter((event) => event.time >= start && event.time <= end);
}
