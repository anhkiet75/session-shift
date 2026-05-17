// popup-types.ts — Shared types and hue utilities for popup modules.

import type { Session } from '../lib/types.js';

export interface PopupSession extends Session {
  color?: string
}

export const HUE_PALETTE = [212, 158, 24, 278, 196, 340, 45];

const HUE_FROM_COLOR: Record<string, number> = {
  '#7c3aed': 262,
  '#2563eb': 219,
  '#059669': 161,
  '#d97706': 36,
  '#dc2626': 0,
  '#db2777': 333,
  '#0891b2': 191,
};

export function getSessionHue(session: PopupSession, index: number): number {
  if (session.hue !== undefined) return session.hue;
  if (session.color && HUE_FROM_COLOR[session.color] !== undefined) return HUE_FROM_COLOR[session.color];
  return HUE_PALETTE[index % HUE_PALETTE.length];
}
