// content.js
// Runs in the ISOLATED world at document_start.
// 1. Injects session ID and nonce into page context via DOM attributes.
// 2. Delivers cookie string to page-api-proxy.js via nonce-authenticated postMessage
// 3. Relays updateCookie messages from page-api-proxy.js to background.js

(async () => {
  // Get session info from background
  let sessionId = 'default';
  let cookieStr = '';

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'getSessionForBootstrap'
    });
    if (response) {
      sessionId = response.sessionId || 'default';
      cookieStr = response.cookieStr || '';
    }
  } catch (error) {
    // Background may not be available yet, use defaults
    console.debug('Failed to get session for bootstrap:', error.message);
  }

  if (sessionId === 'default') return;

  // Generate a one-time nonce so content.js can authenticate messages from page-api-proxy.js.
  // A forged postMessage from a malicious page script won't know this value.
  const nonce = crypto.randomUUID();

  // Pass only the non-secret session ID and nonce via DOM attributes.
  // Cookies are NOT written to DOM — other extensions with MAIN-world scripts could read them.
  document.documentElement.dataset.extSessionId = sessionId;
  document.documentElement.dataset.extNonce = nonce;

  // Listen for page-api-proxy.js requesting the cookie bootstrap.
  // It sends a requestCookies message; we reply with the actual cookie string.
  // This fires before any page JS runs because both scripts run at document_start.
  window.addEventListener('message', function onRequest(event) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'page-api-proxy' ||
      event.data.action !== 'requestCookies' ||
      event.data.nonce !== nonce
    ) {
      return;
    }
    // Remove this one-shot listener — cookies are only bootstrapped once per page load.
    window.removeEventListener('message', onRequest);

    // Skip postMessage on null-origin pages (file://, data:, sandboxed iframes) —
    // broadcasting to '*' would expose the cookie string to any listener on the page.
    const targetOrigin = window.location.origin;
    if (targetOrigin === 'null') return;
    window.postMessage({
      source: 'ext-content',
      nonce: nonce,
      action: 'bootstrapCookies',
      cookieStr: cookieStr
    }, targetOrigin);
  });

  // Also relay updateCookie messages to background.
  window.addEventListener('message', (event) => {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'page-api-proxy' ||
      event.data.nonce !== nonce ||
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
      // Extension context may be invalidated (e.g., during update/reload)
      console.debug('Failed to send updateCookie message:', error.message);
    }
  });
})();
