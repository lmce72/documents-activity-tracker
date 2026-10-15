/**
 * SQLite persistence layer
 *
 * Choice: sql.js (SQLite compiled to WASM). Native modules were rejected because they
 * would force `isDesktopOnly: true` and drop mobile support.
 *
 * How the wasm is loaded:
 *
 *   The wasm ships beside main.js and is read through the vault adapter into an
 *   ArrayBuffer, then injected via `initSqlJs({ wasmBinary })`. `fetch`/`locateFile` are
 *   deliberately avoided: they run into CSP and differ between desktop and mobile. If the
 *   wasm cannot be read, the store degrades to in-memory-only and reports it, rather than
 *   making the whole plugin fail to load.
 *
 * Persistence:
 *
 *   sql.js has no incremental persistence: a save is `db.export()` plus a full overwrite.
 *   The database is small, so mutations mark it dirty and coalesce into one write, with
 *   `flushNow()` for critical points (session saved, manual timer stopped, plugin unload).
 *
 * **Historical data is deliberately not migrated** (an explicit user decision). This class
 * neither reads nor writes the legacy JSON data file: the database starts empty and only
 * records what happens from now on, leaving the old file untouched on disk for the user to
 * deal with. There is therefore no "import on first run" path — silently moving a user's
 * history is not a decision a plugin should make on their behalf.
 *
 */

import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';

import type { Logger } from '../core/logger';
import { PendingBuffer } from './pendingBuffer';

/**
 * 什么时刻在要求落盘 / which moment is asking for a write.
 *
 * 不传（或 null）= 合并刷盘，没有明确时机，只做暂存、不写文件。
 * Absent (or null) means a coalesced flush with no moment attached: buffer, never write the file.
 */
export type FlushTrigger = 'session-end' | 'interval' | 'quit';
import type { ManualSession, RecordEntry, TimelineEvent } from '../core/types';
import type { DataAdapter } from './adapter';
import type { HistoryStore } from './historyStore';
import {
  META_SCHEMA_VERSION,
  SQL_MIGRATE_V1_TO_V2,
  SQL_MIGRATE_V2_TO_V3,
  SQL_CREATE_SCHEMA,
  SQLITE_SCHEMA_VERSION,
  eventToRow,
  manualSessionToRow,
  recordToRow,
  rowToEvent,
  rowToManualSession,
  rowToRecord,
  type EventRow,
  type ManualSessionRow,
  type RecordRow,
} from './sqlite/schema';

/** the wasm file shipped beside main.js. */
export const SQL_WASM_FILE = 'sql-wasm.wasm';

export const DEFAULT_DB_NAME = 'data.sqlite';

const FLUSH_DELAY_MS = 1000;

/** The outcome of initialising the store. */
export interface SqliteInitResult {

  created: boolean;
  /**
   * how many events the database already held.
   * Lets the assembly layer tell a first run apart from an empty database.
   */
  eventCount: number;
}

/**
 * Derive the database path from settings.
 *
 * The user's configured location is kept and only the extension changes: they chose
 * *where* the data lives, not *which format* it uses.
 *
 * plugin dir as a vault-relative path
 */
export function resolveDatabasePath(dataFilePath: string, pluginDir: string): string {
  const trimmed = (dataFilePath ?? '').trim();
  if (!trimmed) return `${pluginDir}/${DEFAULT_DB_NAME}`;

  const withoutExt = trimmed.replace(/\.(json|sqlite|db)$/i, '');
  return `${withoutExt}.sqlite`;
}

/** Statements used for reading. */
const SQL_SELECT_EVENTS = 'SELECT * FROM events ORDER BY time ASC, id ASC';
const SQL_SELECT_RECORDS = 'SELECT * FROM records';
const SQL_SELECT_MANUAL = 'SELECT * FROM manual_sessions ORDER BY start_time ASC';
const SQL_SELECT_MANUAL_RANGE =
  'SELECT * FROM manual_sessions WHERE start_time >= ? AND start_time <= ? ' +
  'ORDER BY start_time ASC';

export class SqliteStore implements HistoryStore {
  private db: Database | null = null;
  private SQL: SqlJsStatic | null = null;

  /** whether there are unsaved changes */
  private dirty = false;
  /** the coalescing flush timer */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** serialises flushes so two exports cannot interleave */
  private flushChain: Promise<void> = Promise.resolve();
  /** whether a flush failure was already reported */
  private flushErrorReported = false;

  /**
   * 是否有一份比 vault 文件新的快照躺在浏览器库里 / whether the browser holds a snapshot
   * newer than the vault file.
   *
   * 这个标志与 dirty 分工：dirty 说的是"内存有改动没存过"，buffered 说的是"vault 文件落后了"。
   * 推迟落盘时内存已经存进暂存，所以 dirty 归零，但文件仍落后 —— 只看 dirty 就永远补不上。
   *
   * The two flags divide the work: dirty means "memory has unstored changes", buffered means
   * "the vault file is behind". Deferring a write stores memory into the buffer and clears dirty,
   * yet the file is still behind — looking at dirty alone would never catch up.
   */
  private buffered = false;

  /**
   * 落盘闸门 / the flush gate.
   *
   * 返回 false 时本次改动只进浏览器暂存，vault 文件不动。由设置驱动，四种时机各自独立开关。
   * When it returns false the change goes to the browser buffer only and the vault file is left
   * alone. Driven by settings; the four triggers each have their own switch.
   */
  private gate: (trigger: FlushTrigger | null) => boolean = () => false;

  /** 未落盘快照的暂存 / the buffer for unflushed snapshots */
  private readonly pending: PendingBuffer;

  constructor(
    private readonly adapter: DataAdapter,
    /** database path relative to the vault */
    private readonly dbPath: string,
    private readonly log: Logger,
  ) {

    //  在构造函数体里建，而不是字段初始化器：字段初始化跑在参数属性赋值之前，那时 this.log 还是 undefined
    //  Built in the constructor body rather than a field initializer: initializers run before the
    //  parameter properties are assigned, when this.log is still undefined.
    this.pending = new PendingBuffer(log);
  }

  /** 设定落盘闸门 / set the flush gate. */
  setFlushGate(gate: (trigger: FlushTrigger | null) => boolean): void {
    this.gate = gate;
  }

  get path(): string {
    return this.dbPath;
  }

  isReady(): boolean {
    return this.db !== null;
  }

  /**
   * Initialise: load the wasm, then open the existing database or create an empty one.
   *
   *         Throws when the wasm is unreadable or the database cannot be opened; callers
   *         are expected to catch and degrade to the in-memory repository.
   */
  async init(): Promise<SqliteInitResult> {
    const wasmBinary = await this.adapter.readPluginBinary(SQL_WASM_FILE);

    //  The bundled types omit `wasmBinary`, but the Emscripten runtime honours it — and it
    //  is what lets us avoid fetch entirely.
    this.SQL = await initSqlJs({ wasmBinary } as never);

    //  暂存里那份比 vault 文件新：它是上一次被推迟的落盘，文件还没跟上。崩溃之后靠它续上，
    //  而不是把 vault 文件里那份旧的当成真相。
    //  The buffered snapshot is newer than the vault file: it is the write that was deferred and
    //  the file never caught up. After a crash it is what continues the story — the stale file is
    //  not the truth.
    const buffered = await this.pending.read();
    if (buffered && buffered.bytes.byteLength > 0) {
      this.db = new this.SQL.Database(new Uint8Array(buffered.bytes));
      this.migrateSchemaIfNeeded();
      await this.pending.clear();
      const eventCount = this.count('SELECT COUNT(*) AS n FROM events');
      this.log.info(
        '[RTT][sqlite] 已从浏览器暂存恢复 / recovered from the browser buffer:',
        eventCount,
        '条事件 / events',
      );
      return { created: false, eventCount };
    }

    const exists = await this.adapter.exists(this.dbPath);
    if (exists) {
      const bytes = await this.adapter.readBinary(this.dbPath);
      this.db = new this.SQL.Database(new Uint8Array(bytes));
      this.migrateSchemaIfNeeded();
      const eventCount = this.count('SELECT COUNT(*) AS n FROM events');
      this.log.info('[RTT][sqlite] 已打开库 / opened database:', this.dbPath, eventCount);
      return { created: false, eventCount };
    }

    this.db = new this.SQL.Database();
    this.db.run(SQL_CREATE_SCHEMA);
    this.setMeta(META_SCHEMA_VERSION, String(SQLITE_SCHEMA_VERSION));

    this.dirty = true;
    await this.flushNow();

    this.log.info('[RTT][sqlite] 已新建空库 / created empty database:', this.dbPath);
    return { created: true, eventCount: 0 };
  }

  /** Flush and close. */
  async close(): Promise<void> {
    await this.flushNow({ trigger: 'quit' });
    this.db?.close();
    this.db = null;
    this.SQL = null;
  }

  //  ==========================================================================
  // Reads
  //  ==========================================================================

  getEvents(): TimelineEvent[] {
    return this.queryAll<EventRow>(SQL_SELECT_EVENTS).map(rowToEvent);
  }

  /** every record entry, keyed by path. */
  getRecords(): Record<string, RecordEntry> {
    const out: Record<string, RecordEntry> = {};
    for (const row of this.queryAll<RecordRow>(SQL_SELECT_RECORDS)) {
      const [filePath, entry] = rowToRecord(row);
      out[filePath] = entry;
    }
    return out;
  }

  /** one record entry, or null. */
  getRecord(filePath: string): RecordEntry | null {
    const row = this.queryOne<RecordRow>(
      'SELECT * FROM records WHERE file_path = ?',
      [filePath],
    );
    return row ? rowToRecord(row)[1] : null;
  }

  /** every manual session, oldest first. */
  getManualSessions(): ManualSession[] {
    return this.queryAll<ManualSessionRow>(SQL_SELECT_MANUAL).map(rowToManualSession);
  }

  getManualSessionsInRange(start: string, end: string): ManualSession[] {
    return this.queryAll<ManualSessionRow>(SQL_SELECT_MANUAL_RANGE, [start, end]).map(
      rowToManualSession,
    );
  }

  //  ==========================================================================
  // Writes
  //  ==========================================================================

  /** Append events. */
  appendEvents(events: readonly TimelineEvent[]): void {
    if (events.length === 0) return;
    this.insertEvents(events);
    this.markDirty();
  }

  /** Replace the whole event log. */
  replaceEvents(events: readonly TimelineEvent[]): void {
    const db = this.requireDb();
    db.run('BEGIN TRANSACTION');
    try {
      db.run('DELETE FROM events');
      this.insertEvents(events, false);
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
    this.markDirty();
  }

  /**
   *
   * The matching `records` row must go too. `records` is a materialised view of `events`,
   * and deleting only the events leaves an orphan row: the UI (derived from the stream)
   * drops the file while `getRecords()` / `getRecord()` keep reporting it — measured
   * exactly that way. Two sources of truth disagreeing hardens into a ghost record after a
   * restart.
   *
   * how many event rows were removed
   */
  deleteFileEvents(filePath: string): number {
    const db = this.requireDb();
    const before = this.count('SELECT COUNT(*) AS n FROM events');
    db.run(
      'DELETE FROM events WHERE file = ? OR from_path = ? OR to_path = ?',
      [filePath, filePath, filePath],
    );
    db.run('DELETE FROM records WHERE file_path = ?', [filePath]);
    const after = this.count('SELECT COUNT(*) AS n FROM events');
    this.markDirty();
    return before - after;
  }

  /**
   * Apply a completed session save.
   *
   * Accumulates rather than overwrites: the totals are the live counter's figures, kept
   * as an independent counterpart to the event-derived view. Unfocused time accumulates
   * separately.
   */
  applySessionSave(
    filePath: string,
    data: { activeSeconds: number; unfocusedSeconds: number; lastReadAt: string },
  ): void {
    const db = this.requireDb();
    const fileName = filePath.split('/').pop() ?? filePath;

    db.run(
      `INSERT INTO records (file_path, file_name, total_read_time, unfocused_read_time, last_read_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         total_read_time     = total_read_time + excluded.total_read_time,
         unfocused_read_time = unfocused_read_time + excluded.unfocused_read_time,
         last_read_at        = excluded.last_read_at,
         file_name           = excluded.file_name`,
      [
        filePath,
        fileName,
        data.activeSeconds + data.unfocusedSeconds,
        data.unfocusedSeconds,
        data.lastReadAt,
      ],
    );

    this.markDirty();
  }

  upsertRecord(filePath: string, data: Partial<RecordEntry>): void {
    const db = this.requireDb();
    const existing = this.getRecord(filePath);
    const merged: RecordEntry = {
      fileName: data.fileName ?? existing?.fileName ?? filePath.split('/').pop() ?? filePath,
      totalReadTime: data.totalReadTime ?? existing?.totalReadTime ?? 0,
      unfocusedReadTime: data.unfocusedReadTime ?? existing?.unfocusedReadTime ?? 0,
      lastReadAt: data.lastReadAt ?? existing?.lastReadAt ?? '',
    };
    const row = recordToRow(filePath, merged);

    db.run(
      `INSERT INTO records (file_path, file_name, total_read_time, unfocused_read_time, last_read_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         file_name           = excluded.file_name,
         total_read_time     = excluded.total_read_time,
         unfocused_read_time = excluded.unfocused_read_time,
         last_read_at        = excluded.last_read_at`,
      [row.file_path, row.file_name, row.total_read_time, row.unfocused_read_time, row.last_read_at],
    );

    this.markDirty();
  }

  /** Delete a record. */
  deleteRecord(filePath: string): void {
    this.requireDb().run('DELETE FROM records WHERE file_path = ?', [filePath]);
    this.markDirty();
  }

  /** Append a manual session. */
  appendManualSession(session: ManualSession): void {
    const row = manualSessionToRow(session);
    this.requireDb().run(
      `INSERT INTO manual_sessions (id, start_time, end_time, duration_seconds, note, flags, pauses)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         start_time       = excluded.start_time,
         end_time         = excluded.end_time,
         duration_seconds = excluded.duration_seconds,
         note             = excluded.note,
         flags            = excluded.flags,
         pauses           = excluded.pauses`,
      [
        row.id,
        row.start_time,
        row.end_time,
        row.duration_seconds,
        row.note,
        row.flags ?? '[]',
        row.pauses ?? '[]',
      ],
    );
    this.markDirty();
  }

  /** Delete a manual session. */
  deleteManualSession(id: string): void {
    this.requireDb().run('DELETE FROM manual_sessions WHERE id = ?', [id]);
    this.markDirty();
  }

  clearAll(): void {
    const db = this.requireDb();
    db.run('DELETE FROM events');
    db.run('DELETE FROM records');
    this.markDirty();
  }

  //  ==========================================================================
  // Persistence
  //  ==========================================================================

  /** Mark dirty and schedule a coalesced flush. */
  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer !== null) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, FLUSH_DELAY_MS);
  }

  /**
   * Flush right away.
   * Serialised through a queue: two interleaved exports would write a truncated database.
   */
  async flushNow(options: { force?: boolean; trigger?: FlushTrigger } = {}): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    //  buffered 也算有待收尾：内存可能已经不脏，但 vault 文件还落后一截
    //  buffered counts as unfinished too: memory may be settled while the vault file is behind
    if (!this.db || (!this.dirty && !this.buffered)) return;

    //  force 用于退出、手动保存、首次建库这些必须落盘的时刻
    //  force is for the moments that must reach the file: quitting, the manual save, creating a
    //  brand-new database.
    const allowed = options.force === true || this.gate(options.trigger ?? null);

    const pending = this.flushChain.then(async () => {

      //  与外层同一条件：buffered 也要收尾，否则推迟过一次之后就永远写不出去了
      //  Same condition as the outer check: buffered needs finishing too, or one deferred write means
      //  the file is never written again.
      if (!this.db || (!this.dirty && !this.buffered)) return;
      try {
        const bytes = this.db.export();

        //  The exported buffer can be larger than the data; slice by byteLength or
        //  uninitialised memory gets written into the file.
        const payload = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;

        //  时机没到：整库存进浏览器自己的库，vault 文件一个字节都不动。不是"先放内存等会儿" ——
        //  那样崩溃就丢了。
        //
        //  Not the moment: the whole database goes into the browser's own store and the vault file is
        //  not touched at all. Not "park it in memory for later" — that loses it on a crash.
        let stored = false;
        if (!allowed) {
          try {
            await this.pending.write(payload);
            this.buffered = true;
            stored = true;
          } catch (error) {

            //  暂存本身不可用（隐私模式、Node 测试环境）：宁可这次就撞同步，也不能丢数据。
            //  The buffer itself is unavailable (a private mode, the Node test environment): better to
            //  meet sync this once than to lose the data.
            this.log.warn('[RTT][sqlite] 暂存不可用，改为直接落盘 / buffer unavailable, writing the file:', error);
          }
        }

        if (!stored) {
          await this.adapter.writeBinary(this.dbPath, payload);
          await this.pending.clear();
          this.buffered = false;
        }
        this.dirty = false;
        this.flushErrorReported = false;
      } catch (error) {

        //  On failure the store stays dirty so the next change or close retries
        if (!this.flushErrorReported) {
          this.log.warn('[RTT][sqlite] 落盘失败 / flush failed:', error);
          this.flushErrorReported = true;
        }
      }
    });

    this.flushChain = pending.catch(() => {});
    await pending.catch(() => {});
  }

  //  ==========================================================================
  // Internals
  //  ==========================================================================

  private requireDb(): Database {
    if (!this.db) throw new Error('[RTT][sqlite] 存储尚未初始化 / store not initialised');
    return this.db;
  }

  /** Insert events in one transaction. */
  private insertEvents(events: readonly TimelineEvent[], ownTransaction = true): void {
    const db = this.requireDb();
    const stmt = db.prepare(
      `INSERT INTO events
         (time, type, file, from_path, to_path, state, reason, duration,
          active_seconds, unfocused_seconds, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      if (ownTransaction) db.run('BEGIN');
      for (const event of events) {
        const row = eventToRow(event);
        stmt.run([
          row.time,
          row.type,
          row.file,
          row.from_path,
          row.to_path,
          row.state,
          row.reason,
          row.duration,
          row.active_seconds,
          row.unfocused_seconds,
          row.raw,
        ]);
      }
      if (ownTransaction) db.run('COMMIT');
    } catch (error) {
      if (ownTransaction) db.run('ROLLBACK');
      throw error;
    } finally {
      stmt.free();
    }
  }

  /** Insert record entries in one transaction. */
  private insertRecords(records: Record<string, RecordEntry>): void {
    const db = this.requireDb();
    const stmt = db.prepare(
      `INSERT INTO records
         (file_path, file_name, total_read_time, unfocused_read_time, last_read_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         file_name           = excluded.file_name,
         total_read_time     = excluded.total_read_time,
         unfocused_read_time = excluded.unfocused_read_time,
         last_read_at        = excluded.last_read_at`,
    );
    try {
      db.run('BEGIN');
      for (const [filePath, entry] of Object.entries(records)) {
        const row = recordToRow(filePath, entry);
        stmt.run([
          row.file_path,
          row.file_name,
          row.total_read_time,
          row.unfocused_read_time,
          row.last_read_at,
        ]);
      }
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    } finally {
      stmt.free();
    }
  }

  /** Write a meta entry. */
  private setMeta(key: string, value: string): void {
    this.requireDb().run(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  /** Read a meta entry. */
  getMeta(key: string): string | null {
    const row = this.queryOne<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  /** whether a table already has a column. */
  private hasColumn(table: string, column: string): boolean {
    const rows = this.queryAll<{ name: string }>(`PRAGMA table_info(${table})`);
    return rows.some((row) => row.name === column);
  }

  /**
   * Schema upgrades.
   *
   * The `IF NOT EXISTS` DDL is idempotent for tables, but **not for columns**: it does
   * nothing to an existing table and never adds one. A database upgrading from v1 therefore
   * needs an explicit `ALTER TABLE`, while a fresh one already has the column and must skip
   * it (adding twice raises "duplicate column name").
   */
  private migrateSchemaIfNeeded(): void {
    const current = Number(this.getMeta(META_SCHEMA_VERSION) ?? '0');
    if (current >= SQLITE_SCHEMA_VERSION) return;

    this.requireDb().run(SQL_CREATE_SCHEMA);

    // the v1 table lacks `flags`
    if (current >= 1 && !this.hasColumn('manual_sessions', 'flags')) {
      this.requireDb().run(SQL_MIGRATE_V1_TO_V2);
      this.log.info('[RTT][sqlite] 补列 / added column: manual_sessions.flags');
    }

    // v2 lacks `pauses`; a fresh database already has it from the DDL above
    if (current >= 2 && !this.hasColumn('manual_sessions', 'pauses')) {
      this.requireDb().run(SQL_MIGRATE_V2_TO_V3);
      this.log.info('[RTT][sqlite] 补列 / added column: manual_sessions.pauses');
    }

    this.setMeta(META_SCHEMA_VERSION, String(SQLITE_SCHEMA_VERSION));
    this.markDirty();
    this.log.info(
      `[RTT][sqlite] 库结构升级 / schema upgraded: ${current} -> ${SQLITE_SCHEMA_VERSION}`,
    );
  }

  /** Run a query returning rows. */
  private queryAll<T>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.requireDb().prepare(sql);
    const rows: T[] = [];
    try {
      stmt.bind(params as never);
      while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T);
    } finally {
      stmt.free();
    }
    return rows;
  }

  /** Run a query returning at most one row. */
  private queryOne<T>(sql: string, params: unknown[] = []): T | null {
    const rows = this.queryAll<T>(sql, params);
    return rows.length > 0 ? rows[0]! : null;
  }

  /** Count rows. */
  private count(sql: string): number {
    const row = this.queryOne<{ n: number }>(sql);
    return row ? Number(row.n) : 0;
  }
}
