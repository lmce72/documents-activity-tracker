/**
 * Status-bar metrics / 状态栏指标
 *
 * Which durations the user may pin to Obsidian's status bar (bottom right), and the rule
 * that keeps the four slots from repeating each other.
 *
 * The interesting part is the exclusion rule, which is pure and therefore testable: a
 * dropdown may offer everything *except* what the other slots already hold. Keeping it here
 * rather than in the settings tab means the tab renders what this says, instead of the rule
 * being re-derived (and eventually mis-derived) inside the view code.
 */

import type { TranslationKey } from './i18n';

/** Which sidebar panel a metric lives in; a click on the status bar jumps there. */
export type PanelId = 'document' | 'manual' | 'overview';

/** One selectable metric. */
export interface StatusMetricDef {
  id: string;
  /**
   * i18n key for its label, used by both the settings dropdowns and the status bar.
   * Typed as a translation key so a typo fails compilation rather than rendering the raw
   * key in the status bar.
   */
  labelKey: TranslationKey;
  /** The panel a click should reveal. */
  panel: PanelId;
  /**
   * Which timer a metric belongs to, for the icon-only layout: the reading icon carries the
   * document timer's state, the stopwatch icon the manual timer's.
   */
  group: 'reading' | 'manual';
}

/** How many metrics may be pinned at once. */
export const MAX_STATUS_METRICS = 4;

/** Every selectable metric, in the order the dropdowns list them. */
export const STATUS_METRICS: readonly StatusMetricDef[] = [
  { id: 'session', labelKey: 'metricSession', panel: 'document', group: 'reading' },
  { id: 'unfocused', labelKey: 'metricUnfocused', panel: 'document', group: 'reading' },
  { id: 'todayTotal', labelKey: 'metricTodayTotal', panel: 'document', group: 'reading' },
  { id: 'rounds', labelKey: 'metricRounds', panel: 'document', group: 'reading' },
  { id: 'manualToday', labelKey: 'metricManualToday', panel: 'manual', group: 'manual' },
  { id: 'union', labelKey: 'metricUnion', panel: 'overview', group: 'reading' },
  { id: 'docTotal', labelKey: 'metricDocTotal', panel: 'overview', group: 'reading' },
  { id: 'viewTotal', labelKey: 'metricViewTotal', panel: 'overview', group: 'reading' },
  { id: 'overlap', labelKey: 'metricOverlap', panel: 'overview', group: 'reading' },
];

/** The definition for a metric id, or null when it is unknown (e.g. from an older config). */
export function metricById(id: string): StatusMetricDef | null {
  return STATUS_METRICS.find((metric) => metric.id === id) ?? null;
}

/**
 * Normalise a stored selection into exactly `MAX_STATUS_METRICS` slots.
 *
 * Unknown ids and duplicates are dropped rather than trusted: the array comes from a JSON
 * file a user may have edited, and a duplicate would otherwise render the same number twice
 * while hiding an option from every dropdown.
 */
export function normalizeSelection(raw: unknown): string[] {
  const source = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const slots: string[] = [];

  for (const value of source) {
    if (slots.length >= MAX_STATUS_METRICS) break;
    if (typeof value !== 'string' || value.length === 0) continue;
    if (seen.has(value) || metricById(value) === null) continue;
    seen.add(value);
    slots.push(value);
  }

  while (slots.length < MAX_STATUS_METRICS) slots.push('');
  return slots;
}

/**
 * The options a given slot may offer.
 *
 * Everything is available except what the *other* slots hold — the slot's own value stays in
 * the list, or the dropdown would clear itself the moment it rendered.
 *
 * @returns metric ids, in {@link STATUS_METRICS} order, to be shown after the empty option
 */
export function optionsForSlot(selection: readonly string[], slotIndex: number): string[] {
  const taken = new Set<string>();
  selection.forEach((value, index) => {
    if (index !== slotIndex && value) taken.add(value);
  });

  return STATUS_METRICS.map((metric) => metric.id).filter((id) => !taken.has(id));
}

/** The metrics actually pinned, in slot order, skipping empty slots. */
export function activeSelection(selection: readonly string[]): StatusMetricDef[] {
  const out: StatusMetricDef[] = [];
  for (const value of selection) {
    if (!value) continue;
    const metric = metricById(value);
    if (metric) out.push(metric);
  }
  return out;
}
