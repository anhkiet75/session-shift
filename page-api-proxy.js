// page-api-proxy.js
// Runs synchronously in the MAIN world at document_start.
// Intercepts web APIs for session isolation.

(function () {
  // 1. Read session ID and nonce from DOM attributes (set by content.js in ISOLATED world).
  // Only sessionId and nonce are in the DOM — cookies are never exposed there.
  const root = document.documentElement;
  const sessionId = root && root.dataset.extSessionId;
  if (!sessionId || sessionId === 'default') return;

  const nonce = root.dataset.extNonce || '';
  delete root.dataset.extSessionId;
  delete root.dataset.extNonce;

  // 2. Prefix for storage isolation
  const prefix = '__ext_' + sessionId + '_';

  // 3. Storage proxy factory
  function makeStorageProxy(realStorage) {
    return {
      getItem: function (key) {
        return realStorage.getItem(prefix + key);
      },
      setItem: function (key, value) {
        realStorage.setItem(prefix + key, String(value));
      },
      removeItem: function (key) {
        realStorage.removeItem(prefix + key);
      },
      clear: function () {
        const keysToRemove = [];
        for (let i = 0; i < realStorage.length; i++) {
          const k = realStorage.key(i);
          if (k && k.startsWith(prefix)) keysToRemove.push(k);
        }
        keysToRemove.forEach(function (k) { realStorage.removeItem(k); });
      },
      key: function (index) {
        let currentIdx = 0;
        for (let i = 0; i < realStorage.length; i++) {
          const k = realStorage.key(i);
          if (k && k.startsWith(prefix)) {
            if (currentIdx === index) return k.substring(prefix.length);
            currentIdx++;
          }
        }
        return null;
      },
      get length() {
        let count = 0;
        for (let i = 0; i < realStorage.length; i++) {
          const k = realStorage.key(i);
          if (k && k.startsWith(prefix)) count++;
        }
        return count;
      }
    };
  }

  // 4. Override window.localStorage and window.sessionStorage
  const realLocalStorage = window.localStorage;
  const realSessionStorage = window.sessionStorage;

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    enumerable: true,
    get: function () { return makeStorageProxy(realLocalStorage); }
  });

  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    enumerable: true,
    get: function () { return makeStorageProxy(realSessionStorage); }
  });

  // 5. Override document.cookie
  // cookieMap is populated asynchronously once content.js delivers the bootstrap cookies.
  // Until then, reads return '' — this is safe because the DNR rule handles network cookies.
  const cookieMap = new Map();
  let cookiesReady = false;

  function serializeCookieMap() {
    return Array.from(cookieMap.entries()).map(function (e) { return e[0] + '=' + e[1]; }).join('; ');
  }

  Object.defineProperty(document, 'cookie', {
    configurable: true,
    enumerable: true,
    get: function () {
      return serializeCookieMap();
    },
    set: function (val) {
      if (typeof val !== 'string') return;
      const parts = val.split(';');
      const kv = parts[0].trim();
      const eqIdx = kv.indexOf('=');
      if (eqIdx === -1) return;

      const name = kv.substring(0, eqIdx);
      const value = kv.substring(eqIdx + 1);

      // Check for deletion via max-age=0 or negative max-age
      const lowerVal = val.toLowerCase();
      const maxAgeMatch = lowerVal.match(/max-age\s*=\s*(-?\d+)/);
      const isDeleting = maxAgeMatch && parseInt(maxAgeMatch[1], 10) <= 0;

      if (isDeleting) {
        cookieMap.delete(name);
      } else {
        cookieMap.set(name, value);
      }

      // Skip postMessage on null-origin pages — broadcasting to '*' is unsafe.
      const _updateOrigin = window.location.origin;
      if (_updateOrigin !== 'null') {
        window.postMessage({
          source: 'page-api-proxy',
          nonce: nonce,
          action: 'updateCookie',
          payload: {
            sessionId: sessionId,
            cookieStr: serializeCookieMap()
          }
        }, _updateOrigin);
      }
    }
  });

  // 6. Request cookie bootstrap from content.js via nonce-authenticated postMessage.
  // Cookies are never stored in DOM attributes — content.js holds them and delivers on request.
  window.addEventListener('message', function onBootstrap(event) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'ext-content' ||
      event.data.action !== 'bootstrapCookies' ||
      event.data.nonce !== nonce
    ) {
      return;
    }
    window.removeEventListener('message', onBootstrap);
    cookiesReady = true;
    const str = event.data.cookieStr || '';
    if (str) {
      str.split('; ').forEach(function (pair) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx !== -1) {
          cookieMap.set(pair.substring(0, eqIdx), pair.substring(eqIdx + 1));
        }
      });
    }
  });

  // Request cookie bootstrap from content.js. content.js is async (awaits background),
  // so its listener may not be ready yet — retry with backoff until acknowledged.
  // Budget: 50 ms × 40 = 2 s, which covers cold service-worker starts (~1–2 s).
  let retries = 0;
  const MAX_RETRIES = 40;
  const RETRY_MS = 50;

  function sendCookieRequest() {
    if (cookiesReady) return;
    if (retries >= MAX_RETRIES) {
      console.warn('[page-api-proxy] cookie bootstrap timed out — document.cookie reads will return empty');
      return;
    }
    retries++;
    const _reqOrigin = window.location.origin;
    if (_reqOrigin === 'null') return; // null-origin pages can't safely receive cookie bootstrap
    window.postMessage({
      source: 'page-api-proxy',
      nonce: nonce,
      action: 'requestCookies'
    }, _reqOrigin);
    setTimeout(sendCookieRequest, RETRY_MS);
  }

  sendCookieRequest();

  // 7. Proxy IndexedDB
  if (window.indexedDB) {
    const realIndexedDBOpen = window.indexedDB.open.bind(window.indexedDB);
    const realIndexedDBDeleteDatabase = window.indexedDB.deleteDatabase.bind(window.indexedDB);

    window.indexedDB.open = function (name, version) {
      return realIndexedDBOpen(prefix + name, version);
    };

    window.indexedDB.deleteDatabase = function (name) {
      return realIndexedDBDeleteDatabase(prefix + name);
    };
  }

  // 8. Proxy Cache API
  if (window.caches) {
    const realCachesOpen = window.caches.open.bind(window.caches);
    const realCachesDelete = window.caches.delete.bind(window.caches);
    const realCachesHas = window.caches.has.bind(window.caches);
    const realCachesKeys = window.caches.keys.bind(window.caches);

    window.caches.open = function (name) {
      return realCachesOpen(prefix + name);
    };

    window.caches.delete = function (name) {
      return realCachesDelete(prefix + name);
    };

    window.caches.has = function (name) {
      return realCachesHas(prefix + name);
    };

    window.caches.keys = async function () {
      const keys = await realCachesKeys();
      return keys
        .filter(function (k) { return k.startsWith(prefix); })
        .map(function (k) { return k.substring(prefix.length); });
    };
  }

})();
