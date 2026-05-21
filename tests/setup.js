import { beforeEach, vi } from 'vitest';

function createStorageMock() {
  let data = {};
  return {
    get: vi.fn(async (keys) => {
      if (keys === null || keys === undefined) return { ...data };
      if (typeof keys === 'string') return { [keys]: data[keys] };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in data) out[k] = data[k];
        return out;
      }
      const out = {};
      for (const k of Object.keys(keys)) out[k] = k in data ? data[k] : keys[k];
      return out;
    }),
    set: vi.fn(async (obj) => { Object.assign(data, obj); }),
    remove: vi.fn(async (keys) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete data[k];
    }),
    clear: vi.fn(async () => { data = {}; }),
    __reset: () => { data = {}; },
  };
}

function createChromeMock() {
  return {
    runtime: {
      id: 'test-ext-id',
      onMessage: { addListener: vi.fn() },
    },
    declarativeNetRequest: {
      updateSessionRules: vi.fn().mockResolvedValue({}),
    },
    storage: {
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue({}),
      },
      local: createStorageMock(),
      onChanged: { addListener: vi.fn() },
    },
    contextMenus: {
      create: vi.fn(),
      removeAll: vi.fn().mockResolvedValue({}),
      onClicked: { addListener: vi.fn() },
    },
    tabs: {
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      query: vi.fn(),
      onRemoved: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
      setIcon: vi.fn().mockResolvedValue({}),
    },
    webRequest: {
      onHeadersReceived: { addListener: vi.fn() },
    },
    commands: {
      onCommand: { addListener: vi.fn() },
    },
  };
}

// Must be set at module level so background.js top-level code sees chrome on import
globalThis.chrome = createChromeMock();

beforeEach(() => {
  globalThis.chrome = createChromeMock();
});
