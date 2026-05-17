/**
 * Storage proxy factory for per-session localStorage/sessionStorage isolation.
 * Extracted from page-api-proxy.js for testability (page-api-proxy.js cannot
 * use ESM imports since it runs in the MAIN world content script context).
 */
export function makeStorageProxy(realStorage: Storage, prefix: string): Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear' | 'key'> & { readonly length: number } {
  return {
    getItem(key) {
      return realStorage.getItem(prefix + key);
    },
    setItem(key, value) {
      realStorage.setItem(prefix + key, String(value));
    },
    removeItem(key) {
      realStorage.removeItem(prefix + key);
    },
    clear() {
      const keysToRemove = [];
      for (let i = 0; i < realStorage.length; i++) {
        const k = realStorage.key(i);
        if (k && k.startsWith(prefix)) keysToRemove.push(k);
      }
      keysToRemove.forEach(k => realStorage.removeItem(k));
    },
    key(index) {
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
    },
  };
}
