// background.js — Module Service Worker

import { parseSetCookie, serializeCookieHeader, parseCookieString } from './lib/cookie-parser.js';
import { getCookieStore, setCookieStore, getSessionList, isInternalSession } from './lib/session-store.js';

// ---------------------------------------------------------------------------
// In-memory tab→session map (also persisted to chrome.storage.session)
// ---------------------------------------------------------------------------
let tabSessions = {}; // tabId (number) -> sessionId (string)

async function restoreTabSessions() {
  try {
    const result = await chrome.storage.session.get(['tabSessions']);
    if (result.tabSessions) {
      tabSessions = result.tabSessions;
    }
  } catch (e) {
    // storage.session may not be available in older Chrome versions
    console.warn('[bg] restoreTabSessions failed:', e);
  }
}

async function persistTabSessions() {
  try {
    await chrome.storage.session.set({ tabSessions });
  } catch (e) {
    console.warn('[bg] persistTabSessions failed:', e);
  }
}

// Restore state on service worker start
restoreTabSessions();

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------
async function updateBadge(tabId, sessionId) {
  if (isInternalSession(sessionId)) {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }

  let label = sessionId.replace(/^session_/, '').substring(0, 3).toUpperCase();
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url && !tab.url.startsWith('chrome://')) {
      const origin = new URL(tab.url).origin;
      const list = await getSessionList(origin);
      const session = list.find((s) => s.id === sessionId);
      if (session?.name) {
        label = session.name.substring(0, 3).toUpperCase();
      }
    }
  } catch (_) {
    // Tab may be gone or URL unavailable — fall back to id-derived label
  }

  chrome.action.setBadgeBackgroundColor({ color: '#7c3aed', tabId });
  chrome.action.setBadgeText({ text: label, tabId });
}

// ---------------------------------------------------------------------------
// DNR rule ID — stable, unique per tab, avoids collision with other rules
// ---------------------------------------------------------------------------
function dnrRuleId(tabId) {
  return (tabId % 1000000) + 1;
}

// ---------------------------------------------------------------------------
// DNR rule update
// ---------------------------------------------------------------------------
const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
  'webbundle', 'other'
];

async function updateDNRRulesForTab(tabId, sessionId) {
  const ruleId = dnrRuleId(tabId);

  // Session-scoped rules support tabIds (dynamic rules do not).
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: []
  });

  if (!sessionId || sessionId === 'default') {
    return;
  }

  const store = await getCookieStore(sessionId);
  const cookieStr = serializeCookieHeader(store);

  const headerAction = cookieStr
    ? { header: 'Cookie', operation: 'set', value: cookieStr }
    : { header: 'Cookie', operation: 'remove' };

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [],
    addRules: [
      {
        id: ruleId,
        priority: 100,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [headerAction]
        },
        condition: {
          tabIds: [tabId],
          resourceTypes: ALL_RESOURCE_TYPES
        }
      }
    ]
  });
}

// ---------------------------------------------------------------------------
// Snapshot default-session tabs on the same host to protect them from
// cookie contamination when a new isolated session is created.
// We read the current global jar and lock those cookies into a DNR rule
// so that Set-Cookie from other sessions can't overwrite them.
// ---------------------------------------------------------------------------
async function protectDefaultTabsOnHost(hostname, excludeTabId) {
  let allTabs;
  try {
    allTabs = await chrome.tabs.query({ url: [`*://${hostname}/*`, `https://${hostname}/*`] });
  } catch (_) {
    return;
  }
  for (const tab of allTabs) {
    if (tab.id === excludeTabId) continue;
    const currentSession = tabSessions[tab.id] || 'default';
    // Only protect tabs that are still using the bare global jar
    if (currentSession !== 'default') continue;

    const snapId = `_snap_${tab.id}_${Math.random().toString(36).substring(2, 7)}`;
    const cookies = await chrome.cookies.getAll({ domain: hostname });
    const store = {};
    for (const c of cookies) {
      store[c.name] = {
        value: c.value,
        expires: c.expirationDate ? Math.round(c.expirationDate * 1000) : null
      };
    }
    await setCookieStore(snapId, store);
    tabSessions[tab.id] = snapId;
    await updateDNRRulesForTab(tab.id, snapId);
    // No badge change — snap sessions are invisible to the user
  }
  await persistTabSessions();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only accept messages from this extension's own pages and content scripts.
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ error: 'unauthorized' });
    return false;
  }
  handleMessage(request, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error('[bg] message error:', err);
      sendResponse({ error: err.message });
    });
  return true; // keep channel open for async response
});

async function handleMessage(request, sender) {
  const { action, payload } = request;

  switch (action) {
    case 'setSession': {
      const { tabId, sessionId } = payload;
      if (typeof tabId !== 'number' || typeof sessionId !== 'string') {
        return { error: 'invalid payload' };
      }
      // Before assigning an isolated session, protect all other default-session tabs
      // on the same host by snapshotting their current global-jar cookies.
      if (sessionId !== 'default') {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab?.url && !tab.url.startsWith('chrome://')) {
            const hostname = new URL(tab.url).hostname;
            await protectDefaultTabsOnHost(hostname, tabId);
          }
        } catch (_) {}
      }
      tabSessions[tabId] = sessionId;
      await persistTabSessions();
      await updateDNRRulesForTab(tabId, sessionId);
      updateBadge(tabId, sessionId);
      return { success: true, sessionId };
    }

    case 'getSession': {
      const tabId = payload?.tabId ?? sender.tab?.id;
      const raw = tabSessions[tabId] || 'default';
      // Snap sessions are internal; expose them as 'default' to the popup
      return { sessionId: raw.startsWith('_snap_') ? 'default' : raw };
    }

    case 'getSessionForBootstrap': {
      const tabId = payload?.tabId ?? sender.tab?.id;
      const sessionId = tabSessions[tabId] || 'default';
      if (isInternalSession(sessionId)) {
        return { sessionId: 'default', cookieStr: '' };
      }
      const store = await getCookieStore(sessionId);
      const cookieStr = serializeCookieHeader(store);
      return { sessionId, cookieStr };
    }

    case 'updateCookie': {
      const { sessionId, cookieStr } = payload;
      if (typeof sessionId !== 'string' || typeof cookieStr !== 'string') {
        return { error: 'invalid payload' };
      }
      const tabId = sender.tab?.id;
      if (isInternalSession(sessionId)) {
        return { success: false, reason: 'default session' };
      }
      const existing = await getCookieStore(sessionId);
      // Rebuild store from page's current cookie state so JS-side deletions are honoured.
      // Preserve Set-Cookie metadata (expires, domain, secure, httpOnly) for known cookies.
      const newStore = {};
      for (const [name, value] of parseCookieString(cookieStr)) {
        newStore[name] = existing[name]
          ? { ...existing[name], value }
          : { value, expires: null };
      }
      await setCookieStore(sessionId, newStore);
      if (tabId) await updateDNRRulesForTab(tabId, sessionId);
      return { success: true };
    }

    case 'refreshBadge': {
      const { tabId } = payload;
      if (typeof tabId !== 'number') return { error: 'invalid payload' };
      const sessionId = tabSessions[tabId] || 'default';
      await updateBadge(tabId, sessionId);
      return { success: true };
    }

    case 'deleteSession': {
      const { sessionId } = payload;
      if (typeof sessionId !== 'string') return { error: 'invalid payload' };
      const affectedTabIds = [];
      for (const [tid, sid] of Object.entries(tabSessions)) {
        if (sid === sessionId) {
          affectedTabIds.push(Number(tid));
          delete tabSessions[tid];
        }
      }
      await persistTabSessions();
      for (const tid of affectedTabIds) {
        await updateDNRRulesForTab(tid, 'default');
        updateBadge(tid, 'default');
      }
      return { success: true, affectedTabIds };
    }

    case 'createSessionTab': {
      const { url, sessionId } = payload;
      if (typeof url !== 'string' || typeof sessionId !== 'string') {
        return { error: 'invalid payload' };
      }
      // Create tab at about:blank so we have the tabId before any real navigation.
      // Assign the session synchronously (no await) right after creation so
      // tabSessions[tabId] is guaranteed set before document_start fires on the real URL.
      const newTab = await chrome.tabs.create({ url: 'about:blank', active: true });
      tabSessions[newTab.id] = sessionId;
      await persistTabSessions();
      await updateDNRRulesForTab(newTab.id, sessionId);
      updateBadge(newTab.id, sessionId);
      // Navigate only after session + DNR rule are fully in place.
      await chrome.tabs.update(newTab.id, { url });
      return { success: true, tabId: newTab.id };
    }

    default:
      return { error: `unknown action: ${action}` };
  }
}

// ---------------------------------------------------------------------------
// webRequest — capture Set-Cookie for isolated tabs
// ---------------------------------------------------------------------------
chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    const { tabId, url: requestUrl } = details;
    if (tabId < 0) return;

    // Snapshot sessionId synchronously before any await.
    // If the tab switches to a new session while we're awaiting storage,
    // we must discard the response — otherwise session A's cookies bleed into session B.
    const sessionId = tabSessions[tabId];
    if (!sessionId || sessionId === 'default') return;

    const setCookieHeaders = (details.responseHeaders || []).filter(
      (h) => h.name.toLowerCase() === 'set-cookie'
    );
    if (setCookieHeaders.length === 0) return;

    const store = await getCookieStore(sessionId);

    // Guard: discard if session changed while we were awaiting storage
    if (tabSessions[tabId] !== sessionId) return;

    for (const header of setCookieHeaders) {
      const parsed = parseSetCookie(header.value, requestUrl);
      if (!parsed) continue;

      const key = parsed.name;
      if (parsed.expires === 0) {
        delete store[key];
      } else {
        store[key] = {
          value: parsed.value,
          expires: parsed.expires,
          domain: parsed.domain,
          path: parsed.path,
          secure: parsed.secure,
          httpOnly: parsed.httpOnly
        };
      }
    }

    await setCookieStore(sessionId, store);
    await updateDNRRulesForTab(tabId, sessionId);
    // Note: we intentionally do NOT remove cookies from the global jar.
    // The DNR session rule overwrites the Cookie header for isolated tabs, making
    // the global jar irrelevant for them. Removing global cookies would log out
    // other sessions (including the default session) sharing the same domain.
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders']
);

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabSessions[tabId] !== undefined) {
    delete tabSessions[tabId];
    await persistTabSessions();
  }
  // Always attempt to clean up DNR rule
  const ruleId = dnrRuleId(tabId);
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  const sessionId = tabSessions[tabId] || 'default';
  updateBadge(tabId, sessionId);
});

// Reapply badge after navigation/reload — Chrome clears tab-specific badge text on navigate.
// status:'loading' fires for both reloads and new-URL navigations (changeInfo.url is absent on reload).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  const sessionId = tabSessions[tabId] || 'default';
  if (isInternalSession(sessionId)) return; // no badge to reapply
  updateBadge(tabId, sessionId);
});
