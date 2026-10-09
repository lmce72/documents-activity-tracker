/**
 * Obsidian event binding
 *
 * This is the only UI module that imports obsidian runtime values. The service layer takes
 * types only and is therefore testable outside Obsidian; concentrating the translation of
 * external events here keeps that logic out of the DOM path.
 *
 * Differences from the old monolith:
 *
 */

import { MarkdownView, type App, type EventRef, type Plugin } from 'obsidian';

import type { Logger } from '../core/logger';
import type { TimerService } from '../services/TimerService';

/** the heartbeat interval. */
const TICK_INTERVAL_MS = 1000;

/**
 * A mouse can emit hundreds of events per second; second-level precision is all idle
 * detection needs.
 */
const ACTIVITY_THROTTLE_MS = 2000;

/** What the binding needs. */
export interface BindingDeps {
  app: App;
  plugin: Plugin;
  service: TimerService;
  log: Logger;
}

/** A handle to the installed bindings. */
export interface Binding {
  /** the active markdown file path */
  getActivePath(): string | null;
  /** markdown paths currently open */
  getOpenPaths(): string[];
  /** tear everything down */
  destroy(): void;
}

/**
 * Install every Obsidian-side listener.
 * The caller must call `destroy()` on unload.
 */
export function installBindings(deps: BindingDeps): Binding {
  const { app, plugin, service, log } = deps;

  const registered: EventRef[] = [];
  let lastActivityAt = 0;

  /** the active markdown view, if any. */
  const activeView = (): MarkdownView | null =>
    app.workspace.getActiveViewOfType(MarkdownView);

  /**
   * the active markdown file.
   *
   * Not `getActiveViewOfType(MarkdownView)` alone: that asks whether the *focused leaf* is a
   * markdown view, and the user has just given focus to the sidebar in order to click "start"
   * — so it returns null, the path never binds, the whole control row is not rendered, and
   * the button does not exist. Measured: with the sidebar focused, `startCurrent()` returns
   * immediately and nothing happens. `getActiveFile()` reports which file is active
   * regardless of which leaf holds focus, so it is the fallback.
   */
  const getActivePath = (): string | null =>
    activeView()?.file?.path ?? app.workspace.getActiveFile()?.path ?? null;

  const getOpenPaths = (): string[] => {
    const paths: string[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) paths.push(view.file.path);
    });
    return paths;
  };

  /** throttled user-activity report. */
  const reportActivity = (): void => {
    const now = Date.now();
    if (now - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
    lastActivityAt = now;
    service.markUserActivity();
  };

  // tab switching ────────────────────────────────────────────
  registered.push(
    app.workspace.on('active-leaf-change', () => {
      void service.onActivePathChange();
    }),
  );
  registered.push(
    app.workspace.on('file-open', () => {
      void service.onActivePathChange();
    }),
  );

  //  Layout changes (tab closed, pane moved) matter too: orphan sessions close here
  registered.push(
    app.workspace.on('layout-change', () => {
      void service.closeOrphanSessions();
    }),
  );

  // wrap up before quitting ───────────────────────────────
  registered.push(
    app.workspace.on('quit', () => {
      void service.shutdown();
    }),
  );

  // window focus ────────────────────────────────────────────
  plugin.registerDomEvent(window, 'focus', () => {
    void service.onWindowFocusChange(true);
  });
  plugin.registerDomEvent(window, 'blur', () => {
    void service.onWindowFocusChange(false);
  });

  //  Minimising or switching virtual desktops fires visibilitychange but not blur
  plugin.registerDomEvent(document, 'visibilitychange', () => {
    void service.onWindowFocusChange(document.visibilityState === 'visible');
  });

  // user activity ───────────────────────────────────────────
  for (const type of ['mousedown', 'keydown', 'mousemove', 'touchstart', 'wheel'] as const) {
    plugin.registerDomEvent(document, type, reportActivity, { passive: true });
  }

  // heartbeat ──────────────────────────────────────────────────
  const timer = window.setInterval(() => {
    void service.tick();
  }, TICK_INTERVAL_MS);
  plugin.registerInterval(timer);

  /**
   * startup sync: focus state plus the active file.
   *
   * A restored workspace fires no `active-leaf-change` (that only fires when the user
   * changes the layout), so the file already open when the plugin loads is never bound.
   * Measured consequence: the sidebar reads "no document is being tracked" and does not
   * even render the Start button, leaving the user to switch tabs by hand before any
   * timing is possible — a hard dead end.
   */
  const syncStartupState = (): void => {
    try {
      void service.onWindowFocusChange(document.hasFocus());
    } catch (error) {
      log.warn('[RTT][binding] 初始焦点探测失败 / initial focus probe failed:', error);
    }

    //  Idempotent: onActivePathChange returns early when from === to
    try {
      void service.onActivePathChange();
    } catch (error) {
      log.warn('[RTT][binding] 初始路径对齐失败 / initial path sync failed:', error);
    }
  };

  //  Both paths are needed: the timeout covers an already-ready layout (plugin reload),
  //  onLayoutReady covers a cold start. The latter alone would never fire on reload.
  window.setTimeout(syncStartupState, 0);
  app.workspace.onLayoutReady(syncStartupState);

  return {
    getActivePath,
    getOpenPaths,
    destroy(): void {
      window.clearInterval(timer);
      for (const ref of registered) app.workspace.offref(ref);
      registered.length = 0;
    },
  };
}
