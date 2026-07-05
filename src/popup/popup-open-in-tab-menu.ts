// popup-open-in-tab-menu.ts — Custom right-click menu for opening a profile in a new tab.

import type { PopupSession } from './popup-types.js';

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

function buildMenu(session: PopupSession, getCurrentUrl: () => string): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'v2-open-tab-menu';
  menu.setAttribute('role', 'menu');
  menu.addEventListener('click', (e) => e.stopPropagation());

  const menuItem = document.createElement('button');
  menuItem.type = 'button';
  menuItem.className = 'v2-open-tab-menu-item';
  menuItem.setAttribute('role', 'menuitem');
  menuItem.textContent = 'Open in new tab';
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
): void {
  card.tabIndex = 0;
  const openMenu = (clientX: number, clientY: number): void => {
    closeActiveMenu();
    const menu = buildMenu(session, getCurrentUrl);
    document.body.appendChild(menu);
    activeMenu = menu;
    const cardRect = card.getBoundingClientRect();
    placeMenu(menu, clientX || cardRect.left + 16, clientY || cardRect.top + 16);
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
