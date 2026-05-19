// session-manager.ts — Tab→session map, badge updates, session icon generation.

import { getSessionList, getAllSessions, isInternalSession } from '../lib/session-store.js';

// ---------------------------------------------------------------------------
// Bound-host cache — sessionId → hostname from the session's origin.
// Avoids full chrome.storage.local scan on every DNR rule rebuild.
// Invalidated whenever any list_* key changes in storage.
// ---------------------------------------------------------------------------
const boundHostCache = new Map<string, string | null>();

export async function getSessionBoundHost(sessionId: string): Promise<string | null> {
  if (boundHostCache.has(sessionId)) return boundHostCache.get(sessionId)!;
  const all = await getAllSessions();
  const session = all.find(s => s.id === sessionId);
  let host: string | null = null;
  if (session?.origin) {
    try { host = new URL(session.origin).hostname; } catch { host = null; }
  }
  boundHostCache.set(sessionId, host);
  return host;
}

export function invalidateBoundHostCache(): void {
  boundHostCache.clear();
}

export async function getSessionBoundOrigin(sessionId: string): Promise<URL | null> {
  const all = await getAllSessions();
  const session = all.find(s => s.id === sessionId);
  if (!session?.origin) return null;
  try { return new URL(session.origin); } catch { return null; }
}

export function hostMatches(actual: string, bound: string): boolean {
  return actual === bound || actual.endsWith('.' + bound);
}

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
