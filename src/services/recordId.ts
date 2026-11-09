/** 能力缺失是正常的移动端差异，不产生诊断日志 / older mobile WebViews need no warning. */
export function newRecordId(prefix = 'record'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}
