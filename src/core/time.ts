/**
 * Time helpers
 *
 * Origin: vault main.js lines 840-953, 960-976, 1129-1143 (byte-identical across versions).
 *
 *   formatLocalHM(895)  formatLocalDate(917)  toLocalKeyStr(929)
 *
 * L0 module; depends only on types.
 */

/**
 * Current local time, minute precision.
 */
export function nowStr(): string {
  const now = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

/** Today's date. */
export function todayStr(): string {
  return nowStr().split(' ')[0] ?? '';
}

/**
 * Monday of the current week as YYYY-MM-DD, local time.
 */
export function getWeekStartStr(): string {
  const now = new Date();
  const day = now.getDay(); // Sunday
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${monday.getFullYear()}-${p(monday.getMonth() + 1)}-${p(monday.getDate())}`;
}

/**
 * Parse a session timestamp string into a local Date.
 *
 * Handles two formats:
 *
 * iOS Safari cannot parse the space-separated form, hence the manual parsing for format 1.
 *
 * null when unparseable
 */
export function parseSessionStartTime(str: string | null | undefined): Date | null {
  if (!str) return null;
  const s = String(str);

  //  Try the standard ISO form first (contains T/Z separators)
  if (/[TZ]/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
  }

  //  Manual parse; the seconds group is optional, keeping end-time precision
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Extract local HH:mm:ss from a timestamp string.
 */
export function formatLocalHMS(str: string | null | undefined): string {
  const d = parseSessionStartTime(str);
  if (!d) return '--:--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** Date to a local full timestamp. */
export function formatLocalFull(date: Date | null | undefined): string {
  if (!date || isNaN(date.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** Now as a local full timestamp. */
export function nowFullStr(): string {
  return formatLocalFull(new Date());
}

/**
 * Seconds to a human-readable duration.
 *
 * Note: the unit strings are hardcoded Chinese, matching the original and not
 * following the UI language. Preserved deliberately — changing it would alter UI text.
 *
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
