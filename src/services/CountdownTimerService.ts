/**
 * Countdown timer service / 倒计时服务
 *
 * 与正计时并列的另一本账：状态、记录表、面板与统计都分开，只有"怎么算时间"是一致的 ——
 * 都由时间戳推导，不按 tick 累加，所以窗口节流、切后台、重新开始都不会把秒数算歪。
 *
 * A second ledger beside the count-up: its own state, records table, panel and statistics. What it
 * shares is only the accounting rule — time is derived from timestamps rather than ticked, so
 * throttling, backgrounding or a restart cannot skew the seconds.
 *
 * 分段推进不需要单独的计时器：当前位置永远由「已过的净秒数 + 方案」推导。少一份随 tick 前进的
 * 状态，就少一处会走散的地方。
 * Phase advancement needs no timer of its own: the position is always derived from "net seconds
 * elapsed + the plan". One less piece of state that advances per tick means one less thing that can
 * drift out of step.
 */

import { ActionTypes, MANUAL_STATUS } from '../core/constants';
import {
  locatePhase,
  planTotalSeconds,
  type CountdownPosition,
} from '../core/countdown';
import type { Logger } from '../core/logger';
import { selectCountdownElapsedMs, selectCountdownElapsedSeconds } from '../core/selectors';
import { formatLocalFull, parseSessionStartTime } from '../core/time';
import type {
  CountdownPlan,
  CountdownSession,
  ManualFlag,
} from '../core/types';
import type { Clock } from './clock';
import type { TimerStore } from './TimerStore';
import type { HistoryStore } from '../data/historyStore';

/** Service dependencies. */
export interface CountdownTimerServiceDeps {
  store: TimerStore;
  history: HistoryStore;
  clock: Clock;
  log: Logger;
  /** injected so tests can assert what is stored */
  newId: () => string;
}

export class CountdownTimerService {
  constructor(private readonly deps: CountdownTimerServiceDeps) {}

  /**
   * Start with a plan.
   *
   * 方案在这一刻被写进状态，之后运行中改设置不会改动这次运行。
   * The plan is written into the state at this instant; later setting changes do not touch this run.
   *
   * whether a run actually started
   */
  start(plan: CountdownPlan): boolean {
    const before = this.deps.store.getState().countdown.status;
    this.deps.store.dispatch({ type: ActionTypes.COUNTDOWN_START, payload: { plan } });
    const after = this.deps.store.getState().countdown.status;

    //  被 reducer 拒绝（已在运行、或方案是空的）时状态不变，这里据实回报
    //  The reducer refuses a second run or an empty plan; report what actually happened
    return before === MANUAL_STATUS.IDLE && after !== MANUAL_STATUS.IDLE;
  }

  pause(): void {
    this.deps.store.dispatch({ type: ActionTypes.COUNTDOWN_PAUSE });
  }

  resume(): void {
    this.deps.store.dispatch({ type: ActionTypes.COUNTDOWN_RESUME });
  }

  /** The net elapsed seconds. */
  elapsedSeconds(): number {
    return selectCountdownElapsedSeconds(this.deps.store.getState(), this.deps.clock.now());
  }

  /** 净毫秒 / the net milliseconds. */
  elapsedMs(): number {
    return selectCountdownElapsedMs(this.deps.store.getState(), this.deps.clock.now());
  }

  /** 当前所处的分段；空闲时为 null / where the run stands, null when idle. */
  position(): CountdownPosition | null {
    const state = this.deps.store.getState();
    if (state.countdown.status === MANUAL_STATUS.IDLE) return null;
    const plan = state.countdown.plan;
    if (!plan) return null;
    //  跳过的只是本段剩余的等待：定位用有效时间，实际时长仍由已过时间决定
    //  Skipping removes only the phase's remaining wait: location uses effective time while the
    //  recorded duration still comes from real elapsed time.
    return locatePhase(plan, this.elapsedSeconds() + (state.countdown.skippedSeconds ?? 0));
  }

  /**
   * 跳过当前分段 / skip the current phase.
   *
   * 把本段剩余的等待记入偏移，立刻进入下一段；已经过去的时间不动，所以这一段的真实计时照常计入
   * 本次记录。最后一段被跳过时按跑完收尾，由主循环的完赛检查落下记录。
   *
   * Records the current phase's remaining wait as an offset and moves straight to the next phase.
   * Time already lived is untouched, so the stretch still counts in the saved run; skipping the last
   * phase completes the run and the main loop's finish check settles it.
   *
   * whether anything was skipped
   */
  skipPhase(): boolean {
    try {
      const state = this.deps.store.getState();
      if (state.countdown.status === MANUAL_STATUS.IDLE) return false;
      const position = this.position();
      if (!position || position.completed) return false;
      const effectiveSeconds = this.elapsedMs() / 1000 + this.deps.store.getState().countdown.skippedSeconds;
      const seconds = Math.max(0, position.remaining - (effectiveSeconds - Math.floor(effectiveSeconds)));
      if (seconds === 0) return false;
      this.deps.store.dispatch({ type: ActionTypes.COUNTDOWN_SKIP, payload: { seconds } });
      return true;
    } catch (error) {
      this.deps.log.warn('[RTT][countdown] 跳过分段失败 / skip phase failed:', error);
      return false;
    }
  }

  /** 本次运行的方案 / the plan this run was started with. */
  plan(): CountdownPlan | null {
    return this.deps.store.getState().countdown.plan;
  }

  /** 是否已经跑完最后一段 / whether the last phase has finished. */
  isComplete(): boolean {
    const position = this.position();
    return position !== null && position.completed;
  }

  isActive(): boolean {
    return this.deps.store.getState().countdown.status !== MANUAL_STATUS.IDLE;
  }

  /**
   * Place a mark.
   *
   * 与正计时一样记的是**净秒数**（暂停不计），另外记下当时在第几段 —— 番茄钟的标记离开段落就
   * 看不出是哪一轮的。
   *
   * Net seconds like the count-up, plus which phase it was in: a mark from a pomodoro is hard to
   * read once it no longer says which round it belonged to.
   *
   * the mark, or null when idle
   */
  flag(label = ''): ManualFlag | null {
    try {
      const position = this.position();
      if (!position) return null;

      const elapsedMs = this.elapsedMs();
      const mark: ManualFlag = {
        //  标记的累计时长是真实已计时长；段号仍用跳过后的有效位置
        //  The mark's elapsed counter is real time; the phase number still uses the effective position.
        atSeconds: Math.floor(elapsedMs / 1000),
        atMs: elapsedMs,
        atTime: this.deps.clock.nowFull(),
        label,
        phase: position.index + 1,
      };

      this.deps.store.dispatch({
        type: ActionTypes.COUNTDOWN_FLAG,
        payload: {
          atSeconds: mark.atSeconds,
          atTime: mark.atTime,
          label,
          phase: mark.phase ?? 1,
        },
      });

      return mark;
    } catch (error) {
      this.deps.log.warn('[RTT][countdown] 打标记失败 / flag failed:', error);
      return null;
    }
  }

  flags(): ManualFlag[] {
    return [...this.deps.store.getState().countdown.flags];
  }

  /** 即时移除一枚标记 / drop one mark without stopping. */
  removeFlag(index: number): boolean {
    const state = this.deps.store.getState();
    if (state.countdown.status === MANUAL_STATUS.IDLE) return false;
    if (!Number.isInteger(index) || index < 0 || index >= state.countdown.flags.length) return false;
    this.deps.store.dispatch({ type: ActionTypes.COUNTDOWN_UNFLAG, payload: { index } });
    return true;
  }

  /** 运行中修改标记名称 / rename a live mark. */
  renameFlag(index: number, label: string): boolean {
    const state = this.deps.store.getState();
    if (state.countdown.status === MANUAL_STATUS.IDLE) return false;
    if (!Number.isInteger(index) || index < 0 || index >= state.countdown.flags.length) return false;
    this.deps.store.dispatch({ type: ActionTypes.COUNTDOWN_RENAME_FLAG, payload: { index, label } });
    return true;
  }

  /**
   * Stop and persist.
   *
   * 跑完最后一段时把时长夹到计划长度：tick 可能晚到一两秒，而"25 分钟的番茄钟记成 25 分 02 秒"
   * 会在每次合计里留下指纹。
   *
   * A completed run's duration is clamped to the planned length: the tick may arrive a second or
   * two late, and "a 25-minute pomodoro recorded as 25:02" leaves a fingerprint in every total.
   *
   * the stored session, or null if idle
   */
  async stop(note: string): Promise<CountdownSession | null> {
    try {
      const state = this.deps.store.getState();
      const countdown = state.countdown;
      if (countdown.status === MANUAL_STATUS.IDLE || !countdown.plan) return null;

      const plan = countdown.plan;
      const durationMs = this.elapsedMs();
      //  完赛与否看有效位置；记录的时长只算真实计时，不包括被跳过的等待
      //  Completion follows the effective position; the saved duration is real time only, with the
      //  skipped waits left out.
      const position = locatePhase(plan, durationMs / 1000 + (countdown.skippedSeconds ?? 0));
      const plannedSeconds = planTotalSeconds(plan);
      // 跳段缩短实际等待，备注框停留不能再次计入已完成的方案。 / Skips shorten the real run; note-entry time is excluded.
      const actualMs = Math.min(durationMs, Math.max(0, plannedSeconds - countdown.skippedSeconds) * 1000);
      const pauses = [
        ...countdown.pauses,
        ...(countdown.pauseStartFull.length > 0
          ? [{ from: countdown.pauseStartFull, to: this.deps.clock.nowFull() }]
          : []),
      ];
      // 从尾部扣除超出的活动时间，并跨过暂停段。 / Remove excess active time from the tail, crossing pauses.
      let endMs = this.deps.clock.now();
      let excess = durationMs - actualMs;
      if (position.completed) {
        const ranges = pauses.flatMap(pause => {
          const from = parseSessionStartTime(pause.from)?.getTime();
          const to = parseSessionStartTime(pause.to)?.getTime();
          return from !== undefined && to !== undefined && to > from ? [{ from, to }] : [];
        }).sort((a, b) => b.to - a.to);
        for (const pause of ranges) {
          const activeTail = Math.max(0, endMs - pause.to);
          if (excess < activeTail) break;
          excess -= activeTail;
          endMs = Math.min(endMs, pause.from);
        }
        endMs -= excess;
      }
      const endTime = formatLocalFull(new Date(endMs));

      const session: CountdownSession = {
        id: this.deps.newId(),
        mode: plan.mode,
        startTime: countdown.startedAt || endTime,
        endTime,
        plannedSeconds,
        durationSeconds: Math.floor(actualMs / 1000),
        durationMs: actualMs,
        completed: position.completed,
        note,
        flags: countdown.flags.filter(flag => (flag.atMs ?? flag.atSeconds * 1000) <= actualMs),
        //  同正计时：结束那一刻仍停着的话，补上这段未闭合的暂停
        //  As with the count-up: a pause still open at stop time is closed here
        pauses: pauses.flatMap(pause => pause.from < endTime
          ? [{ from: pause.from, to: pause.to < endTime ? pause.to : endTime }] : []),
        phases: [...plan.phases],
      };

      this.deps.history.appendCountdownSession(session);
      this.deps.store.dispatch({ type: ActionTypes.COUNTDOWN_STOP });
      await this.deps.history.flushNow();

      this.deps.log.info(
        `[RTT][countdown] 已保存倒计时 / countdown saved: ${session.durationSeconds}s / ${session.plannedSeconds}s`,
      );
      return session;
    } catch (error) {
      this.deps.log.warn('[RTT][countdown] 保存倒计时失败 / countdown stop failed:', error);
      return null;
    }
  }

  /** 开始错了就丢掉 / for when the run was started by mistake. */
  discard(): void {
    this.deps.store.dispatch({ type: ActionTypes.COUNTDOWN_STOP });
  }
}
