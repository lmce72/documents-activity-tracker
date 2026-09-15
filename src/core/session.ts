/**
 * 会话计算 / Session arithmetic
 *
 * 来源：vault 版 main.js 第 1062-1078 行（两版逐字节相同）。
 * Origin: vault main.js lines 1062-1078 (byte-identical across versions).
 *
 * 已删除的死函数（调用点数实测为 0）/ Dead functions removed (measured zero call sites):
 *   calculateSessionTotalDuration(1085)  validateSessionObject(1098)
 *
 * 本模块是第 0 层，只依赖 types / L0 module; depends only on types.
 */

import type { SessionStateMap } from './types';

/**
 * 计算单次会话的活跃时长（仅累计 tracking 时段）。
 * Sum the active seconds of one session (only `tracking` intervals count).
 *
 * 语义：按下标遍历排序后的时间戳，若某时刻的状态是 tracking，
 * 则把它到下一时刻的间隔计入。最后一条时间戳没有后继，故不计。
 *
 * Walks the sorted timestamps; when the state at a timestamp is `tracking`,
 * the gap to the next timestamp is added. The last timestamp has no successor.
 */
export function calculateSessionDuration(sessionObj: SessionStateMap | null): number {
  if (!sessionObj) return 0;

  const timestamps = Object.keys(sessionObj).sort();
  let activeSeconds = 0;

  for (let i = 0; i < timestamps.length - 1; i++) {
    const currentState = sessionObj[timestamps[i]!];
    const currentTime = new Date(timestamps[i]!);
    const nextTime = new Date(timestamps[i + 1]!);
    const duration = (nextTime.getTime() - currentTime.getTime()) / 1000;

    if (currentState === 'tracking') {
      activeSeconds += duration;
    }
  }

  return activeSeconds;
}
