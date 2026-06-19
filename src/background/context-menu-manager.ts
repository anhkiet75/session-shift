// context-menu-manager.ts — Context menu build/rebuild lifecycle.

import { getProfiles } from '../lib/session-store.js';

const CTX_PARENT_ID = 'ss-open-in-session';

export async function setupContextMenu(): Promise<void> {
  try {
    await chrome.contextMenus.removeAll();
    const sessions = await getProfiles();
    if (sessions.length === 0) return;

    chrome.contextMenus.create({
      id: CTX_PARENT_ID,
      title: 'Open in Session',
      contexts: ['link'],
    });

    for (const session of sessions) {
      chrome.contextMenus.create({
        id: `ss-session-${session.id}`,
        parentId: CTX_PARENT_ID,
        title: session.name,
        contexts: ['link'],
      });
    }
  } catch (e) {
    console.warn('[bg] setupContextMenu failed:', e);
  }
}

// Rebuild context menu whenever the global profiles list changes in storage.
export function registerStorageListener(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('profiles' in changes) {
      setupContextMenu();
    }
  });
}
