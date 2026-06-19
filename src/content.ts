// content.ts
// Runs in the ISOLATED world at document_start.
// 1. Injects session ID and nonce into page context via DOM attributes.
// 2. Delivers cookie string to page-api-proxy.js via nonce-authenticated postMessage
// 3. Relays updateCookie messages from page-api-proxy.js to background.js

(async () => {
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
      window.postMessage({
        source: 'ext-content',
        nonce: activeNonce,
        action: 'bridgeCookieSyncDone',
        bridgeId: message.bridgeId
      }, targetOrigin);
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
