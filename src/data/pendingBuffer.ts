/**
 * 未落盘数据库的暂存 / the buffer for an unflushed database
 *
 * vault 里的那份 SQLite 是会被同步工具搬运的文件，每写一次就多一次冲突机会。所以写盘要按用户开的
 * 时机走，而不是每改一次就写。可数据不能因此悬空：崩溃或断电之后，最新状态必须还在某个地方。
 * 这个地方就是浏览器自己的 IndexedDB —— 本地、按设备隔离、不同步、不进 git，因此既能扛住崩溃，
 * 又不会制造同步噪声。
 *
 * The SQLite file in the vault is a file sync tools carry around, and every write is another chance
 * to conflict. So the file is written on the schedule the user chose, not on every change. But the
 * data must not hang in the air: after a crash or a power cut the newest state has to be somewhere.
 * That somewhere is the browser's own IndexedDB — local, per device, never synced, never in git — so
 * it survives a crash without creating sync noise.
 *
 * 存的是**整库快照**而不是变更日志：库很小，快照比"能把日志重放一遍"简单一个数量级，而且重放本身
 * 就是另一处会出错的地方。
 *
 * What is stored is a **snapshot of the whole database** rather than a change log: the database is
 * small, a snapshot is an order of magnitude simpler than "replay this log", and replaying is itself
 * another place to be wrong.
 */

import type { Logger } from '../core/logger';

/** 一份暂存的快照 / one buffered snapshot. */
export interface PendingSnapshot {
  /** 序列化后的整库 / the serialised database */
  bytes: ArrayBuffer;
  /** 写入时刻（毫秒）/ when it was buffered, in milliseconds */
  savedAt: number;
  /** 旧格式没有归属字段 / legacy snapshots omitted their database identity. */
  databasePath?: string;
}

const DB_NAME = 'documents-activity-tracker';
const STORE_NAME = 'pending';
const LEGACY_KEY = 'database';

/**
 * IndexedDB 的 Promise 包装 / a promise wrapper over IndexedDB.
 *
 * 隐私模式下 IndexedDB 可能整个不可用（打开就抛错，或 open 永远不回调）；这种时候退回"没有暂存"，
 * 并且让调用方继续走落盘那条路 —— 少一层缓冲仍然正确，只是又会撞上同步。
 *
 * In a private mode IndexedDB may be unavailable outright (opening throws, or the request never
 * settles). Then this degrades to "nothing buffered", and the caller falls back to writing the file:
 * one layer less is still correct, it just meets sync again.
 */
export class PendingBuffer {
  private openFailed = false;

  constructor(
    private readonly log: Logger,
    /** 数据路径也是暂存身份，切换数据库不得混入旧库 / switching databases must not import another buffer. */
    private readonly databasePath: string,
  ) {}

  private get key(): string {
    return `database:${this.databasePath}`;
  }

  /** 打开那个小库 / open the small database. */
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (this.openFailed) {
        reject(new Error('IndexedDB 已判定不可用 / IndexedDB marked unavailable'));
        return;
      }
      if (typeof indexedDB === 'undefined') {
        reject(new Error('没有 IndexedDB / no IndexedDB'));
        return;
      }

      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
  }

  /** 读出暂存，没有就 null / read what is buffered, or null. */
  async read(): Promise<PendingSnapshot | null> {
    let db: IDBDatabase | null = null;
    try {
      const opened = await this.open();
      db = opened;
      const value = await new Promise<PendingSnapshot | null>((resolve, reject) => {
        const tx = opened.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        let snapshot: PendingSnapshot | null = null;
        const parse = (raw: unknown): PendingSnapshot => {
          if (!raw || typeof raw !== 'object' || !('bytes' in raw) || !(raw.bytes instanceof ArrayBuffer)
            || !('savedAt' in raw) || typeof raw.savedAt !== 'number' || !Number.isFinite(raw.savedAt)
            || ('databasePath' in raw && raw.databasePath !== this.databasePath)) {
            throw new Error('数据库暂存无效或归属不符 / invalid or mismatched pending snapshot');
          }
          return { bytes: raw.bytes, savedAt: raw.savedAt, databasePath: this.databasePath };
        };
        const read = (raw: unknown): void => {
          try { snapshot = parse(raw); }
          catch (error) { tx.abort(); reject(error); }
        };
        const request = store.get(this.key);
        request.onsuccess = () => {
          const scoped: unknown = request.result;
          if (scoped !== undefined) { read(scoped); return; }

          //  旧快照没有归属，只能沿用首次启动的当前配置；原子转存避免升级丢失未落盘数据。
          //  Legacy ownership is unknowable: retain the existing first-start recovery behavior,
          //  atomically claiming it for the currently configured database without losing its bytes.
          const legacy = store.get(LEGACY_KEY);
          legacy.onsuccess = () => {
            const raw: unknown = legacy.result;
            if (raw === undefined) return;
            read(raw);
            if (!snapshot) return;
            store.put(snapshot, this.key);
            store.delete(LEGACY_KEY);
          };
          legacy.onerror = () => reject(legacy.error ?? new Error('IndexedDB legacy read failed'));
        };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
        tx.oncomplete = () => resolve(snapshot);
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB read failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB read aborted'));
      });
      return value;
    } catch (error) {
      this.reportUnavailable(error);
      return null;
    } finally {
      db?.close();
    }
  }

  /** 写入一份快照 / buffer a snapshot. */
  async write(bytes: ArrayBuffer): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ bytes, savedAt: Date.now(), databasePath: this.databasePath }, this.key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
      });
      db.close();
    } catch (error) {
      this.reportUnavailable(error);
      throw error;
    }
  }

  /** 清空暂存 / drop what is buffered. */
  async clear(): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(this.key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB clear failed'));
      });
      db.close();
    } catch (error) {
      this.reportUnavailable(error);
    }
  }

  /**
   * 只报一次不可用 / report unavailability once.
   *
   * 每次写都报一遍会刷屏：不可用是环境属性，不是逐次事件。
   * Reporting on every write would flood the console: unavailable is a property of the environment,
   * not a per-call event.
   */
  private reportUnavailable(error: unknown): void {
    if (this.openFailed) return;
    this.openFailed = true;
    this.log.warn('[RTT][buffer] IndexedDB 不可用，改为直接落盘 / unavailable, falling back to direct writes:', error);
  }
}
