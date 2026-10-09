/**
 * Data I/O abstraction
 *
 * Rationale: the original store held a Plugin instance and did I/O through it, so the
 * persistence layer could not be tested outside Obsidian. Narrowing it to this set of
 * methods lets production wrap the Plugin and tests use an in-memory implementation.
 *
 * Binary I/O and bundled-asset reading are new here, for the SQLite store: the database
 * file is binary, and the bundled `sql-wasm.wasm` is read through the vault adapter
 * rather than `fetch`, which avoids CSP and mobile path differences.
 *
 */

import type { App, Plugin } from 'obsidian';

/** Every I/O capability the store needs. */
export interface DataAdapter {
  /** read a vault-relative path as text */
  read(path: string): Promise<string>;
  /** write a vault-relative path */
  write(path: string, data: string): Promise<void>;
  /** read a vault-relative path as binary */
  readBinary(path: string): Promise<ArrayBuffer>;
  /** write a vault-relative path as binary */
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  /** whether a path exists */
  exists(path: string): Promise<boolean>;

  readPluginBinary(name: string): Promise<ArrayBuffer>;
  /** read the plugin's data.json */
  loadData(): Promise<unknown>;
  /** write the plugin's data.json */
  saveData(data: unknown): Promise<void>;
}

/**
 * Production implementation wrapping a Plugin.
 */
export class ObsidianAdapter implements DataAdapter {
  constructor(private readonly plugin: Plugin) {}

  /** convenience accessor for the app. */
  private get app(): App {
    return this.plugin.app;
  }

  /**
   * the plugin folder as a vault-relative path.
   *
   * `manifest.dir` is normally supplied by the host; when absent, fall back to the
   * conventional layout so bundled assets can still be located.
   */
  private get pluginDir(): string {
    const manifest = this.plugin.manifest;
    return manifest.dir ?? `${this.app.vault.configDir}/plugins/${manifest.id}`;
  }

  async read(path: string): Promise<string> {

    //  adapter.read throws when the file is absent; callers handle that
    return this.app.vault.adapter.read(path);
  }

  async write(path: string, data: string): Promise<void> {
    await this.app.vault.adapter.write(path, data);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.app.vault.adapter.readBinary(path);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    await this.app.vault.adapter.writeBinary(path, data);
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(path);
  }

  async readPluginBinary(name: string): Promise<ArrayBuffer> {
    return this.app.vault.adapter.readBinary(`${this.pluginDir}/${name}`);
  }

  async loadData(): Promise<unknown> {
    return this.plugin.loadData();
  }

  async saveData(data: unknown): Promise<void> {
    await this.plugin.saveData(data as Record<string, unknown>);
  }
}
