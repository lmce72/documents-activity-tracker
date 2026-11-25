/**
 * 显式忽略列表 / the explicit ignore list
 *
 * 与黑/白名单过滤是两套东西：过滤规则描述「这类目标要不要记」，忽略列表描述「这个具体目标我看过了，
 * 就是不想记」。因此它优先于过滤规则，也支持没有路径的插件视图。
 *
 * 条目三种形态：
 *   - 笔记精确路径            `Notes/a.md`
 *   - 目录前缀（必须以 `/` 结尾） `Notes/` —— 结尾斜杠是判据，`Notes` 不会吞掉 `Notes-archive`
 *   - 插件视图键              `view:<type>`
 *
 * The ignore list is separate from the black/white filter rules: the rules describe a class of
 * targets, while this list records a concrete decision about one target. It therefore outranks the
 * rules and can also express plugin views, which have no path.
 *
 * Entries take three shapes: an exact note path, a folder prefix (trailing `/`), or a `view:` key.
 */

import { isPluginViewKey, PLUGIN_VIEW_PREFIX } from './activePath';
import type { PluginSettings } from './types';

/** 忽略条目的种类 / what an ignore entry stands for. */
export type IgnoreTargetKind = 'note' | 'folder' | 'view';

/** 排除菜单的一项 / one choice in the exclude menu. */
export interface IgnoreTarget {
  /** 写进忽略列表的值 / the value stored in the ignore list. */
  value: string;
  /** 目录深度；笔记与视图为 0 / folder depth, zero for a note or a view. */
  level: number;
  kind: IgnoreTargetKind;
}

/**
 * 一个目标可以按哪些粒度排除 / the granularities a target can be excluded at.
 *
 * 笔记：自身 + 从最深祖先到根的各级目录。字典根不提供 —— 忽略根等于忽略整个库，不该出现在一张
 * 卡片旁边的菜单里。视图没有目录层级，只有自身。
 *
 * A note offers itself plus every ancestor folder, deepest first. The vault root is deliberately
 * absent: ignoring it excludes the whole vault and must not sit one click away from a card. A view
 * has no folder hierarchy, so it offers only itself.
 */
export function ignoreTargetsFor(target: string): IgnoreTarget[] {
  if (isPluginViewKey(target)) {
    return [{ value: target, level: 0, kind: 'view' }];
  }

  const targets: IgnoreTarget[] = [{ value: target, level: 0, kind: 'note' }];
  const segments = target.split('/');
  segments.pop(); // 去掉文件名 / drop the filename

  for (let depth = segments.length; depth >= 1; depth--) {
    targets.push({
      value: segments.slice(0, depth).join('/') + '/',
      level: depth,
      kind: 'folder',
    });
  }

  return targets;
}

/**
 * 一个条目是否覆盖某个目标 / whether one entry covers a target.
 *
 * 大小写不敏感（与参考实现 IntelliScroll 一致）；目录按路径边界匹配，`Notes/` 不会命中
 * `Notes-archive/`。视图键只做精确匹配，不允许前缀扩张。
 *
 * Case-insensitive, matching the reference implementation. Folder entries match on a path boundary,
 * so `Notes/` never swallows `Notes-archive/`. View keys match exactly, never as a prefix.
 */
export function isCoveredByEntry(target: string, entry: string): boolean {
  if (typeof entry !== 'string') return false;
  const value = entry.trim();
  if (value.length === 0) return false;

  const path = target.toLowerCase();
  const lowered = value.toLowerCase();

  if (value.startsWith(PLUGIN_VIEW_PREFIX)) return lowered === path;

  if (value.endsWith('/')) {
    const folder = lowered.replace(/\/+$/, '');
    return folder.length > 0 && (path === folder || path.startsWith(folder + '/'));
  }

  return lowered === path;
}

/**
 * 覆盖该目标的最具体条目，没有则 null / the most specific covering entry, or null.
 *
 * 同时被笔记条目和它所在目录的条目覆盖时取最长的那条 —— 它最具体，也是撤销时应该先动的那一条。
 * When both the note and its folder are ignored, the longest entry wins: it is the most specific
 * one and the first a toggle should undo.
 */
export function coveringIgnoreEntry(
  target: string,
  settings: Pick<PluginSettings, 'ignoredTargets'>,
): string | null {
  let best: string | null = null;
  for (const raw of settings.ignoredTargets ?? []) {
    const entry = typeof raw === 'string' ? raw.trim() : '';
    if (!isCoveredByEntry(target, entry)) continue;
    if (best === null || entry.length > best.length) best = entry;
  }
  return best;
}

/** 该目标是否在忽略列表里 / whether the target is ignored. */
export function isTargetIgnored(
  target: string,
  settings: Pick<PluginSettings, 'ignoredTargets'>,
): boolean {
  return coveringIgnoreEntry(target, settings) !== null;
}

/**
 * 增删一个条目后的新列表 / a new list with one entry added or removed.
 *
 * 保持原顺序；加入已存在或删除不存在时原样返回，调用方可据此判断是否真的变了。
 * Keeps the original order. Adding an existing entry or removing an absent one returns the list
 * unchanged, so callers can tell whether anything actually moved.
 */
export function withEntryIgnored(
  list: readonly string[],
  entry: string,
  ignored: boolean,
): string[] {
  const current = [...list];
  const index = current.indexOf(entry);
  if (ignored) {
    if (index >= 0) return current;
    current.push(entry);
    return current;
  }
  if (index < 0) return current;
  current.splice(index, 1);
  return current;
}
