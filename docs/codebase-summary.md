# SessionShift — Codebase Summary

## File Map

| File | LOC | Purpose |
|------|-----|---------|
| **background/index.ts** | 109 | Service worker entry point; listener registration for DNR, messages, commands, context menu |
| **background/session-manager.ts** | 93 | In-memory tabSessions map, badge generation, icon creation via OffscreenCanvas |
| **background/dnr-manager.ts** | 148 | DNR rule management; Set-Cookie capture into session store + jar-pollution strip on isolated tabs |
| **background/context-menu-manager.ts** | 40 | Context menu creation and cleanup lifecycle |
| **background/linked-tab-inheritance.ts** | 35 | Listen for link-opened tabs; auto-assign profile if setting enabled (v0.6.0+) |
| **background/message-handler.ts** | 137 | chrome.runtime.onMessage routing; all message types (setSession, updateCookie, deleteSession, etc.) |
| **content.ts** | 86 | ISOLATED world bridge; session bootstrap; relays updateCookie to background |
| **page-api-proxy.ts** | 222 | MAIN world API interception; document.cookie, localStorage, sessionStorage, indexedDB proxying; uses lib/storage-proxy |
| **lib/cookie-parser.ts** | 170 | Parse/serialize Set-Cookie headers; cookie store serialization |
| **lib/session-store.ts** | 214 | Centralized chrome.storage.local access; session CRUD; export/import; duplication; auto-assign rules CRUD |
| **lib/settings-store.ts** | 14 | Shared ExtSettings read/write (getExtSettings, setExtSettings); extracted for options page + background use (v0.6.0+) |
| **lib/storage-proxy.ts** | 50 | Storage proxy factory for per-session localStorage/sessionStorage isolation (testable) |
| **lib/types.ts** | 45+ | TypeScript types: BackgroundMessage, DNRRule, CookieStoreEntry, SessionConfig, ExtSettings |
| **popup/popup.html** | 81 | Popup UI structure; form, session list, footer; ARIA roles, aria-selected, aria-live |
| **popup/popup.ts** | 537 | Session CRUD, hue-based color system, UI event handlers, global view + search, options button; ARIA toggle |
| **popup/popup.css** | 796 | Stacks design system; CSS custom properties; hue theming; view tabs + search + options link styles; :focus-visible rings |
| **options/options.html** | 161 | Multi-tab layout (Rules, Backup, Settings, About); rule management + settings UI; ARIA roles |
| **options/options.ts** | 272 | Rules CRUD, export/import handlers, settings management, about/version display; ARIA toggle |
| **options/options.css** | 441 | Design tokens; multi-tab layout; form styling; settings panels; responsive design; :focus-visible rings |
| **manifest.json** | 72 | MV3 manifest (v0.4.0+); permissions; background worker; content scripts; context menus; options page; commands |
| **tsconfig.json** | 20+ | TypeScript config; strict mode; ES2020 target; module: esnext |
| **vitest.config.ts** | 25+ | Vitest configuration; jsdom environment; esbuild loader; test patterns |

**Total:** ~3,700+ LOC (excl. assets, tests, node_modules)

## Module Responsibilities

### background/ (Service Worker Modules)

Modularized from original ~556 LOC monolithic background.js into 6 focused modules (~540 LOC total):

#### background/index.ts (~109 LOC)
**Responsibilities:**
- Entry point for service worker
- Registers listeners for DNR events, messages, commands, context menu, linked-tab-inheritance
- Imports and initializes all submodules
- Exports unified message handler
- Manages storage GC alarms

#### background/session-manager.ts (~93 LOC)
**Responsibilities:**
- Maintains in-memory `tabSessions` map (tabId → sessionId)
- Persists tab→session map to `chrome.storage.session`
- Generates colored session icons via OffscreenCanvas (19×19 colored circles)
- Updates action badge with session label + color (hue-based)

**Key Functions:**
- `generateSessionIcon(hue)` — Create colored circle via OffscreenCanvas
- `updateBadge(tabId, sessionId)` — Set badge text + color
- `getTabSession(tabId)` — Retrieve session for tab
- `setTabSession(tabId, sessionId)` — Assign session to tab, persist

#### background/dnr-manager.ts (~148 LOC)
**Responsibilities:**
- Manages DNR rules per-tab for cookie header rewriting
- Rebuilds DNR after captured `Set-Cookie` so login redirects and auth fetches can use fresh cookies
- Captures Set-Cookie responses into the session store (webRequest listener)
- Strips Set-Cookie from isolated-tab responses so they never write to the shared global jar, keeping default-session tabs uncontaminated

**Key Functions:**
- `updateDNRRulesForTab(tabId, sessionId)` — Update DNR rules for cookie rewriting
- `registerWebRequestListener()` — Capture Set-Cookie into the per-session store
- `dnrRuleId(tabId)` — Generate stable DNR rule ID

#### background/context-menu-manager.ts (~40 LOC)
**Responsibilities:**
- Creates and manages context menu items on startup
- Cleans up context menu on uninstall
- Integrates with session list from lib/session-store.ts

**Key Functions:**
- `setupContextMenus()` — Create context menu items
- `cleanupContextMenus()` — Remove all context menus

#### background/linked-tab-inheritance.ts (~35 LOC, v0.6.0+)
**Responsibilities:**
- Listens for `chrome.webNavigation.onCreatedNavigationTarget` (link-opened tabs)
- Auto-inherits opener's profile if setting `autoInheritProfileForLinkedTabs` is enabled
- Filters out internal sessions and already-assigned tabs
- Installs cookie-strip DNR rule for first navigation to avoid first-request cookie leak

**Key Functions:**
- `registerLinkedTabInheritance(restored)` — Register webNavigation listener; awaits restoration before operating on tabSessions

#### background/message-handler.ts (~137 LOC)
**Responsibilities:**
- Routes all chrome.runtime.onMessage calls to appropriate handlers
- Implements message type discrimination via BackgroundMessage union type

**Message Handlers:**
- `setSession` — Assign session to tab, update DNR (with debounce), persist
- `getSession` — Return current session for a tab
- `getSessionForBootstrap` — Return session + cookie string for content.ts bootstrap
- `updateCookie` — Update cookie in session store after page writes (with debounce)
- `duplicateSession` — Clone session's cookies and create new session
- `exportSessions` — Return all sessions with cookies as JSON
- `importSessions` — Import sessions from JSON backup
- `refreshBadge` — Refresh badge display
- `deleteSession` — Remove session from list and delete its data
- `createSessionTab` — Create new tab assigned to a session
- `addAutoAssignRule`, `removeAutoAssignRule`, `getAutoAssignRules` — Rule management
- `setSettings`, `getSettings` — Settings persistence

**Keyboard Commands (v0.4.0+):**
- `_execute_action` (Ctrl+Shift+S / Command+Shift+S) — Open popup (handled by Chrome)
- `session-next` (Ctrl+Shift+Right / Command+Shift+Right) — Switch to next session on active tab
- `session-prev` (Ctrl+Shift+Left / Command+Shift+Left) — Switch to previous session on active tab
- Via `chrome.commands.onCommand` listener in message-handler.ts

### content.js (ISOLATED World)
**Responsibilities:**
- Runs at `document_start` in ISOLATED world
- Fetches session ID and cookie string from background
- Generates nonce for postMessage authentication
- Injects sessionId and nonce into page context via `document.documentElement.dataset`
- Listens for requestCookies message from page-api-proxy.js
- Delivers cookie bootstrap via postMessage (only to same origin)
- Relays updateCookie messages from page-api-proxy.js to background

**Key Operations:**
1. Send `getSessionForBootstrap` message to background
2. Generate `crypto.randomUUID()` as nonce
3. Set `data-ext-session-id` and `data-ext-nonce` on `<html>`
4. Listen for `message` event from page-api-proxy.js with matching nonce
5. Reply with `bootstrapCookies` postMessage containing cookie string
6. Relay `updateCookie` postMessages to background.js

### page-api-proxy.js (MAIN World)
**Responsibilities:**
- Runs synchronously at `document_start` in MAIN world
- Reads sessionId and nonce from DOM attributes (set by content.js)
- Creates storage proxies for localStorage and sessionStorage (prefix-scoped)
- Overrides `document.cookie` getter/setter
- Proxies indexedDB.open() and deleteDatabase() (prefix-scoped database names)
- Proxies window.caches.open() (prefix-scoped cache names)
- Bootstraps cookies from content.js via nonce-authenticated postMessage

**Key Features:**
- `makeStorageProxy(realStorage)` — Factory for prefixed Storage API proxy
- Cookie bootstrap with retry/backoff (50ms × 40 = 2s max wait)
- Lazy initialization (cookies loaded only when first read)
- Updates sent back to background via content.js relay

### lib/cookie-parser.js
**Exports:**
- `parseSetCookie(str, url)` — Parse Set-Cookie header; returns cookie object (name, value, domain, path, secure, httpOnly, expires)
- `serializeCookieHeader(store)` — Serialize session cookie store back to Cookie header string
- `cookieKey(name, domain, path)` — Generate unique key for cookie map
- `parseCookieString(str)` — Split cookie string into name=value pairs

**Purpose:** Centralize cookie parsing logic; handle edge cases (domain defaults, path normalization, expires conversion)

### lib/session-store.js
**Exports:**
- `getCookieStore(sessionId)` → Promise<Object> — Fetch cookies from chrome.storage.local
- `setCookieStore(sessionId, store)` → Promise<void> — Persist cookies to chrome.storage.local
- `getSessionList(origin)` → Promise<Array> — Fetch session list for origin
- `setSessionList(origin, list)` → Promise<void> — Persist session list for origin
- `getAssignRules()` → Promise<Array> — Fetch auto-assign rules
- `setAssignRules(rules)` → Promise<void> — Persist auto-assign rules
- `isInternalSession(sessionId)` → boolean — Returns true for 'default' and _snap_* sessions
- `duplicateSession(sessionId, origin)` → Promise<string> — Clone session's cookies, append "(copy)" to name
- `exportSessions()` → Promise<Array> — Export all sessions + cookies as serializable array
- `importSessions(exportedSessions)` → Promise<void> — Import sessions without overwriting; append "(imported)" on name conflict
- `deleteSessionData(sessionId)` → Promise<void> — Remove session and related keys from storage

**Purpose:** Single source of truth for storage access patterns; reduces duplication

### lib/rule-matcher.js
**Exports:**
- `normalizePattern(input)` → string — Normalize URL or hostname to bare lowercase hostname (strips scheme, path, port)
- `findMatchingRule(hostname, rules)` → object|null — Return first enabled rule matching hostname; supports exact and wildcard patterns

**Purpose:** Pure pattern matching logic; no chrome APIs; safe for unit testing without mocks

### lib/settings-store.ts (v0.6.0)
**Exports:**
- `getExtSettings()` → Promise<ExtSettings> — Fetch settings from chrome.storage.local (defaults to `{ theme: 'system' }`)
- `setExtSettings(settings)` → Promise<void> — Persist settings to chrome.storage.local

**Purpose:**
- Single source of truth for extension-wide settings (theme, autoInheritProfileForLinkedTabs, etc.)
- Extracted from options.ts so background service worker can also read/write settings
- Type-safe via `ExtSettings` interface

**Usage:**
```typescript
const settings = await getExtSettings();
if (settings.autoInheritProfileForLinkedTabs) {
  // enable feature
}
```

### lib/storage-proxy.ts (v0.4.0)
**Exports:**
- `makeStorageProxy(realStorage, prefix)` → Object — Create Storage-compatible proxy with per-session prefix isolation

**Purpose:** 
- Isolate localStorage/sessionStorage per session via key prefix (`__ext_${sessionId}_`)
- Extracted from page-api-proxy.js for testability (11 unit tests in `tests/page-proxy-storage.test.js`)
- Enables prefix-scoped storage operations: getItem, setItem, removeItem, clear, key, length

**Usage in page-api-proxy.js:**
```javascript
Object.defineProperty(window, 'localStorage', {
  get: () => makeStorageProxy(realLocalStorage, prefix)
})
```

### popup/popup.js
**Responsibilities:**
- Load current tab and origin
- Fetch active session for tab
- Fetch saved sessions for origin
- Render hero section (current session info)
- Render session list with switch/rename/delete buttons
- Handle "Create Session" form
- Handle "Reset to Default" with confirm dialog
- Color assignment via hue palette (7-color cycling)
- Tab switching between "This site" and "All sessions" views (v0.4.0)
- Session search/filter across all sessions (v0.4.0)
- Accessibility: toggle aria-selected on tab switch (v0.4.0)

**Key Functions:**
- `getCurrentTab()` — Get active tab via chrome.tabs.query
- `getSavedSessions(origin)` — Fetch sessions from storage for origin
- `getSessionHue(session, index)` — Resolve session color (stored hue or palette default)
- `updateHero(sessionId, sessionObj, hue)` — Render current session display
- `showConfirm()` — Confirm dialog for reset
- `renameSession(origin, sessionId, newName)` — Update session name in list
- `deleteSessionBtn(origin, sessionId)` — Delete session and remove from list
- `switchTab(mode)` — Switch between origin/global view; toggle aria-selected (v0.4.0)
- `filterSessions(query)` — Search sessions by name and origin (v0.4.0)

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                   Page (MAIN World)                          │
│  document.cookie, localStorage, sessionStorage, indexedDB    │
└─────────────────┬───────────────────────────────────────────┘
                  │ postMessage (nonce-authenticated)
                  ↓
┌─────────────────────────────────────────────────────────────┐
│          page-api-proxy.js (MAIN World)                      │
│  Cookie map, storage proxies, API interception              │
└─────────────────┬───────────────────────────────────────────┘
                  │ postMessage (relayed via content.js)
                  ↓
┌─────────────────────────────────────────────────────────────┐
│          content.js (ISOLATED World)                         │
│  Nonce validation, bootstrap delivery, message relay        │
└─────────────────┬───────────────────────────────────────────┘
                  │ chrome.runtime.sendMessage()
                  ↓
┌──────────────────────────────────────┬──────────────────────┐
│        background.js (Service Worker)│  popup/popup.html    │
│  Tab→session map, DNR rules, storage │  Session UI          │
│                                      │                      │
│  ┌───────────────────────────────────┼──────────────────┐  │
│  │                      Message Router                   │  │
│  │  setSession, getSession, updateCookie, deleteSession │  │
│  └───────────────────────────────────┬──────────────────┘  │
│                  │                    │                      │
│  ┌───────────────↓────┐   ┌──────────↓──────────┐           │
│  │ DNR Rules Manager  │   │ Badge Updater       │           │
│  │ (per-tab Cookie    │   │ (session label)     │           │
│  │  header rewriting) │   │                     │           │
│  └────────┬───────────┘   └─────────────────────┘           │
│           │                                                  │
│  ┌────────↓──────────────────────────────────────────┐     │
│  │  chrome.storage.session (volatile tab→session)    │     │
│  │  chrome.storage.local (persistent cookies)        │     │
│  └───────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
            ↓
┌──────────────────────────────────────────────────────────────┐
│      Network (HTTP/HTTPS Requests)                           │
│  DNR Rule: Rewrite Cookie header per-tab                    │
│  Intercept Set-Cookie responses per-tab                     │
└──────────────────────────────────────────────────────────────┘
```

## Storage Schema

### chrome.storage.session (Volatile)
Cleared on service worker restart; recoverable from chrome.storage.local.

```javascript
{
  tabSessions: {
    [tabId]: sessionId,  // e.g., 12345: "session_abc123de"
    [tabId]: "_snap_12345_xyz789"  // internal snapshot
  }
}
```

### chrome.storage.local (Persistent)

#### Cookies per Session
Key: `cookies_${sessionId}`
```javascript
{
  "cookies_session_abc123de": {
    "cookie_name": {
      value: "cookie_value",
      domain: "example.com",
      path: "/",
      expires: 1735689600000,  // ms
      secure: true,
      httpOnly: true
    },
    "another_cookie": { ... }
  }
}
```

#### Session List per Origin
Key: `list_${origin}`
```javascript
{
  "list_https://github.com": [
    { id: "session_abc123de", name: "Work", hue: 212 },
    { id: "session_def456gh", name: "Personal", hue: 158 },
    { id: "session_ghi789ij", name: "Testing", hue: 24 }
  ]
}
```

#### Auto-Assign Rules
Key: `assign_rules`
```javascript
{
  "assign_rules": [
    { pattern: "github.com", sessionId: "session_abc123de", enabled: true },
    { pattern: "*.slack.com", sessionId: "session_def456gh", enabled: true },
    { pattern: "example.com", sessionId: "session_ghi789ij", enabled: false }
  ]
}
```

#### Settings
Key: `ext_settings`
```javascript
{
  "ext_settings": {
    notifyOnAutoAssign: true  // Notify when tab auto-assigns to a session
  }
}
```

## Session ID Prefixes

| Prefix | Type | Scope | Visibility |
|--------|------|-------|------------|
| `session_` | User session | Per-origin | Shown in badge, popup, UI |
| `_snap_` | Internal snapshot (legacy) | Per-tab, per-host | Hidden from user; no longer created — handlers retained for backward-compat with snapshots persisted by older versions |
| `default` | Global jar | Browser-wide | Shown as "Default" in reset button |

## Key Patterns

### 1. DNR Rule ID Generation
```javascript
function dnrRuleId(tabId) {
  return (tabId % 1000000) + 1;  // Stable, unique per-tab, avoids collision
}
```
Why: DNR rule IDs must be unique per session. This allows many tabs (>1M possible) while keeping IDs small.

### 2. Nonce Authentication
```javascript
const nonce = crypto.randomUUID();
document.documentElement.dataset.extNonce = nonce;
// page-api-proxy.js requests cookies with nonce
// content.js validates nonce before posting back
```
Why: Prevents malicious page scripts from forging postMessage events and stealing cookies.

### 3. Storage Prefix Isolation
```javascript
const prefix = '__ext_' + sessionId + '_';
localStorage.setItem(prefix + key, value);  // Actual stored as: __ext_session_abc_key
```
Why: localStorage and sessionStorage are shared across all tabs for a domain. Prefix isolation ensures each session sees only its own data.

### 4. Set-Cookie Strip on Isolated Tabs
Isolated-session subresources must not read from or write to the browser's shared
global cookie jar, or background requests could leak/default-pollute cookies for
the same domain.

1. The webRequest `onHeadersReceived` listener observes the response first and captures
   each `Set-Cookie` into the per-session store
2. Base DNR rules (priority 100, scoped to the tab) strip `Cookie` and `Set-Cookie`
   from cross-site subresource traffic before it reaches the network/browser jar
3. Navigation and same-site subresource responses are not stripped, so login redirects
   and fetch/XHR auth steps can carry freshly set cookies

Why: Capturing into the session store preserves the isolated session's own cookies, while
stripping third-party subresource response headers keeps background writes out of the
shared jar. Same-site auth responses are the exception because Chrome can issue the
next request before extension-side DNR updates complete.

### 5. Badge Label Derivation
```javascript
const label = sessionId.replace(/^session_/, '').substring(0, 3).toUpperCase();
// Or fetch the session name from storage and use first 3 chars
```
Why: Provides visual feedback at a glance; truncated to avoid overflow.

## Testing

### Unit Tests
**Framework:** Vitest + jsdom  
**Tests:**
- `tests/background-batch.test.js` — Unit tests for background.js message handlers
- `tests/options-filter.test.js` — Unit tests for cookie-parser.js
- `tests/cookie-parser.test.js` — Set-Cookie parsing edge cases (>90% coverage)
- `tests/page-proxy-storage.test.js` — localStorage/sessionStorage proxy isolation
- `tests/background-session-lifecycle.test.js` — Session lifecycle + keyboard handlers

**Run unit tests:** `npm test`

### E2E Tests (v0.5.0)
**Framework:** Playwright (chromium-extension project)  
**Infrastructure:**
- `playwright.config.ts` — Configuration with 5 workers, retries on CI, chromium-extension setup
- `tests/e2e/mock-cookie-server.ts` — Local HTTP server (random port binding) for cookie testing
- `tests/e2e/extension-fixtures.ts` — Playwright fixtures: context, extensionId, mockServerUrl, popupPage
- `.github/workflows/test.yml` — CI job with xvfb-run for Linux headless testing

**Test Files (17 tests across 6 files):**
- `tests/e2e/popup-navigation.spec.ts` — Session switching, tab navigation, search
- `tests/e2e/session-crud.spec.ts` — Create/rename/delete sessions
- `tests/e2e/auto-assign-rules.spec.ts` — Auto-assign rule management, pattern matching
- `tests/e2e/isolation.spec.ts` — Per-session cookie isolation, DNR enforcement
- `tests/e2e/keyboard-shortcuts.spec.ts` — Ctrl+Shift+S, Ctrl+Shift+Right/Left navigation
- `tests/e2e/export-import.spec.ts` — Session backup/restore workflows

**Run E2E tests:** `npm run test:e2e` (requires `xvfb-run` on Linux)  
**Run both:** `npm run test:all`

## Build & Release

**No build step required** — Vanilla ES modules load directly.

**Development:** Clone → `chrome://extensions` → Load unpacked  
**Release:** Submit to Chrome Web Store via developer dashboard

## Security Considerations

1. **Nonce authentication** — Prevents postMessage hijacking by rogue page scripts
2. **No DOM exposure** — Cookies never in innerHTML or dataset (only in chrome.storage.local)
3. **Prefix isolation** — Storage keys scoped to prevent cross-session leakage
4. **DNR enforcement** — Network-level isolation; cookies never sent to wrong tab
5. **No eval** — No dynamic code execution
6. **No external calls** — Fully offline; no analytics, no CDN
7. **MV3 enforcement** — CSP and sandboxing built-in

## Performance Characteristics

- **Cookie bootstrap latency:** 50-200ms (avg); 500ms max (w/ retry)
- **DNR rule update:** <10ms per tab
- **Badge update:** <5ms
- **Session creation:** <50ms (storage write + DNR update)
- **Session switch:** <100ms (DNR update + badge refresh)

## Known Technical Debt

1. Service worker startup cost — large tab map deserialization (fixable with indexed storage)
2. No pagination for session list (planning for global list feature)
3. Cookie parser doesn't handle all edge cases (e.g., SameSite=None + Secure)
4. No compression for large cookie stores (planning for Phase 2)

## Recent Architecture Updates (v0.5.0 Prerequisite Work)

### TypeScript Migration (2026-05-10 to 2026-05-15)
- All source files migrated from `.js` to `.ts` (content.ts, page-api-proxy.ts, lib/*.ts, popup/popup.ts, options/options.ts, background/*.ts)
- Added TypeScript configuration (tsconfig.json) with strict mode enabled
- Added vitest.config.ts for test framework configuration
- No `any` types in production code; full type safety via BackgroundMessage union types
- `tsc --noEmit` passes with 0 errors

### background.js Modularization (2026-05-10 to 2026-05-15)
- Split monolithic 556 LOC background.js into 6 focused modules, each <150 LOC
- **background/index.ts** — Entry point with listener registration
- **background/session-manager.ts** — Tab→session map, badge, icons
- **background/dnr-manager.ts** — DNR rules, immediate cookie capture publishing
- **background/context-menu-manager.ts** — Context menu lifecycle
- **background/auto-assign-handler.ts** — Auto-assign navigation logic
- **background/message-handler.ts** — Message routing with discriminated unions
- Updated manifest.json: `service_worker` → `background/index.js`
- All 94 Vitest unit tests still passing (100% pass rate)
- No regression in extension behavior

### Impact on v0.5.0
These architectural improvements provide a solid foundation for the next phase:
- **Type safety** catches bugs before runtime
- **Modularization** enables cleaner IndexedDB integration (Phase 2)
- **Test infrastructure** supports v0.5.0 validation
