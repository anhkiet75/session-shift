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
        let cur = 0;
        for (let i = 0; i < realStorage.length; i++) {
          const k = realStorage.key(i);
          if (k && k.startsWith(prefix)) {
            if (cur === index) return k.substring(prefix.length);
            cur++;
          }
        }
        return null;
      },
      get length() {
        let n = 0;
        for (let i = 0; i < realStorage.length; i++) {
          const k = realStorage.key(i);
          if (k && k.startsWith(prefix)) n++;
        }
        return n;
      }
    };
  }

  // 4. Override window.localStorage and window.sessionStorage.
  // Build the proxies ONCE and cache them so identity holds
  // (`localStorage === localStorage`) and set their prototype so
  // `instanceof Storage` passes — some libraries assert both.
  // KNOWN LIMITATION: direct/bracket property access (`localStorage.token = x`)
  // is NOT proxied — these are plain method objects, not a real `Proxy`. Use
  // getItem/setItem. A Proxy rewrite was rejected (larger blast radius on a core
  // isolation path).
  const realLocalStorage = window.localStorage;
  const realSessionStorage = window.sessionStorage;
  const localStorageProxy = makeStorageProxy(realLocalStorage);
  const sessionStorageProxy = makeStorageProxy(realSessionStorage);
  if (typeof Storage !== 'undefined') {
    Object.setPrototypeOf(localStorageProxy, Storage.prototype);
    Object.setPrototypeOf(sessionStorageProxy, Storage.prototype);
  }

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    enumerable: true,
    get: function () { return localStorageProxy; }
  });

  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    enumerable: true,
    get: function () { return sessionStorageProxy; }
  });

  // 4b. Remap `storage` events: native cross-tab writes arrive with prefixed keys
  // and include OTHER sessions' writes. Strip our prefix + re-dispatch a synthetic
  // event; swallow events for other sessions or unprefixed keys. A re-entry
  // sentinel is mandatory — re-dispatching on `window` re-triggers this same
  // listener; without the guard the synthetic loops or gets swallowed by the
  // own-prefix filter.
  // Sentinel tag on our own re-dispatched events. A stable global symbol (not a
  // per-instance WeakSet) so the guard still recognizes the event if the proxy is
  // somehow installed twice — otherwise a second interceptor would see the
  // already-stripped key, judge it "unprefixed", and swallow it. Page-forged tags
  // carry only page-supplied data (no cross-session leak), so the tag is safe.
  const SYNTHETIC = Symbol.for('__ext_synthetic_storage_event');
  window.addEventListener('storage', function (e: StorageEvent) {
    if ((e as unknown as Record<symbol, unknown>)[SYNTHETIC]) return; // our synthetic → pass through
    // Intercept the raw event before page listeners see prefixed/foreign keys.
    e.stopImmediatePropagation();
    const key = e.key;
    // key === null is storage.clear(); always forward a cleaned clear event.
    if (key !== null && !key.startsWith(prefix)) return; // other session / unprefixed → swallow
    const strippedKey = key === null ? null : key.substring(prefix.length);
    const area = e.storageArea === realSessionStorage ? sessionStorageProxy : localStorageProxy;
    const synthetic = new StorageEvent('storage', {
      key: strippedKey,
      oldValue: e.oldValue,
      newValue: e.newValue,
      url: e.url,
    });
    (synthetic as unknown as Record<symbol, unknown>)[SYNTHETIC] = true;
    // storageArea identity: site code may check `e.storageArea === localStorage`.
    // Point it at the same singleton the getter returns. Some engines ignore the
    // constructor's storageArea, so pin it explicitly.
    try {
      Object.defineProperty(synthetic, 'storageArea', { configurable: true, value: area });
    } catch { /* read-only in some engines; constructor value stands */ }
    // Re-dispatch on a microtask, not synchronously inside this handler: a nested
    // dispatch while the raw event is still propagating (after
    // stopImmediatePropagation) is fragile. The microtask re-enters this listener
    // and is passed through by the sentinel guard above.
    queueMicrotask(() => window.dispatchEvent(synthetic));
  }, true);

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

  // Single relay for updateCookie messages. Skips null-origin pages where
  // broadcasting to '*' would be unsafe. Background re-validates everything.
  function postUpdateCookie(payload: Record<string, unknown>): void {
    const origin = window.location.origin;
    if (origin === 'null') return;
    window.postMessage({
      source: 'page-api-proxy',
      nonce: nonce,
      action: 'updateCookie',
      payload: { url: window.location.href, ...payload },
    }, origin);
  }

  const AUTH_BRIDGE_HEADER = 'X-SessionShift-Bridge';
  const AUTH_BRIDGE_TIMEOUT_MS = 2000;
  const nativeFetch = window.fetch?.bind(window);
  const pendingAuthBridgeWaiters = new Map<string, () => void>();

  function resolveAuthBridge(bridgeId: string): void {
    const resolve = pendingAuthBridgeWaiters.get(bridgeId);
    if (!resolve) return;
    pendingAuthBridgeWaiters.delete(bridgeId);
    resolve();
  }

  function waitForAuthBridge(bridgeId: string): Promise<void> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        pendingAuthBridgeWaiters.delete(bridgeId);
        resolve();
      }, AUTH_BRIDGE_TIMEOUT_MS);
      pendingAuthBridgeWaiters.set(bridgeId, () => {
        window.clearTimeout(timer);
        resolve();
      });
    });
  }

  function buildBridgedRequest(input: RequestInfo | URL, init?: RequestInit): Request | null {
    const request = input instanceof Request
      ? new Request(input, init)
      : new Request(new URL(String(input), window.location.href).href, init);
    const url = new URL(request.url, window.location.href);
    if (
      url.origin !== window.location.origin ||
      (url.protocol !== 'https:' && url.protocol !== 'http:')
    ) {
      return null;
    }
    const headers = new Headers(request.headers);
    headers.set(AUTH_BRIDGE_HEADER, crypto.randomUUID());
    return new Request(request, { headers });
  }

  if (nativeFetch) {
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      enumerable: true,
      value: async function (input: RequestInfo | URL, init?: RequestInit) {
        const bridgedRequest = buildBridgedRequest(input, init);
        if (!bridgedRequest) return nativeFetch(input, init);

        const bridgeId = bridgedRequest.headers.get(AUTH_BRIDGE_HEADER);
        if (!bridgeId) return nativeFetch(bridgedRequest);

        const waitForBridge = waitForAuthBridge(bridgeId);
        try {
          const response = await nativeFetch(bridgedRequest);
          await waitForBridge;
          return response;
        } catch (error) {
          pendingAuthBridgeWaiters.delete(bridgeId);
          throw error;
        }
      },
    });
  }

  const readyOrigin = window.location.origin;
  if (readyOrigin !== 'null') {
    window.postMessage({
      source: 'page-api-proxy',
      action: 'initReady',
      nonce,
    }, readyOrigin);
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

      if (isDeleting) {
        cookieMap.delete(name);
        // Deletion stays name-scoped; background matches at the document scope.
        postUpdateCookie({ deletedNames: [name] });
      } else {
        cookieMap.set(name, value);
        // Forward the FULL string so Path/Max-Age/Expires survive. Background
        // host-pins the domain (ignores any page-supplied Domain=).
        postUpdateCookie({ setCookieStr: val });
      }
    }
  });

  // 5b. Proxy window.cookieStore (async Cookie Store API, secure-context only).
  // Reads resolve from the local cookieMap; writes/deletes route through the same
  // nonce-authenticated updateCookie path as document.cookie. Returns a cached
  // singleton so identity checks (===) hold.
  if (window.cookieStore) {
    const cookieStoreProxy = {
      get(name?: unknown) {
        const n = typeof name === 'string'
          ? name
          : (name && typeof name === 'object' ? (name as { name?: string }).name : undefined);
        if (n !== undefined && cookieMap.has(n)) {
          return Promise.resolve({ name: n, value: cookieMap.get(n) });
        }
        return Promise.resolve(null);
      },
      getAll(_opts?: unknown) {
        // Attribute gap: cookieMap is flat name→value, so getAll returns
        // name+value only (no domain/path/expires). Documented limitation.
        const out: Array<{ name: string; value: string | undefined }> = [];
        for (const [n, v] of cookieMap.entries()) out.push({ name: n, value: v });
        return Promise.resolve(out);
      },
      set(name: unknown, value?: unknown) {
        let n: string | undefined;
        let v = '';
        let path: string | undefined;
        let expires: number | undefined;
        if (typeof name === 'string') {
          n = name;
          v = String(value ?? '');
        } else if (name && typeof name === 'object') {
          const opts = name as { name?: string; value?: unknown; path?: string; expires?: number };
          n = opts.name;
          v = String(opts.value ?? '');
          path = opts.path;
          expires = opts.expires;
        }
        if (n === undefined || !isValidCookieName(n) || !isValidCookieValue(v)) {
          return Promise.reject(new TypeError('Invalid cookie name or value'));
        }
        let cookieStr = `${n}=${v}`;
        if (path) cookieStr += `; Path=${path}`;
        if (expires) cookieStr += `; Expires=${new Date(expires).toUTCString()}`;
        // Domain intentionally NOT forwarded — host-pinned in background.
        cookieMap.set(n, v);
        postUpdateCookie({ setCookieStr: cookieStr });
        return Promise.resolve();
      },
      delete(name: unknown) {
        const opts = typeof name === 'string'
          ? { name }
          : (name && typeof name === 'object' ? name as { name?: string; domain?: string; path?: string } : {});
        if (typeof opts.name !== 'string') {
          return Promise.reject(new TypeError('cookieStore.delete requires a name'));
        }
        cookieMap.delete(opts.name);
        postUpdateCookie({
          deleteTargets: [{ name: opts.name, domain: opts.domain, path: opts.path }],
        });
        return Promise.resolve();
      },
      // onchange is NOT supported: it could only observe page JS writes, never
      // server-set or DNR-injected cookie changes, so partial support misleads.
    };
    Object.defineProperty(window, 'cookieStore', {
      configurable: true,
      enumerable: true,
      get: function () { return cookieStoreProxy; },
    });
  }

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

  window.addEventListener('message', function onBridgeDone(event: MessageEvent) {
    if (
      event.source !== window ||
      !event.data ||
      event.data.source !== 'ext-content' ||
      event.data.action !== 'bridgeCookieSyncDone' ||
      event.data.nonce !== nonce ||
      typeof event.data.bridgeId !== 'string'
    ) {
      return;
    }
    resolveAuthBridge(event.data.bridgeId);
  });

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
    // databases() leaks prefixed DB names across sessions — filter + strip prefix.
    // Guard for older engines that lack databases().
    if (typeof window.indexedDB.databases === 'function') {
      const realIndexedDBDatabases = window.indexedDB.databases.bind(window.indexedDB);
      Object.defineProperty(window.indexedDB, 'databases', {
        configurable: false,
        value: async () => {
          const dbs = await realIndexedDBDatabases();
          return dbs
            .filter((d: IDBDatabaseInfo) => typeof d.name === 'string' && d.name.startsWith(prefix))
            .map((d: IDBDatabaseInfo) => ({ ...d, name: (d.name as string).substring(prefix.length) }));
        },
      });
    }
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
    // caches.match() searches ALL caches by default — restrict to this session's
    // prefixed caches so a match never resolves against another session's cache.
    const realCachesMatch = window.caches.match.bind(window.caches);
    Object.defineProperty(window.caches, 'match', {
      configurable: false,
      value: async (request: RequestInfo | URL, options?: MultiCacheQueryOptions) => {
        if (options?.cacheName !== undefined) {
          // Honor an explicit cacheName by scoping it to this session.
          return realCachesMatch(request, { ...options, cacheName: prefix + options.cacheName });
        }
        const names = (await realCachesKeys()).filter((k: string) => k.startsWith(prefix));
        for (const name of names) {
          const cache = await realCachesOpen(name);
          const hit = await cache.match(request, options);
          if (hit) return hit;
        }
        return undefined;
      },
    });
  }

  } // end initialize

})();
