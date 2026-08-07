// popup-types.ts — Popup-local types, re-exporting the shared hue utilities.
//
// Palette and hue→color conversion live in `lib/profile-color.ts` so the
// background can use them too; this file keeps the popup's own view type and
// the `getSessionHue` name its call sites already use.

import type { Session } from '../lib/types.js';
import { resolveProfileHue } from '../lib/profile-color.js';

export interface PopupSession extends Session {
  color?: string
}

export { HUE_PALETTE, DEFAULT_HUE, profileSwatchCss } from '../lib/profile-color.js';

/** Popup-facing alias of `resolveProfileHue`. */
export const getSessionHue = resolveProfileHue;
