import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { silentLogger } from '../src/core/logger';
import { PendingBuffer } from '../src/data/pendingBuffer';
import { SqliteStore } from '../src/data/SqliteStore';
import { MemoryAdapter } from './helpers/memory-adapter';
import type { TimelineEvent } from '../src/core/types';

const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

afterEach(() => {
  if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB);
  else Reflect.deleteProperty(globalThis, 'indexedDB');
});

/** 小型异步 IDB 替身，共用存储以验证隔离 / shared asynchronous storage verifies isolation. */
function installIndexedDB(): Map<string, unknown> {
  const records = new Map<string, unknown>();
  const database = {
    close() {},
    transaction() {
      const transaction = {
        oncomplete: null as (() => void) | null,
        objectStore: () => ({
          get(key: string) {
            const request = { result: records.get(key), onsuccess: null as (() => void) | null };
            queueMicrotask(() => request.onsuccess?.());
            return request;
          },
          put(value: unknown, key: string) { records.set(key, value); },
          delete(key: string) { records.delete(key); },
        }),
      };
      setTimeout(() => transaction.oncomplete?.(), 0);
      return transaction;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open() {
        const request = { result: database, onsuccess: null as (() => void) | null };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    },
  });
  return records;
}

function adapter(): MemoryAdapter {
  const bytes = readFileSync(path.join(import.meta.dir, '../node_modules/sql.js/dist/sql-wasm.wasm'));
  return new MemoryAdapter({ 'sql-wasm.wasm': bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
}

const firstEvent: TimelineEvent = { time: '2026-11-10 10:00:00', type: 'start', file: 'a.md', state: 'tracking' };
const secondEvent: TimelineEvent = { time: '2026-11-10 10:00:01', type: 'pause', file: 'a.md', state: 'pausing' };

describe('异步持久化 / asynchronous persistence', () => {
  it('写盘期间追加的数据仍会在下一次刷新保存 / concurrent appends remain dirty', async () => {
    const disk = adapter();
    const store = new SqliteStore(disk, 'race.sqlite', silentLogger);
    await store.init();
    const write = disk.writeBinary.bind(disk);
    let release: () => void = () => {};
    let signalStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    disk.writeBinary = async (path, bytes) => {
      signalStarted();
      await new Promise<void>(resolve => { release = resolve; });
      await write(path, bytes);
    };
    store.appendEvents([firstEvent]);
    const flushing = store.flushNow({ force: true });
    await started;
    store.appendEvents([secondEvent]);
    release();
    await flushing;
    disk.writeBinary = write;
    await store.flushNow({ force: true });
    const reopened = new SqliteStore(disk, 'race.sqlite', silentLogger);
    await reopened.init();
    expect(reopened.getEvents()).toEqual([firstEvent, secondEvent]);
    await store.close();
    await reopened.close();
  });

  it('不同数据库的暂存可独立恢复与清除 / database buffers stay separate', async () => {
    installIndexedDB();
    const first = new PendingBuffer(silentLogger, 'a.sqlite');
    const second = new PendingBuffer(silentLogger, 'b.sqlite');
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    await first.write(bytes);
    expect(await second.read()).toBeNull();
    await second.write(new Uint8Array([4]).buffer);
    await second.clear();
    expect((await first.read())?.bytes).toEqual(bytes);
    expect(await second.read()).toBeNull();
  });

  it('旧暂存仅被首次打开的数据库原子接管 / legacy recovery is claimed once', async () => {
    const records = installIndexedDB();
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    records.set('database', { bytes, savedAt: 123 });
    const first = new PendingBuffer(silentLogger, 'a.sqlite');
    expect(await first.read()).toEqual({ bytes, savedAt: 123, databasePath: 'a.sqlite' });
    expect(records.has('database')).toBe(false);
    expect((await new PendingBuffer(silentLogger, 'a.sqlite').read())?.bytes).toEqual(bytes);
    expect(await new PendingBuffer(silentLogger, 'b.sqlite').read()).toBeNull();
  });

  it('恢复后的写盘失败不会清除唯一暂存 / failed recovery writes preserve the buffer', async () => {
    installIndexedDB();
    const source = adapter();
    const sourceStore = new SqliteStore(source, 'source.sqlite', silentLogger);
    await sourceStore.init();
    sourceStore.appendEvents([firstEvent]);
    await sourceStore.flushNow({ force: true });
    const bytes = await source.readBinary('source.sqlite');
    await sourceStore.close();
    const pending = new PendingBuffer(silentLogger, 'recovery.sqlite');
    await pending.write(bytes);
    const disk = adapter();
    const write = disk.writeBinary.bind(disk);
    disk.writeBinary = () => Promise.reject(new Error('disk unavailable'));
    const restored = new SqliteStore(disk, 'recovery.sqlite', silentLogger);
    await restored.init();
    expect(restored.getEvents()).toEqual([firstEvent]);
    expect((await pending.read())?.bytes).toEqual(bytes);
    disk.writeBinary = write;
    await restored.flushNow({ force: true });
    expect(await pending.read()).toBeNull();
    await restored.close();
  });
});
