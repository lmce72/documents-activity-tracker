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
    return locatePhase(plan, this.elapsedSeconds());
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
        atSeconds: position.elapsed,
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
      const position = locatePhase(plan, durationMs / 1000);
      const endTime = this.deps.clock.nowFull();
      const plannedSeconds = planTotalSeconds(plan);

      const session: CountdownSession = {
        id: this.deps.newId(),
        mode: plan.mode,
        startTime: countdown.startedAt || endTime,
        endTime,
        plannedSeconds,
        durationSeconds: Math.min(position.elapsed, plannedSeconds),
        durationMs: Math.min(durationMs, plannedSeconds * 1000),
        completed: position.completed,
        note,
        flags: [...countdown.flags],
        //  同正计时：结束那一刻仍停着的话，补上这段未闭合的暂停
        //  As with the count-up: a pause still open at stop time is closed here
        pauses: [
          ...countdown.pauses,
          ...(countdown.pauseStartFull.length > 0
            ? [{ from: countdown.pauseStartFull, to: endTime }]
            : []),
        ],
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
