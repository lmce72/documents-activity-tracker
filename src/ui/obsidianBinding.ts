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

  /**
   * 挂起/恢复的唯一入口 / the one place suspended and active are applied.
   *
   * 信号有好几个来源（桌面失焦、可见性、Capacitor、Page Lifecycle），同一件事会被报告两三次。
   * 这里按"状态真的变了才处理"去重，顺带保证挂起时**先结算分屏阅读再落盘** —— 挂起之后 WebView
   * 可能立刻被冻结，排在后面的异步写入就没机会执行了。
   *
   * Several sources report the same thing (desktop blur, visibility, Capacitor, Page Lifecycle). This
   * dedupes on "the state actually changed", and makes sure suspending settles split reading *before*
   * the write — the WebView may be frozen immediately afterwards and an async write queued behind it
   * would never run.
   */
  let suspended: boolean | null = null;

  const setSuspended = (next: boolean, reason: string): void => {
    if (suspended === next) return;
    suspended = next;
    log.info('[RTT][binding] 活动状态 / activity state:', next ? 'suspended' : 'active', reason);

    if (next) {
      void service
        .setSplitReading(false)
        .then(() => service.onWindowFocusChange(false))
        .then(() => service.flushPendingWrites())
        .catch((error: unknown) => log.warn('[RTT] 挂起处理失败 / suspend handling failed:', error));
    } else {
      void service
        .onWindowFocusChange(true)
        .catch((error: unknown) => log.warn('[RTT] 恢复处理失败 / resume handling failed:', error));
    }
  };

  // window focus ────────────────────────────────────────────
  plugin.registerDomEvent(window, 'focus', () => {
    setSuspended(false, 'window-focus');
  });
  plugin.registerDomEvent(window, 'blur', () => {
    setSuspended(true, 'window-blur');
  });

  //  Minimising or switching virtual desktops fires visibilitychange but not blur
  plugin.registerDomEvent(document, 'visibilitychange', () => {
    if (document.visibilityState !== 'visible') setSuspended(true, 'visibility-hidden');
    else setSuspended(!document.hasFocus(), 'visibility-visible');
  });

  //  Page Lifecycle：后台标签页被冻结时触发，移动端 WebView 的"退到后台/锁屏"也会走到这里。
  //  它比 blur 更接近真正的"冻结"，而且不依赖 Capacitor 是否挂着。
  //  Page Lifecycle fires when a page is frozen in the background — which is also what a mobile WebView
  //  does when backgrounded or the screen locks. Closer to a real freeze than blur, and independent of
  //  whether Capacitor is wired up.
  //  `freeze`/`resume` 属于 Page Lifecycle，尚未进 TS 的 DocumentEventMap
  //  Page Lifecycle events are not in TS's DocumentEventMap yet
  plugin.registerDomEvent(document, 'freeze' as keyof DocumentEventMap, () => {
    setSuspended(true, 'page-freeze');
  });
  plugin.registerDomEvent(document, 'resume' as keyof DocumentEventMap, () => {
    setSuspended(false, 'page-resume');
  });

  //  页面被移出后台存储/关闭前也记一次 / also on hide and unload
  plugin.registerDomEvent(window, 'pagehide', () => {
    setSuspended(true, 'pagehide');
  });
  plugin.registerDomEvent(window, 'pageshow', () => {
    setSuspended(false, 'pageshow');
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
              handler: (state?: { isActive?: boolean }) => void,
            ) => Promise<{ remove?: () => Promise<void> }>;
            getState?: () => Promise<{ isActive?: boolean }>;
          };
        };
      };
    }
  ).Capacitor?.Plugins?.App;

  let capacitorListener: { remove?: () => Promise<void> } | null = null;

  if (typeof capacitorApp?.addListener === 'function') {
    //  按官方文档，三个事件各有不同的原生触发点：
    //    appStateChange  Android onResume / onStop      iOS willResignActive / didBecomeActive
    //    pause           Android onPause（比 onStop 早） iOS didEnterBackground
    //    resume          Android onResume               iOS willEnterForeground
    //  只订阅 appStateChange 时，Android 走的是 onStop —— 后台进程被系统回收或进入 Doze 时它可能
    //  根本不执行，于是"退到后台"没有任何事件。两个都订，谁先到算谁的（setSuspended 去重）。
    //
    //  Per the official docs each event has its own native trigger; Android's appStateChange uses
    //  onStop, which may never run when the process is reclaimed or the device enters Doze. Subscribe to
    //  both pause and resume as well; whichever arrives first wins (setSuspended dedupes).
    const subscriptions: Array<[string, (state?: { isActive?: boolean }) => void]> = [
      ['appStateChange', (state) => setSuspended(state?.isActive === false, 'capacitor-app-state')],
      ['pause', () => setSuspended(true, 'capacitor-pause')],
      ['resume', () => setSuspended(false, 'capacitor-resume')],
    ];

    for (const [event, handler] of subscriptions) {
      capacitorApp
        .addListener(event, handler)
        .then((handle) => {
          capacitorListener = handle;
        })
        .catch((error: unknown) => {
          log.warn(`[RTT][binding] Capacitor 监听注册失败 / listener failed: ${event}:`, error);
        });
    }

    //  注册那一刻可能已经在后台（例如从通知栏冷启动后退回）
    //  It may already be in the background when we subscribe
    capacitorApp
      .getState?.()
      .then((state) => {
        if (state?.isActive === false) setSuspended(true, 'capacitor-initial-state');
      })
      .catch((error: unknown) => {
        log.warn('[RTT][binding] Capacitor getState 失败 / getState failed:', error);
      });
  } else {
    //  桌面端没有 Capacitor；手机端如果真的缺这个插件，日志里要能看见，而不是安静地降级
    //  Desktops have no Capacitor; if a phone genuinely lacks the plugin, that must be visible in the
    //  log rather than a silent downgrade.
    log.info('[RTT][binding] 无 Capacitor App 插件，使用 Web 事件 / no Capacitor App plugin');
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
