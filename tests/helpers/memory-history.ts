/**
 * In-memory repository for tests
 *
 * Extends the production `VolatileHistoryStore` (the degradation path) with two
 * test-only probes, so the double and the fallback cannot drift apart: the semantics
 * exercised in tests are the semantics that run in degraded mode.
 */

import type { TimelineEvent } from '../../src/core/types';
import { VolatileHistoryStore } from '../../src/data/VolatileHistoryStore';

export class MemoryHistory extends VolatileHistoryStore {

  flushCount = 0;

  /** makes appends fail. */
  failAppends = false;

  override appendEvents(events: readonly TimelineEvent[]): void {
    if (this.failAppends) throw new Error('append failed (test)');
    super.appendEvents(events);
  }

  override async flushNow(): Promise<void> {
    this.flushCount++;
  }
}
