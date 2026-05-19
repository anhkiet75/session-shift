// context-menu-manager.ts — Context menu build/rebuild lifecycle.

import { getAllSessions } from '../lib/session-store.js';
import { invalidateBoundHostCache } from './session-manager.js';

const CTX_PARENT_ID = 'ss-open-in-session';

export async function setupContextMenu(): Promise<void> {
  try {
    await chrome.contextMenus.removeAll();
    const sessions = await getAllSessions();
    if (sessions.length === 0) return;

    chrome.contextMenus.create({
      id: CTX_PARENT_ID,
      title: 'Open in Session',
      contexts: ['link'],
    });

    for (const session of sessions) {
      let hostname: string;
      try { hostname = new URL(session.origin!).hostname; } catch { hostname = session.origin ?? ''; }
      chrome.contextMenus.create({
        id: `ss-session-${session.id}`,
        parentId: CTX_PARENT_ID,
        title: `${session.name} — ${hostname}`,
        contexts: ['link'],
      });
    }
  } catch (e) {
    console.warn('[bg] setupContextMenu failed:', e);
  }
}

// Rebuild context menu whenever session lists change in storage.
export function registerStorageListener(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some(k => k.startsWith('list_'))) {
      invalidateBoundHostCache();
      setupContextMenu();
    }
  });
}
