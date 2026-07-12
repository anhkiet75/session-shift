// session-store.ts — Chrome storage helpers for session isolation (MV3).

import type { Session } from './types.js'

export type CookieStoreEntry = {
  name?: string
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

// Profiles are global containers: a single `profiles` key holds every profile.
// Cookie data stays in per-profile `cookies_${id}` stores (already global).
const PROFILES_KEY = 'profiles';

export async function getProfiles(): Promise<Session[]> {
  const result = await chrome.storage.local.get([PROFILES_KEY]);
  const value = result[PROFILES_KEY];
  return Array.isArray(value) ? (value as Session[]) : [];
}

export async function setProfiles(list: Session[]): Promise<void> {
  await chrome.storage.local.set({ [PROFILES_KEY]: list });
}

export function isInternalSession(sessionId: string): boolean {
  return !sessionId || sessionId === 'default';
}

/**
 * Find cookie stores (`cookies_${id}`) not referenced by any profile. Skips
 * internal sessions (default). Returns orphan session ids.
 */
export async function findOrphanedCookieStores(): Promise<string[]> {
  const all = await chrome.storage.local.get(null);
  const referenced = new Set<string>();

  const profiles = all[PROFILES_KEY];
  if (Array.isArray(profiles)) {
    for (const s of profiles) if (s && typeof s.id === 'string') referenced.add(s.id);
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

/**
 * `buildDuplicateName` resolves the full stored name from the source name at
 * duplication time (e.g. localized "$name$ (copy)"). Called once here; the
 * result is stored and never re-localized on later locale changes.
 */
export async function duplicateSession(
  sessionId: string,
  buildDuplicateName: (sourceName: string) => string = (name) => `${name} (copy)`
): Promise<Session> {
  const list = await getProfiles();
  const source = list.find(s => s.id === sessionId);
  if (!source) throw new Error(`Session not found: ${sessionId}`);

  const newId = 'session_' + crypto.randomUUID();
  const newSession = { id: newId, name: buildDuplicateName(source.name), hue: source.hue };

  // List-then-store ordering: write the profiles reference BEFORE the cookie store.
  // A GC snapshot taken mid-flight then sees a referenced (recoverable) store, never
  // an unreferenced one to delete — so orphan GC can't collect a live new profile's
  // cookies. (The reverse order created a window where the store existed with no
  // profile entry and looked like an orphan.)
  await setProfiles([...list, newSession]);
  const store = await getCookieStore(sessionId);
  await setCookieStore(newId, { ...store });
  return newSession;
}

export async function updateSessionHue(sessionId: string, hue: number): Promise<void> {
  const list = await getProfiles();
  let changed = false;
  const patched = list.map(s => {
    if (s.id !== sessionId) return s;
    changed = true;
    return { ...s, hue };
  });
  if (changed) await setProfiles(patched);
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
