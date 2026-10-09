/**
 * Session arithmetic
 *
 * Origin: vault main.js lines 1062-1078 (byte-identical across versions).
 *
 *   calculateSessionTotalDuration(1085)  validateSessionObject(1098)
 *
 * L0 module; depends only on types.
 */

import type { SessionStateMap } from './types';

/**
 * Sum the active seconds of one session (only `tracking` intervals count).
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
