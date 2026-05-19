// cookie-parser.ts — Parses Set-Cookie headers and serializes cookies for requests.

import type { ParsedCookie } from './types.js'

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
    cookie.path = url.pathname || '/';
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
        cookie.domain = attrValue.toLowerCase();
        if (cookie.domain && !cookie.domain.startsWith('.') && cookie.domain !== 'localhost') {
          cookie.domain = '.' + cookie.domain;
        }
        break;
      }
      case 'path':
        cookie.path = attrValue;
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
}

export function serializeCookieHeader(
  store: Record<string, { value: string; expires?: number | null; httpOnly?: boolean; secure?: boolean }>,
  opts: SerializeOptions = {},
): string {
  const now = Date.now();
  const cookiePairs: string[] = [];
  for (const [name, data] of Object.entries(store)) {
    if (data.expires != null && data.expires <= now) continue;
    if (opts.excludeHttpOnly && data.httpOnly) continue;
    if (opts.excludeSecure && data.secure) continue;
    cookiePairs.push(`${name}=${data.value}`);
  }
  return cookiePairs.join('; ');
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
