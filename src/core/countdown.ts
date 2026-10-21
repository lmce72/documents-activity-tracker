/**
 * Countdown plans / 倒计时方案
 *
 * 三种倒计时模式共用一套模型：一次运行 = 一串**固定长度的分段**，跑完一段自动进下一段。
 *    - 倒计时     down     ：一段
 *    - 番茄钟     pomodoro ：专注 + 休息，单周期或重复若干轮
 *    - 不规则周期 interval ：若干不等长的段依次跑
 * 正计时（count-up）不走这套模型 —— 它没有分段。这样只需要一个状态机，而不是三个计时器。
 *
 * The three countdown modes share one model: a run is a sequence of fixed-length phases, and
 * finishing one moves straight into the next.
 *    - down     : one phase
 *    - pomodoro : focus + break, a single cycle or repeated
 *    - interval : several unequal phases in order
 * Count-up is deliberately outside this model — it has no phases. One state machine, not three.
 *
 * 方案在**开始时**解析并存进状态，运行中改设置不影响本次运行。
 * The plan is resolved at start and stored in the state, so editing settings mid-run cannot
 * change a run already under way.
 *
 * L1 module: depends on types only, no DOM and no clock — `locatePhase` takes elapsed seconds,
 * which is what makes the phase boundary testable without timers.
 */

import type { TranslationKey } from './i18n';
import type {
  CountdownMode,
  CountdownPhase,
  CountdownPlan,
  PluginSettings,
} from './types';

/** 单段最短 1 分钟 / a phase is at least one minute. */
export const MIN_PHASE_MINUTES = 1;

/** 单段最长 24 小时 / a phase is at most a day. */
export const MAX_PHASE_MINUTES = 24 * 60;

/** 番茄钟最多重复 99 轮 / at most 99 pomodoro cycles. */
export const MAX_POMODORO_CYCLES = 99;

/** 不规则周期最多 24 段 / at most 24 irregular phases. */
export const MAX_INTERVAL_PHASES = 24;

/** 缺省的不规则周期：25 → 5 → 25 / the default irregular plan. */
export const DEFAULT_INTERVALS = [25, 5, 25];

/** 构造方案所需的全部配置 / everything needed to build a plan. */
export interface CountdownConfig {
  mode: CountdownMode;
  /** 倒计时模式的分钟数 / minutes for `down` */
  downMinutes: number;
  focusMinutes: number;
  breakMinutes: number;
  cycles: number;
  /** 番茄钟是否重复 / whether pomodoro repeats its cycle */
  repeat: boolean;
  /** 不规则周期的各段分钟数 / minutes per phase for `interval` */
  intervals: number[];
}

/** 用户设置里的原始值可能来自旧版本或被手改，一律夹到合法区间 / clamp anything into range. */
export function clampMinutes(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(MAX_PHASE_MINUTES, Math.max(MIN_PHASE_MINUTES, Math.round(numeric)));
}

/** 夹轮数 / clamp the cycle count. */
export function clampCycles(value: unknown, fallback = 4): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(MAX_POMODORO_CYCLES, Math.max(1, Math.round(numeric)));
}

/**
 * 清洗不规则周期 / sanitise the irregular phase list.
 *
 * 空表补回默认值，而不是留一个跑不起来的方案：界面上删到一行不剩是很容易的手误，而"开始"按钮
 * 从此静默失灵更难查。
 * An empty list falls back to the default rather than leaving a plan that cannot run: deleting
 * every row is an easy slip, and a start button that silently stops working is harder to diagnose.
 */
export function normalizeIntervals(values: readonly unknown[] | undefined): number[] {
  const cleaned = (values ?? [])
    .map((value) => clampMinutes(value, MIN_PHASE_MINUTES))
    .slice(0, MAX_INTERVAL_PHASES);
  return cleaned.length > 0 ? cleaned : [...DEFAULT_INTERVALS];
}

/** 从设置里取出配置 / read the config out of settings. */
export function countdownConfigFrom(
  settings: Pick<
    PluginSettings,
    | 'countdownMode'
    | 'countdownMinutes'
    | 'countdownFocusMinutes'
    | 'countdownBreakMinutes'
    | 'countdownCycles'
    | 'countdownRepeat'
    | 'countdownIntervals'
  >,
): CountdownConfig {
  return {
    mode: normalizeMode(settings.countdownMode),
    downMinutes: clampMinutes(settings.countdownMinutes, 25),
    focusMinutes: clampMinutes(settings.countdownFocusMinutes, 25),
    breakMinutes: clampMinutes(settings.countdownBreakMinutes, 5),
    cycles: clampCycles(settings.countdownCycles),
    repeat: settings.countdownRepeat === true,
    intervals: normalizeIntervals(settings.countdownIntervals),
  };
}

/** 无效模式退回倒计时 / an unknown stored mode falls back to a plain countdown. */
export function normalizeMode(value: unknown): CountdownMode {
  return value === 'pomodoro' || value === 'interval' || value === 'down' ? value : 'down';
}

/** 分钟 → 分段 / minutes to a phase. */
function phase(kind: CountdownPhase['kind'], minutes: number): CountdownPhase {
  return { kind, seconds: clampMinutes(minutes, MIN_PHASE_MINUTES) * 60 };
}

/**
 * 按模式生成分段 / build the phases for a mode.
 *
 * 番茄钟的一"周期"是「专注 + 休息」两段；单周期就是一轮，重复则连着排 N 轮。
 * 最后一段休息保留：干完一段活之后的那次休息是真实的，砍掉它反而要用户自己去补。
 *
 * One pomodoro cycle is a focus phase followed by a break; a single cycle is one of those, and
 * repeat lays down N of them. The trailing break is kept: the rest after the last focus is real
 * time, and dropping it would leave the user to start it by hand.
 */
export function buildCountdownPlan(config: CountdownConfig): CountdownPlan {
  const phases: CountdownPhase[] = [];

  if (config.mode === 'pomodoro') {
    const cycles = config.repeat ? clampCycles(config.cycles) : 1;
    for (let index = 0; index < cycles; index++) {
      phases.push(phase('focus', config.focusMinutes));
      phases.push(phase('break', config.breakMinutes));
    }
  } else if (config.mode === 'interval') {
    for (const minutes of normalizeIntervals(config.intervals)) {
      phases.push(phase('segment', minutes));
    }
  } else {
    phases.push(phase('focus', config.downMinutes));
  }

  return { mode: config.mode, phases };
}

/** 方案总时长（秒）/ total planned seconds. */
export function planTotalSeconds(plan: CountdownPlan | null): number {
  if (!plan) return 0;
  return plan.phases.reduce((total, phase_) => total + phase_.seconds, 0);
}

/** 某一轮运行所处的位置 / where a run stands. */
export interface CountdownPosition {
  /** 当前分段下标（从 0 起）；已完成时停在最后一段 / current phase index, clamped at completion */
  index: number;
  /** 当前分段内已过的秒数 / seconds into the current phase */
  phaseElapsed: number;
  /** 当前分段还剩的秒数 / seconds left in the current phase */
  remaining: number;
  /** 当前分段的总长度 / length of the current phase */
  phaseSeconds: number;
  /** 整个方案已过的秒数（夹到总长）/ elapsed across the plan, clamped */
  elapsed: number;
  /** 整个方案的总秒数 / planned total */
  total: number;
  /** 是否已跑完最后一段 / whether every phase has run */
  completed: boolean;
}

/**
 * 由已过秒数定位当前分段 / locate the phase for a given elapsed time.
 *
 * 纯函数：时间从哪里来（真实时钟还是测试）与这里无关，段边界因此可以直接被测到。
 * Pure: where the seconds came from is not this function's business, which is what makes a
 * phase boundary testable without waiting for a real clock.
 */
export function locatePhase(plan: CountdownPlan, elapsedSeconds: number): CountdownPosition {
  const total = planTotalSeconds(plan);
  const elapsed = Math.max(0, Math.min(total, Math.floor(elapsedSeconds)));

  if (plan.phases.length === 0) {
    return {
      index: 0,
      phaseElapsed: 0,
      remaining: 0,
      phaseSeconds: 0,
      elapsed: 0,
      total: 0,
      completed: true,
    };
  }

  let cursor = 0;
  for (const [index, phase_] of plan.phases.entries()) {
    const end = cursor + phase_.seconds;

    //  `elapsed < end` 而不是 `<=`：第 0 秒属于第 1 段，走到 1500 秒整时才换成第 2 段，
    //  否则一段 25 分钟的专注会在开始时就地跳进休息。
    //  `<` rather than `<=`: second zero belongs to the first phase, and only at exactly 1500s
    //  does the next one begin — otherwise a 25-minute focus would open already in the break.
    if (elapsed < end) {
      return {
        index,
        phaseElapsed: elapsed - cursor,
        remaining: end - elapsed,
        phaseSeconds: phase_.seconds,
        elapsed,
        total,
        completed: false,
      };
    }
    cursor = end;
  }

  const lastIndex = plan.phases.length - 1;
  const lastSeconds = plan.phases[lastIndex]?.seconds ?? 0;
  return {
    index: lastIndex,
    phaseElapsed: lastSeconds,
    remaining: 0,
    phaseSeconds: lastSeconds,
    elapsed: total,
    total,
    completed: total <= 0 || elapsed >= total,
  };
}

/**
 * 分段标题用的词条键 / the i18n key naming a phase kind.
 * 返回键而不是字符串：这一层不读当前语言，界面自己决定用哪种语言。
 * A key rather than a string: this layer does not read the current language — the UI decides.
 */
export function phaseLabelKey(kind: CountdownPhase['kind']): TranslationKey {
  if (kind === 'break') return 'countdownPhaseBreak';
  if (kind === 'segment') return 'countdownPhaseSegment';
  return 'countdownPhaseFocus';
}

/** 模式对应的词条键 / the i18n key naming a mode. */
export function modeLabelKey(mode: CountdownMode): TranslationKey {
  if (mode === 'pomodoro') return 'countdownModePomodoro';
  if (mode === 'interval') return 'countdownModeInterval';
  return 'countdownModeDown';
}
