// index.ts — Service worker entry point: startup + Chrome API listener registration.

import { restoreTabSessions, tabSessions, persistTabSessions, updateBadge } from './session-manager.js';
import { dnrDebounceTimers, dnrRuleIdsForTab, registerWebRequestListener, updateDNRRulesForTab } from './dnr-manager.js';
import { setupContextMenu, registerStorageListener } from './context-menu-manager.js';
import { handleMessage } from './message-handler.js';
import type { BackgroundMessage } from '../lib/types.js';
import { getSessionList, isInternalSession } from '../lib/session-store.js';

export { handleMessage };

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
// Top-level await is disallowed in MV3 service workers — it delays event
// listener registration and triggers "Service worker registration failed".
// Kick off restoration eagerly; handlers below await `restored` before
// touching tabSessions so they see the persisted map.
const restored: Promise<void> = restoreTabSessions();
setupContextMenu();
registerStorageListener();
registerWebRequestListener();

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ error: 'unauthorized' });
    return false;
  }
  restored
    .then(() => handleMessage(request as BackgroundMessage, sender))
    .then(sendResponse)
    .catch((err: Error) => {
      console.error('[bg] message error:', err);
      sendResponse({ error: err.message });
    });
  return true;
});

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await restored;
  const timer = dnrDebounceTimers.get(tabId);
  if (timer) { clearTimeout(timer); dnrDebounceTimers.delete(tabId); }

  if (tabSessions[tabId] !== undefined) {
    delete tabSessions[tabId];
    await persistTabSessions();
  }
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: dnrRuleIdsForTab(tabId) }).catch(() => {});
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await restored;
  updateBadge(tabId, tabSessions[tabId] || 'default');
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  await restored;
  if (changeInfo.status === 'loading') {
    const sessionId = tabSessions[tabId] || 'default';
    if (!isInternalSession(sessionId)) updateBadge(tabId, sessionId);
  }
  if (changeInfo.url) {
    const snapId = tabSessions[tabId];
    if (snapId?.startsWith('_snap_')) {
      const snapPrefix = `_snap_${tabId}_`;
      const snapHostname = snapId.startsWith(snapPrefix) ? snapId.slice(snapPrefix.length) : null;
      let newHostname: string | null = null;
      try { newHostname = new URL(changeInfo.url).hostname; } catch { /* ignore */ }
      if (snapHostname === null || newHostname !== snapHostname) {
        await updateDNRRulesForTab(tabId, 'default');
        await chrome.storage.local.remove(`cookies_${snapId}`);
        delete tabSessions[tabId];
        await persistTabSessions();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Context menu click — open link in selected session
// ---------------------------------------------------------------------------
chrome.contextMenus.onClicked.addListener(async (info) => {
  await restored;
  if (!info.linkUrl || !String(info.menuItemId).startsWith('ss-session-')) return;
  const sessionId = String(info.menuItemId).replace('ss-session-', '');
  let url: string;
  try { url = new URL(info.linkUrl).href; } catch { return; }
  await handleMessage(
    { action: 'createSessionTab', payload: { url, sessionId } },
    { id: chrome.runtime.id }
  );
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts — session cycling
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async (command) => {
  await restored;
  if (command !== 'session-next' && command !== 'session-prev') return;

  let tab: chrome.tabs.Tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) { return; }
  if (!tab?.url || tab.url.startsWith('chrome://') || tab.id === undefined) return;

  let origin: string;
  try { origin = new URL(tab.url).origin; } catch { return; }

  const list = await getSessionList(origin);
  if (list.length === 0) return;

  const currentId = tabSessions[tab.id] || 'default';
  const currentIdx = list.findIndex(s => s.id === currentId);
  const nextIdx = command === 'session-next'
    ? (currentIdx === -1 ? 0 : (currentIdx + 1) % list.length)
    : (currentIdx === -1 ? list.length - 1 : (currentIdx - 1 + list.length) % list.length);

  await handleMessage(
    { action: 'setSession', payload: { tabId: tab.id, sessionId: list[nextIdx].id } },
    { id: chrome.runtime.id }
  );
  chrome.tabs.reload(tab.id);
});
