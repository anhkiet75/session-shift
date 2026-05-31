import { serializeCookieHeader, type SerializeOptions } from '../lib/cookie-parser.js';
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
}

function normalizeStoredDomain(domain: string | null | undefined, boundHost: string | null): string | null {
  return (domain ?? boundHost)?.replace(/\.$/, '').toLowerCase() ?? null;
}

function normalizeStoredPath(path: string | null | undefined): string {
  return path && path.startsWith('/') ? path : '/';
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
    const path = normalizeStoredPath(entry.path);
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

function buildBaseCondition(
  boundHost: string | null,
  scheme: 'https' | 'http' | null,
  resourceTypes: chrome.declarativeNetRequest.ResourceType[]
): chrome.declarativeNetRequest.RuleCondition {
  if (boundHost && scheme) {
    return { urlFilter: `|${scheme}://`, requestDomains: [getEtld1(boundHost)], resourceTypes };
  }
  if (boundHost) return { requestDomains: [getEtld1(boundHost)], resourceTypes };
  return { resourceTypes };
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

export function buildDnrRulesForCookieStore(options: BuildRuleOptions): DNRRule[] {
  const baseCondition = buildBaseCondition(options.boundHost, options.scheme, options.resourceTypes);
  baseCondition.tabIds = [options.tabId];
  const addRules: DNRRule[] = [{
    id: options.ruleIds[0],
    priority: 100,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Cookie', operation: 'remove' }],
      responseHeaders: [{ header: 'set-cookie', operation: 'remove' }],
    },
    condition: baseCondition,
  }];

  for (const scope of buildCookieRuleScopes(options.store, options.boundHost)) {
    if (addRules.length >= options.ruleIds.length) break;
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
