// page-api-proxy.ts
// Runs synchronously in the MAIN world at document_start.
// Intercepts web APIs for session isolation.

(function () {
  // 1. Wait for sessionId and nonce from content.ts (ISOLATED world) via postMessage.
  // Using postMessage instead of DOM attributes avoids the brief window where
  // another MAIN-world extension script could read the nonce before deletion.
  window.addEventListener('message', function onInitNonce(event: MessageEvent) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'ext-content' ||
      event.data.action !== 'initNonce' ||
      !event.data.sessionId ||
      event.data.sessionId === 'default'
    ) {
      return;
    }
    window.removeEventListener('message', onInitNonce);
    initialize(event.data.sessionId as string, event.data.nonce as string || '');
  });

  function initialize(sessionId: string, nonce: string) {
  // 2. Prefix for storage isolation
  const prefix = '__ext_' + sessionId + '_';

  // 3. Storage proxy factory
  function makeStorageProxy(realStorage: Storage) {
    return {
      getItem(key: string) {
        return realStorage.getItem(prefix + key);
      },
      setItem(key: string, value: string) {
        realStorage.setItem(prefix + key, String(value));
      },
      removeItem(key: string) {
        realStorage.removeItem(prefix + key);
      },
      clear() {
        const keysToRemove: string[] = [];
        for (let i = 0; i < realStorage.length; i++) {
          const k = realStorage.key(i);
          if (k && k.startsWith(prefix)) keysToRemove.push(k);
        }
        keysToRemove.forEach(k => realStorage.removeItem(k));
      },
      key(index: number) {
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
  const cookieMap = new Map<string, string>();
  let cookiesReady = false;

  function serializeCookieMap(): string {
    return Array.from(cookieMap.entries()).map(e => e[0] + '=' + e[1]).join('; ');
  }

  function isValidCookieName(n: string): boolean {
    return n.length > 0 && n.length <= 1024 && /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(n);
  }

  function isValidCookieValue(v: string): boolean {
    return v.length <= 4096 && !/[\r\n\0]/.test(v);
  }

  Object.defineProperty(document, 'cookie', {
    configurable: true,
    enumerable: true,
    get: function () {
      return serializeCookieMap();
    },
    set: function (val: string) {
      if (typeof val !== 'string') return;
      const parts = val.split(';');
      const kv = parts[0].trim();
      const eqIdx = kv.indexOf('=');
      if (eqIdx === -1) return;

      const name = kv.substring(0, eqIdx);
      const value = kv.substring(eqIdx + 1);

      if (!isValidCookieName(name) || !isValidCookieValue(value)) return;

      // Check for deletion via max-age=0 or negative max-age
      const lowerVal = val.toLowerCase();
      const maxAgeMatch = lowerVal.match(/max-age\s*=\s*(-?\d+)/);
      const isDeleting = maxAgeMatch && parseInt(maxAgeMatch[1], 10) <= 0;

      const deletedNames: string[] = [];
      if (isDeleting) {
        cookieMap.delete(name);
        deletedNames.push(name);
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
            cookieStr: serializeCookieMap(),
            ...(deletedNames.length > 0 && { deletedNames }),
          }
        }, _updateOrigin);
      }
    }
  });

  // 6. Request cookie bootstrap from content.js via nonce-authenticated postMessage.
  // Cookies are never stored in DOM attributes — content.js holds them and delivers on request.
  window.addEventListener('message', function onBootstrap(event: MessageEvent) {
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
    const str: string = event.data.cookieStr || '';
    if (str) {
      str.split('; ').forEach(pair => {
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
    Object.defineProperty(window.indexedDB, 'open', {
      configurable: false,
      value: (name: string, version?: number) => realIndexedDBOpen(prefix + name, version),
    });
    Object.defineProperty(window.indexedDB, 'deleteDatabase', {
      configurable: false,
      value: (name: string) => realIndexedDBDeleteDatabase(prefix + name),
    });
  }

  // 8. Proxy Cache API
  if (window.caches) {
    const realCachesOpen = window.caches.open.bind(window.caches);
    const realCachesDelete = window.caches.delete.bind(window.caches);
    const realCachesHas = window.caches.has.bind(window.caches);
    const realCachesKeys = window.caches.keys.bind(window.caches);
    Object.defineProperty(window.caches, 'open', {
      configurable: false,
      value: (name: string) => realCachesOpen(prefix + name),
    });
    Object.defineProperty(window.caches, 'delete', {
      configurable: false,
      value: (name: string) => realCachesDelete(prefix + name),
    });
    Object.defineProperty(window.caches, 'has', {
      configurable: false,
      value: (name: string) => realCachesHas(prefix + name),
    });
    Object.defineProperty(window.caches, 'keys', {
      configurable: false,
      value: async () => {
        const keys = await realCachesKeys();
        return keys
          .filter((k: string) => k.startsWith(prefix))
          .map((k: string) => k.substring(prefix.length));
      },
    });
  }

  } // end initialize

})();
