/**
 * Which target is being read / 当前正在使用什么
 *
 * `getActiveViewOfType(MarkdownView)` answers "is the *focused leaf* a markdown view", not
 * "what is being read". Reading it naively produced three separate defects, all of which
 * shipped:
 *
 *   - Falling back to `getActiveFile()` unconditionally kept the timer on the last note
 *     while the user was in a plugin pane, billing the RSS reader's time to whatever note
 *     happened to be open behind it.
 *   - Not falling back at all unbound the file the instant the user clicked our own sidebar,
 *     which is exactly when they are trying to start the timer.
 *   - A plugin pane registers as neither, so its time was simply lost.
 *
 * A plugin view is a real way to read inside Obsidian — the RSS dashboard and the translator
 * are panes, not notes — so it is tracked as its own channel rather than dropped or blamed on
 * a note. The target is therefore either a note path or a synthetic `view:<type>` key.
 *
 * 插件面板（RSS 看板、翻译器）本身就是在 Obsidian 里阅读的一种方式，因此单独记一类，
 * 既不丢掉，也不算到某个笔记头上。
 */

/** Prefix marking a synthetic target that stands for a plugin view. */
export const PLUGIN_VIEW_PREFIX = 'view:';

/** The synthetic target for a plugin view type. */
export function pluginViewKey(viewType: string): string {
  return PLUGIN_VIEW_PREFIX + viewType;
}

/** Whether a target stands for a plugin view rather than a note. */
export function isPluginViewKey(target: string): boolean {
  return target.startsWith(PLUGIN_VIEW_PREFIX);
}

/** The view type behind a synthetic target, or null for a note. */
export function viewTypeOf(target: string): string | null {
  return isPluginViewKey(target) ? target.slice(PLUGIN_VIEW_PREFIX.length) : null;
}

/**
 * A readable name for a plugin view target.
 *
 * View types are kebab-case identifiers (`rss-dashboard-view`), which read as machine
 * noise in a list. The trailing `-view` is dropped and the dashes become spaces, so the
 * label follows the plugin's own naming instead of a hand-maintained table that would go
 * stale the moment a plugin is renamed.
 */
export function pluginViewLabel(target: string): string {
  const type = viewTypeOf(target);
  if (type === null) return target;
  return type.replace(/-view$/, '').replace(/-/g, ' ');
}

/**
 * Core views that are navigation chrome rather than something to read.
 *
 * Focus landing in the file explorer or on the graph is not reading; counting it would
 * inflate every total. Anything *not* listed here is treated as a plugin-rendered view and
 * is tracked, so a new plugin needs no change to this file.
 */
export const NON_READING_VIEW_TYPES: readonly string[] = [
  'empty',
  'file-explorer',
  'search',
  'outline',
  'backlink',
  'tag',
  'all-properties',
  'bookmarks',
  'graph',
  'localgraph',
  'release-notes',
  'sync-log',
  'sync-history',
  'settings',
  'pdf',
];

/** What the caller observed about focus. */
export interface ActiveTargetInput {
  /** Path of the focused leaf, when that leaf is a markdown view. */
  markdownPath: string | null;
  /** View type of the focused leaf, whatever it is. */
  focusedViewType: string | null;
  /** View types belonging to this plugin (its sidebar), which must not end a session. */
  ownViewTypes: readonly string[];
  /** `workspace.getActiveFile()?.path` — the workspace's notion of the active file. */
  activeFilePath: string | null;
}

/**
 * Resolve what the timer should be attached to.
 *
 * @returns a note path, a `view:<type>` key, or null when nothing is being read
 */
export function resolveActiveTarget(input: ActiveTargetInput): string | null {
  // A markdown leaf in focus is unambiguous.
  if (input.markdownPath) return input.markdownPath;

  const type = input.focusedViewType;
  if (!type) return null;

  // Focus on one of our own views: the user is operating the panel while a note stays open
  // behind it, so keep the workspace's active file.
  if (input.ownViewTypes.includes(type)) return input.activeFilePath;

  // Focus on navigation chrome: nothing is being read.
  if (NON_READING_VIEW_TYPES.includes(type)) return null;

  // Any other view is rendered by a plugin (or is file-backed content such as a canvas), and
  // the user is reading in it.
  return pluginViewKey(type);
}
