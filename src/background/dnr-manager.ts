// dnr-manager.ts — Declarative Net Request rules, debounce, and cookie-capture listener.

import { getCookieStore, setCookieStore } from '../lib/session-store.js';
import { serializeCookieHeader, parseSetCookie } from '../lib/cookie-parser.js';
import type { DNRRule } from '../lib/types.js';
import type { CookieStoreEntry } from '../lib/session-store.js';
import { tabSessions, persistTabSessions } from './session-manager.js';

export const dnrDebounceTimers = new Map<number, ReturnType<typeof setTimeout>>();

const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
  'webbundle', 'other',
] as chrome.declarativeNetRequest.ResourceType[];

export function dnrRuleId(tabId: number): number {
  return (tabId % 1000000) + 1;
}

export async function updateDNRRulesForTab(tabId: number, sessionId: string): Promise<void> {
  const ruleId = dnrRuleId(tabId);

  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId], addRules: [] });

  if (!sessionId || sessionId === 'default') return;

  const store = await getCookieStore(sessionId);
  const cookieStr = serializeCookieHeader(store);

  const headerAction: chrome.declarativeNetRequest.ModifyHeaderInfo = cookieStr
    ? { header: 'Cookie', operation: 'set', value: cookieStr }
    : { header: 'Cookie', operation: 'remove' };

  const rule: DNRRule = {
    id: ruleId,
    priority: 100,
    action: { type: 'modifyHeaders', requestHeaders: [headerAction] },
    condition: { tabIds: [tabId], resourceTypes: ALL_RESOURCE_TYPES },
  };

  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [], addRules: [rule] });
}

export function scheduleDNRUpdate(tabId: number, sessionId: string): void {
  const existing = dnrDebounceTimers.get(tabId);
  if (existing) clearTimeout(existing);
  dnrDebounceTimers.set(tabId, setTimeout(async () => {
    dnrDebounceTimers.delete(tabId);
    if (tabSessions[tabId] === sessionId) {
      await updateDNRRulesForTab(tabId, sessionId);
    }
  }, 50));
}

// Snapshot default-session tabs on the same host to protect them from
// cookie contamination when a new isolated session is created.
export async function protectDefaultTabsOnHost(hostname: string, excludeTabId: number): Promise<void> {
  let allTabs: chrome.tabs.Tab[];
  try {
    allTabs = await chrome.tabs.query({ url: [`*://${hostname}/*`, `https://${hostname}/*`] });
  } catch (_) { return; }

  for (const tab of allTabs) {
    if (tab.id === undefined || tab.id === excludeTabId) continue;
    const currentSession = tabSessions[tab.id] || 'default';
    if (currentSession !== 'default') continue;

    const snapId = `_snap_${tab.id}_${hostname}`;
    const cookies = await chrome.cookies.getAll({ domain: hostname });
    const store: Record<string, CookieStoreEntry> = {};
    for (const c of cookies) {
      store[c.name] = {
        value: c.value,
        expires: c.expirationDate ? Math.round(c.expirationDate * 1000) : null,
      };
    }
    await setCookieStore(snapId, store);
    tabSessions[tab.id] = snapId;
    await updateDNRRulesForTab(tab.id, snapId);
  }
  await persistTabSessions();
}

// webRequest listener — capture Set-Cookie headers for isolated tabs.
export function registerWebRequestListener(): void {
  chrome.webRequest.onHeadersReceived.addListener(
    (details): undefined => {
      void (async () => {
        const { tabId, url: requestUrl } = details;
        if (tabId < 0) return;

        const sessionId = tabSessions[tabId];
        if (!sessionId || sessionId === 'default') return;

        const setCookieHeaders = (details.responseHeaders || []).filter(
          (h) => h.name.toLowerCase() === 'set-cookie'
        );
        if (setCookieHeaders.length === 0) return;

        const store = await getCookieStore(sessionId);
        if (tabSessions[tabId] !== sessionId) return; // session changed during await

        for (const header of setCookieHeaders) {
          if (!header.value) continue;
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
              httpOnly: parsed.httpOnly,
            };
          }
        }

        await setCookieStore(sessionId, store);
        scheduleDNRUpdate(tabId, sessionId);
        // Note: we intentionally do NOT remove cookies from the global jar.
        // The DNR session rule overwrites the Cookie header for isolated tabs, making
        // the global jar irrelevant for them. Removing global cookies would log out
        // other sessions (including the default session) sharing the same domain.
      })();
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders', 'extraHeaders']
  );
}
