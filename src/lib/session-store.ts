// session-store.ts — Chrome storage helpers for session isolation (MV3).

import type { Session } from './types.js'

export type CookieStoreEntry = {
  value: string
  expires?: number | null
  domain?: string | null
  path?: string | null
  secure?: boolean
  httpOnly?: boolean
}
type CookieStore = Record<string, CookieStoreEntry>

export async function getCookieStore(sessionId: string): Promise<CookieStore> {
  const result = await chrome.storage.local.get([`cookies_${sessionId}`]);
  return (result[`cookies_${sessionId}`] as CookieStore) || {};
}

export async function setCookieStore(sessionId: string, store: CookieStore): Promise<void> {
  await chrome.storage.local.set({ [`cookies_${sessionId}`]: store });
}

export async function getSessionList(origin: string): Promise<Session[]> {
  const result = await chrome.storage.local.get([`list_${origin}`]);
  return (result[`list_${origin}`] as Session[]) || [];
}

export async function setSessionList(origin: string, list: Session[]): Promise<void> {
  await chrome.storage.local.set({ [`list_${origin}`]: list });
}

export function isInternalSession(sessionId: string): boolean {
  return !sessionId || sessionId === 'default' || sessionId.startsWith('_snap_');
}

export async function getAllSessions(): Promise<Session[]> {
  const all = await chrome.storage.local.get(null);
  const seen = new Set<string>();
  const out: Session[] = [];

  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('list_') || !Array.isArray(value)) continue;
    const origin = key.slice('list_'.length);
    for (const s of value) {
      if (!s || typeof s.id !== 'string') continue;
      if (seen.has(s.id)) {
        console.warn('[session-store] duplicate session id across origins:', s.id);
        continue;
      }
      seen.add(s.id);
      out.push({ id: s.id, name: s.name || s.id, hue: s.hue, origin });
    }
  }

  out.sort((a, b) =>
    (a.origin ?? '').localeCompare(b.origin ?? '') ||
    (a.name || '').localeCompare(b.name || '') ||
    a.id.localeCompare(b.id)
  );
  return out;
}

/**
 * Find cookie stores (`cookies_${id}`) with no corresponding entry in any
 * `list_${origin}`. Skips internal sessions (default, _snap_*).
 *
 * @returns {Promise<string[]>} Orphan session ids
 */
export async function findOrphanedCookieStores() {
  const all = await chrome.storage.local.get(null);
  const referenced = new Set();

  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('list_') || !Array.isArray(value)) continue;
    for (const s of value) if (s && typeof s.id === 'string') referenced.add(s.id);
  }

  const orphans = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith('cookies_')) continue;
    const id = key.slice('cookies_'.length);
    if (isInternalSession(id)) continue;
    if (!referenced.has(id)) orphans.push(id);
  }
  return orphans;
}

export async function duplicateSession(sessionId: string, origin: string): Promise<Session> {
  const list = await getSessionList(origin);
  const source = list.find(s => s.id === sessionId);
  if (!source) throw new Error(`Session not found: ${sessionId}`);

  const newId = 'session_' + crypto.randomUUID();
  const store = await getCookieStore(sessionId);
  await setCookieStore(newId, { ...store });

  const newSession = { id: newId, name: source.name + ' (copy)', hue: source.hue };
  await setSessionList(origin, [...list, newSession]);
  return newSession;
}

export async function updateSessionHue(sessionId: string, hue: number): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const updates: Record<string, Session[]> = {};
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith('list_') || !Array.isArray(value)) continue;
    const patched = (value as Session[]).map(s =>
      s.id === sessionId ? { ...s, hue } : s
    );
    if (patched.some((s, i) => s !== (value as Session[])[i])) {
      updates[key] = patched;
    }
  }
  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

export async function deleteSessionData(sessionId: string): Promise<void> {
  const allKeys = await chrome.storage.local.get(null);
  const keysToRemove = [];

  for (const key of Object.keys(allKeys)) {
    if (
      key === `cookies_${sessionId}` ||
      key.startsWith(`session_${sessionId}_`)
    ) {
      keysToRemove.push(key);
    }
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
}
