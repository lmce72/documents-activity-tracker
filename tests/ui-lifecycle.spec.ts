import { expect, it } from 'bun:test';
import { Script } from 'node:vm';

// 隔离 Obsidian 桩，避免修改其它测试的模块缓存 / isolate host stubs from other tests' module mocks.
const build = await Bun.build({ entrypoints: ['src/main.ts'], target: 'node', format: 'cjs', external: ['obsidian', 'sql.js'], write: false });
if (!build.success || !build.outputs[0]) throw new Error('Could not bundle plugin lifecycle tests');
const source = await build.outputs[0].text();

interface CountdownRun { status: string; startTimestamp: number; plan: object | null }
interface Harness {
  onload(): Promise<void>;
  onunload(): void;
  loadSettings(): Promise<void>;
  restorePendingLive(): void;
  checkCountdownFinish(): void;
  updateSettings(patch: Record<string, unknown>): Promise<void>;
  saveData(settings: object): Promise<void>;
  persistLiveSnapshot(): void;
  refreshSidebar(): void;
  settings: { countdownTimerEnabled: boolean; countdownPromptNote: boolean; [key: string]: unknown };
  pendingLive: { version: number; savedAt: number; manual?: object; countdown?: object } | null;
  timerStore?: { getState(): { manual: { status: string }; countdown: CountdownRun }; dispatch(action: { type: string; payload?: object }): void };
  countdownService: { isComplete(): boolean; stop(note: string): Promise<null> };
  timerService: { onSettingsChange(): Promise<void> };
}

function fixture(): { plugin: Harness; prompts: Array<{ onDone(note: string | null): void }> } {
  const prompts: Array<{ onDone(note: string | null): void }> = [];
  class HostComponent {}
  class HostModal { open(): void { prompts.push(this as unknown as { onDone(note: string | null): void }); } }
  const host = { Plugin: HostComponent, Modal: HostModal, ItemView: HostComponent, PluginSettingTab: HostComponent, Platform: { isMobile: false }, Notice: class {}, MarkdownView: HostComponent };
  const module = { exports: {} };
  new Script(source).runInNewContext({ module, exports: module.exports, require: (name: string): unknown => {
    if (name === 'obsidian') return host;
    if (name === 'sql.js') return {};
    throw new Error(`Unexpected runtime dependency: ${name}`);
  }, window: {}, console });
  const Plugin = (module.exports as { default: new () => Harness }).default;
  return { plugin: new Plugin(), prompts };
}

it('unloading while settings load prevents late plugin initialization', async () => {
  const { plugin } = fixture();
  let release = (): void => {};
  plugin.loadSettings = () => new Promise<void>(resolve => { release = resolve; });
  plugin.persistLiveSnapshot = () => {};
  const loading = plugin.onload();
  plugin.onunload();
  release();
  await loading;
  await Promise.resolve();
  expect(plugin.timerStore).toBeUndefined();
});

it('recovery keeps the previous manual run when a new manual timer is active', () => {
  const { plugin } = fixture();
  const manual = { startedAt: '2026-11-09 10:00:00', elapsedMs: 1000, pausedMs: 0, pauses: [], flags: [], running: true };
  const countdown = { ...manual, plan: { mode: 'down', phases: [{ seconds: 60, kind: 'focus' }] }, skippedSeconds: 0 };
  plugin.pendingLive = { version: 1, savedAt: 1000, manual, countdown };
  let restored = 0;
  plugin.timerStore = {
    getState: () => ({ manual: { status: 'running' }, countdown: { status: 'idle', startTimestamp: 0, plan: null } }),
    dispatch: () => { restored++; },
  };
  plugin.persistLiveSnapshot = () => {};
  plugin.refreshSidebar = () => {};
  plugin.restorePendingLive();
  expect(restored).toBe(1);
  expect(plugin.pendingLive?.manual).toBe(manual);
  expect(plugin.pendingLive?.countdown).toBeUndefined();
});

it('a completed countdown prompt cannot stop a replacement run', () => {
  const { plugin, prompts } = fixture();
  let current: CountdownRun = { status: 'running', startTimestamp: 1000, plan: {} };
  let stopped = 0;
  plugin.settings = { countdownTimerEnabled: true, countdownPromptNote: true };
  plugin.timerStore = { getState: () => ({ manual: { status: 'idle' }, countdown: current }), dispatch: () => {} };
  plugin.countdownService = { isComplete: () => true, stop: () => { stopped++; return Promise.resolve(null); } };
  plugin.checkCountdownFinish();
  expect(prompts).toHaveLength(1);
  current = { status: 'running', startTimestamp: 2000, plan: {} };
  prompts[0]!.onDone('old round');
  expect(stopped).toBe(0);
  plugin.checkCountdownFinish();
  expect(prompts).toHaveLength(2);
});

it('settings writes finish in order and keep patches from overlapping controls', async () => {
  const { plugin } = fixture();
  plugin.settings = { countdownTimerEnabled: true, countdownPromptNote: false, perDeviceSettings: true };
  plugin.timerService = { onSettingsChange: () => Promise.resolve() };
  plugin.refreshSidebar = () => {};
  let release = (): void => {};
  const writes: object[] = [];
  plugin.saveData = settings => {
    writes.push(settings);
    return writes.length === 1 ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  };
  const first = plugin.updateSettings({ filterPatterns: 'private' });
  const second = plugin.updateSettings({ idleTimeout: 15 });
  await Promise.resolve();
  expect(writes).toHaveLength(1);
  release();
  await Promise.all([first, second]);
  expect(writes).toHaveLength(2);
  expect((writes[1] as { filterPatterns: string }).filterPatterns).toBe('private');
  expect((writes[1] as { idleTimeout: number }).idleTimeout).toBe(15);
});
