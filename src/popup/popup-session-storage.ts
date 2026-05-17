// popup-session-storage.ts — chrome.storage helpers scoped to the popup.

import type { PopupSession } from './popup-types.js';

export function getSavedSessions(origin: string): Promise<PopupSession[]> {
  return new Promise(resolve => {
    chrome.storage.local.get([`list_${origin}`], result =>
      resolve((result[`list_${origin}`] as PopupSession[]) || [])
    );
  });
}

export function setSavedSessions(origin: string, list: PopupSession[]): Promise<void> {
  return new Promise(resolve => {
    chrome.storage.local.set({ [`list_${origin}`]: list }, resolve);
  });
}

export async function renameSession(origin: string, sessionId: string, newName: string): Promise<PopupSession | false> {
  if (!newName || !newName.trim()) return false;
  const sessions = await getSavedSessions(origin);
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx === -1) return false;
  sessions[idx].name = newName.trim();
  await setSavedSessions(origin, sessions);
  return sessions[idx];
}
