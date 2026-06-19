// popup-session-storage.ts — chrome.storage helpers for the global profiles list.

import type { PopupSession } from './popup-types.js';

const PROFILES_KEY = 'profiles';

export function getSavedSessions(): Promise<PopupSession[]> {
  return new Promise(resolve => {
    chrome.storage.local.get([PROFILES_KEY], result => {
      const value = result[PROFILES_KEY];
      resolve(Array.isArray(value) ? (value as PopupSession[]) : []);
    });
  });
}

export function setSavedSessions(list: PopupSession[]): Promise<void> {
  return new Promise(resolve => {
    chrome.storage.local.set({ [PROFILES_KEY]: list }, resolve);
  });
}

export async function renameSession(sessionId: string, newName: string): Promise<PopupSession | false> {
  if (!newName || !newName.trim()) return false;
  const sessions = await getSavedSessions();
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx === -1) return false;
  sessions[idx].name = newName.trim();
  await setSavedSessions(sessions);
  return sessions[idx];
}
