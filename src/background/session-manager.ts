// session-manager.ts — Tab→session map, badge updates, session icon generation.

import { getSessionList, isInternalSession } from '../lib/session-store.js';

// ---------------------------------------------------------------------------
// Tab→session in-memory map (persisted to chrome.storage.session)
// ---------------------------------------------------------------------------
export let tabSessions: Record<string, string> = {};

export async function restoreTabSessions(): Promise<void> {
  try {
    const result = await chrome.storage.session.get(['tabSessions']);
    if (result.tabSessions) {
      tabSessions = result.tabSessions as Record<string, string>;
    }
  } catch (e) {
    console.warn('[bg] restoreTabSessions failed:', e);
  }
}

export async function persistTabSessions(): Promise<void> {
  try {
    await chrome.storage.session.set({ tabSessions });
  } catch (e) {
    console.warn('[bg] persistTabSessions failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Badge + per-tab colored icon
// ---------------------------------------------------------------------------
const iconCache = new Map<number, ImageData>();

export async function updateBadge(tabId: number, sessionId: string): Promise<void> {
  if (isInternalSession(sessionId)) {
    chrome.action.setBadgeText({ text: '', tabId });
    chrome.action.setIcon({ path: {
      '16':  'icons/icon-16.png',
      '32':  'icons/icon-32.png',
      '48':  'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    }, tabId }).catch(() => {});
    return;
  }

  let label = sessionId.replace(/^session_/, '').substring(0, 3).toUpperCase();
  let hue = 212;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url && !tab.url.startsWith('chrome://')) {
      const origin = new URL(tab.url).origin;
      const list = await getSessionList(origin);
      const session = list.find((s) => s.id === sessionId);
      if (session?.name) label = session.name.substring(0, 3).toUpperCase();
      if (session?.hue !== undefined) hue = session.hue;
    }
  } catch (_) {}

  chrome.action.setBadgeBackgroundColor({ color: `hsl(${hue}, 70%, 45%)`, tabId });
  chrome.action.setBadgeText({ text: label, tabId });

}
