// dnr-cookie-rule-scopes.ts — Which host/path scopes a profile's cookie store
// needs `Cookie: set` rules for, ordered by how much the tab needs each one.
//
// A scope is one distinct Cookie header value: an exact host (host-only cookies)
// or a Domain= cookie's domain, at one cookie path. A profile is a global jar,
// so its store holds scopes for every site it ever visited, trackers included,
// while a tab only gets a fixed number of rules (dnr-manager.ts). The order
// returned here decides which scopes get a rule when they do not all fit.

import { normalizeCookiePath, type SerializeOptions } from '../lib/cookie-parser.js';
import type { CookieStoreEntry } from '../lib/session-store.js';

export type CookieRuleScope = {
  type: 'host' | 'domain'
  host: string
  path: string
  /** Index of the scope's site in the tab's priority sites; UNRANKED when it is not one of them. */
  rank: number
}

export const UNRANKED = Number.MAX_SAFE_INTEGER;

function normalizeStoredDomain(domain: string | null | undefined, boundHost: string | null): string | null {
  return (domain ?? boundHost)?.replace(/\.$/, '').toLowerCase() ?? null;
}

function addPath(pathsByHost: Map<string, Set<string>>, host: string, path: string): void {
  pathsByHost.set(host, (pathsByHost.get(host) ?? new Set()).add(path));
}

// A cookie that can never be sent under these options must not create a scope:
// the scope would take a rule slot, or be reported as left out, for nothing.
function isSendable(entry: CookieStoreEntry, opts: SerializeOptions, now: number): boolean {
  if (entry.expires != null && entry.expires <= now) return false;
  if (opts.excludeSecure && entry.secure) return false;
  if (opts.excludeHttpOnly && entry.httpOnly) return false;
  return true;
}

function siteRanker(prioritySites: string[]): (host: string) => number {
  const ranks = new Map<string, number>();
  return (host) => {
    let rank = ranks.get(host);
    if (rank === undefined) {
      const index = prioritySites.findIndex((site) => host === site || host.endsWith('.' + site));
      rank = index === -1 ? UNRANKED : index;
      ranks.set(host, rank);
    }
    return rank;
  };
}

export function buildCookieRuleScopes(
  store: Record<string, CookieStoreEntry>,
  boundHost: string | null,
  serializeOpts: SerializeOptions,
  prioritySites: string[],
): CookieRuleScope[] {
  const exactHosts = new Set<string>();
  const pathsByHost = new Map<string, Set<string>>();
  const pathsByDomain = new Map<string, Set<string>>();
  const now = Date.now();

  if (boundHost) exactHosts.add(boundHost.toLowerCase());

  for (const entry of Object.values(store)) {
    if (!isSendable(entry, serializeOpts, now)) continue;
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

  const rankOf = siteRanker(prioritySites);
  const scopes: CookieRuleScope[] = [];
  for (const [host, paths] of pathsByHost) {
    for (const path of paths) scopes.push({ type: 'host', host, path, rank: rankOf(host) });
  }
  for (const [host, paths] of pathsByDomain) {
    for (const path of paths) scopes.push({ type: 'domain', host, path, rank: rankOf(host) });
  }
  // The tab's own sites come first, in priority order, so they are the last to
  // lose a rule when the budget runs out. Within one rank, shortest paths come
  // first: a dropped deep-path scope still matches its shorter-path rule (minus
  // path-specific cookies); a dropped root scope would leave root requests with
  // no Cookie header at all. Rule matching uses per-rule priority, not this
  // order, so selection order is safe to change.
  return scopes.sort((left, right) =>
    left.rank - right.rank ||
    left.path.length - right.path.length ||
    (left.type === right.type ? left.host.localeCompare(right.host) : left.type === 'host' ? -1 : 1)
  );
}
