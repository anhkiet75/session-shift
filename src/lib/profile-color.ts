// profile-color.ts — Single source of truth for profile hue → color conversion.
//
// Consumed by the popup (swatches, hue slider) and the background (action
// badge and per-tab icon).
//
// Dependency direction is one-way: this module imports nothing from `popup/` or
// `background/`, so both can depend on it without a cycle.

/** Fallback hue for profiles with no explicit hue and no palette slot. */
export const DEFAULT_HUE = 212;

/** Preset hues offered in the popup swatch row, in display order. */
export const HUE_PALETTE: readonly number[] = [212, 158, 24, 278, 196, 340, 45];

// The badge reads bold rather than dusty: high saturation with lightness low
// enough that a white label stays comfortable across most of the wheel. The
// stripe reuses these so both surfaces render the identical color.
const BADGE_SATURATION_PCT = 85;
const BADGE_LIGHTNESS_PCT = 42;

// The popup's own design system (popup.css, driven by the `--hue` custom
// property) is tuned around 70%/55% for both themes. Swatches stay on those
// tokens so the picker matches the card dot next to it; only the hue is shared
// with the badge, not the tone.
const SWATCH_SATURATION_PCT = 70;
const SWATCH_LIGHTNESS_PCT = 55;

/**
 * Legacy hex → hue migration map. Profiles created before the hue model stored
 * a fixed hex; these are the hues of those seven colors.
 */
const HUE_FROM_COLOR: Record<string, number> = {
  '#7c3aed': 262,
  '#2563eb': 219,
  '#059669': 161,
  '#d97706': 36,
  '#dc2626': 0,
  '#db2777': 333,
  '#0891b2': 191,
};

/** Minimal shape needed to resolve a color — `Session`, `PopupSession`, or a literal. */
export interface ProfileColorSource {
  hue?: number
  color?: string
}

/** Resolve a profile's hue: explicit hue → legacy hex map → palette by index. */
export function resolveProfileHue(profile: ProfileColorSource, index: number): number {
  if (profile.hue !== undefined) return profile.hue;
  if (profile.color && HUE_FROM_COLOR[profile.color] !== undefined) return HUE_FROM_COLOR[profile.color];
  return HUE_PALETTE[index % HUE_PALETTE.length];
}

/** Wrap any number into 0–359, including negatives. */
export function normalizeHue(hue: number): number {
  if (!Number.isFinite(hue)) return DEFAULT_HUE;
  return ((hue % 360) + 360) % 360;
}

/**
 * HSL→RGB. The single conversion primitive the rest of the module builds on.
 * `saturation` and `lightness` are fractions in 0–1; the result is 0–255 per channel.
 */
export function hueToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const h = normalizeHue(hue);
  const s = Math.min(1, Math.max(0, saturation));
  const l = Math.min(1, Math.max(0, lightness));

  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const second = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const offset = l - chroma / 2;

  let rgb: [number, number, number];
  if (h < 60) rgb = [chroma, second, 0];
  else if (h < 120) rgb = [second, chroma, 0];
  else if (h < 180) rgb = [0, chroma, second];
  else if (h < 240) rgb = [0, second, chroma];
  else if (h < 300) rgb = [second, 0, chroma];
  else rgb = [chroma, 0, second];

  return [
    Math.round((rgb[0] + offset) * 255),
    Math.round((rgb[1] + offset) * 255),
    Math.round((rgb[2] + offset) * 255),
  ];
}

/** WCAG 2.1 relative luminance of an sRGB triple (0–255 channels). */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linear = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * Bold badge fill. Returns `[r,g,b,a]` — the unambiguous `chrome.action` form,
 * accepted across Chrome versions, and the same triple `badgeTextRgba` reads
 * for its luminance decision.
 */
export function badgeBackgroundRgba(hue: number): [number, number, number, number] {
  const [r, g, b] = hueToRgb(hue, BADGE_SATURATION_PCT / 100, BADGE_LIGHTNESS_PCT / 100);
  return [r, g, b, 255];
}

/**
 * Contrast-picked label color for `badgeBackgroundRgba(hue)`.
 *
 * The 0.179 crossover is where white and black contrast are equal. Because the
 * white-passes bound (L ≤ 0.1833) and the black-passes bound (L ≥ 0.175)
 * overlap, picking the better of the two always clears 4.5:1 for any color.
 */
export function badgeTextRgba(hue: number): [number, number, number, number] {
  const [r, g, b] = badgeBackgroundRgba(hue);
  return relativeLuminance([r, g, b]) > 0.179 ? [0, 0, 0, 255] : [255, 255, 255, 255];
}

/**
 * CSS string for the bold profile color. Matches `badgeBackgroundRgba()` exactly.
 */
export function profileColorCss(hue: number): string {
  return `hsl(${normalizeHue(hue)}, ${BADGE_SATURATION_PCT}%, ${BADGE_LIGHTNESS_PCT}%)`;
}

/** CSS string for popup swatches and hue-slider previews (popup.css tone). */
export function profileSwatchCss(hue: number): string {
  return `hsl(${normalizeHue(hue)}, ${SWATCH_SATURATION_PCT}%, ${SWATCH_LIGHTNESS_PCT}%)`;
}

/**
 * Runtime string values of `chrome.tabGroups.Color` (the enum's values, not
 * its member names — matches what `chrome.tabGroups.update({ color })`
 * actually takes). Declared locally rather than as `` `${chrome.tabGroups.Color}` ``
 * so this module has no dependency on the exact @types/chrome enum name.
 */
export type TabGroupColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

// chrome.tabGroups color mapping (Phase 4) — grey excluded, it is the
// "no color" look and should never be a nearest match for a colored profile.
const TAB_GROUP_HUES: Record<Exclude<TabGroupColor, 'grey'>, number> = {
  red: 0,
  orange: 30,
  yellow: 55,
  green: 130,
  cyan: 190,
  blue: 217,
  purple: 270,
  pink: 330,
};

/** Circular distance between two hues on the 0-360 wheel. */
function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, 360 - diff);
}

/** Nearest of Chrome's 8 colored `tabGroups` enum colors to a profile hue. */
export function nearestTabGroupColor(hue: number): TabGroupColor {
  const target = normalizeHue(hue);
  let best: TabGroupColor = 'grey';
  let bestDistance = Infinity;
  for (const [color, anchor] of Object.entries(TAB_GROUP_HUES) as [Exclude<TabGroupColor, 'grey'>, number][]) {
    const distance = hueDistance(target, anchor);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = color;
    }
  }
  return best;
}
