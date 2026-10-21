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

import { isPluginViewKey, resolveActiveTarget } from '../core/activePath';

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
  /**
   * This plugin's own view type(s), e.g. the sidebar.
   *
   * Passed in rather than imported so this module keeps its single runtime dependency on
   * obsidian (`MarkdownView`) and does not pull in the whole view tree.
   */
  ownViewTypes?: readonly string[];
}

/** A handle to the installed bindings. */
export interface Binding {
  /** the active markdown file path */
  getActivePath(): string | null;
  getActiveTitle(): string | null;
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
  const ownViewTypes = new Set(deps.ownViewTypes ?? []);

  const registered: EventRef[] = [];
  let lastActivityAt = 0;

  /**
   * the active markdown file, or null when nothing is being read.
   *
   * `getActiveViewOfType(MarkdownView)` answers "is the *focused leaf* a markdown view", so
   * it returns null whenever focus sits anywhere else. Two opposite mistakes come from
   * treating that null naively:
   *
   *   - Falling back to `getActiveFile()` unconditionally keeps the timer running on the
   *     last note while the user is actually reading a *plugin view* — an RSS reader, a
   *     translator pane. Measured: those panes were credited to the previously focused note.
   *   - Not falling back at all unbinds the file the moment the user clicks our own sidebar,
   *     which is exactly when they are trying to start the timer.
   *
   * So the fallback is scoped to our own views: focus anywhere else that is not a markdown
   * view means nothing is being read, and the session ends.
   */
  const getActivePath = (): string | null => {
    const focused = app.workspace.activeLeaf?.view;
    const recent = app.workspace.getMostRecentLeaf()?.view;
    return resolveActiveTarget({
      markdownPath: focused instanceof MarkdownView ? focused.file?.path ?? null : null,
      focusedViewType: focused?.getViewType() ?? null,
      ownViewTypes: [...ownViewTypes],
      recentViewType: recent?.getViewType() ?? null,
      recentMarkdownPath: recent instanceof MarkdownView ? recent.file?.path ?? null : null,
    });
  };

  const getActiveTitle = (): string | null => {
    const focused = app.workspace.activeLeaf?.view;
    const view = focused && ownViewTypes.has(focused.getViewType())
      ? app.workspace.getMostRecentLeaf()?.view : focused;
    return view?.getDisplayText().trim() || null;
  };

  const getOpenPaths = (): string[] => {
    const paths: string[] = [];
    app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) paths.push(view.file.path);
    });

    // A plugin view has no file, so it can never appear in the walk above. Without adding it
    // here it looks like a tab that has been closed, and `closeOrphanSessions` auto-saves and
    // unbinds it the instant it starts — measured: the canvas session was killed within the
    // same second it began. Once the view loses focus the key stops being returned, so
    // closing the leaf still ends the session.
    const active = getActivePath();
    if (active !== null && isPluginViewKey(active)) paths.push(active);

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
    if (document.visibilityState !== 'visible') {
      void service.setSplitReading(false).then(() => service.onWindowFocusChange(false)).catch((error: unknown) => log.warn('[RTT] visibility handling failed:', error));
    } else {
      void service.onWindowFocusChange(document.hasFocus());
    }
  });

  // Mobile: neither `window.blur/focus` nor `visibilitychange` is reliable once the app is
  // backgrounded — the WebView is frozen and may never deliver the event, so the whole
  // unfocused channel silently never fires on a phone. Capacitor's App plugin reports the
  // *native* activity state instead (Android `onResume`/`onStop`, iOS
  // `didBecomeActive`/`willResignActive`), which is the mobile equivalent of a window losing
  // focus. Reached through `window.Capacitor` because Obsidian ships the runtime; there is no
  // package to import, and a desktop build simply does not have it.
  //
  // 移动端一旦退到后台，WebView 会被冻结，blur/focus 与 visibilitychange 都可能永远不来，
  // 于是整个"脱离窗口"通道在手机上根本不触发。Capacitor 的 App 插件报告的是**原生**活动状态
  // （Android onResume/onStop、iOS didBecomeActive/willResignActive），正是窗口失焦的对应物。
  const capacitorApp = (
    window as unknown as {
      Capacitor?: {
        Plugins?: {
          App?: {
            addListener?: (
              event: string,
              handler: (state: { isActive?: boolean }) => void,
            ) => Promise<{ remove?: () => Promise<void> }>;
          };
        };
      };
    }
  ).Capacitor?.Plugins?.App;

  let capacitorListener: { remove?: () => Promise<void> } | null = null;

  if (typeof capacitorApp?.addListener === 'function') {
    capacitorApp
      .addListener('appStateChange', (state) => {
        // `isActive` is the only field; treat a missing payload as "still active" rather than
        // inventing an out-of-window stretch.
        if (state?.isActive === false) {
          void service.setSplitReading(false).then(() => service.onWindowFocusChange(false)).catch((error: unknown) => log.warn('[RTT] background handling failed:', error));
        } else void service.onWindowFocusChange(true);
      })
      .then((handle) => {
        capacitorListener = handle;
      })
      .catch((error: unknown) => {
        log.warn('[RTT][binding] Capacitor 状态监听注册失败 / app-state listener failed:', error);
      });
  }

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
    getActiveTitle,
    getOpenPaths,
    destroy(): void {
      window.clearInterval(timer);
      for (const ref of registered) app.workspace.offref(ref);
      registered.length = 0;
      // A native listener is not covered by `registerDomEvent`; without this it survives the
      // plugin and keeps writing to a dead service.
      void capacitorListener?.remove?.().catch(() => undefined);
      capacitorListener = null;
    },
  };
}
