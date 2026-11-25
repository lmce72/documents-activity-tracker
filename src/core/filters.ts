/**
 * File filtering
 *
 * Origin: vault main.js lines 1040-1055 (byte-identical across versions).
 *
 * L0 module; depends only on types.
 */

import { isPluginViewKey } from './activePath';
import { isTargetIgnored } from './ignoreTargets';
import type { PluginSettings } from './types';

/** Filter mode. */
export type FilterMode = 'blacklist' | 'whitelist';

/**
 * Whether a path is a markdown note.
 *
 * Only markdown notes count as documents for this plugin. A canvas or a `.base` file is a
 * different kind of view, and the active file is not always a note — `getActiveFile()`
 * returns whatever leaf holds focus, so focus landing on a canvas handed the tracker a
 * `.canvas` path to "read". Measured in a real vault: `未命名.canvas` (6 events) and
 * `未命名.base` (3 events) had been recorded as documents, and worse, opening one closed
 * the session of the note the user was actually reading.
 *
 * Enforced here, at the single predicate every path passes through, so no call site can
 * reintroduce it.
 */
export function isMarkdownPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.md');
}

/**
 * Whether a tracking target should be recorded.
 *
 * 忽略列表最先判：它是用户对某个具体目标做过的显式决定，优先于黑/白名单，也覆盖没有路径的插件
 * 视图。过滤规则只回答「这类目标要不要记」，回答不了「这个视图我看过了，不想记」。
 *
 * The explicit ignore list is checked first: it is a concrete decision the user made about this
 * one target, so it outranks the black/white rules and also covers plugin views, which have no
 * path for the rules to match. The rules answer "should this class be recorded"; they cannot
 * answer "I have seen this view and do not want it recorded".
 */
export function isTrackableTarget(target: string, settings: PluginSettings): boolean {
  if (isTargetIgnored(target, settings)) return false;
  if (isPluginViewKey(target)) return true;
  return shouldTrackFile(target, settings);
}

/**
 * Decide whether a file path should be tracked.
 *
 * Blacklist: a match means "do not track"; whitelist: only a match is tracked.
 *
 * Two rule syntaxes:
 *
 * vault-relative path
 * plugin settings
 */
export function shouldTrackFile(filePath: string, settings: PluginSettings): boolean {
  //  Not a note: never tracked, whatever the rules say. The whitelist matches by folder
  //  prefix, so a canvas sitting inside a whitelisted folder used to pass straight through.
  if (!isMarkdownPath(filePath)) return false;

  //  Tolerate the legacy excludePatterns key. It still exists in real configs (empty
  //  string). The original's `filterPatterns || excludePatterns || ''` fallback is kept
  //  so very old configs that only set excludePatterns keep working.
  const legacy = settings as PluginSettings & { excludePatterns?: string };
  const raw = (settings.filterPatterns || legacy.excludePatterns || '').trim();
  const mode: FilterMode = (settings.filterMode as FilterMode) || 'blacklist';

  //  With no rules configured: blacklist tracks everything, whitelist tracks nothing
  if (!raw) return mode !== 'whitelist';

  const patterns = raw
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const matches = (pattern: string): boolean => {
    try {
      const reMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
      if (reMatch) return new RegExp(reMatch[1]!, reMatch[2]!).test(filePath);
      // a bare name is treated as a folder prefix
      const prefix =
        pattern.indexOf('.') < 0 && !pattern.endsWith('/') ? pattern + '/' : pattern;
      return filePath.startsWith(prefix) || filePath === pattern;
    } catch (error) {

      //  One malformed rule must not break filtering; skip it.
      console.error('[RTT][filters] 规则解析失败 / bad rule:', pattern, error);
      return false;
    }
  };

  const matched = patterns.some((p) => matches(p));
  return mode === 'whitelist' ? matched : !matched;
}
