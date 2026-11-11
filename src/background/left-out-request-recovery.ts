// left-out-request-recovery.ts — What happens when a profile tab's request left
// without cookies the profile holds for its site (tab-cookie-rule-coverage.ts
// explains how that comes about and how it is detected).
//
// The request already reached the server as a stranger, so nothing it or the
// rest of its redirect chain sets is kept. Its site is placed first in the
// tab's rules, so the next request to it carries the cookies. When the request
// was the page the user is waiting for, that page is requested again — but only
// when that helps and is still wanted: a GET, of the tab's visible page (not a
// prerender, which shares the tab's id), that is still the tab's latest
// navigation, to a site the rebuilt rules now cover. A POST is never replayed.

import { tabSessions } from './session-manager.js';
import { updateDNRRulesForTab } from './dnr-tab-rule-publisher.js';
import { deferHeldRedirectToReplay } from './held-redirects.js';
import {
  distrustChain,
  forgetRequest,
  hasPublishedRules,
  isDistrustedChain,
  isHopJudged,
  isLatestTopNavigation,
  leftOutSite,
  markHopJudged,
  noteRequestStart,
  noteTopNavigation,
  promoteSite,
  requestStartedAt,
} from './tab-cookie-rule-coverage.js';

/** The fields every webRequest event of a request carries. */
export type RequestDetails = {
  requestId: string
  tabId: number
  frameId: number
  url: string
  type: chrome.webRequest.ResourceType | `${chrome.webRequest.ResourceType}`
  method: string
  documentLifecycle?: string
}

// `tabId:site` -> the publish that places that site first in the tab's rules.
const coveringSites = new Map<string, Promise<void>>();
// tabId -> URL, without fragment, that is being requested again.
const replayTargets = new Map<number, string>();
// Requests that are such a replay.
const replayRequests = new Set<string>();

const withoutFragment = (url: string) => url.split('#')[0];

function isTopNavigation(details: RequestDetails): boolean {
  return details.type === 'main_frame' && details.frameId === 0 && details.documentLifecycle !== 'prerender';
}

/**
 * onBeforeRequest, every request and redirect hop of every tab: Chrome matches
 * the tab's rules at this moment. Listens for all tabs because a restarted
 * worker may not know yet which ones belong to a profile.
 */
export function noteRequestStarted(details: RequestDetails & { timeStamp: number }): void {
  if (details.tabId < 0) return;
  noteRequestStart(details.requestId, details.url, details.timeStamp);
  if (isTopNavigation(details)) {
    noteTopNavigation(details.tabId, details.requestId);
    if (replayTargets.get(details.tabId) === withoutFragment(details.url)) {
      replayTargets.delete(details.tabId);
      replayRequests.add(details.requestId);
    }
  }
  const sessionId = tabSessions[details.tabId];
  if (sessionId && sessionId !== 'default') judgeRequest(details, sessionId);
}

// Decides, once per hop, whether the hop left without the profile's cookies.
// Leaves it undecided while this worker does not know the tab's rules.
function judgeRequest(details: RequestDetails, sessionId: string): void {
  const { requestId, tabId, url } = details;
  if (isHopJudged(requestId, url)) return;
  const site = leftOutSite(tabId, url, requestStartedAt(requestId, url));
  if (site === undefined) return;
  markHopJudged(requestId, url);
  if (site !== null) recoverLeftOutRequest(details, sessionId, site);
}

/**
 * Before a response of a profile tab is captured: makes sure its request has
 * been judged. A request that started before this worker, or before the tab's
 * rules were known to it, is judged here, against the rules that were live
 * when it started.
 */
export async function ensureRequestJudged(details: RequestDetails, sessionId: string): Promise<void> {
  if (isHopJudged(details.requestId, details.url)) return;
  // The publisher logs its own failures; a tab whose rules stay unknown is trusted.
  if (!hasPublishedRules(details.tabId)) await updateDNRRulesForTab(details.tabId, sessionId).catch(() => {});
  judgeRequest(details, sessionId);
}

// Places `site` first in the tab's rules. Returns the publish doing that, or
// null when the site already is first and no publish is under way: the rules
// then cannot serve it any better, and publishing again would only repeat them.
function coverSite(tabId: number, sessionId: string, site: string): Promise<void> | null {
  const key = `${tabId}:${site}`;
  const promoted = promoteSite(tabId, site);
  let covering = coveringSites.get(key);
  if (!covering && promoted) {
    covering = updateDNRRulesForTab(tabId, sessionId)
      .catch((error: unknown) => console.error(`[dnr] covering ${site} for tab ${tabId} failed:`, error))
      .finally(() => coveringSites.delete(key));
    coveringSites.set(key, covering);
  }
  return covering ?? null;
}

function recoverLeftOutRequest(details: RequestDetails, sessionId: string, site: string): void {
  const { requestId, tabId, url } = details;
  const firstBareHop = !isDistrustedChain(requestId);
  distrustChain(requestId);
  const covering = coverSite(tabId, sessionId, site);
  // Only the hop that first went out bare is worth requesting again: later
  // hops exist only because of the answer a stranger got.
  if (!firstBareHop || !isTopNavigation(details) || details.method !== 'GET') return;
  // No publish under way does not mean no replay: the rules may have started
  // covering the site just after this request left (replayNavigation checks).
  const replayed = (covering ?? Promise.resolve())
    .then(() => replayNavigation(tabId, requestId, url))
    .catch((error: unknown) => {
      console.error(`[dnr] requesting ${site} again for tab ${tabId} failed:`, error);
      return false;
    });
  deferHeldRedirectToReplay(tabId, details.frameId, requestId, replayed);
}

// Requests the bare URL itself again, never "whatever the tab shows now": that
// may be a redirect target chosen for a stranger. Resolves to whether it did.
async function replayNavigation(tabId: number, requestId: string, url: string): Promise<boolean> {
  // The user has gone elsewhere meanwhile, or even first place in the rules
  // could not fit the site's cookies: a replay would be unwanted, or bare again.
  if (!isLatestTopNavigation(tabId, requestId) || leftOutSite(tabId, url, Date.now()) !== null) return false;
  const tab = await chrome.tabs.get(tabId);
  // Request URLs carry no fragment; the navigation still pending does.
  const target = tab.pendingUrl && withoutFragment(tab.pendingUrl) === withoutFragment(url) ? tab.pendingUrl : url;
  replayTargets.set(tabId, withoutFragment(url));
  try {
    await chrome.tabs.update(tabId, { url: target });
  } catch (error) {
    replayTargets.delete(tabId);
    throw error;
  }
  return true;
}

/**
 * webNavigation.onBeforeNavigate, top frame of a profile tab: when the tab's
 * rules leave the target site out, rebuild them with that site first. When
 * this does not beat the request, the request is caught as left out and
 * requested again.
 */
export async function refreshRulesBeforeNavigation(tabId: number, url: string): Promise<void> {
  const sessionId = tabSessions[tabId];
  if (!sessionId || sessionId === 'default' || !/^https?:/.test(url)) return;
  if (!hasPublishedRules(tabId)) {
    await updateDNRRulesForTab(tabId, sessionId, url);
    return;
  }
  const site = leftOutSite(tabId, url, Date.now());
  if (site) await coverSite(tabId, sessionId, site);
}

/** onCompleted / onErrorOccurred: the request chain is over. */
export function noteRequestFinished(details: { requestId: string; tabId: number; fromCache?: boolean }): void {
  // A replay answered from the disk cache shows the response fetched without
  // cookies: fetch it once more, past the cache.
  if (replayRequests.delete(details.requestId) && details.fromCache) {
    chrome.tabs.reload(details.tabId, { bypassCache: true }).catch(() => {});
  }
  forgetRequest(details.requestId);
}
