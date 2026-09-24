# SessionShift — Codebase Summary

## File Map

| File | LOC | Purpose |
|------|-----|---------|
| **background/index.ts** | 109 | Service worker entry point; listener registration for DNR, messages, commands, context menu |
| **background/session-manager.ts** | 74 | In-memory tabSessions map; badge text/color/label-contrast; delegates icon rasterization |
| **background/profile-icon-renderer.ts** | 106 | Per-hue action icon rasterization via OffscreenCanvas; per-hue + base-bitmap caches |
| **background/dnr-manager.ts** | 148 | DNR rule management; Set-Cookie capture into session store + jar-pollution strip on isolated tabs |
| **background/context-menu-manager.ts** | 40 | Context menu creation and cleanup lifecycle |
| **background/linked-tab-inheritance.ts** | 35 | Listen for link-opened tabs; auto-assign profile if setting enabled (v0.6.0+) |
| **background/message-handler.ts** | 137 | chrome.runtime.onMessage routing; all message types (setSession, updateCookie, deleteSession, etc.) |
| **background/tab-group-sync.ts** | 213 | chrome.tabGroups mutation engine (Phase 4): create/move/recolor groups per profile; withTabGroups() permission guard; onUpdated self-write detection |
| **background/tab-group-lifecycle.ts** | 83 | Phase 4 permission/setting orchestration: request/decline/revoke handling, ext_settings on/off transition, SW-startup reconcile |
| **background/tab-group-registry.ts** | 98 | chrome.storage.session-backed (windowId, profileId) → groupId registry; ownership invariant for Phase 4 |
| **content.ts** | 86 | ISOLATED world bridge; session bootstrap; relays updateCookie to background |
| **page-api-proxy.ts** | 222 | MAIN world API interception; document.cookie, localStorage, sessionStorage, indexedDB proxying; uses lib/storage-proxy |
| **lib/cookie-parser.ts** | 170 | Parse/serialize Set-Cookie headers; cookie store serialization |
| **lib/profile-color.ts** | 136 | Single source of truth for hue→color: palette, legacy-hex migration, HSL→RGB, badge fill, WCAG contrast-picked label, CSS helpers |
| **lib/session-store.ts** | 122 | Centralized chrome.storage.local access; global `profiles` CRUD; per-profile cookie stores; duplication; orphan-store discovery |
| **lib/favorites-store.ts** | 190 | Sole authority for the `favorites` key: CRUD, reorder, http(s)-only URL normalization, label normalization, MAX_FAVORITES cap, queue-serialized writes, cascade purge on profile delete |
| **lib/settings-store.ts** | 33 | Shared ExtSettings read/write (getExtSettings, setExtSettings); extracted for options page + background use (v0.6.0+) |
| **lib/tab-groups-permission.ts** | 36 | Phase 4: hasTabGroupsPermission(), reconcileTabGroupsSetting() — reconciles groupTabsByProfile to off when the optional tabGroups grant is gone |
| **lib/storage-proxy.ts** | 50 | Storage proxy factory for per-session localStorage/sessionStorage isolation (testable) |
| **lib/types.ts** | 45+ | TypeScript types: BackgroundMessage, DNRRule, CookieStoreEntry, SessionConfig, ExtSettings |
| **popup/popup-render-favorites-list.ts** | 150 | Popup favorites section: rows, profile swatch, launch via `createSessionTab`, per-row remove, missing-profile state, search filter |
| **popup/popup-save-favorite.ts** | 93 | Hero star: save/remove toggle for the current tab + active profile; disabled on `default` and non-http(s) pages |
| **options/options-favorites.ts** | 83 | Favorites tab orchestration: render, empty state, cap message, focus-restoring refresh |
| **options/options-favorites-row.ts** | 165 | One editable favorite row: label, URL (validated), profile re-assign, move up/down, delete |
| **options/options-favorites-types.ts** | 19 | Shared PanelContext contract between the Favorites panel and its row builder |
| **popup/popup.html** | 108 | Popup UI structure; form, session list, footer; ARIA roles, aria-selected, aria-live |
| **popup/popup.ts** | 233 | Session CRUD, hue-based color system, UI event handlers, global view + search, options button; ARIA toggle |
| **popup/popup.css** | 1220 | Stacks design system; CSS custom properties; hue theming; view tabs + search + options link styles; :focus-visible rings |
| **options/options.html** | 174 | Multi-tab layout (Settings, Favorites, About); settings + favorites UI; ARIA roles |
| **options/options.ts** | 178 | Tab wiring (Settings / Favorites / About), theme + language + toggles, about/version display; ARIA toggle |
| **options/options.css** | 758 | Design tokens; multi-tab layout; form styling; settings panels; responsive design; :focus-visible rings |
| **manifest.json** | 79 | MV3 manifest (v0.4.0+); permissions; `optional_permissions: ["tabGroups"]` (Phase 4, requested at runtime, never on install/update); background worker; content scripts; context menus; options page; commands |
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

#### background/session-manager.ts (~74 LOC)
**Responsibilities:**
- Maintains in-memory `tabSessions` map (tabId → sessionId)
- Persists tab→session map to `chrome.storage.session`
- Updates the action badge: 3-char label, profile-colored fill, contrast-picked label color
- Requests the per-hue action icon from `profile-icon-renderer` and applies it per tab

**Key Functions:**
- `updateBadge(tabId, sessionId)` — Set badge text/colors, then the tinted icon. Internal
  sessions clear the badge and restore the static path icons. Icon work runs after the
  badge and is wrapped so a rasterization failure degrades to the stock icon.
- `restoreTabSessions()` / `persistTabSessions()` — Load/save the map across SW restarts

#### background/profile-icon-renderer.ts (~106 LOC)
**Responsibilities:**
- Rasterizes the toolbar icon in a profile's hue at 16px and 32px via `OffscreenCanvas`
  (the MV3 service worker has no DOM, so `document.createElement('canvas')` is unavailable)
- Composition: rounded tile filled with the profile color, brand mark composited on top as
  a white silhouette derived from the logo's own alpha — the stock logo is blue and would
  vanish against blue hues
- Two memory caches: the base `ImageBitmap` (one fetch per SW lifetime) and rendered icon
  sets keyed by hue, so recoloring a profile is a natural cache miss

**Key Functions:**
- `getIconSetForHue(hue)` — `Promise<{16: ImageData, 32: ImageData}>`; rejects (retryably)
  when `OffscreenCanvas` is unavailable or the logo cannot be fetched

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
- Context menu titles follow the manual locale override (via `getMessage()`)

**Key Functions:**
- `setupContextMenus()` — Create context menu items
- `cleanupContextMenus()` — Remove all context menus

#### background/linked-tab-inheritance.ts (~35 LOC, v0.6.0+)
**Responsibilities:**
- Listens for `chrome.webNavigation.onCreatedNavigationTarget` (link-opened tabs)
- Auto-inherits opener's profile unless setting `autoInheritProfileForLinkedTabs` is explicitly `false` (default: on)
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
- `refreshBadge` — Refresh badge display
- `deleteSession` — Remove profile's tab mappings, reset affected tabs, cascade-purge its favorites
- `createSessionTab` — Create new tab assigned to a profile (also the favorites launch path)
- `colorSession` — Update a profile's hue and repaint badges/groups
- `renameProfileGroups` — Retitle an open tab group after a profile rename

*(Earlier revisions listed `exportSessions`/`importSessions` and
`addAutoAssignRule`/`removeAutoAssignRule`/`getAutoAssignRules`. Those messages
do not exist — see `docs/BACKLOG.md` items #3 and #7. Settings are read/written
directly through `lib/settings-store.ts`, not via messages.)*

**Keyboard Commands (v0.4.0+):**
- `_execute_action` (unassigned by default) — Open popup (handled by Chrome)
- `session-next` (unassigned by default) — Move active tab to next profile and reload
- `session-prev` (unassigned by default) — Move active tab to previous profile and reload
- Via `chrome.commands.onCommand` listener in `background/index.ts`
- No command has a `suggested_key`: `Ctrl/Cmd+Shift+Left/Right` is the OS text-selection chord and `Ctrl/Cmd+Shift+S` is Save As in many apps (guarded by `tests/manifest-permissions.test.js`)
- Options → Settings → Keyboard shortcuts (`options/options-shortcuts.ts`) shows live bindings via `chrome.commands.getAll()` and opens `chrome://extensions/shortcuts`

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
- `getProfiles()` → Promise<Session[]> — Fetch the single global profile list
- `setProfiles(list)` → Promise<void> — Persist the global profile list
- `isInternalSession(sessionId)` → boolean — Returns true for 'default' and empty ids
- `findOrphanedCookieStores()` → Promise<string[]> — Cookie stores no profile references
- `duplicateSession(sessionId, buildDuplicateName?)` → Promise<Session> — Clone a profile's cookies into a new profile
- `updateSessionHue(sessionId, hue)` → Promise<void> — Recolor a profile
- `deleteSessionData(sessionId)` → Promise<void> — Remove a profile's cookie store and related keys

*(Earlier revisions listed `getSessionList`/`setSessionList` (replaced by the
global `profiles` key), `getAssignRules`/`setAssignRules`, `exportSessions` and
`importSessions`. None of those exist.)*

**Purpose:** Single source of truth for storage access patterns; reduces duplication

### lib/favorites-store.ts
**Exports:**
- `getFavorites()` / `setFavorites(list)` — Read/write the `favorites` array (absent or non-array reads as `[]`)
- `normalizeFavoriteUrl(url)` → string|null — Absolute href for http(s); `null` for every other scheme
- `normalizeFavoriteLabel(label, url)` → string — Trim/collapse/cap at 100 chars; hostname fallback when blank
- `addFavorite({ url, sessionId, label? })` → `{ status: 'added' | 'exists' | 'invalid-url' | 'limit' }` — never throws
- `updateFavorite(id, patch)` / `deleteFavorite(id)` / `moveFavorite(id, 'up'|'down')`
- `findFavorite(url, sessionId)` → Favorite|null — Exact normalized-href + profile match (powers the popup star)
- `removeFavoritesForSession(sessionId)` → Promise<number> — Cascade purge, called from `deleteSession`
- `MAX_FAVORITES = 50`

**Purpose:** Sole authority for the `favorites` key; writes serialized through a
chained-promise queue (same per-context-only limitation as `settings-store.ts`).

*(This section previously documented `lib/rule-matcher.js`, which was never
created — see `docs/BACKLOG.md` #3.)*

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
if (settings.autoInheritProfileForLinkedTabs === false) {
  // user explicitly opted out; feature is on by default otherwise
}
```

### lib/localization-types.ts (~203 LOC)
**Exports:**
- `SUPPORTED_LOCALES` — 55 Chrome extension locales (am, ar, bg, ..., zh_TW)
- `RTL_LOCALES` — ar, fa, he (right-to-left rendering)
- `LOCALE_METADATA` — Per-locale direction, BCP 47 tag
- `MessageKey` — Exhaustive union of all message keys (extensionName, deleteTitle, etc.)
- `ChromeMessageCatalog` — Typed Chrome i18n messages.json schema
- `CRITICAL_MESSAGE_KEYS` — Destructive/confirm keys forced to English on unreviewed locales
- `QualityTier` / `TranslationQualityData` — Types for `translation-quality.json`'s per-locale review-tier registry

**Purpose:**
- Single source of truth for supported locales and their properties
- Type-safe message key references across DOM and manifest
- Runtime locale/direction resolution

### lib/localization.ts (~258 LOC)
**Exports:**
- `getLanguagePreference()` → Promise<RuntimeLocalePreference> — Reads `ext_settings.language`, defaults to `'system'`
- `createLocalizer(preference)` → Promise<Localizer> — Builds a resolved localizer; `Localizer.getMessage(key, substitutions?)` resolves a message with the critical-key/English fallback chain
- `loadCatalog(locale)` → Promise<ChromeMessageCatalog | null> — Fetches a packaged `_locales/<locale>/messages.json`
- `getTextDirection(localizer)` / `getResolvedLanguageTag(localizer)` — Direction and BCP 47 tag for the active localizer
- `applyDocumentLocale(document, localizer)` — Sets `<html lang>`/`<html dir>`, idempotent
- `localizeDocument(root, localizer)` — Localizes every `data-i18n*` marker under `root`
- `getLocaleDisplayName(locale)` — Native-language display name via `Intl.DisplayNames`
- `createGenerationGuard()` — Discards a stale in-flight locale resolution superseded by a newer one

**Purpose:**
- Runtime adapter: `preference === 'system'` uses Chrome's native `chrome.i18n` directly; any other preference loads that locale's packaged catalog with English fallback — a pure switch, not an automatic detect-then-fallback chain
- Critical-key fallback: beta locales render `CRITICAL_MESSAGE_KEYS` (delete, reset, confirm) in English, failing closed to blank rather than the untrusted draft if the English catalog itself fails to load
- Never surfaces untranslated/machine-only text for delete confirmations or security wording
- Type-safe message resolution with `MessageKey` union

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

#### Global Profile List
Key: `profiles` — one global list; a profile created on any site is selectable
everywhere. This replaced the former per-origin `list_${origin}` keys, which
`lib/profile-migration.ts` folds in on install.

```javascript
{
  "profiles": [
    { id: "session_abc123de", name: "Work", hue: 212 },
    { id: "session_def456gh", name: "Personal", hue: 158 }
  ]
}
```

*(An `assign_rules` key was documented here in earlier revisions. No such key
exists — the auto-assign engine was never built; see `docs/BACKLOG.md` #3.)*

#### Favorites
Key: `favorites` — an array, so the stored order *is* the user's display order.

```javascript
{
  "favorites": [
    {
      id: "fav_1f2e3d4c-...",     // 'fav_' + crypto.randomUUID()
      label: "Work inbox",         // user-editable; defaults to the tab title, else the hostname
      url: "https://mail.example.com/",  // absolute http(s) only, normalized via new URL().href
      sessionId: "session_abc123de",     // references Session.id in `profiles`
      createdAt: 1735689600000
    }
  ]
}
```

Owned exclusively by `lib/favorites-store.ts`; UI layers never read or write the
key directly. Capped at `MAX_FAVORITES = 50`.

**Cascade on profile delete.** The `deleteSession` message handler calls
`removeFavoritesForSession(sessionId)` alongside its tab-mapping and DNR
cleanup — a favorite bound to a deleted profile could only ever relaunch into a
cookie jar that no longer exists. A favorite orphaned by any *other* path
(out-of-band storage edit, interrupted delete) is never dropped at read time:
it renders disabled with a missing-profile label in the popup, and with an
unresolved profile selector in Options so its URL can be rebound.

**Launch path.** Favorites add no new background message and no new
cookie-isolation code. A row sends the existing
`{ action: 'createSessionTab', payload: { url, sessionId } }`, which already
enforces the http(s) scheme, validates `sessionId` against `profiles`, and calls
`stripCookiesOnNextNavigation` for a clean first load.

#### Settings
Key: `ext_settings`
```javascript
{
  "ext_settings": {
    theme: "system",                          // 'dark' | 'light' | 'system'
    language: "vi",                           // absent/'system' follows Chrome's UI locale
    autoInheritProfileForLinkedTabs: true,    // only an explicit false disables it
    groupTabsByProfile: false                 // absent means OFF; needs the optional tabGroups grant
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

**Test Files (52 tests across 10 suites):**
- `tests/e2e/session-isolation.test.ts` — Per-profile cookie isolation, DNR enforcement
- `tests/e2e/session-crud.test.ts` — Create/switch/delete/duplicate via the popup
- `tests/e2e/global-session-list.test.ts` — Cross-origin global profile list and search
- `tests/e2e/linked-tab-profile-inheritance.test.ts` — Profile inheritance for link-opened tabs
- `tests/e2e/profile-open-in-new-tab.test.ts` — Right-click "Open in new tab" isolation
- `tests/e2e/session-favorites.test.ts` — Favorite launch isolation, non-http(s) popup path, hero star toggle, delete cascade, orphan state
- `tests/e2e/options-favorites.test.ts` — Options CRUD: rename, URL validation + revert, profile re-assign, reorder + focus, delete, rebind, empty state
- `tests/e2e/theme-switcher.test.ts` — Dark/light/system persistence
- `tests/e2e/localization-rtl.test.ts` — RTL rendering, locale switching, manifest/context-menu i18n
- `tests/e2e/native-locale-smoke.test.ts` — Native `chrome.i18n` smoke tests

**Run E2E tests:** `npm run test:e2e:docker` (project rule — never native `npm run test:e2e`)

*(Earlier revisions listed `.spec.ts` files such as `auto-assign-rules.spec.ts`
and `export-import.spec.ts`. None of those exist.)*

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
- **background/message-handler.ts** — Message routing with discriminated unions
- Updated manifest.json: `service_worker` → `background/index.js`
- All 94 Vitest unit tests still passing (100% pass rate)
- No regression in extension behavior

### Impact on v0.5.0
These architectural improvements provide a solid foundation for the next phase:
- **Type safety** catches bugs before runtime
- **Modularization** enables cleaner IndexedDB integration (Phase 2)
- **Test infrastructure** supports v0.5.0 validation
