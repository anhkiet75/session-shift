// message-handler.ts — Handles all chrome.runtime.onMessage dispatches.

import { getCookieStore, setCookieStore, getProfiles, isInternalSession, duplicateSession, updateSessionHue } from '../lib/session-store.js';
import { withCookieLock } from '../lib/cookie-write-lock.js';
import { serializeCookieHeader, parseCookieString, parseDocumentCookie, cookieKey, cookieMatchesRequest, defaultCookiePath, normalizeCookiePath, isValidCookieName, isValidCookieValue } from '../lib/cookie-parser.js';
import type { BackgroundMessage } from '../lib/types.js';
import { tabSessions, persistTabSessions, updateBadge } from './session-manager.js';
import { updateDNRRulesForTab, stripCookiesOnNextNavigation } from './dnr-manager.js';

export async function handleMessage(
  request: BackgroundMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  switch (request.action) {
    case 'setSession': {
      const { tabId, sessionId } = request.payload;
      if (typeof tabId !== 'number' || typeof sessionId !== 'string') {
        return { error: 'invalid payload' };
      }
      if (sessionId !== 'default') {
        // Profiles are global — validate the id against the single profile list,
        // not a per-origin one. A profile created on any site is selectable here.
        const list = await getProfiles();
        if (!list.find(s => s.id === sessionId)) return { error: 'unknown session' };
      }
      tabSessions[tabId] = sessionId;
      await persistTabSessions();
      await updateDNRRulesForTab(tabId, sessionId);
      updateBadge(tabId, sessionId);
      if (sessionId !== 'default') {
        await chrome.tabs.sendMessage(tabId, { action: 'sessionBootstrapChanged' }).catch(() => null);
      }
      return { success: true, sessionId };
    }

    case 'getSession': {
      const tabId = request.payload?.tabId ?? sender.tab?.id;
      if (tabId === undefined) return { sessionId: 'default' };
      return { sessionId: tabSessions[tabId] || 'default' };
    }

    case 'getSessionForBootstrap': {
      const tabId = request.payload?.tabId ?? sender.tab?.id;
      if (tabId === undefined) return { sessionId: 'default', cookieStr: '' };
      const sessionId = tabSessions[tabId] || 'default';
      if (isInternalSession(sessionId)) return { sessionId: 'default', cookieStr: '' };
      const store = await getCookieStore(sessionId);
      const cookieStr = serializeCookieHeader(store, { excludeHttpOnly: true });
      return { sessionId, cookieStr };
    }

    // Trust model: sessionId is derived from tabSessions[sender.tab.id] (server-side
    // authority). The cross-world nonce in page-api-proxy is defense-in-depth only;
    // do not add new trust on it.
    case 'updateCookie': {
      const { cookieStr, setCookieStr, deletedNames, deleteTargets } = request.payload;
      const hasSet = typeof setCookieStr === 'string' || typeof cookieStr === 'string';
      const hasDelete = Array.isArray(deletedNames) || Array.isArray(deleteTargets);
      if (!hasSet && !hasDelete) return { error: 'invalid payload' };
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { error: 'no tab context' };
      const sessionId = tabSessions[tabId];
      if (!sessionId || isInternalSession(sessionId)) {
        return { success: false, reason: 'no isolated session' };
      }
      await withCookieLock(sessionId, async () => {
        const existing = await getCookieStore(sessionId);
        let currentUrl: URL | null = null;
        try {
          currentUrl = new URL(request.payload.url ?? sender.tab?.url ?? '');
        } catch {
          currentUrl = null;
        }
        if (!currentUrl || (currentUrl.protocol !== 'https:' && currentUrl.protocol !== 'http:')) return;
        // Domain is ALWAYS host-pinned to the document host — never page-supplied.
        // A page setting Domain=.victim.com must not widen the stored cookie's
        // domain (would emit a domain-wide DNR set-rule = cookie injection).
        const cookieDomain = currentUrl.hostname;
        const requestUrl = currentUrl.href;

        const hasHttpOnlyCookie = (name: string) =>
          Object.entries(existing).some(([key, entry]) =>
            (entry?.name ?? key) === name &&
            entry?.httpOnly &&
            cookieMatchesRequest(entry, requestUrl)
          );

        const deleteByName = (name: string) => {
          for (const [key, entry] of Object.entries(existing)) {
            if ((entry?.name ?? key) === name && !entry?.httpOnly && cookieMatchesRequest(entry, requestUrl)) {
              delete existing[key];
            }
          }
        };

        const setCookie = (name: string, value: string, path: string, expires: number | null) => {
          if (hasHttpOnlyCookie(name)) return;
          const key = cookieKey(name, cookieDomain, path);
          existing[key] = existing[key]
            ? { ...existing[key], name, domain: cookieDomain, path, value, expires }
            : { name, domain: cookieDomain, path, value, expires };
          if (key !== name && name in existing) delete existing[name];
        };

        // Preferred set path: full cookie string with Path/Max-Age/Expires.
        if (typeof setCookieStr === 'string') {
          const parsed = parseDocumentCookie(setCookieStr, requestUrl);
          // Authoritative validation — the nonce is defense-in-depth only.
          if (parsed && isValidCookieName(parsed.name) && isValidCookieValue(parsed.value)) {
            if (parsed.expires !== null && parsed.expires <= Date.now()) {
              if (!hasHttpOnlyCookie(parsed.name)) deleteByName(parsed.name);
            } else {
              setCookie(parsed.name, parsed.value, parsed.path, parsed.expires);
            }
          }
        } else if (typeof cookieStr === 'string') {
          // Legacy attribute-less path (no setCookieStr); host-pinned, session expiry.
          for (const [name, value] of parseCookieString(cookieStr)) {
            if (!isValidCookieName(name) || !isValidCookieValue(value)) continue;
            setCookie(name, value, defaultCookiePath(currentUrl.pathname), null);
          }
        }

        if (Array.isArray(deletedNames)) {
          for (const name of deletedNames) {
            if (typeof name !== 'string') continue;
            if (hasHttpOnlyCookie(name)) continue;
            deleteByName(name);
          }
        }

        // Structured deletes (cookieStore.delete) — match by name + optional
        // domain/path, NOT the document URL, so delete({name, path:'/admin'})
        // from /app targets the right entry.
        if (Array.isArray(deleteTargets)) {
          for (const target of deleteTargets) {
            if (typeof target?.name !== 'string') continue;
            const targetPath = typeof target.path === 'string' ? normalizeCookiePath(target.path) : null;
            const targetDomain = typeof target.domain === 'string'
              ? target.domain.replace(/^\./, '').toLowerCase() : null;
            for (const [key, entry] of Object.entries(existing)) {
              if ((entry?.name ?? key) !== target.name || entry?.httpOnly) continue;
              if (targetPath && normalizeCookiePath(entry.path) !== targetPath) continue;
              if (targetDomain && (entry.domain ?? '').replace(/^\./, '').toLowerCase() !== targetDomain) continue;
              delete existing[key];
            }
          }
        }

        await setCookieStore(sessionId, existing);
      });
      await updateDNRRulesForTab(tabId, sessionId);
      return { success: true };
    }

    case 'refreshBadge': {
      const { tabId } = request.payload;
      if (typeof tabId !== 'number') return { error: 'invalid payload' };
      const sessionId = tabSessions[tabId] || 'default';
      await updateBadge(tabId, sessionId);
      return { success: true };
    }

    case 'deleteSession': {
      const { sessionId } = request.payload;
      if (typeof sessionId !== 'string') return { error: 'invalid payload' };
      const affectedTabIds: number[] = [];
      for (const [tid, sid] of Object.entries(tabSessions)) {
        if (sid === sessionId) {
          affectedTabIds.push(Number(tid));
          delete tabSessions[tid];
        }
      }
      await persistTabSessions();
      for (const tid of affectedTabIds) {
        await updateDNRRulesForTab(tid, 'default');
        updateBadge(tid, 'default');
      }
      return { success: true, affectedTabIds };
    }

    case 'createSessionTab': {
      const { url, sessionId } = request.payload;
      if (typeof url !== 'string' || typeof sessionId !== 'string') {
        return { error: 'invalid payload' };
      }
      if (!/^https?:/.test(url)) return { error: 'invalid url scheme' };
      const newTab = await chrome.tabs.create({ url: 'about:blank', active: true });
      if (newTab.id === undefined) return { error: 'tab creation failed' };
      tabSessions[newTab.id] = sessionId;
      await persistTabSessions();
      // The new profile has no captured cookies for this host yet, so no
      // per-host override rule exists to cover navigation. Force a clean first
      // load instead of letting the default jar's stale cookie pass through.
      stripCookiesOnNextNavigation(newTab.id, url);
      await updateDNRRulesForTab(newTab.id, sessionId);
      updateBadge(newTab.id, sessionId);
      await chrome.tabs.update(newTab.id, { url });
      return { success: true, tabId: newTab.id };
    }

    case 'duplicateSession': {
      const { sessionId } = request.payload ?? {};
      if (typeof sessionId !== 'string') {
        return { error: 'invalid payload' };
      }
      const newSession = await duplicateSession(sessionId);
      return { success: true, session: newSession };
    }

    case 'colorSession': {
      const { sessionId, hue } = request.payload;
      if (typeof sessionId !== 'string' || typeof hue !== 'number' || hue < 0 || hue > 360) {
        return { error: 'invalid payload' };
      }
      await updateSessionHue(sessionId, hue);
      for (const [tid, sid] of Object.entries(tabSessions)) {
        if (sid === sessionId) updateBadge(Number(tid), sessionId);
      }
      return { success: true };
    }

    default:
      return { error: `unknown action: ${(request as { action: string }).action}` };
  }
}
