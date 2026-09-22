// options-favorites-types.ts — Shared contract between the Favorites panel and
// its row builder, so neither imports the other's implementation.

import type { Session } from '../lib/types.js'
import type { Localizer } from '../lib/localization.js'

/** Placeholder option for a favorite whose profile is gone — lets the user rebind it. */
export const MISSING_PROFILE_VALUE = '__missing__'

export interface PanelContext {
  /** All profiles, in storage order — index drives the swatch hue. */
  profiles: Session[]
  localizer: Localizer
  text(key: string, fallback: string): string
  named(key: string, name: string, fallback: string): string
  announce(message: string): void
  /** Re-read the store and repaint, then restore focus to `[favId, action]` when it still exists. */
  refresh(favId?: string, action?: string): Promise<void>
}
