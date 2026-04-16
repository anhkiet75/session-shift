/**
 * Cookie Parser Module
 * Handles parsing Set-Cookie headers and serializing cookies for requests
 */

/**
 * Parses a Set-Cookie header string into a structured object
 * @param {string} setCookieStr - The Set-Cookie header value
 * @param {string} requestUrl - The request URL for extracting default domain/path
 * @returns {Object} Parsed cookie object with fields: name, value, domain, path, expires, secure, httpOnly, sameSite
 */
export function parseSetCookie(setCookieStr, requestUrl) {
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
  const cookie = {
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
  let maxAge = null;
  let expiresStr = null;

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
      case 'domain':
        cookie.domain = attrValue;
        // Normalize: prepend dot if not already present and not a localhost
        if (cookie.domain && !cookie.domain.startsWith('.') && cookie.domain !== 'localhost') {
          cookie.domain = '.' + cookie.domain;
        }
        break;
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

/**
 * Serializes a cookie store into a Cookie header string
 * @param {Object} store - Object mapping cookie names to { value, expires } objects
 * @returns {string} Serialized cookie string in format "name1=val1; name2=val2"
 */
export function serializeCookieHeader(store) {
  const now = Date.now();
  const cookiePairs = [];

  for (const [name, data] of Object.entries(store)) {
    // Filter out expired cookies
    if (data.expires !== null && data.expires !== undefined && data.expires <= now) {
      continue;
    }
    cookiePairs.push(`${name}=${data.value}`);
  }

  return cookiePairs.join('; ');
}

/**
 * Creates a unique cookie key from name, domain, and path
 * @param {string} name - Cookie name
 * @param {string} domain - Cookie domain
 * @param {string} path - Cookie path
 * @returns {string} Unique cookie key in format "name|domain|path"
 */
export function cookieKey(name, domain, path) {
  return `${name}|${domain}|${path}`;
}

/**
 * Parses a serialized cookie string ("name1=val1; name2=val2") into a Map.
 * @param {string} cookieStr
 * @returns {Map<string, string>}
 */
export function parseCookieString(cookieStr) {
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
