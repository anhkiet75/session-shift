// dnr-manager.ts — Declarative Net Request rules, debounce, and cookie-capture listener.

import { getCookieStore, setCookieStore } from '../lib/session-store.js';
import { parseSetCookie, cookieKey, type SerializeOptions } from '../lib/cookie-parser.js';
import type { CookieStoreEntry } from '../lib/session-store.js';
import { tabSessions, persistTabSessions, getSessionBoundHost, getSessionBoundOrigin } from './session-manager.js';
import { withCookieLock } from '../lib/cookie-write-lock.js';
import { buildDnrRulesForCookieStore } from './dnr-cookie-rule-builder.js';

export const dnrDebounceTimers = new Map<number, ReturnType<typeof setTimeout>>();
const MAX_DNR_RULES_PER_TAB = 100;
const DNR_RULE_ID_STRIDE = 1_000_000;

const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
  'webbundle', 'other',
] as chrome.declarativeNetRequest.ResourceType[];

export function dnrRuleId(tabId: number): number {
  return (tabId % 1000000) + 1;
}

export function dnrRuleIdsForTab(tabId: number): number[] {
  const baseId = dnrRuleId(tabId);
  return Array.from({ length: MAX_DNR_RULES_PER_TAB }, (_, index) => baseId + index * DNR_RULE_ID_STRIDE);
}

export async function updateDNRRulesForTab(tabId: number, sessionId: string): Promise<void> {
  const ruleIds = dnrRuleIdsForTab(tabId);

  if (!sessionId || sessionId === 'default') {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds, addRules: [] });
    return;
  }

  // Derive bound host and scheme. Snap sessions encode the host in their ID;
  // regular sessions look up from the stored origin. Snap scheme comes from the
  // current tab URL; regular scheme comes from the session's bound origin.
  let boundHost: string | null = null;
  let scheme: 'https' | 'http' | null = null;

  if (sessionId.startsWith('_snap_')) {
    const snapPrefix = `_snap_${tabId}_`;
    boundHost = sessionId.startsWith(snapPrefix) ? sessionId.slice(snapPrefix.length) : null;
    try {
      const tab = await chrome.tabs.get(tabId);
      scheme = tab.url?.startsWith('https://') ? 'https' : tab.url?.startsWith('http://') ? 'http' : null;
    } catch { scheme = null; }
  } else {
    boundHost = await getSessionBoundHost(sessionId);
    const origin = await getSessionBoundOrigin(sessionId);
    scheme = origin?.protocol === 'https:' ? 'https' : origin?.protocol === 'http:' ? 'http' : null;
  }

  // For HTTP-bound sessions, Secure cookies must not be sent in plaintext.
  const serializeOpts: SerializeOptions = scheme === 'http' ? { excludeSecure: true } : {};
  const store = await getCookieStore(sessionId);

  // Strip inbound Set-Cookie so isolated-tab responses never write to the global
  // cookie jar. Without this, an isolated session's login cookies overwrite the
  // default profile's cookies in the shared jar, and resetting a tab to default
  // would surface the isolated session instead of the original default profile.
  // The webRequest listener still captures Set-Cookie into the session store
  // (it observes the response before this removal takes effect).
  const addRules = buildDnrRulesForCookieStore({
    tabId,
    ruleIds,
    boundHost,
    scheme,
    store,
    serializeOpts,
    resourceTypes: ALL_RESOURCE_TYPES,
  });

  // Atomic remove+add: Chrome processes the removal before the addition within a
  // single call, so concurrent callers for the same tab can't collide on rule ID.
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds, addRules });
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
      store[cookieKey(c.name, c.domain, c.path)] = {
        name: c.name,
        value: c.value,
        expires: c.expirationDate ? Math.round(c.expirationDate * 1000) : null,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
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

        await withCookieLock(sessionId, async () => {
          const store = await getCookieStore(sessionId);
          if (tabSessions[tabId] !== sessionId) return;
          const requestHost = new URL(requestUrl).hostname;

          for (const header of setCookieHeaders) {
            if (!header.value) continue;
            const parsed = parseSetCookie(header.value, requestUrl);
            if (!parsed) continue;
            const domain = parsed.domain ?? requestHost;
            const path = parsed.path ?? '/';
            const key = cookieKey(parsed.name, domain, path);
            if (parsed.expires === 0) {
              delete store[key];
            } else {
              store[key] = {
                name: parsed.name,
                value: parsed.value,
                expires: parsed.expires,
                domain,
                path,
                secure: parsed.secure,
                httpOnly: parsed.httpOnly,
              };
            }
            if (key !== parsed.name && parsed.name in store) delete store[parsed.name];
          }

          await setCookieStore(sessionId, store);
        });
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
