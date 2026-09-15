/**
 * 文件过滤 / File filtering
 *
 * 来源：vault 版 main.js 第 1040-1055 行（两版逐字节相同）。
 * Origin: vault main.js lines 1040-1055 (byte-identical across versions).
 *
 * 本模块是第 0 层，只依赖 types / L0 module; depends only on types.
 */

import type { PluginSettings } from './types';

/** 过滤模式 / Filter mode. */
export type FilterMode = 'blacklist' | 'whitelist';

/**
 * 判断文件路径是否应被计时追踪 / Decide whether a file path should be tracked.
 *
 * 黑名单：命中规则则不追踪；白名单：仅命中规则才追踪。
 * Blacklist: a match means "do not track"; whitelist: only a match is tracked.
 *
 * 规则支持两种写法 / Two rule syntaxes:
 *   - 路径前缀 "Templates/"（也接受完整文件名精确匹配）
 *   - 正则 "/^Daily\\//i"（形如 /pattern/flags）
 *
 * @param filePath vault 相对路径 / vault-relative path
 * @param settings 插件设置 / plugin settings
 */
export function shouldTrackFile(filePath: string, settings: PluginSettings): boolean {
  // 兼容早期的 excludePatterns 字段名。真实配置里该键仍然存在（值为空串），
  // 原实现的 `filterPatterns || excludePatterns || ''` 回退必须保留，
  // 否则极老配置（只填了 excludePatterns）的行为会变。
  // Tolerate the legacy excludePatterns key. It still exists in real configs (empty
  // string). The original's `filterPatterns || excludePatterns || ''` fallback is kept
  // so very old configs that only set excludePatterns keep working.
  const legacy = settings as PluginSettings & { excludePatterns?: string };
  const raw = (settings.filterPatterns || legacy.excludePatterns || '').trim();
  const mode: FilterMode = (settings.filterMode as FilterMode) || 'blacklist';

  // 未配置任何规则时：黑名单=全部追踪，白名单=全部不追踪
  // With no rules configured: blacklist tracks everything, whitelist tracks nothing
  if (!raw) return mode !== 'whitelist';

  const patterns = raw
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const matches = (pattern: string): boolean => {
    try {
      const reMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
      if (reMatch) return new RegExp(reMatch[1]!, reMatch[2]!).test(filePath);
      // 无扩展名且不以斜杠结尾者视为目录前缀 / a bare name is treated as a folder prefix
      const prefix =
        pattern.indexOf('.') < 0 && !pattern.endsWith('/') ? pattern + '/' : pattern;
      return filePath.startsWith(prefix) || filePath === pattern;
    } catch (error) {
      // 单条规则非法不应让整个过滤失效，跳过该条即可
      // One malformed rule must not break filtering; skip it.
      console.error('[RTT][filters] 规则解析失败 / bad rule:', pattern, error);
      return false;
    }
  };

  const matched = patterns.some((p) => matches(p));
  return mode === 'whitelist' ? matched : !matched;
}
