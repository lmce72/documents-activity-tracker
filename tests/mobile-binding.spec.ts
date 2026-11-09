import { expect, it, mock } from 'bun:test';
import type { App, Plugin } from 'obsidian';
import { CapturingLogger } from './helpers/fake-clock';
import type { TimerService } from '../src/services/TimerService';

mock.module('obsidian', () => ({ Platform: { isMobile: true }, MarkdownView: class {} }));
const { installBindings } = await import('../src/ui/obsidianBinding');

/** Real binding handlers run against a controllable WebView/native lifecycle. */
function bindingFixture(multiWindow = false) {
  const dom = new Map<string, () => void>();
  const native = new Map<string, (state?: { isActive?: boolean }) => void>();
  const backgrounds: boolean[] = [];
  let interval = (): void => {};
  let startup = (): void => {};
  let active = true;
  let removed = 0;
  const web = { visibilityState: 'visible', hasFocus: () => true };
  const win = {
    setInterval: (handler: () => void) => { interval = handler; return 1; },
    clearInterval: () => {},
    setTimeout: (handler: () => void) => { startup = handler; return 1; },
    Capacitor: { Plugins: { App: {
      getState: () => Promise.resolve({ isActive: active }),
      addListener: (name: string, handler: (state?: { isActive?: boolean }) => void) => {
        native.set(name, handler);
        return Promise.resolve({ remove: () => { removed++; return Promise.resolve(); } });
      },
    } } },
  };
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: web, configurable: true });
  const workspace = {
    on: () => ({}), offref: () => {}, onLayoutReady: (handler: () => void) => handler(),
    activeLeaf: null, getMostRecentLeaf: () => null, iterateAllLeaves: () => {},
  };
  const plugin = {
    registerDomEvent: (target: unknown, name: string, handler: () => void) => {
      dom.set(`${target === win ? 'window' : 'document'}:${name}`, handler);
    },
    registerInterval: () => {},
  };
  const service = {
    onMobileBackgroundChange: (background: boolean) => { backgrounds.push(background); return Promise.resolve(); },
    onWindowFocusChange: () => Promise.resolve(), onActivePathChange: () => Promise.resolve(),
    closeOrphanSessions: () => Promise.resolve(), shutdown: () => Promise.resolve(),
    markUserActivity: () => {}, tick: () => Promise.resolve(),
  };
  const binding = installBindings({ app: { workspace } as unknown as App,
    plugin: plugin as unknown as Plugin, service: service as unknown as TimerService,
    mobileMultiWindow: () => multiWindow, log: new CapturingLogger() });
  return {
    web, backgrounds,
    emitDom: (name: string) => dom.get(name)?.(),
    emitNative: (name: string, state?: { isActive?: boolean }) => native.get(name)?.(state),
    poll: () => interval(), startup: () => startup(), setNativeActive: (value: boolean) => { active = value; },
    dispose: async () => {
      binding.destroy();
      await Promise.resolve();
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
      else Reflect.deleteProperty(globalThis, 'document');
      expect(removed).toBe(3);
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

it('native pause stays suspended through active polls until an explicit resume', async () => {
  const f = bindingFixture();
  try {
    await settle();
    f.emitNative('pause');
    await settle();
    f.poll();
    await settle();
    expect(f.backgrounds.slice(-1)[0]).toBe(true);
    f.emitNative('resume');
    await settle();
    expect(f.backgrounds.slice(-1)[0]).toBe(false);
  } finally { await f.dispose(); }
});

it('an in-flight initial active poll cannot undo a newer native pause', async () => {
  const f = bindingFixture();
  try {
    f.emitNative('pause');
    await settle();
    expect(f.backgrounds.slice(-1)[0]).toBe(true);
  } finally { await f.dispose(); }
});

it('explicit blur survives stale hasFocus and duplicate startup sync', async () => {
  const f = bindingFixture();
  try {
    await settle();
    f.emitDom('window:blur');
    f.startup();
    f.poll();
    await settle();
    expect(f.backgrounds.slice(-1)[0]).toBe(true);
    f.emitDom('window:focus');
    await settle();
    expect(f.backgrounds.slice(-1)[0]).toBe(false);
  } finally { await f.dispose(); }
});

it('DeX permits visible pause but hidden/native inactive/frozen still stop', async () => {
  const f = bindingFixture(true);
  try {
    await settle();
    f.emitNative('pause');
    f.emitDom('window:blur');
    await settle();
    expect(f.backgrounds.slice(-1)[0]).toBe(false);
    f.web.visibilityState = 'hidden';
    f.emitDom('document:visibilitychange');
    await settle();
    expect(f.backgrounds.slice(-1)[0]).toBe(true);
    f.web.visibilityState = 'visible';
    f.emitDom('document:visibilitychange');
    f.emitNative('appStateChange', { isActive: false });
    f.poll();
    await settle();
    expect(f.backgrounds.slice(-1)[0]).toBe(true);
    f.emitNative('appStateChange', { isActive: true });
    f.emitDom('document:freeze');
    f.emitNative('resume');
    await settle();
    expect(f.backgrounds.slice(-1)[0]).toBe(true);
    f.emitDom('document:resume');
    await settle();
    expect(f.backgrounds.slice(-1)[0]).toBe(false);
  } finally { await f.dispose(); }
});
