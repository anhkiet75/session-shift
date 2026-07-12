// popup-hero-updater.ts — Updates the hero section with the active session's hue.

import type { PopupSession } from './popup-types.js';
import type { Localizer } from '../lib/localization.js';

export function updateHero(
  currentSessionId: string,
  sessionObj: PopupSession | undefined,
  hue: number | null,
  localizer: Localizer
): void {
  const heroSection = document.getElementById('heroSection')!;
  const heroMark    = document.getElementById('heroMark')!;
  const heroName    = document.getElementById('heroName')!;
  const heroMeta    = document.getElementById('heroMeta')!;

  if (currentSessionId === 'default' || !sessionObj) {
    heroSection.style.setProperty('--hue', '210');
    heroMark.className = 'v2-hero-mark v2-mark-default';
    heroName.textContent = localizer.getMessage('heroDefaultName') || 'Default';
    heroMeta.textContent = localizer.getMessage('heroNoSessionMeta') || 'No session scoped';
  } else {
    heroSection.style.setProperty('--hue', String(hue));
    heroMark.className = 'v2-hero-mark';
    heroName.textContent = sessionObj.name || sessionObj.id;
    heroMeta.replaceChildren();
    const live = document.createElement('span');
    live.className = 'v2-hero-live';
    const dot = document.createElement('span');
    dot.className = 'v2-live-dot';
    live.appendChild(dot);
    live.appendChild(document.createTextNode(` ${localizer.getMessage('heroLiveLabel') || 'live'}`));
    heroMeta.appendChild(live);
  }
}
