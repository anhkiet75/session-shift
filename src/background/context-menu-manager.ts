// context-menu-manager.ts — Context menu build/rebuild lifecycle.
// Extension-owned (created via chrome.contextMenus at runtime), so its parent
// title follows the manual in-extension locale override — not only Chrome's
// native UI locale like manifest-declared surfaces.

import { getProfiles } from '../lib/session-store.js';
import { getLanguagePreference, createLocalizer } from '../lib/localization.js';

const CTX_PARENT_ID = 'ss-open-in-session';

async function rebuildContextMenu(): Promise<void> {
  try {
    const localizer = await createLocalizer(await getLanguagePreference());
    await chrome.contextMenus.removeAll();
    const sessions = await getProfiles();
    if (sessions.length === 0) return;

    chrome.contextMenus.create({
      id: CTX_PARENT_ID,
      title: localizer.getMessage('contextMenuParentTitle') || 'Open in Session',
      contexts: ['link'],
    });

    for (const session of sessions) {
      chrome.contextMenus.create({
        id: `ss-session-${session.id}`,
        parentId: CTX_PARENT_ID,
        title: session.name,
        contexts: ['link'],
      });
    }
  } catch (e) {
    console.warn('[bg] setupContextMenu failed:', e);
  }
}

// Single-flight + trailing-coalesced scheduler: a rebuild already in flight
// absorbs any number of requests that arrive while it runs into at most one
// trailing rebuild afterward, so a storm of profile/language change events
// never queues more than one extra rebuild.
let inFlight: Promise<void> | null = null;
let trailingRequested = false;

export function setupContextMenu(): Promise<void> {
  if (inFlight) {
    trailingRequested = true;
    return inFlight;
  }
  inFlight = (async () => {
    await rebuildContextMenu();
    while (trailingRequested) {
      trailingRequested = false;
      await rebuildContextMenu();
    }
  })();
  inFlight.finally(() => { inFlight = null; });
  return inFlight;
}

// Rebuild the context menu whenever the global profiles list or the manual
// language preference changes in storage.
export function registerStorageListener(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('profiles' in changes) {
      setupContextMenu();
      return;
    }
    if ('ext_settings' in changes) {
      const before = changes.ext_settings.oldValue as { language?: string } | undefined;
      const after = changes.ext_settings.newValue as { language?: string } | undefined;
      if (before?.language !== after?.language) setupContextMenu();
    }
  });
}
