// dnr-manager.ts — Declarative Net Request rules, debounce, and cookie-capture listener.

import { getCookieStore, setCookieStore } from '../lib/session-store.js';
import { parseSetCookie, cookieKey, type SerializeOptions } from '../lib/cookie-parser.js';
import { tabSessions } from './session-manager.js';
import { withCookieLock } from '../lib/cookie-write-lock.js';
import { buildDnrRulesForCookieStore } from './dnr-cookie-rule-builder.js';
import { getEtld1 } from '../lib/public-suffix.js';
import { AUTH_BRIDGE_HEADER } from '../lib/auth-transition-bridge.js';
import {
  beginCookieCapture,
  endCookieCapture,
  forgetRequestChain,
  isStaleHopResponse,
  noteRequestHop,
  whenCapturesSettled,
} from './redirect-hop-stale-cookie-guard.js';
import {
  forgetPreAssignmentRequest,
  isPreAssignmentResponse,
  noteNavigationRequest,
} from './pre-assignment-navigations.js';
import { heldRedirectTarget, noteHeldRedirect } from './held-redirects.js';

const MAX_DNR_RULES_PER_TAB = 100;
const DNR_RULE_ID_STRIDE = 1_000_000;

const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
  'webbundle', 'other',
] as chrome.declarativeNetRequest.ResourceType[];


type AuthBridgeRequest = {
  bridgeId: string
  tabId: number
  frameId?: number
  url: string
}

const authBridgeRequests = new Map<string, AuthBridgeRequest>();

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

  // Profile tabs never read or write Chrome's own cookie jar — that jar belongs
  // to the user's normal (no-profile) tabs. Both base strip rules therefore
  // cover every resource type, navigations included: the request-side
  // `Cookie: remove` keeps jar cookies out of this tab, the response-side
  // `set-cookie: remove` keeps this tab's cookies out of the jar. The profile
  // store, published as higher-priority `Cookie: set` rules, is the only cookie
  // source. Redirect hops that outrun a capture are handled by held redirects
  // and the stale-hop guard, not by falling back to the jar.
  const addRules = buildDnrRulesForCookieStore({
    tabId,
    ruleIds,
    boundHost,
    scheme,
    store,
    serializeOpts,
    resourceTypes: ALL_RESOURCE_TYPES,
    firstPartyDomain,
  });

  // Atomic remove+add: Chrome processes the removal before the addition within a
  // single call, so concurrent callers for the same tab can't collide on rule ID.
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds, addRules });
}

// Rules are per tab, but a profile's cookie store is shared by every tab using
// it. After a store change, republish the rules of all those tabs — otherwise a
// sibling tab keeps sending the cookies from before, e.g. a session id the
// server destroyed at login, and the guest cookie it gets back logs the whole
// profile out. Only the tab that caused the change is awaited: its redirect
// chain and auth bridge depend on it, and sibling rebuilds must not lengthen
// that critical path.
export async function updateDNRRulesForProfileTabs(sessionId: string, originTabId: number): Promise<void> {
  for (const [tabId, tabSessionId] of Object.entries(tabSessions)) {
    if (tabSessionId !== sessionId || Number(tabId) === originTabId) continue;
    void updateDNRRulesForTab(Number(tabId), sessionId).catch(() => {});
  }
  await updateDNRRulesForTab(originTabId, sessionId);
}

// Capture Set-Cookie headers for an isolated tab and re-publish the DNR rules.
//
// DNR strips every Set-Cookie of a profile tab from Chrome's jar; this listener
// is the only place those cookies are kept, in the profile store, before the
// tab's rules are republished.
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

  // A cookie-setting redirect in this tab is held by DNR (Location removed);
  // record where it was going before anything awaits.
  const heldTarget = heldRedirectTarget(details);
  if (heldTarget) noteHeldRedirect(tabId, details.frameId, details.requestId, heldTarget);

  // Sent before the tab joined this profile, with Chrome's own jar: the
  // response belongs to the normal account, not to the profile.
  if (isPreAssignmentResponse(details.requestId)) return;

  // A redirect hop that left before the previous hop's capture finished carried
  // stale cookies, so the server answered the wrong session; capturing its
  // cookies would overwrite the fresh ones.
  if (isStaleHopResponse(details.requestId, requestUrl)) return;

  // Registered before the first await so the next hop of this chain, dispatched
  // while the capture is in flight, is recognised as stale.
  beginCookieCapture(details.requestId, tabId, details.type === 'main_frame' || details.type === 'sub_frame');
  try {
    await captureAndPublish(details, sessionId, setCookieHeaders);
  } finally {
    endCookieCapture(details.requestId);
  }
}

async function captureAndPublish(
  details: chrome.webRequest.OnHeadersReceivedDetails,
  sessionId: string,
  setCookieHeaders: chrome.webRequest.HttpHeader[],
): Promise<void> {
  const { tabId, url: requestUrl } = details;
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
  await updateDNRRulesForProfileTabs(sessionId, tabId);
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
  const assigned = Boolean(sessionId) && sessionId !== 'default';
  if (details.type === 'main_frame') {
    noteNavigationRequest(tabId, requestId, details.method, details.timeStamp, assigned);
  }
  if (!assigned) return;

  noteRequestHop(requestId, details.url, tabId);

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
  forgetRequestChain(details.requestId);
  forgetPreAssignmentRequest(details.requestId);
  if (authBridgeRequests.has(details.requestId)) {
    // Release the page only once the whole chain is over and every Set-Cookie
    // it carried (any redirect hop included) is in the store, so the page's
    // document.cookie refresh that precedes the release sees them.
    await whenCapturesSettled(details.requestId);
    await resolveAuthBridgeRequest(details.requestId);
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
