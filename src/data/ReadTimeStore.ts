/**
 * Persistence layer
 *
 * Origin: vault main.js lines 1224-1489.
 *
 * Changes:
 *
 *      Decoupled from the Plugin instance via a four-method DataAdapter.
 *
 *      Removed dead code: two indexes that were only written, their sole reader
 *      (getSessionsByDate) with zero call sites, and a rebuild that walked a field
 *      which no longer exists in v3 data.
 *
 *      The original hardcoded version = 2 on save, which repeatedly downgraded v3 data.
 *      The new write primitives never touch `version`.
 *
 *      New primitives replacing seven direct `_cache` reach-throughs from the UI.
 *
 *      Migration is now non-destructive, still preceded by a backup.
 *
 */

import { DATA_VERSION } from '../core/constants';
import { migrateV2ToV3 } from '../core/migration';
import { removeFileEvents as removeFileEventsPure } from '../core/timeline';
import type {
  HistoryCache,
  MigrationReport,
  PluginSettings,
  RecordEntry,
  TimelineEvent,
} from '../core/types';
import type { DataAdapter } from './adapter';

/** The outcome of a load. */
export interface LoadResult {
  cache: HistoryCache;
  /** whether a migration ran during this load */
  migration: MigrationReport | null;
  /** backup path written before migrating */
  backupPath: string | null;
}

/** An empty cache at the current version. */
function emptyCache(): HistoryCache {
  return { version: DATA_VERSION, records: {}, timeline: [], settings: {} };
}

export class ReadTimeStore {
  /** in-memory cache, populated by load() */
  private cache: HistoryCache = emptyCache();

  /** write queue that serialises disk I/O */
  private writeQueue: Promise<void> = Promise.resolve();

  private loaded = false;

  constructor(
    private readonly adapter: DataAdapter,
    private settings: PluginSettings,
  ) {}

  /** settings are a live reference. */
  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
  }

  private get customPath(): string {
    return (this.settings.dataFilePath ?? '').trim();
  }

  /**
   * Load everything into memory, migrating if needed.
   */
  async load(): Promise<LoadResult> {
    let raw: unknown = null;

    try {
      if (this.customPath) {
        raw = JSON.parse(await this.adapter.read(this.customPath));
      } else {
        raw = await this.adapter.loadData();
      }
    } catch (error) {

      //  Absent file, first run, or corrupt JSON all fall back to an empty cache
      console.warn('[RTT][store] 数据加载失败，使用空缓存 / load failed, using empty cache:', error);
      raw = null;
    }

    let cache: HistoryCache;
    if (!raw || typeof raw !== 'object') {
      cache = emptyCache();
    } else {
      cache = raw as HistoryCache;
      if (!cache.records) cache.records = {};
      if (!Array.isArray(cache.timeline)) cache.timeline = [];
    }

    let migration: MigrationReport | null = null;
    let backupPath: string | null = null;

    const currentVersion = typeof cache.version === 'number' ? cache.version : 2;
    if (currentVersion < DATA_VERSION) {

      //  Back up before migrating: even though the migration is non-destructive, this is
      //  the user's only recourse if anything looks wrong afterwards.
      backupPath = await this.writeBackup(cache);

      const result = migrateV2ToV3(cache);
      cache = result.cache;
      migration = result.report;

      if (migration.timelineBefore !== migration.timelineAfter) {
        console.error(
          `[RTT][store] 迁移丢弃了事件 / migration dropped events: ` +
            `${migration.timelineBefore} → ${migration.timelineAfter}`,
        );
      }
    }

    this.cache = cache;
    this.loaded = true;

    if (migration) await this.save();

    return { cache: this.cache, migration, backupPath };
  }

  /** Write a timestamped backup before migrating. */
  private async writeBackup(cache: HistoryCache): Promise<string | null> {
    const base =
      this.customPath ||
      '.obsidian/plugins/documents-activity-tracker/data.json';
    const backupPath = `${base}.backup-v2-${Date.now()}`;
    try {
      await this.adapter.write(backupPath, JSON.stringify(cache, null, 2));
      console.log('[RTT][store] 已备份 / backed up to:', backupPath);
      return backupPath;
    } catch (error) {

      //  A failed backup must not block migration, but it must be visible
      console.error('[RTT][store] 备份失败 / backup failed:', error);
      return null;
    }
  }

  /**
   * Persist to disk.
   * Serialised through a write queue; errors are swallowed so later writes still queue.
   */
  async save(): Promise<void> {
    if (!this.loaded && !this.cache) return;

    const pending = this.writeQueue.then(async () => {
      try {
        const json = JSON.stringify(this.cache, null, 2);
        if (this.customPath) {
          await this.adapter.write(this.customPath, json);
        } else {
          await this.adapter.saveData(this.cache);
        }
      } catch (error) {
        console.error('[RTT][store] 数据写入失败 / write failed:', error);
      }
    });

    this.writeQueue = pending.catch(() => {});
    await pending.catch(() => {});
  }

  //  ==========================================================================
  // Reads
  //  ==========================================================================

  /** One record entry, or null. */
  getRecord(filePath: string): RecordEntry | null {
    return this.cache.records[filePath] ?? null;
  }

  /** Every record entry. */
  getAllRecords(): Record<string, RecordEntry> {
    return this.cache.records;
  }

  /**
   * The global timeline.
   *
   * Returns the internal array (zero-copy, called every second by the UI) typed as
   * readonly so stray writes fail compilation. Writing goes through the primitives below.
   */
  getTimeline(): readonly TimelineEvent[] {
    return this.cache.timeline;
  }

  getFileEvents(filePath: string): TimelineEvent[] {
    return this.cache.timeline.filter(
      (e) =>
        (e as { file?: string }).file === filePath ||
        (e.type === 'switch' && (e.from === filePath || e.to === filePath)),
    );
  }

  /** events in a time range, ascending. */
  getTimeRangeEvents(startTime: string, endTime: string): TimelineEvent[] {
    return this.cache.timeline
      .filter((e) => e.time >= startTime && e.time <= endTime)
      .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  }

  /**
   * Derive a file's active/pause/inactive seconds.
   */
  calculateFileStats(
    filePath: string,
    startTime?: string,
    endTime?: string,
  ): { activeTime: number; pauseTime: number; inactiveTime: number } {
    let events = this.getFileEvents(filePath);
    if (startTime && endTime) {
      events = events.filter((e) => e.time >= startTime && e.time <= endTime);
    }

    let activeTime = 0;
    let pauseTime = 0;
    let inactiveTime = 0;

    for (let i = 0; i < events.length - 1; i++) {
      const curr = events[i]!;
      const next = events[i + 1]!;
      const duration =
        (new Date(next.time).getTime() - new Date(curr.time).getTime()) / 1000;

      let state = (curr as { state?: string }).state;
      if (curr.type === 'switch') {
        state = curr.from === filePath ? curr.fromState : curr.toState;
      }

      if (state === 'tracking') activeTime += duration;
      else if (state === 'pausing') pauseTime += duration;
      else if (state === 'inactive') inactiveTime += duration;
    }

    return { activeTime, pauseTime, inactiveTime };
  }

  //  ==========================================================================
  // Write primitives
  //

  //
  //  These four replace the seven direct `_cache` reach-throughs from the UI.
  //  None of them touches `version`, which is exactly what the old saveTimeline got wrong.
  //  ==========================================================================

  /** Append events to the timeline. */
  appendTimeline(events: readonly TimelineEvent[]): void {
    if (events.length === 0) return;
    this.cache.timeline.push(...events);
  }

  /** Replace the whole timeline. */
  setTimeline(events: readonly TimelineEvent[]): void {
    this.cache.timeline = [...events];
  }

  removeFileEvents(filePath: string): number {
    const before = this.cache.timeline.length;
    this.cache.timeline = removeFileEventsPure(this.cache.timeline, filePath);
    return before - this.cache.timeline.length;
  }

  /**
   * Apply a completed session to the record.
   */
  applySessionSave(
    filePath: string,
    data: { activeSeconds: number; lastReadAt: string },
  ): void {
    const existing = this.cache.records[filePath];
    if (!existing) {
      this.cache.records[filePath] = {
        fileName: filePath.split('/').pop() ?? filePath,
        totalReadTime: 0,
        lastReadAt: '',
      };
    }
    const record = this.cache.records[filePath]!;
    record.totalReadTime = (record.totalReadTime || 0) + data.activeSeconds;
    record.lastReadAt = data.lastReadAt;
  }

  /** Upsert a record and persist. */
  async upsertRecord(filePath: string, data: Partial<RecordEntry>): Promise<void> {
    try {
      if (!this.loaded) await this.load();
      this.cache.records[filePath] = { ...this.cache.records[filePath], ...data } as RecordEntry;
      await this.save();
    } catch (error) {
      console.error(`[RTT][store] upsertRecord 失败 / failed (${filePath}):`, error);
      throw error;
    }
  }

  /** Delete a record and persist. */
  async deleteRecord(filePath: string): Promise<void> {
    try {
      if (!this.loaded) await this.load();
      if (this.cache.records[filePath]) {
        delete this.cache.records[filePath];
        await this.save();
        console.log(`[RTT][store] 已删除记录 / record deleted: ${filePath}`);
      }
    } catch (error) {
      console.error(`[RTT][store] deleteRecord 失败 / failed (${filePath}):`, error);
      throw error;
    }
  }

  /**
   * Clear everything.
   *
   * The original reset command cleared only `records` and left `timeline` intact, which
   * amounts to clearing nothing in v3 data. Both are cleared here.
   */
  clearAll(): void {
    this.cache.records = {};
    this.cache.timeline = [];
  }

  getCache(): HistoryCache {
    return this.cache;
  }
}
