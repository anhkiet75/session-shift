import { serializeCookieHeader, type SerializeOptions } from '../lib/cookie-parser.js';
import type { CookieStoreEntry } from '../lib/session-store.js';
import type { DNRRule } from '../lib/types.js';
import { getEtld1 } from '../lib/public-suffix.js';
import { buildCookieRuleScopes, UNRANKED, type CookieRuleScope } from './dnr-cookie-rule-scopes.js';

/**
 * Server-Timing entry DNR appends to a held redirect, so the content script can
 * tell it apart from a genuine 3xx document synchronously (content.ts mirrors it).
 */
export const HELD_REDIRECT_MARKER = 'sessionshift-held';

type BuildRuleOptions = {
  tabId: number
  ruleIds: number[]
  boundHost: string | null
  scheme: 'https' | 'http' | null
  store: Record<string, CookieStoreEntry>
  serializeOpts: SerializeOptions
  resourceTypes: chrome.declarativeNetRequest.ResourceType[]
  firstPartyDomain?: string | null
  requestStripResourceTypes?: chrome.declarativeNetRequest.ResourceType[]
  responseStripResourceTypes?: chrome.declarativeNetRequest.ResourceType[]
  /** Sites (eTLD+1) the tab needs most, most important first. Their scopes get rules before any other. */
  prioritySites?: string[]
  /** How many exact-host rules may use a regex (Chrome caps regex rules per extension). Default: no cap. */
  regexRuleBudget?: number
  /** Publish only the priority sites' scopes: the smallest rule set that keeps the tab's own sites working. */
  prioritySitesOnly?: boolean
}

/**
 * What the built rules leave out. A request the store holds cookies for but no
 * rule covers is sent without them (the base strip still removes the header),
 * so the caller must know which requests those are.
 */
export type CookieRuleCoverage = {
  /** Exact hosts with host-scoped cookies. Domain scopes never apply to these: their host rules win. */
  scopedHosts: Set<string>
  /** Cookie paths per exact host that got no rule. */
  droppedHostPaths: Map<string, string[]>
  /** Cookie paths per Domain= domain that got no rule. */
  droppedDomainPaths: Map<string, string[]>
  /** Exact hosts whose rules only match the scheme's default port. */
  defaultPortOnlyHosts: Set<string>
}

export type CookieRuleSet = { rules: DNRRule[]; coverage: CookieRuleCoverage }

function pathFilterSuffix(path: string): string {
  if (path === '/') return '/';
  return path.endsWith('/') ? path : `${path}^`;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

// Exact host on any port. Only a regex can say "optional port" without also
// matching a URL whose userinfo is the host (`https://host:x@other/`).
function exactHostRegexFilter(scheme: 'https' | 'http', host: string, path: string): string {
  const hostPattern = escapeRegex(host);
  if (path === '/') return `^${scheme}://${hostPattern}(?::[0-9]+)?/`;
  const pathPattern = escapeRegex(path);
  return `^${scheme}://${hostPattern}(?::[0-9]+)?${pathPattern}(?:[/?#]|$)`;
}

// Exact host on the scheme's default port, without a regex. Chrome allows an
// extension 1000 regex session rules in total, across every tab.
function exactHostUrlFilter(scheme: 'https' | 'http', host: string, path: string): string {
  return `|${scheme}://${host}${pathFilterSuffix(path)}`;
}

function domainUrlFilter(scheme: 'https' | 'http', path: string): string {
  if (path === '/') return `|${scheme}://`;
  return `|${scheme}://*${pathFilterSuffix(path)}`;
}

// Bound-host-scoped condition: matches only requests to the session's eTLD+1.
function boundHostCondition(
  boundHost: string,
  scheme: 'https' | 'http' | null,
  resourceTypes: chrome.declarativeNetRequest.ResourceType[]
): chrome.declarativeNetRequest.RuleCondition {
  if (scheme) {
    return { urlFilter: `|${scheme}://`, requestDomains: [getEtld1(boundHost)], resourceTypes };
  }
  return { requestDomains: [getEtld1(boundHost)], resourceTypes };
}

// Request-side `Cookie: remove` condition.
// For global profiles this is tab-scoped, all schemes, no requestDomains. An
// http/ws subresource in an https-bound tab must also be stripped or the default
// jar leaks.
function buildRequestStripCondition(
  boundHost: string | null,
  scheme: 'https' | 'http' | null,
  resourceTypes: chrome.declarativeNetRequest.ResourceType[],
  firstPartyDomain: string | null | undefined
): chrome.declarativeNetRequest.RuleCondition {
  if (!boundHost) {
    void firstPartyDomain;
    return { resourceTypes };
  }
  return boundHostCondition(boundHost, scheme, resourceTypes);
}

// Response-side `set-cookie: remove` condition. The caller controls resource
// types because top-level navigation redirects need Chrome's jar write to happen
// before the redirected request is sent.
function buildResponseStripCondition(
  boundHost: string | null,
  scheme: 'https' | 'http' | null,
  resourceTypes: chrome.declarativeNetRequest.ResourceType[]
): chrome.declarativeNetRequest.RuleCondition {
  if (!boundHost) {
    return { resourceTypes };
  }
  return boundHostCondition(boundHost, scheme, resourceTypes);
}

function buildCookieCondition(
  scope: CookieRuleScope,
  scheme: 'https' | 'http' | null,
  resourceTypes: chrome.declarativeNetRequest.ResourceType[],
  anyPort: boolean,
): chrome.declarativeNetRequest.RuleCondition {
  if (scheme && scope.type === 'host') {
    return anyPort
      ? { regexFilter: exactHostRegexFilter(scheme, scope.host, scope.path), resourceTypes }
      : { urlFilter: exactHostUrlFilter(scheme, scope.host, scope.path), resourceTypes };
  }
  if (scheme) {
    return {
      urlFilter: domainUrlFilter(scheme, scope.path),
      requestDomains: [scope.host],
      resourceTypes,
    };
  }
  return { requestDomains: [scope.host], resourceTypes };
}

function addDroppedPath(paths: Map<string, string[]>, host: string, path: string): void {
  paths.set(host, [...(paths.get(host) ?? []), path]);
}

export function buildDnrRulesForCookieStore(options: BuildRuleOptions): CookieRuleSet {
  // Request and response strips are separate rules so each side can scope its
  // resource types independently. Both default to every type the tab uses,
  // navigations included: the tab's cookies come only from the `Cookie: set`
  // rules below, never from Chrome's shared jar, and never land in it.
  const requestStripResourceTypes = options.requestStripResourceTypes ?? options.resourceTypes;
  const requestCondition = buildRequestStripCondition(
    options.boundHost, options.scheme, requestStripResourceTypes, options.firstPartyDomain);
  requestCondition.tabIds = [options.tabId];
  const strictResponseResourceTypes = options.responseStripResourceTypes ?? options.resourceTypes;

  const addRules: DNRRule[] = [
    {
      id: options.ruleIds[0],
      priority: 100,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'remove' }] },
      condition: requestCondition,
    },
  ];

  if (strictResponseResourceTypes.length > 0) {
    const responseCondition = buildResponseStripCondition(
      options.boundHost, options.scheme, strictResponseResourceTypes);
    responseCondition.tabIds = [options.tabId];
    addRules.push({
      id: options.ruleIds[addRules.length],
      priority: 100,
      action: { type: 'modifyHeaders', responseHeaders: [{ header: 'set-cookie', operation: 'remove' }] },
      condition: responseCondition,
    });
  }

  // Held redirects: a navigation response that sets cookies loses its Location,
  // so Chrome commits it instead of following it before those cookies are
  // captured; SessionShift finishes the hop (see held-redirects.ts). The
  // Server-Timing marker lets the content script stop only held documents.
  // `responseHeaders` conditions need Chrome 128 (manifest minimum).
  addRules.push({
    id: options.ruleIds[addRules.length],
    priority: 100,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'location', operation: 'remove' },
        { header: 'server-timing', operation: 'append', value: HELD_REDIRECT_MARKER },
      ],
    },
    condition: {
      tabIds: [options.tabId],
      resourceTypes: ['main_frame', 'sub_frame'],
      responseHeaders: [{ header: 'set-cookie' }],
    },
  });

  const coverage: CookieRuleCoverage = {
    scopedHosts: new Set(),
    droppedHostPaths: new Map(),
    droppedDomainPaths: new Map(),
    defaultPortOnlyHosts: new Set(),
  };
  const scopes = buildCookieRuleScopes(
    options.store, options.boundHost, options.serializeOpts, options.prioritySites ?? []);
  let regexRulesLeft = options.regexRuleBudget ?? Infinity;
  let droppedPriorityScopes = 0;
  // A Domain= rule matches every host under its domain, so it may carry only
  // cookies that were set for the whole domain. The domain's own host-only
  // cookies belong in that host's rules alone.
  const domainCookies = Object.fromEntries(
    Object.entries(options.store).filter(([, entry]) => entry.domain?.startsWith('.')));

  for (const scope of scopes) {
    if (scope.type === 'host') coverage.scopedHosts.add(scope.host);
    const prioritised = scope.rank !== UNRANKED;
    if (addRules.length >= options.ruleIds.length || (options.prioritySitesOnly && !prioritised)) {
      addDroppedPath(
        scope.type === 'host' ? coverage.droppedHostPaths : coverage.droppedDomainPaths, scope.host, scope.path);
      if (prioritised) droppedPriorityScopes++;
      continue;
    }
    const requestScheme = options.scheme ?? 'https';
    const requestUrl = `${requestScheme}://${scope.host}${scope.path}`;
    const cookieStr = serializeCookieHeader(
      scope.type === 'domain' ? domainCookies : options.store, { ...options.serializeOpts, requestUrl });
    if (!cookieStr) continue;
    const needsExactHost = Boolean(options.scheme) && scope.type === 'host';
    const anyPort = needsExactHost && regexRulesLeft > 0;
    if (anyPort) regexRulesLeft--;
    else if (needsExactHost) coverage.defaultPortOnlyHosts.add(scope.host);
    const condition = buildCookieCondition(scope, options.scheme, options.resourceTypes, anyPort);
    condition.tabIds = [options.tabId];
    addRules.push({
      id: options.ruleIds[addRules.length],
      priority: 100 + scope.path.length * 2 + (scope.type === 'host' ? 1 : 0),
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Cookie', operation: 'set', value: cookieStr }],
      },
      condition,
    });
  }

  // Scopes of other sites are expected to be left out of a well-used profile
  // and are recovered on demand (tab-cookie-rule-coverage.ts). Losing a scope of
  // a site the tab is on is a real loss: surface it.
  if (droppedPriorityScopes > 0) {
    console.warn(
      `[dnr] rule budget (${options.ruleIds.length}) exhausted for tab ${options.tabId}; ` +
      `${droppedPriorityScopes} cookie scope(s) of the tab's own sites dropped`,
    );
  }

  return { rules: addRules, coverage };
}
