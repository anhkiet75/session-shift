// dnr-manager.ts — webRequest listeners of profile tabs: Set-Cookie capture and
// the guards that keep a response answered with the wrong cookies out of the store.

import { getCookieStore, setCookieStore } from '../lib/session-store.js';
import { parseSetCookie, cookieKey } from '../lib/cookie-parser.js';
import { tabSessions } from './session-manager.js';
import { withCookieLock } from '../lib/cookie-write-lock.js';
import { AUTH_BRIDGE_HEADER } from '../lib/auth-transition-bridge.js';
import { updateDNRRulesForTab, updateDNRRulesForProfileTabs } from './dnr-tab-rule-publisher.js';
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
import { isDistrustedChain } from './tab-cookie-rule-coverage.js';
import { ensureRequestJudged, noteRequestFinished, noteRequestStarted } from './left-out-request-recovery.js';

type AuthBridgeRequest = {
  bridgeId: string
  tabId: number
  frameId?: number
  url: string
}

const authBridgeRequests = new Map<string, AuthBridgeRequest>();

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

  // A hop of this chain left without the cookies the profile holds for its
  // site (the tab's rules left the site out): the server answered a stranger,
  // and its guest cookies would overwrite the profile's login.
  if (isDistrustedChain(details.requestId)) return;

  // A redirect hop that left before the previous hop's capture finished carried
  // stale cookies, so the server answered the wrong session; capturing its
  // cookies would overwrite the fresh ones.
  if (isStaleHopResponse(details.requestId, requestUrl)) return;

  // Registered before the first await so the next hop of this chain, dispatched
  // while the capture is in flight, is recognised as stale.
  beginCookieCapture(details.requestId, tabId, details.type === 'main_frame' || details.type === 'sub_frame');
  try {
    // Normally judged when it started. A request that started before this
    // worker did, or before the worker knew the tab's rules, is judged now.
    await ensureRequestJudged(details, sessionId);
    if (isDistrustedChain(details.requestId)) return;
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
  // Only once every capture of the chain is done: a capture still running may
  // be about to judge the request, and would re-create the state dropped here.
  await whenCapturesSettled(details.requestId);
  noteRequestFinished(details);
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
  chrome.webRequest.onBeforeRequest.addListener(
    (details): undefined => {
      noteRequestStarted(details);
    },
    { urls: ['<all_urls>'] }
  );
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details): undefined => {
      handleBeforeSendHeaders(details);
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders', 'extraHeaders']
  );
  chrome.webRequest.onHeadersReceived.addListener(
    (details): undefined => {
      // A failed capture or rule publish must never pass silently: the tab
      // would keep sending the cookies from before.
      void handleHeadersReceived(details).catch((error: unknown) =>
        console.error(`[dnr] capturing cookies for tab ${details.tabId} failed:`, error));
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
