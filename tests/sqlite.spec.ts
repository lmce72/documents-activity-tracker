/**
 * SQLite store tests
 *
 * Runs against the real sql.js wasm (read from node_modules and injected), so the round
 * trips below exercise the bytes that actually get written, not a stand-in.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { silentLogger } from '../src/core/logger';
import { migrateV2ToV3 } from '../src/core/migration';
import { SQLITE_SCHEMA_VERSION, META_SCHEMA_VERSION } from '../src/data/sqlite/schema';
import {
  SqliteStore,
  resolveDatabasePath,
} from '../src/data/SqliteStore';
import type { HistoryCache, ManualSession, TimelineEvent } from '../src/core/types';
import { MemoryAdapter } from './helpers/memory-adapter';

const WASM_PATH = path.join(
  import.meta.dir,
  '..',
  'node_modules',
  'sql.js',
  'dist',
  'sql-wasm.wasm',
);

/** Load the real wasm bytes. */
function wasmBytes(): ArrayBuffer {
  const bytes = readFileSync(WASM_PATH);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const DB_PATH = 'Components/History/readTimeHistory.sqlite';
const JSON_PATH = 'Components/History/readTimeHistory.json';

/** An adapter with the wasm pre-seeded. */
function makeAdapter(): MemoryAdapter {
  return new MemoryAdapter({ 'sql-wasm.wasm': wasmBytes() });
}

function legacyCache(): HistoryCache {
  return {
    version: 2,
    records: {
      'Notes/a.md': { fileName: 'a.md', totalReadTime: 120, lastReadAt: '2026-09-07' },
    },
    timeline: [
      { time: '2026-09-07 08:00:00', type: 'start', file: 'Notes/a.md', state: 'tracking' },
      {
        time: '2026-09-07 08:10:00',
        type: 'blur',
        file: 'Notes/a.md',
        state: 'tracking',
        reason: 'window-blur',
      },
      {
        time: '2026-09-07 08:20:00',
        type: 'focus',
        file: 'Notes/a.md',
        state: 'tracking',
        reason: 'window-focus',
      },
      {
        time: '2026-09-07 08:25:00',
        type: 'switch',
        from: 'Notes/a.md',
        to: 'Notes/b.md',
        fromState: 'tracking',
        toState: 'tracking',
      },
      {
        time: '2026-09-07 08:30:00',
        type: 'save',
        file: 'Notes/b.md',
        state: 'saved',
        duration: 600,
        activeSeconds: 540,
        unfocusedSeconds: 60,

        futureField: 'keep-me',
      },
    ],
  } as unknown as HistoryCache;
}

describe('schema 行映射 / row mapping', () => {
  it('事件往返无损：switch 的 from/to 与 blur 的 reason 都保留', async () => {
    const { eventToRow, rowToEvent } = await import('../src/data/sqlite/schema');
    const original = legacyCache().timeline;

    for (const event of original) {
      expect(rowToEvent(eventToRow(event))).toEqual(event);
    }
  });

  it('未知字段经 raw 列保留 / unknown fields survive via the raw column', async () => {
    const { eventToRow, rowToEvent } = await import('../src/data/sqlite/schema');
    const event = { time: 't', type: 'save', file: 'x.md', futureField: 'keep-me' } as unknown as TimelineEvent;
    const restored = rowToEvent(eventToRow(event)) as unknown as Record<string, unknown>;
    expect(restored.futureField).toBe('keep-me');
  });
});

describe('resolveDatabasePath', () => {
  it('保留用户配置的位置，只换扩展名', () => {
    expect(resolveDatabasePath('Components/History/readTimeHistory.json', 'plug')).toBe(
      'Components/History/readTimeHistory.sqlite',
    );
    expect(resolveDatabasePath('some/dir/data', 'plug')).toBe('some/dir/data.sqlite');
  });

  it('未配置时落在插件目录', () => {
    expect(resolveDatabasePath('', '.obsidian/plugins/x')).toBe(
      '.obsidian/plugins/x/data.sqlite',
    );
    expect(resolveDatabasePath('   ', '.obsidian/plugins/x')).toBe(
      '.obsidian/plugins/x/data.sqlite',
    );
  });
});

describe('SqliteStore — 首次运行 / first run', () => {
  it('库不存在时新建一个空库，且不读取旧 JSON', async () => {
    const adapter = makeAdapter();
    const legacy = legacyCache();
    const jsonText = JSON.stringify(legacy);
    adapter.seedText(JSON_PATH, jsonText);

    const store = new SqliteStore(adapter, DB_PATH, silentLogger);
    const result = await store.init();

    expect(result.created).toBe(true);
    expect(result.eventCount).toBe(0);

    expect(store.getEvents()).toHaveLength(0);
    expect(store.getRecords()).toEqual({});
    expect(store.getMeta(META_SCHEMA_VERSION)).toBe(String(SQLITE_SCHEMA_VERSION));

    //  Never even read — asserted before the content check below, whose own read would
    //  otherwise show up in the log.
    expect(adapter.reads).not.toContain(JSON_PATH);
    // and the legacy file is never rewritten
    expect(await adapter.read(JSON_PATH)).toBe(jsonText);

    await store.close();
  });

  it('库已存在时直接打开，已有的库不会被旧 JSON 覆盖', async () => {
    const adapter = makeAdapter();
    adapter.seedText(JSON_PATH, JSON.stringify(legacyCache()));

    const first = new SqliteStore(adapter, DB_PATH, silentLogger);
    await first.init();
    first.appendEvents([
      { time: '2026-09-25 10:00:00', type: 'start', file: 'Notes/c.md', state: 'tracking' },
    ]);
    await first.flushNow();
    await first.close();

    const second = new SqliteStore(adapter, DB_PATH, silentLogger);
    const result = await second.init();

    expect(result.created).toBe(false);
    expect(result.eventCount).toBe(1);
    expect(second.getEvents()).toHaveLength(1);
    await second.close();
  });

  it('落盘后再打开，事件内容逐字段一致（含 switch 与 reason）', async () => {
    const adapter = makeAdapter();
    const store = new SqliteStore(adapter, DB_PATH, silentLogger);
    await store.init();

    const events = legacyCache().timeline;
    store.appendEvents(events);
    await store.flushNow();
    await store.close();

    const reopened = new SqliteStore(adapter, DB_PATH, silentLogger);
    await reopened.init();

    const readBack = reopened.getEvents();
    expect(readBack).toHaveLength(events.length);
    for (let i = 0; i < events.length; i++) {
      expect(readBack[i]).toEqual(events[i]);
    }
    await reopened.close();
  });
});

describe('SqliteStore — 写入原语 / write primitives', () => {
  it('applySessionSave 累加窗口内与失焦两段时长', async () => {
    const adapter = makeAdapter();
    const store = new SqliteStore(adapter, DB_PATH, silentLogger);
    await store.init();

    store.applySessionSave('Notes/a.md', {
      activeSeconds: 100,
      unfocusedSeconds: 40,
      lastReadAt: '2026-09-07',
    });
    store.applySessionSave('Notes/a.md', {
      activeSeconds: 50,
      unfocusedSeconds: 10,
      lastReadAt: '2026-09-08',
    });

    const record = store.getRecord('Notes/a.md')!;
    expect(record.totalReadTime).toBe(200); //  (100+40) + (50+10)
    expect(record.unfocusedReadTime).toBe(50);
    expect(record.lastReadAt).toBe('2026-09-08');

    await store.close();
  });

  it('deleteFileEvents 同时清理以该文件为 from / to 的 switch 事件', async () => {
    const adapter = makeAdapter();
    const store = new SqliteStore(adapter, DB_PATH, silentLogger);
    await store.init();
    store.appendEvents(legacyCache().timeline);

    expect(store.deleteFileEvents('Notes/a.md')).toBe(4);
    const remaining = store.getEvents();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.type).toBe('save');

    await store.close();
  });

  it('deleteFileEvents 同时清掉物化的 records 行，不留孤儿统计', async () => {
    const adapter = makeAdapter();
    const store = new SqliteStore(adapter, DB_PATH, silentLogger);
    await store.init();

    store.appendEvents(legacyCache().timeline);
    store.applySessionSave('Notes/a.md', {
      activeSeconds: 42,
      unfocusedSeconds: 7,
      lastReadAt: '2026-09-15',
    });
    expect(store.getRecord('Notes/a.md')).not.toBeNull();

    store.deleteFileEvents('Notes/a.md');

    //  Deleting only the events would leave this row behind, so the UI (derived from the
    //  stream) drops the file while getRecords()/getRecord() still report it.
    expect(store.getRecord('Notes/a.md')).toBeNull();
    expect(Object.keys(store.getRecords())).not.toContain('Notes/a.md');

    await store.close();
  });

  it('upsertRecord 按字段合并，deleteRecord 移除', async () => {
    const adapter = makeAdapter();
    const store = new SqliteStore(adapter, DB_PATH, silentLogger);
    await store.init();

    store.upsertRecord('Notes/x.md', { totalReadTime: 10, lastReadAt: '2026-09-01' });
    store.upsertRecord('Notes/x.md', { lastReadAt: '2026-09-02' });

    const record = store.getRecord('Notes/x.md')!;
    expect(record.totalReadTime).toBe(10);
    expect(record.lastReadAt).toBe('2026-09-02');

    store.deleteRecord('Notes/x.md');
    expect(store.getRecord('Notes/x.md')).toBeNull();

    await store.close();
  });
});

describe('SqliteStore — 手动计时 / manual sessions', () => {
  const sessions: ManualSession[] = [
    {
      id: 'm1',
      startTime: '2026-09-07 09:00:00',
      endTime: '2026-09-07 09:25:00',
      durationSeconds: 1500,
      note: '写周报',
      flags: [],
    },
    {
      id: 'm2',
      startTime: '2026-09-08 14:00:00',
      endTime: '2026-09-08 14:10:00',
      durationSeconds: 600,
      note: '复习英语',
      flags: [],
    },
  ];

  it('追加、查询、按区间过滤、删除', async () => {
    const adapter = makeAdapter();
    const store = new SqliteStore(adapter, DB_PATH, silentLogger);
    await store.init();

    for (const session of sessions) store.appendManualSession(session);
    expect(store.getManualSessions()).toHaveLength(2);

    const ranged = store.getManualSessionsInRange('2026-09-08 00:00:00', '2026-09-08 23:59:59');
    expect(ranged).toHaveLength(1);
    expect(ranged[0]!.note).toBe('复习英语');

    store.deleteManualSession('m1');
    expect(store.getManualSessions().map((s) => s.id)).toEqual(['m2']);

    await store.close();
  });

  it('手动计时记录与文档事件互不影响', async () => {
    const adapter = makeAdapter();
    adapter.seedText(JSON_PATH, JSON.stringify(legacyCache()));
    const store = new SqliteStore(adapter, DB_PATH, silentLogger);
    await store.init();

    store.appendManualSession(sessions[0]!);
    store.appendEvents([
      { time: '2026-09-25 10:00:00', type: 'start', file: 'Notes/a.md', state: 'tracking' },
    ]);
    expect(store.getEvents()).toHaveLength(1);
    expect(store.getManualSessions()).toHaveLength(1);

    store.clearAll();
    expect(store.getEvents()).toHaveLength(0);
    expect(store.getManualSessions()).toHaveLength(1);

    await store.close();
  });

  it('落盘后重新打开，手动记录与原值一致', async () => {
    const adapter = makeAdapter();
    const store = new SqliteStore(adapter, DB_PATH, silentLogger);
    await store.init();
    for (const session of sessions) store.appendManualSession(session);
    await store.flushNow();
    await store.close();

    const reopened = new SqliteStore(adapter, DB_PATH, silentLogger);
    await reopened.init();
    expect(reopened.getManualSessions()).toEqual(sessions);
    await reopened.close();
  });
});

describe('SqliteStore — 降级与边界 / degradation and edges', () => {
  it('wasm 缺失时 init 抛错，但不产生半初始化状态', async () => {
    const adapter = new MemoryAdapter();
    const store = new SqliteStore(adapter, DB_PATH, silentLogger);

    let threw = false;
    try {
      await store.init();
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(store.isReady()).toBe(false);
  });

  it('未初始化就读取会抛错，而不是静默返回空数据', () => {
    const store = new SqliteStore(makeAdapter(), DB_PATH, silentLogger);
    expect(() => store.getEvents()).toThrow();
  });

  it('旧 JSON 损坏也不影响新建空库', async () => {
    const adapter = makeAdapter();
    adapter.seedText(JSON_PATH, '{ this is not json');

    const store = new SqliteStore(adapter, DB_PATH, silentLogger);
    const result = await store.init();

    expect(result.created).toBe(true);
    expect(store.getEvents()).toHaveLength(0);

    await store.close();
  });

  it('无论旧 JSON 是什么版本，都不迁移、不导入', async () => {

    //  A v2 or a v3 legacy file is treated the same way here: neither is read.
    for (const version of [2, 3]) {
      const adapter = makeAdapter();
      const legacy = version === 2 ? legacyCache() : migrateV2ToV3(legacyCache()).cache;
      adapter.seedText(JSON_PATH, JSON.stringify(legacy));

      const store = new SqliteStore(adapter, DB_PATH, silentLogger);
      await store.init();

      expect(store.getEvents()).toHaveLength(0);
      expect(adapter.reads).not.toContain(JSON_PATH);
      await store.close();
    }
  });
});
