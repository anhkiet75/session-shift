// tab-group-lifecycle.ts — permission and setting transitions for Phase 4 tab
// grouping: request/decline/revoke handling, the ext_settings on/off
// transition, and the SW-startup reconcile. The actual chrome.tabGroups
// mutation engine lives in tab-group-sync.ts; this module only orchestrates
// when it runs. See plans/260729-0005-profile-color-visibility/phase-04-*.md.

import { getExtSettings } from '../lib/settings-store.js';
import { reconcileTabGroupsSetting } from '../lib/tab-groups-permission.js';
import { tabSessions } from './session-manager.js';
import { groupRegistryRestored, clearRegistry } from './tab-group-registry.js';
import { reconcileIfPermissionLost, syncTabToGroup, ungroupAllManaged } from './tab-group-sync.js';

/** chrome.permissions namespace always exists (it needs no permission itself). */
export function registerPermissionRemovedListener(): void {
  chrome.permissions.onRemoved.addListener(async (removed) => {
    if (removed.permissions?.includes('tabGroups')) await reconcileIfPermissionLost();
  });
}

/**
 * Full toggle-off transition: ungroup managed tabs, clear the registry, then
 * release the grant. Ordering matters — releasing the permission first would
 * leave the ungroup step unable to call chrome.tabs.ungroup. Skips the release
 * if the ungroup step couldn't actually run (permission already gone) —
 * calling `permissions.remove()` on a grant we never touched here would hide
 * a real failure behind a no-op success.
 */
async function releaseTabGroupsOnToggleOff(): Promise<void> {
  const didUngroup = await ungroupAllManaged();
  if (!didUngroup) return;
  try {
    await chrome.permissions.remove({ permissions: ['tabGroups'] });
  } catch (e) {
    console.warn('[bg] releasing tabGroups permission failed:', e);
  }
}

/** On-transition: sync every currently-open profiled tab into its group. */
async function syncAllOpenTabs(): Promise<void> {
  await groupRegistryRestored;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) {
    if (tab.id === undefined || tab.windowId === undefined) continue;
    const sessionId = tabSessions[tab.id];
    if (sessionId) await syncTabToGroup(tab.id, tab.windowId, sessionId);
  }
}

/** ext_settings on/off transition. Mirrors context-menu-manager.ts:62-75's oldValue/newValue diff pattern. */
export function registerSettingsListener(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('ext_settings' in changes)) return;
    const before = changes.ext_settings.oldValue as { groupTabsByProfile?: boolean } | undefined;
    const after = changes.ext_settings.newValue as { groupTabsByProfile?: boolean } | undefined;
    if (before?.groupTabsByProfile === after?.groupTabsByProfile) return;
    if (after?.groupTabsByProfile === true) {
      void syncAllOpenTabs();
    } else {
      void releaseTabGroupsOnToggleOff(); // also reached from the revoke-reconcile path (reconcileTabGroupsSetting writes the same false) — permissions.remove() on an already-absent grant is a harmless no-op there
    }
  });
}

/**
 * SW-startup backstop — authoritative because it does not depend on having
 * observed an event. Never re-requests the permission (impossible without a
 * user gesture); reconciles the setting to off instead. Call as a promise,
 * never with a top-level `await` (index.ts:18-21).
 */
export async function startupReconcile(): Promise<void> {
  await groupRegistryRestored;
  const settings = await getExtSettings();
  if (settings.groupTabsByProfile !== true) return;
  if (await reconcileTabGroupsSetting()) await clearRegistry();
  // Otherwise the grant still holds — tabs regroup lazily as setSession /
  // tabs.onAttached fire during this session; no eager full-window sweep
  // (that already happened on the true-transition that got us here).
}
