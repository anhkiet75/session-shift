import { beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const englishCatalog = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/_locales/en/messages.json'), 'utf8'),
);

function createI18nMock() {
  return {
    // Positional only: each declared placeholder's "content" is "$N$" (N = its
    // 1-based position), so this maps $name$/$index$/etc to substitutions[N-1]
    // in the order they're declared in the English catalog entry.
    getMessage: vi.fn((key, substitutions) => {
      const entry = englishCatalog[key];
      if (!entry) return '';
      if (!substitutions || substitutions.length === 0) return entry.message;
      const order = Object.keys(entry.placeholders ?? {});
      return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (_full, name) => {
        const position = order.indexOf(name);
        if (position === -1) throw new Error(`i18n mock: "${key}" references undeclared placeholder "${name}"`);
        return String(substitutions[position]);
      });
    }),
  };
}

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
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    i18n: createI18nMock(),
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
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
      sendMessage: vi.fn().mockResolvedValue({}),
      update: vi.fn(),
      query: vi.fn(),
      onRemoved: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    webNavigation: {
      onCreatedNavigationTarget: { addListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
      setIcon: vi.fn().mockResolvedValue({}),
    },
    webRequest: {
      onBeforeSendHeaders: { addListener: vi.fn() },
      onHeadersReceived: { addListener: vi.fn() },
      onCompleted: { addListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn() },
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
