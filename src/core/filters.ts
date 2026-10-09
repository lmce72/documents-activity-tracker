/**
 * File filtering
 *
 * Origin: vault main.js lines 1040-1055 (byte-identical across versions).
 *
 * L0 module; depends only on types.
 */

import type { PluginSettings } from './types';

/** Filter mode. */
export type FilterMode = 'blacklist' | 'whitelist';

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
