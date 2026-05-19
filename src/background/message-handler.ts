// message-handler.ts — Handles all chrome.runtime.onMessage dispatches.

import { getCookieStore, setCookieStore, getSessionList, isInternalSession, duplicateSession, updateSessionHue } from '../lib/session-store.js';
import { serializeCookieHeader, parseCookieString } from '../lib/cookie-parser.js';
import type { BackgroundMessage } from '../lib/types.js';
import type { CookieStoreEntry } from '../lib/session-store.js';
import { tabSessions, persistTabSessions, updateBadge } from './session-manager.js';
import { updateDNRRulesForTab, protectDefaultTabsOnHost } from './dnr-manager.js';

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
        let tab: chrome.tabs.Tab;
        try { tab = await chrome.tabs.get(tabId); } catch { return { error: 'tab not found' }; }
        if (tab?.url && !tab.url.startsWith('chrome://')) {
          const { hostname, origin } = new URL(tab.url);
          await protectDefaultTabsOnHost(hostname, tabId);
          const list = await getSessionList(origin);
          if (!list.find(s => s.id === sessionId)) return { error: 'unknown session' };
        }
      }
      tabSessions[tabId] = sessionId;
      await persistTabSessions();
      await updateDNRRulesForTab(tabId, sessionId);
      updateBadge(tabId, sessionId);
      return { success: true, sessionId };
    }

    case 'getSession': {
      const tabId = request.payload?.tabId ?? sender.tab?.id;
      if (tabId === undefined) return { sessionId: 'default' };
      const raw = tabSessions[tabId] || 'default';
      return { sessionId: raw.startsWith('_snap_') ? 'default' : raw };
    }

    case 'getSessionForBootstrap': {
      const tabId = request.payload?.tabId ?? sender.tab?.id;
      if (tabId === undefined) return { sessionId: 'default', cookieStr: '' };
      const sessionId = tabSessions[tabId] || 'default';
      if (isInternalSession(sessionId)) return { sessionId: 'default', cookieStr: '' };
      const store = await getCookieStore(sessionId);
      const cookieStr = serializeCookieHeader(store);
      return { sessionId, cookieStr };
    }

    case 'updateCookie': {
      const { sessionId, cookieStr } = request.payload;
      if (typeof sessionId !== 'string' || typeof cookieStr !== 'string') {
        return { error: 'invalid payload' };
      }
      const tabId = sender.tab?.id;
      if (isInternalSession(sessionId)) return { success: false, reason: 'default session' };
      const existing = await getCookieStore(sessionId);
      const newStore: Record<string, CookieStoreEntry> = {};
      for (const [name, value] of parseCookieString(cookieStr)) {
        newStore[name] = existing[name]
          ? { ...existing[name], value }
          : { value, expires: null };
      }
      await setCookieStore(sessionId, newStore);
      if (tabId !== undefined) await updateDNRRulesForTab(tabId, sessionId);
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
      await updateDNRRulesForTab(newTab.id, sessionId);
      updateBadge(newTab.id, sessionId);
      // Snapshot default-session tabs on the same host before navigating so their
      // global-jar cookies aren't overwritten by Set-Cookie responses from the new tab.
      try {
        const hostname = new URL(url).hostname;
        if (hostname) await protectDefaultTabsOnHost(hostname, newTab.id);
      } catch (_) {}
      await chrome.tabs.update(newTab.id, { url });
      return { success: true, tabId: newTab.id };
    }

    case 'duplicateSession': {
      const { sessionId, origin } = request.payload ?? {};
      if (typeof sessionId !== 'string' || typeof origin !== 'string') {
        return { error: 'invalid payload' };
      }
      const newSession = await duplicateSession(sessionId, origin);
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
