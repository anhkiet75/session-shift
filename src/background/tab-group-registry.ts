// tab-group-registry.ts — chrome.storage.session record of tab groups this
// extension created, keyed by window then profile. A group id absent from
// this registry is user-owned and must never be renamed, recolored, moved,
// or removed by this extension. Mirrors the tabSessions persistence pattern
// in session-manager.ts:12-29 (same storage area, same restore-on-startup
// shape), kept as a separate module per the 200-LOC rule since tab-group-sync.ts
// already carries the event-handling and permission-guard logic.

export type GroupRegistry = Record<string, Record<string, number>>; // windowId -> profileId -> groupId

const REGISTRY_KEY = 'tabGroupRegistry';

let registry: GroupRegistry = {};

export async function restoreGroupRegistry(): Promise<void> {
  try {
    const result = await chrome.storage.session.get([REGISTRY_KEY]);
    if (result[REGISTRY_KEY]) registry = result[REGISTRY_KEY] as GroupRegistry;
  } catch (e) {
    console.warn('[bg] restoreGroupRegistry failed:', e);
  }
}

/**
 * Kicked off once at module load (same shape as `restoreTabSessions()`'s
 * `restored` promise in session-manager.ts/index.ts) — every registry-touching
 * function in tab-group-sync.ts awaits this before its first read or write.
 * Without it, a service worker woken specifically by the event that needs the
 * registry (e.g. a `setSession` message) can run before the storage.session
 * read finishes, see an empty map, and both create a duplicate group and clobber
 * the in-flight restore's write on the next persist.
 */
export const groupRegistryRestored: Promise<void> = restoreGroupRegistry();

async function persist(): Promise<void> {
  try {
    await chrome.storage.session.set({ [REGISTRY_KEY]: registry });
  } catch (e) {
    console.warn('[bg] persistGroupRegistry failed:', e);
  }
}

export function getGroupId(windowId: number, profileId: string): number | undefined {
  return registry[windowId]?.[profileId];
}

export async function setGroupId(windowId: number, profileId: string, groupId: number): Promise<void> {
  registry[windowId] ??= {};
  registry[windowId][profileId] = groupId;
  await persist();
}

export async function dropGroupId(windowId: number, profileId: string): Promise<void> {
  if (!registry[windowId]) return;
  delete registry[windowId][profileId];
  if (Object.keys(registry[windowId]).length === 0) delete registry[windowId];
  await persist();
}

export async function dropWindow(windowId: number): Promise<void> {
  if (!(windowId in registry)) return;
  delete registry[windowId];
  await persist();
}

/** Drops whichever (windowId, profileId) entry currently points at `groupId`, if any. */
export async function dropGroupById(groupId: number): Promise<void> {
  let changed = false;
  for (const windowId of Object.keys(registry)) {
    for (const profileId of Object.keys(registry[windowId])) {
      if (registry[windowId][profileId] === groupId) {
        delete registry[windowId][profileId];
        changed = true;
      }
    }
    if (Object.keys(registry[windowId]).length === 0) delete registry[windowId];
  }
  if (changed) await persist();
}

export function isManagedGroup(groupId: number): boolean {
  return Object.values(registry).some((byProfile) => Object.values(byProfile).includes(groupId));
}

export function allEntries(): Array<{ windowId: number; profileId: string; groupId: number }> {
  const out: Array<{ windowId: number; profileId: string; groupId: number }> = [];
  for (const [windowId, byProfile] of Object.entries(registry)) {
    for (const [profileId, groupId] of Object.entries(byProfile)) {
      out.push({ windowId: Number(windowId), profileId, groupId });
    }
  }
  return out;
}

export async function clearRegistry(): Promise<void> {
  registry = {};
  await persist();
}
