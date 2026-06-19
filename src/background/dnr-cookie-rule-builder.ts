import { serializeCookieHeader, normalizeCookiePath, type SerializeOptions } from '../lib/cookie-parser.js';
import type { CookieStoreEntry } from '../lib/session-store.js';
import type { DNRRule } from '../lib/types.js';
import { getEtld1 } from '../lib/public-suffix.js';

type CookieRuleScope = {
  type: 'host' | 'domain'
  host: string
  path: string
}

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
  bridgeNavigationUrl?: string | null
}

function normalizeStoredDomain(domain: string | null | undefined, boundHost: string | null): string | null {
  return (domain ?? boundHost)?.replace(/\.$/, '').toLowerCase() ?? null;
}

function pathFilterSuffix(path: string): string {
  if (path === '/') return '/';
  return path.endsWith('/') ? path : `${path}^`;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function exactHostRegexFilter(scheme: 'https' | 'http', host: string, path: string): string {
  const hostPattern = escapeRegex(host);
  if (path === '/') return `^${scheme}://${hostPattern}(?::[0-9]+)?/`;
  const pathPattern = escapeRegex(path);
  return `^${scheme}://${hostPattern}(?::[0-9]+)?${pathPattern}(?:[/?#]|$)`;
}

function domainUrlFilter(scheme: 'https' | 'http', path: string): string {
  if (path === '/') return `|${scheme}://`;
  return `|${scheme}://*${pathFilterSuffix(path)}`;
}

function addPath(pathsByHost: Map<string, Set<string>>, host: string, path: string): void {
  pathsByHost.set(host, (pathsByHost.get(host) ?? new Set()).add(path));
}

function buildCookieRuleScopes(store: Record<string, CookieStoreEntry>, boundHost: string | null): CookieRuleScope[] {
  const exactHosts = new Set<string>();
  const pathsByHost = new Map<string, Set<string>>();
  const pathsByDomain = new Map<string, Set<string>>();

  if (boundHost) exactHosts.add(boundHost.toLowerCase());

  for (const entry of Object.values(store)) {
    const domain = normalizeStoredDomain(entry.domain, boundHost);
    if (!domain) continue;
    const path = normalizeCookiePath(entry.path);
    const domainWithoutDot = domain.replace(/^\./, '');

    if (domain.startsWith('.')) {
      addPath(pathsByDomain, domainWithoutDot, path);
      for (const host of exactHosts) {
        if (host === domainWithoutDot || host.endsWith('.' + domainWithoutDot)) addPath(pathsByHost, host, path);
      }
    } else {
      exactHosts.add(domain);
      addPath(pathsByHost, domain, path);
    }
  }

  for (const host of exactHosts) {
    for (const [domain, paths] of pathsByDomain) {
      if (host === domain || host.endsWith('.' + domain)) {
        for (const path of paths) addPath(pathsByHost, host, path);
      }
    }
  }

  const scopes: CookieRuleScope[] = [];
  for (const [host, paths] of pathsByHost) {
    for (const path of paths) scopes.push({ type: 'host', host, path });
  }
  for (const [host, paths] of pathsByDomain) {
    for (const path of paths) scopes.push({ type: 'domain', host, path });
  }
  // Shortest paths first: when the rule budget is exhausted, deeper-path scopes
  // are dropped before root scopes. A dropped deep-path scope still matches its
  // shorter-path rule (minus path-specific cookies); a dropped root scope would
  // leave root requests with no Cookie header at all. Rule matching uses
  // per-rule priority, not this order, so selection order is safe to change.
  return scopes.sort((left, right) =>
    left.path.length - right.path.length ||
    (left.type === right.type ? left.host.localeCompare(right.host) : left.type === 'host' ? -1 : 1)
  );
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
  resourceTypes: chrome.declarativeNetRequest.ResourceType[]
): chrome.declarativeNetRequest.RuleCondition {
  if (scheme && scope.type === 'host') {
    return { regexFilter: exactHostRegexFilter(scheme, scope.host, scope.path), resourceTypes };
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

function buildBridgeNavigationStripCondition(
  bridgeNavigationUrl: string
): chrome.declarativeNetRequest.RuleCondition | null {
  try {
    const url = new URL(bridgeNavigationUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return {
      regexFilter: exactHostRegexFilter(url.protocol === 'https:' ? 'https' : 'http', url.hostname, '/'),
      resourceTypes: ['main_frame', 'sub_frame'],
    };
  } catch {
    return null;
  }
}

export function buildDnrRulesForCookieStore(options: BuildRuleOptions): DNRRule[] {
  // Split the legacy combined rule so request and response sides can scope
  // independently. Request-side stripping is tab-scoped for all subresources so
  // the shared jar never competes with an isolated cookie on same-site fetches
  // or later navigations; response-side stripping stays strict and the auth
  // bridge handles the timing gap between capture and the next navigation.
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

  if (options.bridgeNavigationUrl) {
    const bridgeNavigationCondition = buildBridgeNavigationStripCondition(options.bridgeNavigationUrl);
    if (bridgeNavigationCondition) {
      bridgeNavigationCondition.tabIds = [options.tabId];
      addRules.push({
        id: options.ruleIds[addRules.length],
        priority: 100,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'remove' }] },
        condition: bridgeNavigationCondition,
      });
    }
  }

  const scopes = buildCookieRuleScopes(options.store, options.boundHost);
  for (let i = 0; i < scopes.length; i++) {
    const scope = scopes[i];
    if (addRules.length >= options.ruleIds.length) {
      // Budget exhausted: deeper-path scopes are dropped (shortest-path-first sort
      // makes this safe — root rules survive). Surface it so a user hitting the cap
      // can diagnose missing cookies on deep paths.
      console.warn(
        `[dnr] rule budget (${options.ruleIds.length}) exhausted for tab ${options.tabId}; ` +
        `${scopes.length - i} cookie scope(s) dropped`,
      );
      break;
    }
    const requestScheme = options.scheme ?? 'https';
    const requestUrl = `${requestScheme}://${scope.host}${scope.path}`;
    const cookieStr = serializeCookieHeader(options.store, { ...options.serializeOpts, requestUrl });
    if (!cookieStr) continue;
    const condition = buildCookieCondition(scope, options.scheme, options.resourceTypes);
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

  return addRules;
}
