import englishMessages from '../src/_locales/en/messages.json';
import { beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Session, Favorite, ExtSettings } from '../src/lib/types.js';
import type { CookieStore } from '../src/lib/session-store.js';
import type { ChromeMessageCatalog } from '../src/lib/localization-types.js';

interface TestStorage {
  profiles: Session[];
  favorites: Favorite[];
  ext_settings: ExtSettings;
  [key: `cookies_${string}`]: CookieStore;
  [key: string]: unknown;
}


const englishCatalog: ChromeMessageCatalog = englishMessages;

// A real (if tiny) event target rather than a bare `vi.fn()` — removeListener
// actually drops the callback, so tests can dispatch through it and verify a
// listener that unregisters itself doesn't get called again, exactly like the
// real chrome.tabs.onUpdated/onRemoved.
export function createEventMock() {
  type Listener = (...args: never[]) => unknown;
  const listeners = new Set<Listener>();
  return {
    addListener: vi.fn((fn: Listener) => { listeners.add(fn); }),
    removeListener: vi.fn((fn: Listener) => { listeners.delete(fn); }),
    hasListener: vi.fn((fn: Listener) => listeners.has(fn)),
    // Test-only: invoke every listener currently registered, snapshotted first
    // so a listener that removes itself mid-dispatch doesn't skip a sibling.
    __dispatch: (...args: unknown[]) => { for (const fn of [...listeners]) (fn as (...values: unknown[]) => unknown)(...args); },
  };
}

function createI18nMock() {
  return {
    // Positional only: each declared placeholder's "content" is "$N$" (N = its
    // 1-based position), so this maps $name$/$index$/etc to substitutions[N-1]
    // in the order they're declared in the English catalog entry.
    getMessage: vi.fn((key: string, substitutions?: string | string[]) => {
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
  let data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null): Promise<TestStorage> => {
      if (keys === null || keys === undefined) return { ...data } as TestStorage;
      if (typeof keys === 'string') return { [keys]: data[keys] } as TestStorage;
      if (Array.isArray(keys)) {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in data) out[k] = data[k];
        return out as TestStorage;
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(keys)) out[k] = k in data ? data[k] : keys[k];
      return out as TestStorage;
    }),
    set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(data, obj); }),
    remove: vi.fn(async (keys: string | string[]) => {
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
      getURL: vi.fn((path: string) => path),
    },
    i18n: createI18nMock(),
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
    declarativeNetRequest: {
      ResourceType: { MAIN_FRAME: 'main_frame' as chrome.declarativeNetRequest.ResourceType },
      updateSessionRules: vi.fn<(options: { addRules: chrome.declarativeNetRequest.Rule[]; removeRuleIds: number[] }) => Promise<void>>().mockResolvedValue(undefined),
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
      get: vi.fn<(tabId: number) => Promise<Partial<chrome.tabs.Tab>>>(),
      create: vi.fn<(properties: chrome.tabs.CreateProperties) => Promise<Partial<chrome.tabs.Tab>>>(),
      sendMessage: vi.fn().mockResolvedValue({}),
      update: vi.fn<(tabId: number, properties: chrome.tabs.UpdateProperties) => Promise<Partial<chrome.tabs.Tab>>>(),
      reload: vi.fn().mockResolvedValue({}),
      query: vi.fn<(query: chrome.tabs.QueryInfo) => Promise<Partial<chrome.tabs.Tab>[]>>(),
      group: vi.fn<(options: { tabIds: number | number[]; groupId?: number; createProperties?: { windowId?: number } }) => Promise<number>>(),
      ungroup: vi.fn(),
      onRemoved: createEventMock(),
      onActivated: { addListener: vi.fn() },
      onUpdated: createEventMock(),
      onAttached: { addListener: vi.fn() },
    },
    tabGroups: undefined as undefined | {
      update: ReturnType<typeof vi.fn<(groupId: number, properties: chrome.tabGroups.UpdateProperties) => Promise<unknown>>>;
      query?: ReturnType<typeof vi.fn<(query: chrome.tabGroups.QueryInfo) => Promise<Partial<chrome.tabGroups.TabGroup>[]>>>;
      get?: ReturnType<typeof vi.fn<(groupId: number) => Promise<Partial<chrome.tabGroups.TabGroup>>>>;
      onUpdated?: Pick<ReturnType<typeof createEventMock>, "addListener">;
      onRemoved?: Pick<ReturnType<typeof createEventMock>, "addListener">;
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
      setBadgeTextColor: vi.fn() as ReturnType<typeof vi.fn> | undefined,
      setIcon: vi.fn<(details: chrome.action.TabIconDetails) => Promise<void>>().mockResolvedValue(undefined),
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
  return vi.fn(async (url: string | URL | Request) => {
    try {
      const path = resolve(process.cwd(), 'src', String(url));
      const text = readFileSync(path, 'utf8');
      return {
        ok: true,
        status: 200,
        json: async (): Promise<unknown> => JSON.parse(text),
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
  calls: unknown[][] = [];
  fillStyle = "";
  globalCompositeOperation = "source-over";
  constructor(public canvas: MockOffscreenCanvas) {
    this.canvas = canvas;
    this.calls = [];
    this.fillStyle = '';
    this.globalCompositeOperation = 'source-over';
  }
  beginPath() { this.calls.push(['beginPath']); }
  roundRect(...args: number[]) { this.calls.push(['roundRect', ...args]); }
  rect(...args: number[]) { this.calls.push(['rect', ...args]); }
  fill() { this.calls.push(['fill', this.fillStyle]); }
  fillRect(...args: number[]) { this.calls.push(['fillRect', this.fillStyle, ...args]); }
  drawImage(...args: unknown[]) { this.calls.push(['drawImage', ...args]); }
  getImageData(_x: number, _y: number, w: number, h: number) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4), __calls: this.calls };
  }
}

class MockOffscreenCanvas {
  __ctx: MockOffscreenCanvasRenderingContext2D;
  constructor(public width: number, public height: number) {
    this.width = width;
    this.height = height;
    this.__ctx = new MockOffscreenCanvasRenderingContext2D(this);
  }
  getContext() { return this.__ctx; }
}

// Must be set at module level so background.js top-level code sees chrome on import
export let chrome = createChromeMock();
vi.stubGlobal("chrome", chrome);
vi.stubGlobal("fetch", createFetchMock());
vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
vi.stubGlobal("createImageBitmap", vi.fn(async (source: unknown) => ({ width: 128, height: 128, source })));

beforeEach(() => {
  chrome = createChromeMock();
  vi.stubGlobal("chrome", chrome);
  vi.stubGlobal("fetch", createFetchMock());
  vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
  vi.stubGlobal("createImageBitmap", vi.fn(async (source: unknown) => ({ width: 128, height: 128, source })));
});
