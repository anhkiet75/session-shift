// tab-group-sync.ts — the chrome.tabGroups mutation engine: creates/moves/
// recolors browser tab groups to mirror profile assignment, and owns the
// listeners that detect a user's manual edits. Permission-lifecycle
// orchestration (request/decline/revoke, on/off transitions, SW-startup
// reconcile) lives in tab-group-lifecycle.ts, which calls back into the
// exports here. `chrome.tabGroups` is `undefined` whenever the optional
// `tabGroups` permission is not currently granted — every call into it goes
// through withTabGroups(), the single choke point that tolerates that. See
// plans/260729-0005-profile-color-visibility/phase-04-*.md for the full spec.

import { getExtSettings } from '../lib/settings-store.js';
import { nearestTabGroupColor, resolveProfileHue, type TabGroupColor } from '../lib/profile-color.js';
import { getProfiles, isInternalSession } from '../lib/session-store.js';
import { reconcileTabGroupsSetting } from '../lib/tab-groups-permission.js';
import {
  groupRegistryRestored, getGroupId, setGroupId, dropWindow,
  dropGroupById, isManagedGroup, allEntries, clearRegistry,
} from './tab-group-registry.js';

// Collapses a burst of failed calls (e.g. every open tab regrouping at once
// after a mid-session revoke) into a single settings write + registry clear.
// Exported for tab-group-lifecycle.ts's permissions.onRemoved handler, which
// needs the same dedup — one-directional dependency (lifecycle -> sync) to
// avoid a circular import between the two modules.
let reconciling = false;

export async function reconcileIfPermissionLost(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    if (await reconcileTabGroupsSetting()) {
      forgetAllAppearances();
      await clearRegistry();
    }
  } finally {
    reconciling = false;
  }
}

/** Single choke point: every chrome.tabGroups / chrome.tabs.group|ungroup call goes through here. */
export async function withTabGroups<T>(fn: () => Promise<T>): Promise<T | null> {
  if (typeof chrome.tabGroups === 'undefined') return null;
  try {
    return await fn();
  } catch (e) {
    console.warn('[bg] tab-group-sync call failed:', e);
    await reconcileIfPermissionLost();
    return null;
  }
}

// Every group-mutating operation runs through this single chained queue, so
// two calls racing for the same (windowId, sessionId) — e.g. two tabs
// assigned to the same profile back to back — can't both see "no existing
// group" and create two. Mirrors settings-store.ts:21-33's mutationQueue.
let mutationQueue: Promise<unknown> = Promise.resolve();
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const task = mutationQueue.then(fn, fn);
  mutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function isEnabled(): Promise<boolean> {
  const settings = await getExtSettings();
  return settings.groupTabsByProfile === true;
}

async function resolveGroupAppearance(sessionId: string): Promise<{ title: string; color: TabGroupColor }> {
  const list = await getProfiles();
  const index = list.findIndex((s) => s.id === sessionId);
  if (index === -1) return { title: sessionId, color: 'grey' };
  const profile = list[index];
  return { title: profile.name, color: nearestTabGroupColor(resolveProfileHue(profile, index)) };
}

// Last {title, color} this module itself wrote to a managed group, keyed by
// group id. handleGroupUpdated compares incoming events against this to tell
// "we just wrote this" (or "the user only (un)collapsed it") apart from a
// genuine user rename/recolor — onUpdated does not distinguish the source.
const lastKnownAppearance = new Map<number, { title: string; color: TabGroupColor }>();

async function applyGroupAppearance(groupId: number, title: string, color: TabGroupColor): Promise<void> {
  lastKnownAppearance.set(groupId, { title, color }); // set BEFORE the call — the event can fire before update() resolves
  await chrome.tabGroups.update(groupId, { title, color });
}

async function forgetGroup(groupId: number): Promise<void> {
  lastKnownAppearance.delete(groupId);
  await dropGroupById(groupId);
}

/** Toggle-off / revoke-reconcile cleanup: drop everything this module remembers about appearances. */
export function forgetAllAppearances(): void {
  lastKnownAppearance.clear();
}

/** Move `tabId` (in `windowId`) into `sessionId`'s group for that window, creating it if absent. */
export const syncTabToGroup = (tabId: number, windowId: number, sessionId: string): Promise<void> =>
  enqueue(() => syncTabToGroupImpl(tabId, windowId, sessionId));

async function syncTabToGroupImpl(tabId: number, windowId: number, sessionId: string): Promise<void> {
  if (typeof chrome.tabGroups === 'undefined' || isInternalSession(sessionId)) return;
  await groupRegistryRestored;
  if (!(await isEnabled())) return;
  await withTabGroups(async () => {
    let groupId = getGroupId(windowId, sessionId);
    if (groupId !== undefined) {
      try {
        const group = await chrome.tabGroups.get(groupId);
        // Registered for this window but Chrome has since moved it (drag to
        // another window) — stale for OUR purposes even though it still exists.
        if (group.windowId !== windowId) groupId = undefined;
      } catch {
        groupId = undefined; // stale — group no longer exists, fall through and recreate
      }
    }
    if (groupId === undefined) {
      groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      const { title, color } = await resolveGroupAppearance(sessionId);
      await applyGroupAppearance(groupId, title, color);
      await setGroupId(windowId, sessionId, groupId);
    } else {
      await chrome.tabs.group({ tabIds: [tabId], groupId });
    }
  });
}

/**
 * colorSession/renameSession hook: re-apply the current {title, color} to every
 * already-open window's group for this profile. `resolveGroupAppearance` reads
 * both fields fresh from the profile record, so this is also what makes a
 * rename via the popup (which never touches chrome.storage.session or calls
 * chrome.tabGroups itself) reach a group that already exists.
 */
export const syncProfileGroupAppearance = (sessionId: string): Promise<void> =>
  enqueue(() => syncProfileGroupAppearanceImpl(sessionId));

async function syncProfileGroupAppearanceImpl(sessionId: string): Promise<void> {
  if (typeof chrome.tabGroups === 'undefined') return;
  await groupRegistryRestored;
  if (!(await isEnabled())) return;
  const { title, color } = await resolveGroupAppearance(sessionId);
  await withTabGroups(async () => {
    for (const entry of allEntries()) {
      if (entry.profileId !== sessionId) continue;
      try {
        await applyGroupAppearance(entry.groupId, title, color);
      } catch {
        await forgetGroup(entry.groupId); // group no longer exists — drop the stale entry
      }
    }
  });
}

/** tabs.onAttached: tab moved into windowId — regroup it there for its current session. */
export async function handleTabAttached(tabId: number, windowId: number, sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  await syncTabToGroup(tabId, windowId, sessionId);
}

/** windows.onRemoved: drop the whole window's registry sub-map — Chrome already discarded its groups. */
export async function handleWindowRemoved(windowId: number): Promise<void> {
  await groupRegistryRestored;
  await dropWindow(windowId);
}

/**
 * tabGroups.onUpdated (guarded — only registered when the namespace exists).
 * Fires for title/color changes AND for collapse/expand, and for our own
 * `applyGroupAppearance()` writes — the event alone can't tell those apart.
 * Only release ownership when the incoming title/color actually differs from
 * what this module itself last wrote (or never wrote, for a group it doesn't
 * manage). A collapse-only change, or the event echoing our own update, is a
 * no-op here instead of a permanent, un-recoverable loss of ownership.
 */
async function handleGroupUpdated(group: { id: number; title?: string; color?: string }): Promise<void> {
  await groupRegistryRestored;
  if (!isManagedGroup(group.id)) return;
  const known = lastKnownAppearance.get(group.id);
  if (known && group.title === known.title && group.color === known.color) return;
  await forgetGroup(group.id);
}

/** Registers the two listeners that only exist once the permission is granted. */
export function registerGuardedListeners(): void {
  if (typeof chrome.tabGroups === 'undefined') return;
  // onRemoved covers both explicit user deletion AND Chrome's automatic
  // removal when a group's last tab leaves — no separate tabs.onRemoved
  // handler is needed for registry cleanup.
  chrome.tabGroups.onRemoved.addListener((group) => { void forgetGroup(group.id); });
  chrome.tabGroups.onUpdated.addListener((group) => { void handleGroupUpdated(group); });
}

/**
 * Toggle-off: ungroup every registry-tracked tab, then clear the registry.
 * Returns whether the guarded block actually ran (permission was present) —
 * callers use this to decide whether it's safe to also release the grant.
 */
export const ungroupAllManaged = (): Promise<boolean> => enqueue(ungroupAllManagedImpl);

async function ungroupAllManagedImpl(): Promise<boolean> {
  await groupRegistryRestored;
  const ran = await withTabGroups(async () => {
    for (const entry of allEntries()) {
      try {
        const tabs = await chrome.tabs.query({ windowId: entry.windowId, groupId: entry.groupId });
        const tabIds = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
        if (tabIds.length > 0) await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
      } catch {
        // Group already gone — nothing to ungroup.
      }
    }
    return true;
  });
  if (ran === null) return false; // permission wasn't there — nothing was actually ungrouped
  forgetAllAppearances();
  await clearRegistry();
  return true;
}
