// popup-hero-updater.ts — Updates the hero section with the active session's hue.

import type { PopupSession } from './popup-types.js';

export function updateHero(currentSessionId: string, sessionObj: PopupSession | undefined, hue: number | null): void {
  const heroSection = document.getElementById('heroSection')!;
  const heroMark    = document.getElementById('heroMark')!;
  const heroName    = document.getElementById('heroName')!;
  const heroMeta    = document.getElementById('heroMeta')!;

  if (currentSessionId === 'default' || !sessionObj) {
    heroSection.style.setProperty('--hue', '210');
    heroMark.className = 'v2-hero-mark v2-mark-default';
    heroName.textContent = 'Default';
    heroMeta.innerHTML = 'No session scoped';
  } else {
    heroSection.style.setProperty('--hue', String(hue));
    heroMark.className = 'v2-hero-mark';
    heroName.textContent = sessionObj.name || sessionObj.id;
    heroMeta.innerHTML = `<span class="v2-hero-live"><span class="v2-live-dot"></span> live</span>`;
  }
}
