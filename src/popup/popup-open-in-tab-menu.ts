// popup-open-in-tab-menu.ts — Custom right-click menu for opening a profile in a new tab.

import type { PopupSession } from './popup-types.js';
import type { Localizer } from '../lib/localization.js';

let activeMenu: HTMLElement | null = null;

function closeActiveMenu(): void {
  if (!activeMenu) return;
  activeMenu.remove();
  activeMenu = null;
}

document.addEventListener('click', closeActiveMenu);
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') closeActiveMenu();
});
document.addEventListener('scroll', closeActiveMenu, true);

function placeMenu(menu: HTMLElement, clientX: number, clientY: number): void {
  const menuHeight = menu.offsetHeight || 40;
  const menuWidth = menu.offsetWidth || 160;
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  const margin = 4;

  let top = clientY;
  let left = clientX;

  if (top + menuHeight > viewportH - margin) top = viewportH - menuHeight - margin;
  if (left + menuWidth > viewportW - margin) left = viewportW - menuWidth - margin;
  if (top < margin) top = margin;
  if (left < margin) left = margin;

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

function buildMenu(session: PopupSession, getCurrentUrl: () => string, localizer: Localizer): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'v2-open-tab-menu';
  menu.setAttribute('role', 'menu');
  menu.addEventListener('click', (e) => e.stopPropagation());

  const menuItem = document.createElement('button');
  menuItem.type = 'button';
  menuItem.className = 'v2-open-tab-menu-item';
  menuItem.setAttribute('role', 'menuitem');
  menuItem.setAttribute('data-action', 'open-in-new-tab');
  menuItem.textContent = localizer.getMessage('openInNewTab') || 'Open in new tab';
  menuItem.addEventListener('click', async (e) => {
    e.stopPropagation();
    menuItem.disabled = true;
    closeActiveMenu();
    await chrome.runtime.sendMessage({
      action: 'createSessionTab',
      payload: { url: getCurrentUrl(), sessionId: session.id },
    });
    window.close();
  });

  menu.appendChild(menuItem);
  return menu;
}

export function attachOpenInTabMenu(
  card: HTMLElement,
  session: PopupSession,
  getCurrentUrl: () => string,
  localizer: Localizer,
): void {
  card.tabIndex = 0;
  const openMenu = (clientX: number, clientY: number): void => {
    closeActiveMenu();
    const menu = buildMenu(session, getCurrentUrl, localizer);
    document.body.appendChild(menu);
    activeMenu = menu;
    const cardRect = card.getBoundingClientRect();
    // Real clicks pass their own viewport coordinates (correct in any
    // direction — the menu should open at the cursor). Only the
    // keyboard-invoked fallback needs a direction-aware inline-start anchor.
    // placeMenu treats (x, y) as the menu's own top-left and grows it
    // rightward/downward, so the rtl branch must subtract the menu's own
    // width to anchor its *right* edge near the card — mirroring the ltr
    // case, not just picking a different point that grows away from the card.
    const isRtl = document.documentElement.dir === 'rtl';
    const menuWidth = menu.offsetWidth || 160;
    const fallbackX = isRtl ? cardRect.right - 16 - menuWidth : cardRect.left + 16;
    placeMenu(menu, clientX || fallbackX, clientY || cardRect.top + 16);
  };

  card.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY);
  });

  card.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
    e.preventDefault();
    e.stopPropagation();
    openMenu(0, 0);
  });
}
