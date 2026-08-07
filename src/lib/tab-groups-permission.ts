// tab-groups-permission.ts — Optional `tabGroups` permission lifecycle helpers.
//
// `tabGroups` is declared under `optional_permissions`, never `permissions`
// (see manifest.json), so it may or may not actually be granted at any given
// moment regardless of what `groupTabsByProfile` says in settings. These two
// facts — the setting and the grant — are independent; this module is the
// single place that reconciles them, shared by Options (load-time check) and
// the background (SW-startup check and the `permissions.onRemoved` listener).

import { mutateExtSettingsField } from './settings-store.js';
import { getExtSettings } from './settings-store.js';

/** Whether the `tabGroups` permission is currently granted. */
export async function hasTabGroupsPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ['tabGroups'] });
  } catch (e) {
    console.warn('[lib] hasTabGroupsPermission failed:', e);
    return false;
  }
}

/**
 * If `groupTabsByProfile` is on but the grant is gone (revoked out-of-band —
 * there is no UI for the extension to detect this except by checking), turn
 * the setting back off. Never re-requests: only a user gesture in Options can
 * do that, and this runs from contexts (SW startup, the removal event) that
 * have neither. Returns `true` if it reconciled (setting was turned off).
 */
export async function reconcileTabGroupsSetting(): Promise<boolean> {
  const settings = await getExtSettings();
  if (settings.groupTabsByProfile !== true) return false;
  if (await hasTabGroupsPermission()) return false;
  await mutateExtSettingsField('groupTabsByProfile', false);
  return true;
}
