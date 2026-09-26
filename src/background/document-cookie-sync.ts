// document-cookie-sync.ts — What a profile tab's `document.cookie` may see, and
// keeping every frame's copy current.
//
// The page proxy answers `document.cookie` from an in-page map. That map must
// hold exactly what Chrome would expose to the frame: non-HttpOnly cookies
// whose domain and path match the frame's URL, minus Secure cookies on http.
// Profiles are global jars, so an unscoped snapshot would hand one site's
// cookies to every other site's scripts.
//
// Cookies change behind the page's back — XHR/fetch responses, navigations in
// other tabs of the same profile, page writes in sibling frames. Every change to
// a profile's store is broadcast to that profile's tabs; each frame then pulls
// its own scoped snapshot, the same way it bootstraps.

import { serializeCookieHeader } from '../lib/cookie-parser.js';
import type { CookieStoreEntry } from '../lib/session-store.js';
import { tabSessions } from './session-manager.js';

const BROADCAST_DEBOUNCE_MS = 30;
const COOKIE_STORE_KEY_PREFIX = 'cookies_';

/**
 * The URL whose cookies a frame's `document.cookie` exposes. A frame without
 * its own http(s) URL (about:blank, srcdoc) inherits its creator's origin.
 */
export function documentCookieUrl(sender: chrome.runtime.MessageSender): string | null {
  for (const candidate of [sender.url, sender.origin ? `${sender.origin}/` : undefined]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch {
      // Not a URL — try the next candidate.
    }
  }
  return null;
}

/** Cookie string `document.cookie` returns for `url` from this profile's store. */
export function serializeDocumentCookie(store: Record<string, CookieStoreEntry>, url: string | null): string {
  if (!url) return '';
  return serializeCookieHeader(store, {
    excludeHttpOnly: true,
    excludeSecure: new URL(url).protocol !== 'https:',
    requestUrl: url,
  });
}

const pendingBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();

function broadcastCookiesChanged(sessionId: string): void {
  if (pendingBroadcasts.has(sessionId)) return;
  pendingBroadcasts.set(sessionId, setTimeout(() => {
    pendingBroadcasts.delete(sessionId);
    for (const [tabId, tabSessionId] of Object.entries(tabSessions)) {
      if (tabSessionId !== sessionId) continue;
      // No frameId: every frame of the tab refreshes its own scoped copy.
      chrome.tabs.sendMessage(Number(tabId), { action: 'cookiesChanged' }).catch(() => {});
    }
  }, BROADCAST_DEBOUNCE_MS));
}

/** Broadcasts every profile cookie-store change to the tabs using that profile. */
export function registerDocumentCookieBroadcast(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of Object.keys(changes)) {
      if (key.startsWith(COOKIE_STORE_KEY_PREFIX)) {
        broadcastCookiesChanged(key.slice(COOKIE_STORE_KEY_PREFIX.length));
      }
    }
  });
}
