// tab-cookie-rule-coverage.ts — Which of a profile's cookies each tab's
// published rules actually deliver, and which requests left without them.
//
// A profile is a global jar: its store holds cookies for every site it ever
// visited, third-party trackers included, and session cookies never expire.
// A tab only gets a fixed number of rules (dnr-tab-rule-publisher.ts), so a
// well-used profile cannot publish every scope to every tab. The tab's own
// sites are published first; the rest are left out and recovered on demand.
//
// "Left out" is not harmless. The base strip still removes the Cookie header,
// so a request to a left-out site reaches the server with no cookies at all.
// A session-starting server answers it as a guest, and capturing that guest
// Set-Cookie would overwrite the login the profile holds for the site. So the
// response to such a request is never captured, and neither is any later hop
// of its redirect chain: each follows from an answer given to a stranger
// (WordPress redirects a stranger to a login URL that clears the auth cookies
// of whoever arrives there). The site is promoted to the tab's priority sites
// and the rules are rebuilt; dnr-manager.ts drives that.
//
// Chrome matches a request against the rules once, when the request starts
// (onBeforeRequest), and the update that publishes a rule set takes time to
// reach Chrome. A request is therefore judged by its start time against every
// rule set that may have been the live one at that moment, never by the order
// in which its events reach the service worker.

import { cookieMatchesRequest } from '../lib/cookie-parser.js';
import { getEtld1 } from '../lib/public-suffix.js';
import type { CookieRuleCoverage } from './dnr-cookie-rule-builder.js';

// Sites a tab reached that its rules had left out, most recent first. The rule
// budget, not this bound, decides how many of them get rules.
const MAX_PROMOTED_SITES = 100;
const PROMOTED_SITES_KEY = 'tabPromotedSites';
// Rule sets remembered per tab: enough to cover the publishes that can overlap
// one request's start.
const MAX_RULE_SETS = 8;

export type PublishedRules = CookieRuleCoverage & {
  /** When the update was handed to Chrome, epoch ms. */
  sentAt: number
  /** When Chrome confirmed it; null while the update is still in flight. */
  liveAt: number | null
}

// Per tab, oldest first.
const ruleSets = new Map<number, PublishedRules[]>();
// Persisted to chrome.storage.session: the service worker restarts often, and a
// tab that forgot its promoted sites would send their next request bare again.
const promotedSites = new Map<number, string[]>();
// Where a tab the extension just opened is about to go, known before Chrome
// reports it as the tab's URL.
const navigationTargets = new Map<number, string>();
// requestId -> where and when the latest hop of that request started.
const requestStarts = new Map<string, { url: string; at: number }>();
// requestId -> URL of the latest hop that has been judged.
const judgedHops = new Map<string, string>();
// Request chains with a hop that left without the profile's cookies.
const distrustedChains = new Set<string>();
// tabId -> the request of the tab's latest top-level navigation.
const latestNavigations = new Map<number, string>();

function parseWebUrl(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
  } catch {
    return null;
  }
}

/** The site (eTLD+1) of an http(s) URL, or null for anything else. */
export function siteOfUrl(url: string | undefined): string | null {
  const parsed = parseWebUrl(url);
  return parsed ? getEtld1(parsed.hostname) : null;
}

const leavesNothingOut = (rules: PublishedRules) =>
  rules.droppedHostPaths.size === 0 && rules.droppedDomainPaths.size === 0 && rules.defaultPortOnlyHosts.size === 0;

function leavesCookiesBehind(rules: PublishedRules, url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const matchesAny = (paths: string[] | undefined, domain: string) =>
    (paths ?? []).some((path) => cookieMatchesRequest({ value: '', domain, path }, url.href));

  // A host with its own host-scoped rules never falls back to a domain rule
  // for its host cookies: each of its rules already carries the matching
  // Domain= cookies.
  if (rules.scopedHosts.has(host)) {
    if (url.port && rules.defaultPortOnlyHosts.has(host)) return true;
    return matchesAny(rules.droppedHostPaths.get(host), host);
  }
  for (let domain = host; ; domain = domain.slice(domain.indexOf('.') + 1)) {
    if (matchesAny(rules.droppedDomainPaths.get(domain), '.' + domain)) return true;
    if (!domain.includes('.')) return false;
  }
}

// Every rule set that may have been the live one at `at`: the last one Chrome
// had confirmed by then, and any whose update was in flight at that moment.
function ruleSetsPossiblyLiveAt(sets: PublishedRules[], at: number): PublishedRules[] {
  let confirmed: PublishedRules | null = null;
  const inFlight: PublishedRules[] = [];
  for (const rules of sets) {
    if (rules.liveAt !== null && rules.liveAt <= at) confirmed = rules;
    else if (rules.sentAt <= at) inFlight.push(rules);
  }
  // Older than everything remembered: the oldest known set is the best guess.
  return [confirmed ?? sets[0], ...inFlight];
}

/** True once this worker knows what the tab's rules cover. */
export function hasPublishedRules(tabId: number): boolean {
  return ruleSets.has(tabId);
}

/** A rule set is being handed to Chrome for the tab. Confirm or discard it once Chrome answers. */
export function beginRuleSet(tabId: number, coverage: CookieRuleCoverage): PublishedRules {
  const rules: PublishedRules = { ...coverage, sentAt: Date.now(), liveAt: null };
  ruleSets.set(tabId, [...(ruleSets.get(tabId) ?? []), rules].slice(-MAX_RULE_SETS));
  return rules;
}

export function confirmRuleSet(rules: PublishedRules): void {
  rules.liveAt = Date.now();
}

/** Chrome refused the update: the set never went live. */
export function discardRuleSet(tabId: number, rules: PublishedRules): void {
  const sets = ruleSets.get(tabId);
  if (sets) ruleSets.set(tabId, sets.filter((other) => other !== rules));
}

/**
 * A restarted worker has forgotten which rules are live in Chrome. `coverage`
 * is what they must cover: it stands for everything published before this
 * worker's first publish.
 */
export function recordAssumedRuleSet(tabId: number, coverage: CookieRuleCoverage): void {
  if (!ruleSets.has(tabId)) ruleSets.set(tabId, [{ ...coverage, sentAt: 0, liveAt: 0 }]);
}

/**
 * The site of a request, started at `at`, that the tab's rules may have sent
 * without cookies the profile holds for it. null when every rule set that could
 * have been live covers it; undefined when this worker does not know the tab's
 * rules.
 */
export function leftOutSite(tabId: number, url: string, at: number): string | null | undefined {
  const sets = ruleSets.get(tabId);
  if (!sets || sets.length === 0) return undefined;
  const candidates = ruleSetsPossiblyLiveAt(sets, at).filter((rules) => !leavesNothingOut(rules));
  if (candidates.length === 0) return null;
  const parsed = parseWebUrl(url);
  if (!parsed) return null;
  return candidates.some((rules) => leavesCookiesBehind(rules, parsed)) ? getEtld1(parsed.hostname) : null;
}

/** onBeforeRequest, every request and every redirect hop: Chrome matches the rules now. */
export function noteRequestStart(requestId: string, url: string, at: number): void {
  requestStarts.set(requestId, { url, at });
}

/** When this hop started; 0 when it started before this worker was listening. */
export function requestStartedAt(requestId: string, url: string): number {
  const start = requestStarts.get(requestId);
  return start?.url === url ? start.at : 0;
}

export function markHopJudged(requestId: string, url: string): void {
  judgedHops.set(requestId, url);
}

export function isHopJudged(requestId: string, url: string): boolean {
  return judgedHops.get(requestId) === url;
}

/** A hop of this chain left without the profile's cookies: no response of the chain is captured. */
export function distrustChain(requestId: string): void {
  distrustedChains.add(requestId);
}

export function isDistrustedChain(requestId: string): boolean {
  return distrustedChains.has(requestId);
}

/** onCompleted / onErrorOccurred: the chain is over, drop its state. */
export function forgetRequest(requestId: string): void {
  requestStarts.delete(requestId);
  judgedHops.delete(requestId);
  distrustedChains.delete(requestId);
}

/** A top-level navigation of the tab's visible page started. */
export function noteTopNavigation(tabId: number, requestId: string): void {
  latestNavigations.set(tabId, requestId);
}

/** False once the tab has started another top-level navigation. */
export function isLatestTopNavigation(tabId: number, requestId: string): boolean {
  return latestNavigations.get(tabId) === requestId;
}

/**
 * The tab reached `site` while its rules left it out: place it first from now
 * on. Returns false when it already was first, i.e. the rules cannot serve it
 * any better than they do.
 */
export function promoteSite(tabId: number, site: string): boolean {
  const current = promotedSites.get(tabId) ?? [];
  if (current[0] === site) return false;
  promotedSites.set(tabId, [site, ...current.filter((other) => other !== site)].slice(0, MAX_PROMOTED_SITES));
  persistPromotedSites();
  return true;
}

/** The tab is about to navigate to `url` (not yet visible as the tab's URL). */
export function rememberNavigationTarget(tabId: number, url: string): void {
  navigationTargets.set(tabId, url);
}

export function navigationTargetOf(tabId: number): string | undefined {
  return navigationTargets.get(tabId);
}

/** The tab has committed a page of its own: the target has done its job. */
export function clearNavigationTarget(tabId: number): void {
  navigationTargets.delete(tabId);
}

/**
 * Sites whose scopes the tab's rules must place first: the sites of the given
 * URLs (where the tab is and where it is going), then the promoted sites.
 */
export function prioritySitesForTab(tabId: number, urls: Array<string | undefined>): string[] {
  const sites = urls.map(siteOfUrl).filter((site): site is string => site !== null);
  return [...new Set([...sites, ...(promotedSites.get(tabId) ?? [])])];
}

/** The tab closed or left its profile: a tab id may be reused. */
export function forgetTabRuleCoverage(tabId: number): void {
  ruleSets.delete(tabId);
  navigationTargets.delete(tabId);
  latestNavigations.delete(tabId);
  if (promotedSites.delete(tabId)) persistPromotedSites();
}

function persistPromotedSites(): void {
  chrome.storage.session.set({ [PROMOTED_SITES_KEY]: Object.fromEntries(promotedSites) })
    .catch((e: unknown) => console.warn('[dnr] persisting promoted sites failed:', e));
}

/** Service worker start: reload the promoted sites of the tabs still open. */
export async function restorePromotedSites(): Promise<void> {
  try {
    const result = await chrome.storage.session.get([PROMOTED_SITES_KEY]);
    const stored = (result[PROMOTED_SITES_KEY] ?? {}) as Record<string, string[]>;
    for (const [tabId, sites] of Object.entries(stored)) {
      // A promotion made while this read was in flight is newer: keep it.
      if (!promotedSites.has(Number(tabId)) && Array.isArray(sites)) promotedSites.set(Number(tabId), sites);
    }
  } catch (e) {
    console.warn('[dnr] restoring promoted sites failed:', e);
  }
}
