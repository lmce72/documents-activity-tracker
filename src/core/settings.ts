/**
 * Settings normalisation
 *
 * The original assigned the loaded payload straight to `this.settings` with no fallback:
 * a missing field yields undefined (NaN once compared), and every field added in an
 * upgrade is guaranteed to be missing from an older data.json.
 *
 * Three jobs:
 *
 */

import { DEFAULT_SETTINGS } from './defaults';
import { normalizeSelection } from './statusMetrics';
import type { PluginSettings } from './types';

/**
 * upper bound for the idle timeout: 24 hours.
 * Anything beyond this is a unit mistake, not a user asking for a 55-hour timeout.
 */
export const MAX_IDLE_TIMEOUT_SECONDS = 24 * 60 * 60;

/**
 *
 * The UI and the implementation both work in seconds (the original multiplied by 1000),
 * yet this vault's real settings hold `200000` — a legacy value written in milliseconds
 * by an older build, which reads as 55 hours and makes idle detection never fire. The
 * magnitude is used to detect and convert it, then clamped to [1, 24h].
 */
export function normalizeIdleTimeoutSeconds(raw: unknown): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_SETTINGS.idleTimeout;

  //  Magnitude check: a value ≥1000 can only be milliseconds (20s written as 20000)
  const seconds = value >= 1000 ? value / 1000 : value;

  if (!Number.isFinite(seconds) || seconds < 1) return DEFAULT_SETTINGS.idleTimeout;
  return Math.min(Math.round(seconds), MAX_IDLE_TIMEOUT_SECONDS);
}

/** Coerce one field to the type of its default. */
function coerce<K extends keyof PluginSettings>(
  key: K,
  raw: unknown,
): PluginSettings[K] {
  const fallback = DEFAULT_SETTINGS[key];
  if (raw === undefined || raw === null) return fallback;

  if (typeof fallback === 'boolean') return (raw === true || raw === 'true') as PluginSettings[K];
  if (typeof fallback === 'number') {
    const num = typeof raw === 'number' ? raw : Number(raw);
    return (Number.isFinite(num) ? num : fallback) as PluginSettings[K];
  }
  //  Arrays need their own branch: without it an array-valued setting falls through to the
  //  string check, never matches, and silently reverts to the default on every load — the
  //  user's choice would appear to save and then be gone next launch.
  if (Array.isArray(fallback)) {
    return (Array.isArray(raw) ? raw : fallback) as PluginSettings[K];
  }
  return (typeof raw === 'string' ? raw : fallback) as PluginSettings[K];
}

/**
 * Merge on-disk settings over the defaults.
 *
 * Only known keys are taken; unknown ones are dropped, so leftovers from older versions
 * are not carried forward and non-settings data never gets written back.
 */
export function mergeSettings(loaded: unknown): PluginSettings {
  const source = (loaded && typeof loaded === 'object' ? loaded : {}) as Record<string, unknown>;

  const merged = {} as PluginSettings;

  //  Coerce field by field to the default's type. Writes go through a Record view since
  //  PluginSettings has no index signature.
  const target = merged as unknown as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof PluginSettings)[]) {
    target[key] = coerce(key, source[key]);
  }

  merged.idleTimeout = normalizeIdleTimeoutSeconds(source.idleTimeout);
  //  The status-bar slots come from a JSON file a user may have hand-edited, so unknown ids
  //  and duplicates are dropped and the array is padded to a fixed width.
  //  Only a real array from disk is normalised. Passing `undefined` through would produce
  //  four empty slots and wipe the default selection — the status bar then renders nothing on
  //  every install that predates this setting.
  merged.statusBarMetrics = Array.isArray(source.statusBarMetrics)
    ? normalizeSelection(source.statusBarMetrics)
    : [...DEFAULT_SETTINGS.statusBarMetrics];
  return merged;
}

/**
 * Whether a file should be tracked.
 * The rules live in core/filters.ts; this only combines the toggle with them so the
 * service layer does not repeat the condition.
 */
export function isTrackingEnabled(settings: PluginSettings): boolean {
  return settings.documentTrackingEnabled !== false;
}

/**
 * whether document activity should be recorded right now.
 *
 * The **conjunction** of two switches that mean different things and must not be merged:
 * the settings-page toggle enables the whole document-tracking feature, while the manual
 * panel's toggle stops events being written while manual timing runs. The latter only
 * stops the recording step and leaves the panel visible, so it reads as "pause recording"
 * rather than "turn the feature off".
 */
export function isDocumentRecordingEnabled(settings: PluginSettings): boolean {
  return (
    settings.documentTrackingEnabled !== false &&
    settings.manualRecordDocActivity !== false
  );
}

/**
 * Whether out-of-window stretches count toward reading totals.
 *
 * Reading is "in-window plus out-of-window" by default. Turning this off leaves the
 * stretches recorded and displayed but keeps them out of every total, for when a note simply
 * stayed open while the user was in another application.
 *
 * Defaults to off; unfocused intervals remain available for explicit classification.
 */
export function countsUnfocusedAsReading(settings: PluginSettings): boolean {
  return settings.countUnfocusedAsReading === true;
}

/** Plugin activity is reading by default; the raw ledger is always retained. */
export function countsPluginViewsAsReading(settings: PluginSettings): boolean {
  return settings.countPluginViewsAsReading !== false;
}
