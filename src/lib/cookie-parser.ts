// cookie-parser.ts — Parses Set-Cookie headers and serializes cookies for requests.

import type { ParsedCookie } from './types.js'
import type { CookieStoreEntry } from './session-store.js'
import { isPublicSuffix } from './public-suffix.js'

function isValidDomainAttribute(domainAttr: string, requestHost: string): boolean {
  const cleaned = domainAttr.replace(/^\./, '').toLowerCase();
  const host = requestHost.toLowerCase();
  if (!cleaned) return false;
  // Exempt localhost and IP literals from single-label rejection.
  const isIpLiteral = /^(\d+\.){3}\d+$/.test(cleaned) || /^\[?[0-9a-f:]+\]?$/.test(cleaned);
  if (!cleaned.includes('.') && cleaned !== 'localhost' && !isIpLiteral) return false;
  if (cleaned === host) return true;
  return host.endsWith('.' + cleaned);
}

export function defaultCookiePath(pathname: string | null | undefined): string {
  if (!pathname || !pathname.startsWith('/')) return '/';
  const rightmostSlash = pathname.lastIndexOf('/');
  if (rightmostSlash <= 0) return '/';
  return pathname.slice(0, rightmostSlash);
}

export function normalizeCookiePath(path: string | null | undefined): string {
  return path && path.startsWith('/') ? path : '/';
}

function domainMatches(cookieDomain: string | null | undefined, requestHost: string): boolean {
  if (!cookieDomain) return true;
  const normalizedDomain = cookieDomain.toLowerCase();
  const normalizedHost = requestHost.toLowerCase();
  if (normalizedDomain.startsWith('.')) {
    const parentDomain = normalizedDomain.slice(1);
    return normalizedHost === parentDomain || normalizedHost.endsWith('.' + parentDomain);
  }
  return normalizedHost === normalizedDomain;
}

function pathMatches(cookiePath: string | null | undefined, requestPath: string): boolean {
  const normalizedCookiePath = normalizeCookiePath(cookiePath);
  const normalizedRequestPath = requestPath || '/';
  if (normalizedCookiePath === '/') return true;
  if (normalizedRequestPath === normalizedCookiePath) return true;
  if (!normalizedRequestPath.startsWith(normalizedCookiePath)) return false;
  if (normalizedCookiePath.endsWith('/')) return true;
  return normalizedRequestPath.charAt(normalizedCookiePath.length) === '/';
}

export function cookieMatchesRequest(entry: CookieStoreEntry, requestUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return true;
  }
  return domainMatches(entry.domain, url.hostname) && pathMatches(entry.path, url.pathname || '/');
}

export function parseSetCookie(setCookieStr: string, requestUrl: string): ParsedCookie | null {
  const parts = setCookieStr.split(';');
  if (parts.length === 0) {
    return null;
  }

  // Parse name=value
  const [nameValue] = parts;
  const trimmed = nameValue.trim();
  const eqIndex = trimmed.indexOf('=');

  if (eqIndex === -1) {
    return null;
  }

  const name = trimmed.substring(0, eqIndex);
  const value = trimmed.substring(eqIndex + 1);

  // Parse attributes
  const cookie: ParsedCookie = {
    name,
    value,
    domain: null,
    path: null,
    expires: null,
    secure: false,
    httpOnly: false,
    sameSite: null
  };

  // Default domain and path from requestUrl
  let url;
  try {
    url = new URL(requestUrl);
  } catch (e) {
    // If URL parsing fails, use fallback
    url = null;
  }

  if (url) {
    cookie.domain = url.hostname;
    cookie.path = defaultCookiePath(url.pathname);
  }

  // Parse cookie attributes
  let maxAge: number | null = null;
  let expiresStr: string | null = null;

  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i].trim();
    if (!attr) continue;

    const attrEqIndex = attr.indexOf('=');
    let attrName, attrValue;

    if (attrEqIndex === -1) {
      // Boolean attribute like Secure, HttpOnly
      attrName = attr.toLowerCase();
      attrValue = '';
    } else {
      attrName = attr.substring(0, attrEqIndex).trim().toLowerCase();
      attrValue = attr.substring(attrEqIndex + 1).trim();
    }

    switch (attrName) {
      case 'domain': {
        const requestHost = url?.hostname;
        if (!requestHost || !isValidDomainAttribute(attrValue, requestHost)) return null;
        const cleaned = attrValue.replace(/^\./, '').toLowerCase();
        if (isPublicSuffix(cleaned)) return null;
        // `cleaned` is non-empty and dot-stripped here, so the leading-dot form
        // is unconditional except for the host-only `localhost` case.
        cookie.domain = cleaned === 'localhost' ? cleaned : '.' + cleaned;
        break;
      }
      case 'path':
        cookie.path = attrValue.startsWith('/') ? attrValue : defaultCookiePath(url?.pathname);
        break;
      case 'expires':
        expiresStr = attrValue;
        break;
      case 'max-age':
        maxAge = parseInt(attrValue, 10);
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite':
        cookie.sameSite = attrValue;
        break;
    }
  }

  // Calculate expires timestamp
  // Max-Age takes precedence over Expires
  if (maxAge !== null) {
    if (maxAge === 0) {
      // Max-Age=0 means deletion
      cookie.expires = 0;
    } else {
      cookie.expires = Date.now() + maxAge * 1000;
    }
  } else if (expiresStr) {
    const expiresDate = new Date(expiresStr);
    if (!isNaN(expiresDate.getTime())) {
      cookie.expires = expiresDate.getTime();
    }
  }

  return cookie;
}

export interface SerializeOptions {
  excludeHttpOnly?: boolean;
  excludeSecure?: boolean;
  requestUrl?: string;
}

export function serializeCookieHeader(
  store: Record<string, CookieStoreEntry>,
  opts: SerializeOptions = {},
): string {
  const now = Date.now();
  const cookiePairs: Array<{ name: string; path: string; value: string }> = [];
  for (const [key, data] of Object.entries(store)) {
    if (data.expires != null && data.expires <= now) continue;
    if (opts.excludeHttpOnly && data.httpOnly) continue;
    if (opts.excludeSecure && data.secure) continue;
    if (opts.requestUrl && !cookieMatchesRequest(data, opts.requestUrl)) continue;
    cookiePairs.push({
      name: data.name ?? key,
      path: data.path ?? '/',
      value: data.value,
    });
  }
  cookiePairs.sort((left, right) => right.path.length - left.path.length);
  return cookiePairs.map(({ name, value }) => `${name}=${value}`).join('; ');
}

export function cookieKey(name: string, domain: string, path: string): string {
  return `${name}|${domain}|${path}`;
}

export function parseCookieString(cookieStr: string): Map<string, string> {
  const map = new Map();
  if (!cookieStr) return map;
  for (const pair of cookieStr.split('; ')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx !== -1) {
      map.set(pair.substring(0, eqIdx), pair.substring(eqIdx + 1));
    }
  }
  return map;
}
