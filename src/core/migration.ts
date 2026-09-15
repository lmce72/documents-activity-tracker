/**
 * 数据迁移 v2 → v3 / Data migration v2 -> v3
 *
 * 来源：vault 版 main.js 第 1154-1217 行的 `migrateDataV2ToV3`。
 * Origin: vault main.js lines 1154-1217.
 *
 * ⚠️ 原实现是有损的，本文件是本次重构的最高优先级修复项。
 * The original was lossy; this is the highest-priority fix in the refactor.
 *
 * 原实现有两个问题 / Two problems with the original:
 *
 *   1. **白名单丢弃 30% 的事件**。原 `validTypes` 只有
 *      ['start','pause','resume','save','auto-save','discard']，
 *      而真实数据 138 个事件里另有 blur(19) / focus(14) / switch(8) 共 41 个
 *      不在白名单内，会被静默丢弃。
 *      The whitelist dropped 41 of 138 real events (blur/focus/switch).
 *
 *   2. **字段裁剪**。`.map()` 只保留 time/type/file/state/duration/activeSeconds，
 *      于是 switch 事件的 from/to/fromState/toState 与 blur/focus 的 reason 全部丢失，
 *      且给 switch 事件硬塞了一个语义错误的 `file` 字段。
 *      The `.map()` kept only six fields, losing switch's from/to and blur/focus's reason,
 *      while inventing a meaningless `file` field on switch events.
 *
 * 本次改为**非破坏性迁移**：保留全部事件与全部原始字段，只做形状规范化，
 * 并且不修改入参（返回新对象，便于测试与幂等性验证）。
 * Now non-destructive: every event and every original field is preserved, only shapes
 * are normalised, and the input is not mutated (a new object is returned).
 *
 * 另：原实现在此调用 `new Notice(...)` 弹提示，属于 core 层泄漏 UI，已移除，
 * 改为返回 `MigrationReport` 由调用方决定如何提示。
 * The original called `new Notice(...)` here, leaking UI into core; it now returns a report.
 *
 * 本模块是第 0 层，只依赖 constants / types。
 */

import { DATA_VERSION, TIMELINE_PERSISTED_TYPES } from './constants';
import type {
  HistoryCache,
  MigrationReport,
  RecordEntry,
  TimelineEvent,
} from './types';

/** 迁移结果 / The result of a migration. */
export interface MigrationResult {
  cache: HistoryCache;
  report: MigrationReport;
}

/**
 * 判断输入是否已是指定版本 / Whether the payload is already at the target version.
 */
export function isCurrentVersion(cache: HistoryCache, target: number = DATA_VERSION): boolean {
  return cache.version === target;
}

/**
 * 规范化单条记录 / Normalise one record entry.
 * 只保留三个核心统计字段；readTimeLine / readTimeToday 等派生字段会被移除。
 * 这是安全的：readTimeLine 可以从 timeline 重新派生（见 core/timeline.ts），
 * 且原引擎的静默刷盘路径从不写 readTimeLine。
 *
 * Keeps only the three statistic fields. Removing derived fields is safe because
 * readTimeLine is re-derivable from the timeline, and the original engine's silent
 * flush path never wrote it.
 */
function normalizeRecord(filePath: string, record: unknown): RecordEntry {
  const r = (record ?? {}) as Record<string, unknown>;
  return {
    fileName:
      typeof r.fileName === 'string' && r.fileName.length > 0
        ? r.fileName
        : (filePath.split('/').pop() ?? filePath),
    totalReadTime: typeof r.totalReadTime === 'number' ? r.totalReadTime : 0,
    lastReadAt: typeof r.lastReadAt === 'string' ? r.lastReadAt : '',
  };
}

/**
 * 规范化单条 timeline 事件 / Normalise one timeline event.
 *
 * 保留原始的所有字段，只做两件事：
 *   - 补一个空的额外字段对象（保证引用形状稳定，便于幂等比较）
 *   - 对 switch 事件补 file 别名？**不补**。原实现硬塞的 file 字段语义错误，
 *     这里保持 from/to 原样（下游用 eventFileRefs() 统一取文件引用）。
 *
 * Keeps every original field. Notably does NOT invent a `file` field on switch events
 * as the original did; downstream code uses `eventFileRefs()` instead.
 */
function normalizeEvent(event: unknown): TimelineEvent | null {
  const e = (event ?? {}) as Record<string, unknown>;

  // time 是排序与展示的基石，缺失则整条不可用
  if (typeof e.time !== 'string' || e.time.length === 0) return null;
  if (typeof e.type !== 'string' || e.type.length === 0) return null;

  // 浅拷贝，保留全部原始字段（含 reason / from / to / duration / activeSeconds）
  return { ...e } as unknown as TimelineEvent;
}

/**
 * 取事件所引用的全部文件路径 / Every file path an event refers to.
 *
 * 普通事件看 `file`，switch 事件看 `from` / `to`。
 * Plain events use `file`; switch events use `from` / `to`.
 */
export function eventFileRefs(event: TimelineEvent): string[] {
  const refs: string[] = [];
  if (event.type === 'switch') {
    const e = event as { from?: unknown; to?: unknown };
    if (typeof e.from === 'string') refs.push(e.from);
    if (typeof e.to === 'string') refs.push(e.to);
    return refs;
  }
  const file = (event as { file?: unknown }).file;
  if (typeof file === 'string') refs.push(file);
  return refs;
}

/**
 * 迁移 v2 数据到当前版本 / Migrate v2 data to the current version.
 *
 * 非破坏性且幂等 / non-destructive and idempotent:
 *   - 不修改入参，返回全新的 cache 对象
 *   - 连跑两次结果与跑一次相同
 *   - 除非事件结构不可用（缺 time/type），否则一条都不丢
 *
 * @param raw 从磁盘读到的原始数据 / the raw on-disk payload
 */
export function migrateV2ToV3(raw: Partial<HistoryCache> | null | undefined): MigrationResult {
  const source = raw ?? {};
  const fromVersion = typeof source.version === 'number' ? source.version : 2;

  // ---- records ----
  const recordsIn = source.records ?? {};
  const recordsOut: Record<string, RecordEntry> = {};
  for (const [filePath, record] of Object.entries(recordsIn)) {
    recordsOut[filePath] = normalizeRecord(filePath, record);
  }

  // ---- timeline ----
  const timelineIn = Array.isArray(source.timeline) ? source.timeline : [];
  const timelineOut: TimelineEvent[] = [];
  const unknownEventTypes = new Set<string>();
  let droppedMalformed = 0;

  for (const event of timelineIn) {
    const normalized = normalizeEvent(event);
    if (!normalized) {
      droppedMalformed++;
      continue;
    }
    // 未知类型不丢弃，只记录：丢弃会重演原实现的静默数据损失
    // Unknown types are kept, only reported — dropping would repeat the original's data loss
    if (!(TIMELINE_PERSISTED_TYPES as readonly string[]).includes(normalized.type)) {
      unknownEventTypes.add(normalized.type);
    }
    timelineOut.push(normalized);
  }

  const cache: HistoryCache = {
    ...source,
    version: DATA_VERSION,
    records: recordsOut,
    timeline: timelineOut,
  };

  const report: MigrationReport = {
    migrated: fromVersion !== DATA_VERSION,
    fromVersion,
    toVersion: DATA_VERSION,
    recordsBefore: Object.keys(recordsIn).length,
    recordsAfter: Object.keys(recordsOut).length,
    timelineBefore: timelineIn.length,
    timelineAfter: timelineOut.length,
    droppedMalformed,
    unknownEventTypes: [...unknownEventTypes].sort(),
  };

  return { cache, report };
}
