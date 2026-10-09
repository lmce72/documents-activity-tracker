/**
 * In-memory adapter for tests
 *
 * Lets the storage layer run outside Obsidian: text and binary both live in a Map, and
 * bundled plugin assets (such as sql-wasm.wasm) are pre-seeded via the constructor.
 */

import type { DataAdapter } from '../../src/data/adapter';

export class MemoryAdapter implements DataAdapter {
  private readonly text = new Map<string, string>();
  private readonly binary = new Map<string, ArrayBuffer>();
  private pluginData: unknown = null;

  readonly writes: string[] = [];

  readonly reads: string[] = [];

  constructor(pluginAssets: Record<string, ArrayBuffer> = {}) {
    for (const [name, bytes] of Object.entries(pluginAssets)) {
      this.binary.set(name, bytes);
    }
  }

  /** Seed a text file. */
  seedText(path: string, content: string): void {
    this.text.set(path, content);
  }

  /** Seed a binary file. */
  seedBinary(path: string, content: ArrayBuffer): void {
    this.binary.set(path, content);
  }

  async read(path: string): Promise<string> {
    this.reads.push(path);
    const value = this.text.get(path);
    if (value === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.text.set(path, data);
    this.writes.push(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    this.reads.push(path);
    const value = this.binary.get(path);
    if (value === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return value;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.binary.set(path, data);
    this.writes.push(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.text.has(path) || this.binary.has(path);
  }

  async readPluginBinary(name: string): Promise<ArrayBuffer> {
    const value = this.binary.get(name);
    if (value === undefined) {
      throw new Error(`ENOENT (plugin asset): ${name}`);
    }
    return value;
  }

  async loadData(): Promise<unknown> {
    return this.pluginData;
  }

  async saveData(data: unknown): Promise<void> {
    this.pluginData = data;
    this.writes.push('(plugin data.json)');
  }
}
