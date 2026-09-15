/**
 * 时间工具 / Time helpers
 *
 * 来源：vault 版 main.js 第 840-953、960-976、1129-1143 行（两版逐字节相同）。
 * Origin: vault main.js lines 840-953, 960-976, 1129-1143 (byte-identical across versions).
 *
 * 已删除的死函数（调用点数实测为 0）/ Dead functions removed (measured zero call sites):
 *   formatLocalHM(895)  formatLocalDate(917)  toLocalKeyStr(929)
 *
 * 保留但必须原样搬运的函数（均有真实调用）/ Kept verbatim (all have real callers):
 *   formatLocalHMS(5 处)  getWeekStartStr(2 处)
 *
 * 本模块是第 0 层，只依赖 types / L0 module; depends only on types.
 */

/**
 * 当前本地时间 "YYYY-MM-DD HH:mm" / Current local time, minute precision.
 */
export function nowStr(): string {
  const now = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

/** 今日日期 "YYYY-MM-DD" / Today's date. */
export function todayStr(): string {
  return nowStr().split(' ')[0] ?? '';
}

/**
 * 本周一的日期字符串（YYYY-MM-DD，本地时间）。
 * Monday of the current week as YYYY-MM-DD, local time.
 */
export function getWeekStartStr(): string {
  const now = new Date();
  const day = now.getDay(); // 0=周日 / Sunday
  const diff = day === 0 ? 6 : day - 1; // 距周一的天数 / days since Monday
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${monday.getFullYear()}-${p(monday.getMonth() + 1)}-${p(monday.getDate())}`;
}

/**
 * 解析会话时间字符串为本地 Date。
 * Parse a session timestamp string into a local Date.
 *
 * 兼容两种格式 / Handles two formats:
 *   1. "YYYY-MM-DD HH:mm" 或 "... HH:mm:ss"（本地时间，无时区标记）
 *   2. ISO 8601 "2026-08-21T08:11:59.825Z"（UTC）
 *
 * 移动端 iOS Safari 无法解析带空格的非 ISO 格式，故对格式 1 手动拆解。
 * iOS Safari cannot parse the space-separated form, hence the manual parsing for format 1.
 *
 * @returns 解析失败返回 null / null when unparseable
 */
export function parseSessionStartTime(str: string | null | undefined): Date | null {
  if (!str) return null;
  const s = String(str);

  // 优先尝试标准 ISO 格式（含 T/Z 分隔符）
  // Try the standard ISO form first (contains T/Z separators)
  if (/[TZ]/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
  }

  // 手动拆解，秒组可选，保证推算结束时间的精度
  // Manual parse; the seconds group is optional, keeping end-time precision
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 从时间字符串提取本地 HH:mm:ss（兼容 ISO UTC 与本地格式）。
 * Extract local HH:mm:ss from a timestamp string.
 */
export function formatLocalHMS(str: string | null | undefined): string {
  const d = parseSessionStartTime(str);
  if (!d) return '--:--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** Date → 本地 "YYYY-MM-DD HH:mm:ss" / Date to a local full timestamp. */
export function formatLocalFull(date: Date | null | undefined): string {
  if (!date || isNaN(date.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** 当前本地 "YYYY-MM-DD HH:mm:ss" / Now as a local full timestamp. */
export function nowFullStr(): string {
  return formatLocalFull(new Date());
}

/**
 * 秒数 → 可读时长 / Seconds to a human-readable duration.
 *
 * 注意：单位文案（秒/分/小时）是硬编码中文，与原实现一致，不随界面语言变化。
 * 这是既有行为，本次重构刻意未改（改它会变更界面文案）。
 *
 * Note: the unit strings are hardcoded Chinese, matching the original and not
 * following the UI language. Preserved deliberately — changing it would alter UI text.
 *
 * @param mode 'compact' 满分钟省略秒；'precise' 精确到秒
 */
export function formatReadTime(seconds: number, mode: string = 'compact'): string {
  if (!seconds || seconds <= 0) return '0 秒';
  if (seconds < 60) return `${Math.floor(seconds)} 秒`;

  const totalMinutes = Math.floor(seconds / 60);
  const secs = seconds % 60;

  if (totalMinutes < 60) {
    if (mode === 'precise' && secs > 0) return `${totalMinutes} 分 ${secs} 秒`;
    return `${totalMinutes} 分钟`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (mode === 'precise' && secs > 0) {
    return mins > 0
      ? `${hours} 小时 ${mins} 分 ${secs} 秒`
      : `${hours} 小时 ${secs} 秒`;
  }
  return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
}

/**
 * 秒数 → 带秒的紧凑时长（无空格）/ Seconds to a compact duration with seconds.
 * 如 "5分30秒"。热力图与会话详情共用。
 */
export function formatDurationWithSeconds(seconds: number): string {
  if (!seconds || seconds <= 0) return '0秒';

  const s = Math.floor(seconds % 60);
  const totalMinutes = Math.floor(seconds / 60);

  if (totalMinutes === 0) return `${s}秒`;

  const mins = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours === 0) return `${mins}分${s}秒`;
  return `${hours}小时${mins}分${s}秒`;
}
