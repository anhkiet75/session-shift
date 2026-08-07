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
      if (key === '@@bidi_dir') return 'ltr'; // native English UI locale is LTR
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
    getUILanguage: vi.fn(() => 'en-US'),
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
      // Mirrors chrome.runtime.getURL's package-relative-path -> URL shape
      // closely enough for the fetch mock below to resolve real disk files.
      getURL: vi.fn((path) => path),
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
      group: vi.fn(),
      ungroup: vi.fn(),
      onRemoved: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onAttached: { addListener: vi.fn() },
    },
    // Deliberately no `tabGroups` entry — `chrome.tabGroups` is `undefined`
    // without the optional permission granted, and that (opted-out) state is
    // what tests exercise unless a test opts in by adding it explicitly.
    permissions: {
      contains: vi.fn().mockResolvedValue(false),
      request: vi.fn().mockResolvedValue(false),
      remove: vi.fn().mockResolvedValue(true),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    windows: {
      onRemoved: { addListener: vi.fn() },
    },
    webNavigation: {
      onCreatedNavigationTarget: { addListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
      // Chrome 110+; source feature-detects it, so tests may delete it.
      setBadgeTextColor: vi.fn(),
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

// Resolves package-relative paths (what chrome.runtime.getURL returns in the
// mock above) against real files under src/ — an offline stand-in for
// fetching a packaged extension resource.
function createFetchMock() {
  return vi.fn(async (url) => {
    try {
      const path = resolve(process.cwd(), 'src', String(url));
      const text = readFileSync(path, 'utf8');
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(text),
        text: async () => text,
        // Binary resources (the icon PNG) only ever reach the stubbed
        // createImageBitmap, so identity is enough.
        blob: async () => ({ __path: path, type: 'image/png' }),
      };
    } catch {
      return { ok: false, status: 404, json: async () => { throw new Error('not found') } };
    }
  });
}

// jsdom ships neither OffscreenCanvas nor createImageBitmap, and has no 2d
// rasterizer at all. These stubs record the draw calls the icon renderer makes
// and hand back correctly-shaped ImageData, which is what the renderer's
// contract (sizes, caching, failure handling) is actually tested on — pixel
// fidelity is a manual visual check, not a unit-test concern.
class MockOffscreenCanvasRenderingContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.calls = [];
    this.fillStyle = '';
    this.globalCompositeOperation = 'source-over';
  }
  beginPath() { this.calls.push(['beginPath']); }
  roundRect(...args) { this.calls.push(['roundRect', ...args]); }
  rect(...args) { this.calls.push(['rect', ...args]); }
  fill() { this.calls.push(['fill', this.fillStyle]); }
  fillRect(...args) { this.calls.push(['fillRect', this.fillStyle, ...args]); }
  drawImage(...args) { this.calls.push(['drawImage', ...args]); }
  getImageData(_x, _y, w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4), __calls: this.calls };
  }
}

class MockOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.__ctx = new MockOffscreenCanvasRenderingContext2D(this);
  }
  getContext() { return this.__ctx; }
}

// Must be set at module level so background.js top-level code sees chrome on import
globalThis.chrome = createChromeMock();
globalThis.fetch = createFetchMock();
globalThis.OffscreenCanvas = MockOffscreenCanvas;
globalThis.createImageBitmap = vi.fn(async (source) => ({ width: 128, height: 128, source }));

beforeEach(() => {
  globalThis.chrome = createChromeMock();
  globalThis.fetch = createFetchMock();
  globalThis.OffscreenCanvas = MockOffscreenCanvas;
  globalThis.createImageBitmap = vi.fn(async (source) => ({ width: 128, height: 128, source }));
});
