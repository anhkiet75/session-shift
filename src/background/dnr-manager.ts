// dnr-manager.ts — Declarative Net Request rules, debounce, and cookie-capture listener.

import { getCookieStore, setCookieStore } from '../lib/session-store.js';
import { parseSetCookie, cookieKey, type SerializeOptions } from '../lib/cookie-parser.js';
import { tabSessions } from './session-manager.js';
import { withCookieLock } from '../lib/cookie-write-lock.js';
import { buildDnrRulesForCookieStore } from './dnr-cookie-rule-builder.js';
import { getEtld1 } from '../lib/public-suffix.js';
import {
  AUTH_BRIDGE_DNR_SETTLE_MS,
  AUTH_BRIDGE_HEADER,
} from '../lib/auth-transition-bridge.js';

const MAX_DNR_RULES_PER_TAB = 100;
const DNR_RULE_ID_STRIDE = 1_000_000;

const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
  'webbundle', 'other',
] as chrome.declarativeNetRequest.ResourceType[];

const NON_NAVIGATION_RESOURCE_TYPES = ALL_RESOURCE_TYPES.filter(
  (type) => type !== 'main_frame' && type !== 'sub_frame'
);

type AuthBridgeRequest = {
  bridgeId: string
  tabId: number
  frameId?: number
  url: string
}

const authBridgeRequests = new Map<string, AuthBridgeRequest>();
const bridgeNavigationStrips = new Map<number, string>();

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
    bridgeNavigationStrips.delete(tabId);
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds, addRules: [] });
    return;
  }

  // Profiles span all sites, so there is no bound host. Scheme comes from the
  // current tab URL — a profile has no single origin, and using the live scheme
  // keeps Secure cookies out of plaintext http requests.
  const boundHost = null;
  let scheme: 'https' | 'http' | null = null;
  let firstPartyDomain: string | null = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = new URL(tab.url ?? '');
    scheme = url.protocol === 'https:' ? 'https' : url.protocol === 'http:' ? 'http' : null;
    if (scheme) firstPartyDomain = getEtld1(url.hostname);
  } catch {
    scheme = null;
    firstPartyDomain = null;
  }

  // Fail closed on Secure cookies: only an explicitly-https tab gets them. http
  // must never carry Secure cookies in plaintext, and an unresolved scheme (tab
  // gone / chrome:// / tabs.get threw) is treated as not-https for safety.
  const serializeOpts: SerializeOptions = scheme === 'https' ? {} : { excludeSecure: true };
  const store = await getCookieStore(sessionId);

  // Base-strip subresource cookies only. Top-level redirects can happen before
  // async webRequest capture rebuilds DNR, so navigation requests/responses must
  // let Chrome carry freshly set login cookies. Stored isolated cookies still get
  // explicit higher-priority navigation `Cookie: set` rules below. Same-site
  // auth XHR remains the one relaxed response path: it can bridge a just-set
  // cookie into an immediate navigation, while other subresource responses stay
  // stripped and cannot pollute Chrome's shared jar.
  const addRules = buildDnrRulesForCookieStore({
    tabId,
    ruleIds,
    boundHost,
    scheme,
    store,
    serializeOpts,
    resourceTypes: ALL_RESOURCE_TYPES,
    firstPartyDomain,
    requestStripResourceTypes: NON_NAVIGATION_RESOURCE_TYPES,
    responseStripResourceTypes: NON_NAVIGATION_RESOURCE_TYPES,
    bridgeNavigationUrl: bridgeNavigationStrips.get(tabId) ?? null,
  });

  // Atomic remove+add: Chrome processes the removal before the addition within a
  // single call, so concurrent callers for the same tab can't collide on rule ID.
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds, addRules });
}

// Force the next navigation in this tab to that exact host to go out with no
// Cookie header, overriding the normal navigation exemption. Used when a tab is
// newly assigned to a profile whose cookie store has no entries yet for that
// host: with no per-host override rule, the navigation-exempt base strip rule
// would otherwise let Chrome attach the default jar's stale cookie for that
// site, making a brand-new profile look logged in as the old account. Cleared
// automatically by `handleRequestCompleted()` once that navigation finishes.
export function stripCookiesOnNextNavigation(tabId: number, url: string): void {
  bridgeNavigationStrips.set(tabId, url);
}

// Drop a tab's pending strip entry so a closed tab's numeric id can't be
// reused later and inject a stale-URL strip condition for an unrelated tab.
export function clearBridgeNavigationStrip(tabId: number): void {
  bridgeNavigationStrips.delete(tabId);
}

// Capture Set-Cookie headers for an isolated tab and re-publish the DNR rules.
//
// Navigation Set-Cookie is intentionally not stripped by DNR because Chrome can
// issue the redirect request before this async handler completes. The captured
// copy still rebuilds DNR for later isolated requests. Subresource Set-Cookie is
// stripped from the browser jar and captured here for the isolated store.
export async function handleHeadersReceived(
  details: chrome.webRequest.OnHeadersReceivedDetails
): Promise<void> {
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

  // Publish immediately so an auth response that sets a cookie and then triggers
  // navigation cannot outrun the profile's DNR Cookie-set rule.
  if (tabSessions[tabId] !== sessionId) return;
  const pendingBridge = authBridgeRequests.get(details.requestId);
  if (pendingBridge) bridgeNavigationStrips.set(tabId, pendingBridge.url);
  await updateDNRRulesForTab(tabId, sessionId);
  if (pendingBridge) await resolveAuthBridgeRequest(details.requestId);
  // Note: we intentionally do NOT remove cookies from the global jar.
  // The DNR session rule overwrites the Cookie header for isolated tabs, making
  // the global jar irrelevant for them. Removing global cookies would log out
  // other sessions (including the default session) sharing the same domain.
}

export function handleBeforeSendHeaders(
  details: chrome.webRequest.OnBeforeSendHeadersDetails
): void {
  const { requestId, requestHeaders, tabId, frameId } = details;
  if (tabId < 0) return;
  const sessionId = tabSessions[tabId];
  if (!sessionId || sessionId === 'default') return;

  const bridgeHeader = requestHeaders?.find(
    (header) => header.name.toLowerCase() === AUTH_BRIDGE_HEADER.toLowerCase()
  );
  if (!bridgeHeader?.value) return;

  authBridgeRequests.set(requestId, {
    bridgeId: bridgeHeader.value,
    tabId,
    frameId: typeof frameId === 'number' && frameId >= 0 ? frameId : undefined,
    url: details.url,
  });
}

export async function handleRequestCompleted(
  details:
  | chrome.webRequest.OnCompletedDetails
  | chrome.webRequest.OnErrorOccurredDetails
): Promise<void> {
  if (authBridgeRequests.has(details.requestId)) {
    await new Promise((resolve) => setTimeout(resolve, AUTH_BRIDGE_DNR_SETTLE_MS));
    await resolveAuthBridgeRequest(details.requestId);
  }
  if (
    details.tabId >= 0 &&
    bridgeNavigationStrips.has(details.tabId) &&
    (details.type === 'main_frame' || details.type === 'sub_frame')
  ) {
    bridgeNavigationStrips.delete(details.tabId);
    const sessionId = tabSessions[details.tabId];
    if (sessionId && sessionId !== 'default') {
      await updateDNRRulesForTab(details.tabId, sessionId);
    }
  }
}

async function resolveAuthBridgeRequest(requestId: string): Promise<void> {
  const pending = authBridgeRequests.get(requestId);
  if (!pending) return;
  authBridgeRequests.delete(requestId);
  try {
    await chrome.tabs.sendMessage(
      pending.tabId,
      { action: 'bridgeCookieSyncDone', bridgeId: pending.bridgeId },
      pending.frameId !== undefined ? { frameId: pending.frameId } : undefined,
    );
  } catch {
    // The tab/frame may be gone already; fail open.
  }
}

// webRequest listener — capture Set-Cookie headers for isolated tabs.
export function registerWebRequestListener(): void {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details): undefined => {
      handleBeforeSendHeaders(details);
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders', 'extraHeaders']
  );
  chrome.webRequest.onHeadersReceived.addListener(
    (details): undefined => {
      void handleHeadersReceived(details);
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders', 'extraHeaders']
  );
  chrome.webRequest.onCompleted.addListener(
    (details): undefined => {
      void handleRequestCompleted(details);
    },
    { urls: ['<all_urls>'] }
  );
  chrome.webRequest.onErrorOccurred.addListener(
    (details): undefined => {
      void handleRequestCompleted(details);
    },
    { urls: ['<all_urls>'] }
  );
}
