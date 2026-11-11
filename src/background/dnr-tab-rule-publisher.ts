// dnr-tab-rule-publisher.ts — Builds and publishes one tab's DNR session rules.

import { getCookieStore } from '../lib/session-store.js';
import type { SerializeOptions } from '../lib/cookie-parser.js';
import { tabSessions } from './session-manager.js';
import { buildDnrRulesForCookieStore } from './dnr-cookie-rule-builder.js';
import {
  beginRuleSet,
  clearNavigationTarget,
  confirmRuleSet,
  discardRuleSet,
  forgetTabRuleCoverage,
  hasPublishedRules,
  navigationTargetOf,
  prioritySitesForTab,
  recordAssumedRuleSet,
  rememberNavigationTarget,
  siteOfUrl,
} from './tab-cookie-rule-coverage.js';

// Chrome allows an extension 5000 session rules and 1000 regex session rules,
// shared by every tab. 100 rules and 20 regex rules per tab reach both limits
// at the same 50 profile tabs, so neither is hit first.
const MAX_DNR_RULES_PER_TAB = 100;
const MAX_REGEX_RULES_PER_TAB = 20;
const DNR_RULE_ID_STRIDE = 1_000_000;

const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
  'webbundle', 'other',
] as chrome.declarativeNetRequest.ResourceType[];

type Scheme = 'https' | 'http';

// Publishes of one tab overlap: every Set-Cookie capture of a profile
// republishes all its tabs, and none of them may wait for another (a capture
// holds its tab's redirect chain until its own publish is live). What must not
// happen is an older publish reaching Chrome after a newer one and putting the
// older store's rules back. Each publish therefore takes a number when it is
// requested; a later request always reads a store at least as new, so a publish
// that finds a later one already sent to Chrome sends nothing and waits for it.
type TabPublishes = { requested: number; sent: number; live: Promise<void> };
const tabPublishes = new Map<number, TabPublishes>();

export function dnrRuleId(tabId: number): number {
  return (tabId % 1000000) + 1;
}

export function dnrRuleIdsForTab(tabId: number): number[] {
  const baseId = dnrRuleId(tabId);
  return Array.from({ length: MAX_DNR_RULES_PER_TAB }, (_, index) => baseId + index * DNR_RULE_ID_STRIDE);
}

function schemeOf(url: string | undefined): Scheme | null {
  if (url?.startsWith('https:')) return 'https';
  return url?.startsWith('http:') ? 'http' : null;
}

/**
 * Publish the tab's rules for `sessionId` (or remove them for the default
 * session). `navigationUrl` is where the tab is about to go when the caller
 * knows it before Chrome does. Resolves once rules at least as new as the
 * caller's store are live; rejects, after logging, when Chrome refused every
 * rule set and the tab keeps its old rules.
 */
export async function updateDNRRulesForTab(tabId: number, sessionId: string, navigationUrl?: string): Promise<void> {
  const publishes = tabPublishes.get(tabId) ?? { requested: 0, sent: 0, live: Promise.resolve() };
  tabPublishes.set(tabId, publishes);
  const request = ++publishes.requested;
  // Hands `send` to Chrome unless a later request already got there; then that
  // request's rules stand, and this one waits for them instead.
  const sendUnlessSuperseded = (send: () => Promise<void>): Promise<void> => {
    if (request < publishes.sent) return publishes.live;
    publishes.sent = request;
    publishes.live = send();
    return publishes.live;
  };
  const ruleIds = dnrRuleIdsForTab(tabId);

  if (!sessionId || sessionId === 'default') {
    return sendUnlessSuperseded(async () => {
      forgetTabRuleCoverage(tabId);
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds, addRules: [] });
      // The tab is closed or back on the default session: nothing left to order.
      if (publishes.requested === request) tabPublishes.delete(tabId);
    });
  }

  let tab: chrome.tabs.Tab | null = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    // The tab is gone. Rules for it would only use up the budget every tab shares.
    return;
  }

  // Profiles span all sites, so there is no bound host. Scheme comes from the
  // current tab URL — a profile has no single origin, and using the live scheme
  // keeps Secure cookies out of plaintext http requests. A tab the extension
  // just opened is still on about:blank; its scheme is that of the URL it was
  // opened for, so its very first request already carries Secure cookies.
  const boundHost = null;
  if (navigationUrl) rememberNavigationTarget(tabId, navigationUrl);
  const committedScheme = schemeOf(tab?.url);
  if (committedScheme) clearNavigationTarget(tabId);
  const navigationTarget = navigationTargetOf(tabId);
  const scheme = committedScheme ?? schemeOf(navigationTarget);

  // Fail closed on Secure cookies: only an explicitly-https tab gets them. http
  // must never carry Secure cookies in plaintext, and an unresolved scheme (tab
  // gone / chrome:// / tabs.get threw) is treated as not-https for safety.
  const serializeOpts: SerializeOptions = scheme === 'https' ? {} : { excludeSecure: true };
  const store = await getCookieStore(sessionId);
  // A later request is already in Chrome: nothing to build, and no coverage to
  // record for a tab that may have closed meanwhile.
  if (request < publishes.sent) return publishes.live;

  // Profile tabs never read or write Chrome's own cookie jar — that jar belongs
  // to the user's normal (no-profile) tabs. Both base strip rules therefore
  // cover every resource type, navigations included: the request-side
  // `Cookie: remove` keeps jar cookies out of this tab, the response-side
  // `set-cookie: remove` keeps this tab's cookies out of the jar. The profile
  // store, published as higher-priority `Cookie: set` rules, is the only cookie
  // source. Redirect hops that outrun a capture are handled by held redirects
  // and the stale-hop guard, not by falling back to the jar.
  const build = (prioritySites: string[], limits: { regexRuleBudget: number; prioritySitesOnly?: boolean }) =>
    buildDnrRulesForCookieStore({
      tabId,
      ruleIds,
      boundHost,
      scheme,
      store,
      serializeOpts,
      resourceTypes: ALL_RESOURCE_TYPES,
      firstPartyDomain: siteOfUrl(tab?.url),
      prioritySites,
      ...limits,
    });

  // The store rarely fits the tab's rule budget, so the sites the tab is on or
  // heading to are placed first (tab-cookie-rule-coverage.ts).
  const prioritySites = prioritySitesForTab(tabId, [navigationUrl, tab?.pendingUrl, tab?.url, navigationTarget]);

  if (!hasPublishedRules(tabId)) {
    // A restarted worker has forgotten what the rules still live in Chrome
    // cover. They were built from this store for the page the tab is on, so
    // rebuild that picture: requests that started before the publish below are
    // judged by it.
    const live = build(prioritySitesForTab(tabId, [tab?.url]), { regexRuleBudget: MAX_REGEX_RULES_PER_TAB });
    recordAssumedRuleSet(tabId, live.coverage);
  }

  // Chrome's rule limits are shared by every tab, and a rejected update changes
  // nothing: the tab would keep sending the cookies from before. So a refused
  // full set is retried as the smallest useful one — the priority sites only,
  // without regex rules.
  const attempts = [
    { regexRuleBudget: MAX_REGEX_RULES_PER_TAB },
    { regexRuleBudget: 0, prioritySitesOnly: true },
  ];
  return sendUnlessSuperseded(async () => {
    let failure: unknown;
    for (const limits of attempts) {
      // A later request reached Chrome while this one was being refused.
      if (request < publishes.sent) return publishes.live;
      const { rules, coverage } = build(prioritySites, limits);
      const ruleSet = beginRuleSet(tabId, coverage);
      try {
        // Atomic remove+add: Chrome processes the removal before the addition
        // within a single call, so the tab is never left without its strip rules.
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds, addRules: rules });
        confirmRuleSet(ruleSet);
        return;
      } catch (error) {
        discardRuleSet(tabId, ruleSet);
        failure = error;
        console.error(`[dnr] Chrome refused ${rules.length} rule(s) for tab ${tabId}:`, error);
      }
    }
    console.error(`[dnr] tab ${tabId} keeps its previous rules: no rule set was accepted`);
    throw failure;
  });
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
