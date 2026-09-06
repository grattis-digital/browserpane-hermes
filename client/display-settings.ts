/** Pure viewer preferences and layout; never changes Chromium's own DPR. */
export type DisplayPreferences = { resolution: string; density: string };

export const DISPLAY_PREFERENCES_VERSION = 1;
export const AUTO_CAPTURE_PIXEL_BUDGET = 1280 * 720;
export const CAPTURE_LIMITS = Object.freeze({ minWidth: 320, maxWidth: 3840, minHeight: 200, maxHeight: 2160 });
export const DEFAULT_DISPLAY_PREFERENCES: Readonly<DisplayPreferences> = Object.freeze({ resolution: 'auto', density: 'auto' });

export const RESOLUTION_PRESETS: ReadonlyArray<Readonly<{ value: string; label: string; width?: number; height?: number }>> = Object.freeze([
  Object.freeze({ value: 'auto', label: 'Auto · Pi balanced' }),
  ...[[800, 600], [1024, 768], [1280, 720], [1280, 800], [1360, 768], [1440, 900],
    [1600, 900], [1920, 1080]].map(([width, height]) =>
    Object.freeze({ value: `${width}x${height}`, label: `${width} × ${height}`, width, height })),
]);

export const DENSITY_OPTIONS: ReadonlyArray<Readonly<{ value: string; label: string }>> = Object.freeze([
  { value: 'auto', label: 'Auto · 1×' },
  { value: '1', label: 'Off · 1×' },
  { value: '1.25', label: '1.25×' },
  { value: '1.5', label: '1.5×' },
  { value: '2', label: '2×' },
  { value: 'native', label: 'Native' },
].map(option => Object.freeze(option)));

function validPreferences(value: unknown): value is DisplayPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prefs = value as DisplayPreferences;
  return typeof prefs.resolution === 'string' && typeof prefs.density === 'string'
    && RESOLUTION_PRESETS.some(option => option.value === prefs.resolution)
    && DENSITY_OPTIONS.some(option => option.value === prefs.density);
}

function safePreferences(value: unknown): DisplayPreferences {
  return validPreferences(value)
    ? { resolution: value.resolution, density: value.density }
    : { ...DEFAULT_DISPLAY_PREFERENCES };
}

/** Versioned, allowlisted storage. Invalid records fall back as a whole. */
export function readDisplayPreferences(raw: string | null): DisplayPreferences {
  if (typeof raw !== 'string' || raw.length > 4096) return { ...DEFAULT_DISPLAY_PREFERENCES };
  try {
    const value: unknown = JSON.parse(raw);
    if (!validPreferences(value)) return { ...DEFAULT_DISPLAY_PREFERENCES };
    const record = value as DisplayPreferences & { version?: unknown };
    if (record.version !== DISPLAY_PREFERENCES_VERSION
      || Object.keys(record).length !== 3) return { ...DEFAULT_DISPLAY_PREFERENCES };
    return safePreferences(record);
  } catch {
    return { ...DEFAULT_DISPLAY_PREFERENCES };
  }
}

export function writeDisplayPreferences(preferences: DisplayPreferences): string {
  return JSON.stringify({ version: DISPLAY_PREFERENCES_VERSION, ...safePreferences(preferences) });
}

export interface DisplayLayoutInput {
  preferences: DisplayPreferences;
  availableWidth: number;
  availableHeight: number;
  devicePixelRatio: number;
  softwareRenderer?: boolean;
  /** Display only: preserve server authority exactly, even if unaligned. */
  authoritativeSize?: { width: number; height: number };
}

export interface DisplayLayout {
  /** Physical capture pixels, not page CSS pixels. */
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
  /** Resolved requested viewer density; does not change remote browser DPR. */
  captureScale: number;
  /** Physical pixels per displayed CSS pixel, or 0 for a hidden surface. */
  effectiveScale: number;
  reason: string;
  /** Auto hit a pixel-budget or host-size limit (alignment alone is excluded). */
  autoLimited: boolean;
}

function availableDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
}

function density(preference: string, devicePixelRatio: number): number {
  if (preference === 'auto') return 1;
  if (preference !== 'native') return Number(preference);
  return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? Math.max(1, Math.min(3, devicePixelRatio)) : 1;
}

function validAuthority(size: DisplayLayoutInput['authoritativeSize']): size is { width: number; height: number } {
  return !!size && Number.isInteger(size.width) && Number.isInteger(size.height)
    && size.width > 0 && size.height > 0 && size.width <= 65535 && size.height <= 65535;
}

export function computeDisplayLayout(input: DisplayLayoutInput): DisplayLayout {
  const preferences = safePreferences(input.preferences);
  const availableWidth = availableDimension(input.availableWidth);
  const availableHeight = availableDimension(input.availableHeight);
  const captureScale = density(preferences.density, input.devicePixelRatio);
  const reasons = [preferences.density === 'auto'
    ? 'Auto density keeps readable 1× with the shared browser at DPR 1; this is a conservative policy, not a benchmark.'
    : `${preferences.density === 'native' ? 'Native monitor' : 'Manual'} ${captureScale}× viewer density; the shared browser DPR is unchanged.`];
  if (input.softwareRenderer) reasons.push('Software rendering reported; no automatic density increase is applied.');

  let width: number;
  let height: number;
  let autoLimited = false;
  const preset = RESOLUTION_PRESETS.find(option => option.value === preferences.resolution)!;
  if (validAuthority(input.authoritativeSize)) {
    ({ width, height } = input.authoritativeSize);
    reasons.push(`Shared ${width}×${height} capture is authoritative; local fitting does not resize it.`);
  } else if (preset.width !== undefined && preset.height !== undefined) {
    ({ width, height } = preset as { width: number; height: number });
    reasons.push(`Fixed ${width}×${height} capture; fitting changes only its CSS display size.`);
  } else {
    const desiredWidth = availableWidth * captureScale;
    const desiredHeight = availableHeight * captureScale;
    const { minWidth, maxWidth, minHeight, maxHeight } = CAPTURE_LIMITS;
    const desiredArea = desiredWidth * desiredHeight;
    const ratio = Math.min(1,
      desiredWidth > 0 ? maxWidth / desiredWidth : 1,
      desiredHeight > 0 ? maxHeight / desiredHeight : 1,
      desiredArea > 0 ? Math.sqrt(AUTO_CAPTURE_PIXEL_BUDGET / desiredArea) : 1);
    // Uniform reduction first; floor alignment only after scaling. Host minima
    // can force letterboxing on tiny/extreme-aspect viewers, never stretching.
    width = Math.max(minWidth, Math.min(maxWidth, Math.floor(desiredWidth * ratio / 8) * 8));
    height = Math.max(minHeight, Math.min(maxHeight, Math.floor(desiredHeight * ratio / 2) * 2));
    autoLimited = ratio < 1 || desiredWidth < minWidth || desiredHeight < minHeight;
    reasons.push('Auto resolution follows the available aspect within a 921,600-pixel Pi budget (1280×720), host limits and 8×2 alignment.');
    if (desiredWidth * ratio < minWidth || desiredHeight * ratio < minHeight) {
      reasons.push('The host minimum capture size requires letterboxing in this viewport.');
    }
  }

  const naturalWidth = width / captureScale;
  const naturalHeight = height / captureScale;
  const fit = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);
  let cssWidth = naturalWidth * fit;
  let cssHeight = naturalHeight * fit;
  let effectiveScale = cssWidth > 0 ? width / cssWidth : 0;
  // Non-finite/zero layouts (including underflow-sized CSS) must not leak NaN
  // or Infinity into style strings or runtime settings. Defer while hidden.
  if (cssWidth === 0 || cssHeight === 0 || !Number.isFinite(effectiveScale)) {
    cssWidth = 0;
    cssHeight = 0;
    effectiveScale = 0;
    reasons.push('The viewer has no drawable space; defer capture changes until it is visible.');
  } else if (fit < 1) {
    reasons.push('Uniformly scaled down to fit; no stretching or display upscaling.');
  }
  return { width, height, cssWidth, cssHeight, captureScale, effectiveScale, reason: reasons.join(' '), autoLimited };
}
