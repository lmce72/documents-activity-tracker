/**
 * 时间轴派生计算 / Timeline-derived computations
 *
 * 来源 / Origins:
 *   - `buildFileRecords`      ← vault 版 ReadRecordsModal._buildFileRecordsFromTimeline (3952-4104)
 *   - `recalcAggregates`      ← 工程目录版 ReadTimeEngine._recalcAggregates (1636-1656)
 *   - `getTodaySeconds`       ← vault 版 HeaderWidget._getTodaySeconds (3151-3173)
 *   - `getTodaySessionCount`  ← vault 版 HeaderWidget._getTodaySessionCount (3182-3202)
 *   - `getAllTodaySeconds`    ← vault 版 HeaderWidget._getAllTodaySeconds (3218-3239)
 *   - `removeFileEvents`      ← 取代 vault 版 ReadRecordsModal 第 4541 行对
 *                               `dataStore._cache.timeline` 的直接赋值（且当时未落盘）
 *
 * 本次改动 / Changes:
 *   1. 全部抽为纯函数：timeline 作为参数传入，不再从 `dataStore._cache` 里穿透读取。
 *      All turned into pure functions taking the timeline as a parameter.
 *   2. `buildFileRecords` 的「当前时间」改为注入，便于确定性测试。
 *      `buildFileRecords` takes `now` as a parameter for deterministic testing.
 *   3. `removeFileEvents` 修正了原实现的引用判定：switch 事件用 from/to，
 *      原过滤条件已正确处理，这里保持并加注释。
 *      `removeFileEvents` keeps the original's switch-aware reference check.
 *
 * 本模块是第 0 层，只依赖 constants / types / time / session。
 */

import { calculateSessionDuration } from './session';
import { todayStr } from './time';
import type {
  FileRecord,
  SessionStateMap,
  TimelineEvent,
  TimerFileState,
} from './types';
import { eventFileRefs } from './migration';

/** 未闭合会话的最大可信时长（秒）：24 小时 / Max credible unfinished session: 24h. */
export const MAX_SESSION_DURATION = 24 * 60 * 60;

/** 判断事件是否代表一次「已结算」的阅读 / Whether an event closes a session. */
function isSaveLike(event: TimelineEvent): boolean {
  return event.type === 'save' || event.type === 'auto-save';
}

/**
 * 从 timeline 一次性构建所有文件的视图记录。
 * Build the per-file view records in a single pass over the timeline.
 *
 * 单遍扫描：先用 `currentSession` 把事件流切成一个个会话，再按文件汇总。
 * 复杂度 O(事件数 + 会话数)，与文件数无关。
 * Single pass: split the event stream into sessions with `currentSession`, then
 * aggregate per file — O(events + sessions), independent of file count.
 *
 * @param timeline 时间轴事件（假定按时间升序）/ events, assumed time-ascending
 * @param nowMs   当前时间戳，用于未闭合会话的时长推算 / current time for open sessions
 * @param today   今日日期串 / today's date string
 */
export function buildFileRecords(
  timeline: readonly TimelineEvent[],
  nowMs: number,
  today: string = todayStr(),
): Record<string, FileRecord> {
  const fileRecords: Record<string, FileRecord> = {};
  if (timeline.length === 0) return fileRecords;

  interface OpenSession {
    filePath: string;
    events: TimelineEvent[];
  }
  const fileSessions: Record<string, OpenSession[]> = {};

  const closeSession = (session: OpenSession): void => {
    (fileSessions[session.filePath] ??= []).push(session);
  };

  let currentSession: OpenSession | null = null;

  for (const event of timeline) {
    const filePath =
      event.type === 'switch' ? event.to : (event as { file?: string }).file;
    if (!filePath) continue;

    if (event.type === 'start') {
      // 任何 start 都开启新会话，未闭合的先收下
      if (currentSession) closeSession(currentSession);
      currentSession = { filePath: event.file, events: [event] };
      continue;
    }

    if (!currentSession) continue;

    if (
      (event.type !== 'switch' && event.file === currentSession.filePath) ||
      (event.type === 'switch' && event.to === currentSession.filePath)
    ) {
      currentSession.events.push(event);
    }

    // save / auto-save 计入历史；discard 整段丢弃
    if (isSaveLike(event) || event.type === 'discard') {
      const belongsToCurrent =
        event.type === 'switch' ? false : event.file === currentSession.filePath;
      if (belongsToCurrent) {
        if (isSaveLike(event)) closeSession(currentSession);
        currentSession = null;
      }
    }
  }

  // 未闭合的会话（含正在计时的那个）也要算进来
  if (currentSession) closeSession(currentSession);

  for (const [filePath, sessions] of Object.entries(fileSessions)) {
    const readTimeLine: SessionStateMap[] = [];
    let totalReadTime = 0;
    let readTimeToday = 0;
    let lastReadAt = '';
    let hasAbnormalSession = false;

    for (const session of sessions) {
      if (session.events.length === 0) continue;

      const sessionObj: SessionStateMap = {};
      let isUnfinishedSession = true;

      for (const event of session.events) {
        const state = (event as { state?: string }).state;
        if (state) {
          sessionObj[event.time] = state as SessionStateMap[string];
        } else if (event.type === 'save' || event.type === 'auto-save') {
          sessionObj[event.time] = 'saved';
          isUnfinishedSession = false;
        } else if (event.type === 'discard') {
          // 原实现此处写 'discarded'。该分支实际不可达：携带 discard 的会话在
          // 下面的闭合逻辑里会被整段丢弃、不会进入 readTimeLine，所以这个值
          // 从不被读到。这里写 'saved' 以符合 SessionState 的取值域。
          // The original wrote 'discarded' here, but this branch is unreachable: a session
          // closed by discard is dropped wholesale and never enters readTimeLine, so the
          // value is never read. 'saved' keeps it inside SessionState's domain.
          sessionObj[event.time] = 'saved';
          isUnfinishedSession = false;
        }
      }

      const keys = Object.keys(sessionObj);
      if (keys.length === 0) continue;

      readTimeLine.push(sessionObj);

      let sessionDuration: number;
      if (isUnfinishedSession && keys.length === 1) {
        // 只有一个 start：按「至今」推算，但超过 24 小时的判定为异常、计 0
        // A lone start: measure up to now, but treat >24h as abnormal and count zero
        const startTime = new Date(keys[0]!);
        const elapsed = (nowMs - startTime.getTime()) / 1000;

        if (elapsed > MAX_SESSION_DURATION) {
          console.warn(
            `[RTT][timeline] 跳过异常未闭合会话 / skipping abnormal open session ${filePath}: ` +
              `${Math.floor(elapsed / 3600)}小时前开始 / started hours ago`,
          );
          hasAbnormalSession = true;
          sessionDuration = 0;
        } else {
          sessionDuration = sessionObj[keys[0]!] === 'tracking' ? Math.max(0, elapsed) : 0;
        }
      } else {
        sessionDuration = calculateSessionDuration(sessionObj);
      }

      totalReadTime += sessionDuration;

      const sorted = keys.slice().sort();
      const firstTime = sorted[0]!;
      if (firstTime.startsWith(today)) readTimeToday += sessionDuration;

      const lastTime = sorted[sorted.length - 1]!;
      if (lastTime > lastReadAt) lastReadAt = lastTime;
    }

    fileRecords[filePath] = {
      fileName: (filePath.split('/').pop() ?? filePath).replace(/\.md$/, ''),
      totalReadTime,
      readTimeToday,
      lastReadAt: lastReadAt.slice(0, 10),
      readTimeLine,
      hasAbnormalSession,
    };
  }

  return fileRecords;
}

/**
 * 从会话列表重算统计汇总 / Recompute aggregates from a session list.
 * 来源：工程目录版 _recalcAggregates。
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
 * 单个文件的今日活跃秒数 / Today's active seconds for one file.
 *
 * 含两部分：今日已结算事件的 activeSeconds + 当前会话的 activeSeconds。
 * Two parts: settled events today, plus the in-progress session.
 */
export function getTodaySeconds(
  timeline: readonly TimelineEvent[],
  file: TimerFileState | null | undefined,
  filePath: string,
  today: string = todayStr(),
): number {
  let total = 0;

  for (const event of timeline) {
    if (event.type === 'switch') continue;
    if (event.file !== filePath || !event.time.startsWith(today)) continue;
    if (isSaveLike(event)) {
      total += (event as { activeSeconds?: number }).activeSeconds ?? 0;
    }
  }

  if (file?.sessionStartTime?.startsWith(today)) {
    total += file.activeSeconds;
  }

  return total;
}

/**
 * 单个文件的今日会话轮数 / Today's session count for one file.
 * 至少返回 1（与原实现的 `|| 1` 兜底一致）。
 */
export function getTodaySessionCount(
  timeline: readonly TimelineEvent[],
  file: TimerFileState | null | undefined,
  filePath: string,
  today: string = todayStr(),
  statusTracking = 'tracking',
  statusPaused = 'paused',
): number {
  let count = 0;

  for (const event of timeline) {
    if (event.type === 'switch') continue;
    if (event.file !== filePath || !event.time.startsWith(today)) continue;
    if (isSaveLike(event)) count++;
  }

  if (file && (file.status === statusTracking || file.status === statusPaused)) {
    count++;
  }

  return count || 1;
}

/**
 * 全库今日活跃秒数 / Vault-wide active seconds today.
 */
export function getAllTodaySeconds(
  timeline: readonly TimelineEvent[],
  files: Iterable<TimerFileState>,
  today: string = todayStr(),
): number {
  let total = 0;

  for (const event of timeline) {
    if (event.type === 'switch') continue;
    if (event.time.startsWith(today) && isSaveLike(event)) {
      total += (event as { activeSeconds?: number }).activeSeconds ?? 0;
    }
  }

  for (const file of files) {
    if (file.sessionStartTime?.startsWith(today)) {
      total += file.activeSeconds;
    }
  }

  return total;
}

/**
 * 移除某个文件的全部事件 / Remove every event referring to a file.
 *
 * 取代 vault 版 ReadRecordsModal 第 4541 行对 `_cache.timeline` 的直接赋值。
 * 注意引用判定必须覆盖 switch 事件的 from/to，否则切换事件会成为孤儿。
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
 * 把某文件的事件挑出来（只读视图）/ Read-only view of one file's events.
 */
export function getFileEvents(
  timeline: readonly TimelineEvent[],
  filePath: string,
): TimelineEvent[] {
  return timeline.filter((event) => eventFileRefs(event).includes(filePath));
}

/**
 * 按时间区间筛选事件 / Filter events into a time range (inclusive on both ends).
 * 用于热力图按日/周聚合。
 */
export function getTimeRangeEvents(
  timeline: readonly TimelineEvent[],
  start: string,
  end: string,
): TimelineEvent[] {
  return timeline.filter((event) => event.time >= start && event.time <= end);
}
