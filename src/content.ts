// content.ts
// Runs in the ISOLATED world at document_start.
// 1. Injects session ID and nonce into page context via DOM attributes.
// 2. Delivers cookie string to page-api-proxy.js via nonce-authenticated postMessage
// 3. Relays updateCookie messages from page-api-proxy.js to background.js

(async () => {
  // A held redirect: in a profile tab, a navigation response that sets cookies
  // has its Location removed by DNR, so Chrome commits the 3xx here instead of
  // following it (see background/held-redirects.ts). Stop the document before
  // its body runs (e.g. a meta-refresh "Redirecting…" page), then finish the hop
  // once the background has published the response's cookies. location.replace
  // keeps the history of a native redirect.
  // Only held documents carry the DNR-appended Server-Timing marker (mirrors
  // HELD_REDIRECT_MARKER in dnr-cookie-rule-builder.ts); any other 3xx document
  // renders natively. serverTiming is secure-context only, so plain-http pages
  // fall back to asking the background for every 3xx.
  const navigation = performance.getEntriesByType('navigation')[0] as
    (PerformanceNavigationTiming & { responseStatus?: number }) | undefined;
  const navigationStatus = navigation?.responseStatus ?? 0;
  const markedHeld = navigation?.serverTiming
    ? navigation.serverTiming.some((entry) => entry.name === 'sessionshift-held')
    : true;
  if (navigationStatus >= 300 && navigationStatus < 400 && markedHeld) {
    window.stop();
    try {
      const response = await chrome.runtime.sendMessage({ action: 'resolveHeldRedirect' }) as { url?: string | null } | null;
      if (response?.url) window.location.replace(response.url);
    } catch (error) {
      console.debug('Failed to resolve held redirect:', (error as Error).message);
    }
    return;
  }

  let activeSessionId = 'default';
  let activeCookieStr = '';
  let activeNonce = '';
  let isolationBootstrapped = false;
  let pendingBootstrapAck: (() => void) | null = null;

  function postInitNonce(sessionId: string, nonce: string): void {
    const initOrigin = window.location.origin;
    if (initOrigin === 'null') return;
    window.postMessage({
      source: 'ext-content',
      action: 'initNonce',
      sessionId,
      nonce,
    }, initOrigin);
  }

  function ensureIsolationBootstrap(sessionId: string, cookieStr: string): void {
    if (sessionId === 'default' || isolationBootstrapped) return;
    activeSessionId = sessionId;
    activeCookieStr = cookieStr;
    activeNonce = crypto.randomUUID();
    isolationBootstrapped = true;
    postInitNonce(activeSessionId, activeNonce);
  }

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'getSessionForBootstrap'
    }) as { sessionId?: string; cookieStr?: string } | null;
    if (response) {
      activeSessionId = response.sessionId || 'default';
      activeCookieStr = response.cookieStr || '';
    }
  } catch (error) {
    console.debug('Failed to get session for bootstrap:', (error as Error).message);
  }

  ensureIsolationBootstrap(activeSessionId, activeCookieStr);

  // Pulls this frame's scoped cookie snapshot and hands it to the page proxy,
  // which replaces its document.cookie map. Covers cookies set by XHR/fetch
  // responses and by other tabs or frames of the same profile.
  async function syncDocumentCookies(): Promise<void> {
    if (!isolationBootstrapped || !activeNonce) return;
    const targetOrigin = window.location.origin;
    if (targetOrigin === 'null') return;
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getSessionForBootstrap' }) as
        { sessionId?: string; cookieStr?: string } | null;
      // A profile switch is handled by sessionBootstrapChanged, not here.
      if (!response || response.sessionId !== activeSessionId) return;
      activeCookieStr = response.cookieStr || '';
      window.postMessage({
        source: 'ext-content',
        nonce: activeNonce,
        action: 'syncCookies',
        cookieStr: activeCookieStr
      }, targetOrigin);
    } catch (error) {
      console.debug('Failed to sync document cookies:', (error as Error).message);
    }
  }

  // Listen for page-api-proxy.js requesting the cookie bootstrap.
  // It sends a requestCookies message; we reply with the actual cookie string.
  // This fires before any page JS runs because both scripts run at document_start.
  window.addEventListener('message', function onRequest(event: MessageEvent) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'page-api-proxy' ||
      event.data.action !== 'requestCookies' ||
      event.data.nonce !== activeNonce
    ) {
      return;
    }

    const targetOrigin = window.location.origin;
    if (targetOrigin === 'null') return;
    window.postMessage({
      source: 'ext-content',
      nonce: activeNonce,
      action: 'bootstrapCookies',
      cookieStr: activeCookieStr
    }, targetOrigin);
  });

  window.addEventListener('message', (event: MessageEvent) => {
    if (
      event.source === window &&
      event.data &&
      event.data.source === 'page-api-proxy' &&
      event.data.action === 'initReady' &&
      event.data.nonce === activeNonce
    ) {
      pendingBootstrapAck?.();
      pendingBootstrapAck = null;
      return;
    }
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'page-api-proxy' ||
      event.data.nonce !== activeNonce ||
      event.data.action !== 'updateCookie'
    ) {
      return;
    }

    try {
      chrome.runtime.sendMessage({
        action: 'updateCookie',
        payload: event.data.payload
      });
    } catch (error) {
      console.debug('Failed to send updateCookie message:', (error as Error).message);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return;

    if (
      message.action === 'bridgeCookieSyncDone' &&
      typeof message.bridgeId === 'string' &&
      activeNonce
    ) {
      const targetOrigin = window.location.origin;
      if (targetOrigin === 'null') return;
      // Refresh document.cookie first: the page resumes its fetch/XHR on the
      // release message and immediately reads cookies the response just set
      // (axios copies XSRF-TOKEN into X-XSRF-TOKEN). postMessage keeps order.
      void syncDocumentCookies().finally(() => {
        window.postMessage({
          source: 'ext-content',
          nonce: activeNonce,
          action: 'bridgeCookieSyncDone',
          bridgeId: message.bridgeId
        }, targetOrigin);
      });
      return;
    }

    if (message.action === 'cookiesChanged') {
      void syncDocumentCookies();
      return;
    }

    if (message.action === 'sessionBootstrapChanged') {
      void chrome.runtime.sendMessage({ action: 'getSessionForBootstrap' })
        .then((response: { sessionId?: string; cookieStr?: string } | null) => {
          if (!response) return;
          const nextSessionId = response.sessionId || 'default';
          const nextCookieStr = response.cookieStr || '';
          const needsBootstrap = nextSessionId !== 'default' && !isolationBootstrapped;
          const bootstrapReady = needsBootstrap
            ? new Promise<void>((resolve) => {
              const timer = window.setTimeout(() => {
                pendingBootstrapAck = null;
                resolve();
              }, 500);
              pendingBootstrapAck = () => {
                window.clearTimeout(timer);
                resolve();
              };
            })
            : Promise.resolve();
          ensureIsolationBootstrap(nextSessionId, nextCookieStr);
          void bootstrapReady.then(() => sendResponse({ success: true }));
        })
        .catch((error: Error) => {
          console.debug('Failed to refresh session bootstrap:', error.message);
          sendResponse({ success: false });
        });
      return true;
    }
  });
})();
