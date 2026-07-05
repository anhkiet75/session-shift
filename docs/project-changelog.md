# SessionShift — Project Changelog

All significant changes to the SessionShift Chrome extension are documented here.

---

## v0.6.0 (In Progress)

### 2026-07-05 — Popup Profile Right-Click Open in New Tab

**Type:** Feature / Test

#### Popup profiles
- Added a custom right-click menu on popup profile cards with "Open in new tab".
- The action opens the current tab URL in the selected profile session through the existing `createSessionTab` background path, preserving first-navigation cookie stripping.
- Hardened `createSessionTab` so forged or stale profile ids return `{ error: 'unknown session' }` before any tab is created.

#### Test coverage
- Added unit coverage for invalid `createSessionTab` profile ids.
- Added Playwright coverage for no default-cookie leakage on the opened profile tab and for multiple tabs sharing the selected profile's cookie store.
- Updated stale popup e2e selectors/fixtures to match the current single global profile-list UI.

### 2026-07-05 — Auto-Inherit Profile for Linked Tabs (v0.6.0+)

**Type:** Feature (UX)

#### Changes

- Added opt-in "Auto-open linked tabs in the same profile" toggle to Options → Settings (default: off)
- New background module (`src/background/linked-tab-inheritance.ts`) listens for `chrome.webNavigation.onCreatedNavigationTarget` to detect tabs opened via `target="_blank"`, Ctrl+Click, middle-click
- Automatically assigns new tab to opener's profile if:
  - Setting `autoInheritProfileForLinkedTabs` is enabled
  - Opener has a non-internal profile assigned
  - New tab not already assigned
- Added `webNavigation` permission to manifest (required to detect link-opened tabs synchronously with URL)
- New shared settings store (`src/lib/settings-store.ts`): `getExtSettings()` and `setExtSettings()` extracted from options.ts for use by background service worker
- New settings field: `ExtSettings.autoInheritProfileForLinkedTabs?: boolean`
- Known limitation (documented in system-architecture.md): first network request may not be hard-guaranteed cookie-clean due to browser timing; isolation deterministic from second request onward

#### Files Modified
- `manifest.json` — Added `webNavigation` permission
- `src/lib/types.ts` — Added `autoInheritProfileForLinkedTabs` to ExtSettings interface
- `src/options/options.ts`, `options.html`, `options.css` — New toggle UI

#### Files Created
- `src/background/linked-tab-inheritance.ts` — Listener registration for link-opened tab profile inheritance
- `src/lib/settings-store.ts` — Shared ExtSettings persistence (options page + background)

#### Test Coverage
- Added unit tests: `tests/linked-tab-inheritance.test.js`
- Added e2e test: `tests/e2e/linked-tab-profile-inheritance.test.ts`

#### Backward Compatibility
Feature is opt-in and off by default. No breaking changes.

---

### 2026-06-20 — New Profile First-Navigation Cookie Leak Fix

**Type:** Fix

Creating a new profile via "New session" showed the default/old account's cookie on the first page load, because brand-new profiles have an empty cookie store, so no per-host DNR override rule existed yet to shadow the navigation-exemption that lets auth redirects through. The new tab's first navigation fell through to Chrome's native (shared) cookie jar.

#### Cookie isolation
- Added `stripCookiesOnNextNavigation()` (`src/background/dnr-manager.ts`), which forces a one-shot `Cookie: remove` DNR rule for `main_frame`/`sub_frame` on the new tab's exact host, self-clearing once that navigation completes. `createSessionTab` calls it before navigating the new tab to its first URL.
- Added `clearBridgeNavigationStrip()` and wired it into `chrome.tabs.onRemoved` so a closed tab's pending strip entry can't leak into a reused tab id.
- This fix is intentionally **not** applied to `setSession` (switching an already-open tab to a profile): that flow can race a same-navigation Set-Cookie + redirect (e.g. a login flow) against the async DNR rebuild, since MV3's non-blocking `webRequest` can't make Chrome wait for the rebuild before following the redirect. `tests/e2e/session-isolation.test.ts`'s `isolated navigation redirect carries Set-Cookie to redirected request` case caught this regression when the same approach was tried there.

### 2026-06-19 — Auth Transition Bridge

**Type:** Fix

Plan: `plans/260619-2256-auth-transition-bridge`. Restores strict same-site subresource `Set-Cookie` stripping without breaking same-site auth fetch → immediate navigation.

#### Cookie isolation
- Added an auth transition bridge (`src/lib/auth-transition-bridge.ts`): `page-api-proxy.ts` wraps same-origin `fetch` with a bridge header; `dnr-manager.ts` captures `Set-Cookie`, rebuilds DNR, and signals completion back through `content.ts` before the wrapped fetch resolves. Fails open after a 2s timeout so pages never hang.
- Restored strict response-side `Set-Cookie` stripping for **all** subresources, including same-site ones — the previous same-site passthrough exemption is removed. The default/global jar no longer receives same-site auth cookies from isolated tabs.
- `tests/e2e/session-isolation.test.ts` case `isolated same-site auth fetch can set cookie before immediate navigation` now passes under strict stripping via the bridge instead of a jar passthrough.

### 2026-06-19 — Navigation Login Redirect Fix

**Type:** Fix

#### Cookie isolation
- Base DNR stripping now exempts **navigation only**. GitHub-style auth flows can still set `_gh_sess` on a redirect and continue to 2FA without waiting for async DNR rebuilds.
- Request-side `Cookie` stripping still excludes the active top-level site's eTLD+1 so same-site auth fetch/XHR can proceed, while response-side subresource `Set-Cookie` is always stripped to avoid polluting Chrome's shared jar.
- Captured `Set-Cookie` responses now rebuild DNR immediately instead of waiting for the 50ms debounce; added focused regression coverage for navigation redirects, same-site auth fetch → immediate navigation, and third-party subresource jar-pollution protection.
- Removed the ineffective `settings_stripAllThirdPartyCookies` kill switch and its Options toggle. In the global-profile model it could not change runtime behavior because profiles have no `boundHost` fallback path.

### 2026-06-19 — Profile-Based Session Model

**Type:** Feature / Refactor

Plan: `plans/260619-1902-profile-based-session-model`. Replaces per-origin sessions with global profile containers. 168 unit tests pass; type-check + build clean.

#### Data model
- **Single `profiles` storage key** replaces N per-origin `list_${origin}` keys. A profile is `{ id, name, hue }` — the `origin` field is dropped. Cookie stores (`cookies_${id}`) were already global and are unchanged.
- `lib/session-store.ts`: `getSessionList`/`setSessionList` → `getProfiles`/`setProfiles`; `getAllSessions` is now an alias of `getProfiles`; `duplicateSession(id)` and `updateSessionHue` operate on the single list (duplicate keeps the list-then-store ordering for orphan-GC safety).

#### Global profiles (cookies span all sites)
- A profile created on site A is selectable/switchable on site B — `setSession` validates the id against the global list, not a per-origin one.
- Regular profiles have no bound host, so request-side DNR stripping covers cross-site subresource `Cookie` traffic tab-wide while excluding the active top-level site's eTLD+1. Response-side `Set-Cookie` stripping applies to all subresources, including same-site ones, and only navigations are exempt. DNR scheme is derived from the current tab URL; Secure cookies are sent only on an explicitly-https tab (fail-closed otherwise).
- Removed the dead bound-host machinery (`getSessionBoundHost`, `getSessionBoundOrigin`, `invalidateBoundHostCache`, `boundHostCache`, `hostMatches`).

#### Migration (auto, on upgrade)
- `lib/profile-migration.ts` `migrateToProfiles()` folds every legacy `list_*` entry into `profiles` (deduped by id, `origin` stripped), deletes the old keys, leaves cookie stores intact. Idempotent; wired to `chrome.runtime.onInstalled`. Same-named sessions from different origins remain distinct profiles (separate jars) — no merge by name.

#### Popup
- Collapsed the "This site" / "All sessions" tabs into a **single searchable profile list**. Switching applies to the current tab. Replaced `popup-render-origin-list.ts` + `popup-render-global-list.ts` with one `popup-render-profile-list.ts`.

> Note: `docs/codebase-summary.md` still references a removed "auto-assign rules" subsystem (`auto-assign-handler.ts`, `rule-matcher.ts`, `getAssignRules`) that no longer exists in `src/`. This is pre-existing drift unrelated to this change and is flagged for a separate docs refresh.

## v0.5.0 (In Progress)

### 2026-06-14 — Isolation Hardening (P1 + P2 + P4)

**Type:** Fix / Security / Housekeeping

Plan: `plans/260614-1726-isolation-hardening-p1-p2-p4`. Closes page-API isolation leaks flagged in `docs/enhancement-recommendations.md`. 161 unit + 17 e2e tests pass.

#### Page-API isolation (P1)
- **`window.cookieStore` proxy** (`page-api-proxy.ts`): get/getAll/set/delete resolve against the session cookie map and route writes through the nonce-authenticated `updateCookie` path — never the real jar. `onchange` intentionally unsupported. Secure-context guarded.
- **`document.cookie` attributes**: the setter forwards the full cookie string (`setCookieStr`) so `Path`/`Max-Age`/`Expires` persist. New `parseDocumentCookie()` parses document.cookie grammar (ignores `Domain`, never null-drops). Background **host-pins the domain** to the document host — a page-supplied `Domain=` can no longer widen the stored cookie's scope (cookie-injection guard). Background re-validates name/value (rejects CRLF/oversize) since the nonce is defense-in-depth only.
- **Storage proxy identity**: `localStorage`/`sessionStorage` are cached singletons with `Storage.prototype` so `===` and `instanceof Storage` hold. `storage` events are remapped (prefix stripped, other-session writes swallowed, `storageArea` points at the singleton) via a `Symbol.for` sentinel + microtask re-dispatch. Direct/bracket property access remains a documented limitation.
- **`indexedDB.databases()`** and **`caches.match()`** are now proxied (prefix-filtered/scoped) so cross-session DB names and cache hits don't leak.

#### CWS review surface (P2)
- Removed the unused `cookies` permission from the manifest (verified zero `chrome.cookies` usage).

#### Third-party cookie strip (P4, gated)
- Split the base DNR rule: the request-side `Cookie: remove` is **widened** for cross-site subresources (all schemes incl. http/ws, tab-scoped, excluding the active top-level site's eTLD+1) so third-party subresources stop leaking the default jar; the response-side `set-cookie: remove` uses the same cross-site subresource scope so same-site SSO/payment/login steps keep their own `Set-Cookie`.
- Added a runtime **kill switch** (`settings_stripAllThirdPartyCookies`, options-toggleable) that reverts request-side stripping to bound-host scope without a CWS release.
- **Manual follow-up:** SSO/CDN breakage eval against real providers before relying on strip-all in production.

#### Housekeeping (P4)
- Added `chrome.alarms`-driven storage GC (`storage-gc.ts`): expired-cookie purge (compare-and-retry, predicate excludes session/tombstone entries) on startup + alarm; orphaned-store purge (two-run confirmation, alarm-only). `duplicateSession` now writes list-then-store so GC can't collect a live new session. DNR rule-budget exhaustion now logs a warning. Added `alarms` permission.

### 2026-06-02 — Remove Snapshot Protection (Superseded by Set-Cookie Strip)

**Type:** Refactor

#### Changes

- Removed `protectDefaultTabsOnHost` and its two call sites (`setSession`, `createSessionTab`). It snapshotted default-session tabs into hidden `_snap_` sessions to shield them from cookie contamination.
- This is now redundant: isolated tabs already strip outbound `Set-Cookie` via a base DNR rule (`responseHeaders: set-cookie remove`), so they never write to the shared global jar and default-session tabs stay uncontaminated.
- Side benefit: default tabs are no longer silently frozen into snapshots on session creation, so real logins/logouts in those tabs keep reflecting in the global jar.
- `_snap_` handling paths in `dnr-manager.ts` / `message-handler.ts` are retained for backward-compat with snapshots persisted by older versions; nothing creates new `_snap_` sessions.
- DRY: exported `normalizeCookiePath` from `cookie-parser.ts` and removed the duplicate `normalizeStoredPath` in `dnr-cookie-rule-builder.ts`.
- Simplified the `Set-Cookie` `Domain=` leading-dot normalization (behavior-preserving).
- Bumped manifest 0.0.5 → 0.0.6.

### 2026-05-26 — Multi-Domain Cookie Isolation (PSL + Composite Cookie Store)

**Type:** Fix

#### Changes

- Added bundled Public Suffix List support, including private hosted-domain rules:
  - `src/lib/public-suffix.ts` implements `getEtld1()` and `isPublicSuffix()`
  - `src/lib/public-suffix-data.ts` is generated by `npm run generate:psl`
- DNR rules now scope by registrable domain without reusing one cookie header for every sibling subdomain:
  - `requestDomains:[getEtld1(boundHost)]` covers sibling subdomains in one login flow
  - `urlFilter:'|https://'` / `|http://'` scheme anchoring remains in place
  - host/path-specific cookie rules only inject cookies matching the request host and path
- Cookie store promoted from flat `Record<name, entry>` to composite keys:
  - keys are `cookieKey(name, domain, path)`
  - `serializeCookieHeader()` now preserves same-name cookies across domain/path variants and supports request URL filtering
  - header serialization sorts by path length descending
- `Set-Cookie` parsing now rejects `Domain=` values that are public suffixes such as `co.il`, `.com`, or `github.io`
- Default Set-Cookie paths now follow browser directory-path behavior
- `updateCookie` and snapshot capture paths now write full cookie metadata (`name`, `domain`, `path`, `secure`, `httpOnly`) into the session store
- `document.cookie` updates are stored under the current document host/default path instead of the session's original host

#### Test Coverage Added

- `tests/public-suffix.test.js` — eTLD+1 resolution, wildcard rules, exception rules, private suffixes, public-suffix checks
- `tests/dnr-rule-condition.test.js` — DNR rule shape for HTTPS, HTTP, snap-session fallback, and host/path-specific cookie rules
- Extended `tests/cookie-parser.test.js` for composite-key coexistence, path ordering, request URL filtering, default paths, and public-suffix `Domain=` rejection
- Extended `tests/background-session-lifecycle.test.js` for current-document cookie writes and scoped deletion

### 2026-05-19 — Security Hardening (Phases 1–9)

**Type:** Security

#### Changes

**High severity (all closed)**
- H1: `getSessionForBootstrap` now filters HttpOnly cookies from the page-bound cookie string; `document.cookie` no longer exposes server-set HttpOnly tokens
- H2: DNR rules are now host-scoped; as of 2026-05-26 they target the bound eTLD+1 plus scheme anchor for multi-subdomain login flows
- H3: `updateCookie` handler derives `sessionId` from `tabSessions[sender.tab.id]` (not the page payload); switch to merge-into-existing semantics; empty payload no longer wipes the store; httpOnly cookies are immutable via this path

**Medium severity**
- M1: Per-sessionId write lock (`withCookieLock`) serializes concurrent `Set-Cookie` captures
- M2: DNR rule condition uses `urlFilter` with scheme anchor to prevent HTTP-downgrade cookie leakage
- M4: `Math.random()` → `crypto.randomUUID()` for session ID generation
- M5: `parseSetCookie` rejects `Domain=` values that don't match or aren't a parent of the request host

**Low / Info**
- I3: Explicit `content_security_policy` block added to manifest (`base-uri 'none'`)
- I4: Dead `renameSessions` handler removed
- L1: Trust-model comment added to `updateCookie` handler
- L2: Cookie name/value validation in `page-api-proxy.ts` (CRLF/control-char rejection)
- L5: GitHub Actions workflow SHA-pinned
- L6: IndexedDB and Cache API proxies use `Object.defineProperty({ configurable: false })`
- I1: `npm audit` → 0 vulnerabilities (postcss, ws, vitest bumped)

#### Test Coverage Added
- 87 unit tests (up from 59): cookie-write-lock, session-manager, H3 merge semantics, H1 bootstrap filtering, M5 domain validation, M2 serializer options

### 2026-05-16 — Popup Quick Theme Toggle

**Type:** Feature (UX)

#### Changes
- Added one-click theme toggle to popup hero (`src/popup/popup.html`, `popup.ts`, `popup.css`)
  - Cycles `light → dark → system` on each click; icon swaps to reflect current state
  - Reuses existing `ext_settings.theme` storage and `html[data-theme]` CSS pipeline
  - Preserves other `ext_settings` fields (e.g. `notifyOnAutoAssign`) when writing
- Extended `tests/e2e/theme-switcher.test.ts` with three popup-toggle cases (cycle, persistence, settings preservation)
- Options page 3-button picker unchanged — popup toggle mirrors it for fast access

### 2026-05-16 — E2E Test Suite Implementation

**Type:** Feature (Testing Infrastructure)

#### Changes
- Added Playwright E2E test suite with 17 tests across 6 test files
- Created `playwright.config.ts` with chromium-extension project configuration
  - 5 workers for parallel test execution
  - Automatic retries enabled on CI environments
- Implemented `tests/e2e/mock-cookie-server.ts` — local HTTP server for cookie testing
  - Uses random port binding (port 0) for test isolation
  - Supports Set-Cookie header responses for isolation verification
- Implemented `tests/e2e/extension-fixtures.ts` — reusable Playwright fixtures
  - `context` — Extension context with background service worker
  - `extensionId` — Dynamically resolved extension ID
  - `mockServerUrl` — Mock server endpoint for tests
  - `popupPage` — Extension popup page reference
- Updated `vitest.config.ts` to exclude `tests/e2e/**` from Vitest runs
- Added GitHub Actions workflow (`.github/workflows/test.yml`)
  - Unified test job: unit (Vitest) + E2E (Playwright)
  - Uses `xvfb-run` on Linux for headless Chrome testing
  - Runs on all PRs and main branch pushes

#### Test Coverage
**Test Files:**
- `tests/e2e/popup-navigation.spec.ts` — Popup UI navigation, session switching, tab switching, search filtering
- `tests/e2e/session-crud.spec.ts` — Session creation, renaming, deletion, error handling
- `tests/e2e/auto-assign-rules.spec.ts` — Rule creation, pattern matching, enable/disable toggles
- `tests/e2e/isolation.spec.ts` — Per-session cookie isolation via DNR, Set-Cookie interception
- `tests/e2e/keyboard-shortcuts.spec.ts` — Ctrl+Shift+S popup trigger, Ctrl+Shift+Right/Left session cycling
- `tests/e2e/export-import.spec.ts` — Session list export/import, backup restoration, conflict handling

**Test Count:** 17 tests, 100% passing

#### Breaking Changes
None. E2E tests run separately from unit tests; no API or behavior changes.

#### Migration Guide
No migration required. E2E tests are opt-in development tool.

**Run commands:**
```bash
npm test              # Unit tests only (Vitest)
npm run test:e2e      # E2E tests only (Playwright)
npm run test:all      # Both unit + E2E
```

---

## v0.4.0 (2026-05-04)

### Shipped Features

#### 1. Keyboard Shortcuts
- `Ctrl+Shift+S` (Mac: `Cmd+Shift+S`) — Open SessionShift popup
- `Ctrl+Shift+Right` — Cycle to next session on active tab
- `Ctrl+Shift+Left` — Cycle to previous session on active tab
- Configurable at `chrome://extensions/shortcuts`
- Wrapping behavior: last session → first session

#### 2. Lazy DNR Optimization
- Per-tab 50ms debounce timer for DNR rule updates
- Batches rapid Set-Cookie responses
- Reduces rule churn during high-frequency network activity

#### 3. Test Coverage Expansion
- 94 unit tests (up from ~36)
- New test suites: cookie-parser, page-proxy-storage, background-session-lifecycle
- ~75% code coverage of testable JS

#### 4. Accessibility (WCAG 2.1 AA)
- Focus-visible rings on all interactive elements
- ARIA labels, roles, live regions
- Color contrast ≥4.5:1
- Full keyboard navigation support

#### Modified Files
- `manifest.json` — Version 0.3.0 → 0.4.0, added `commands` section
- `background.js` — DNR debounce, keyboard command handlers
- `popup/popup.js` — ARIA attributes, tab switching, search
- `options/options.js` — ARIA labels, form controls
- CSS files — Focus ring styles, contrast improvements

#### Test Files Created
- `tests/cookie-parser.test.js` (156 LOC, 32 tests)
- `tests/page-proxy-storage.test.js` (118 LOC, 18 tests)
- `tests/background-session-lifecycle.test.js` (94 LOC, 12 tests)

---

## v0.3.0 (2026-03-15)

### Shipped Features

#### 1. Session Colors
- Hue-based 7-color palette for visual differentiation
- Color assigned on session creation, persisted in storage
- Popup icon and badge reflect session color

#### 2. Export/Import
- Export all sessions + cookies as JSON backup file
- Import from backup (conflict handling: append "(imported)" suffix)
- Allows session migration across browsers

#### 3. Session Duplication
- Clone existing session with all cookies
- New session named "{original} (copy)"
- Allows template-based session creation

#### 4. Settings Page
- `notifyOnAutoAssign` toggle — Notify when tab auto-assigns
- Settings persisted to `chrome.storage.local`
- About tab with version display

#### Modified Files
- `manifest.json` — Version 0.2.0 → 0.3.0, options page added
- `popup/popup.js` — Color assignment, duplication handler
- `options/options.js` — Settings CRUD, export/import handlers
- `lib/session-store.js` — Duplication and import/export methods

---

## v0.2.0 (2026-01-20)

### Shipped Features

#### 1. Global Session List
- "This site" + "All sessions" tabs in popup
- Search/filter across all sessions by name and origin
- Reduces need to manually track sessions across origins

#### 2. Auto-Assign Rules
- Pattern-based rule creation (exact + wildcard matching)
- Enable/disable toggles (persistent)
- Auto-assign tabs matching patterns to designated sessions
- Reduces manual session switching on common sites

#### 3. Context Menu Integration
- Right-click menu to create session for current tab
- Right-click menu to switch to session (for current site)
- Faster workflow for frequent users

#### 4. Session Snapshots (Internal)
- Automatic snapshot sessions (`_snap_${tabId}_${random}`) on new isolated session creation
- Protects default-session tabs from cookie contamination
- Transparent to users; improves reliability

#### Modified Files
- `manifest.json` — Version 0.1.0 → 0.2.0, context menu permissions added
- `popup/popup.js` — Tab switching, search, global view
- `options/options.js` — Rules management UI
- `background.js` — Context menu handlers, auto-assign logic, snapshot creation
- `lib/rule-matcher.js` — Pattern matching for auto-assign rules

#### Test Files Created
- `tests/rule-matcher.test.js` (80 LOC, 18 tests)

---

## v0.1.0 (2025-12-20)

### Initial Release

#### 1. Core Session Isolation
- Per-tab DNR rule isolation — cookies isolated via network rules
- Session CRUD (create/switch/delete)
- In-memory tab→session map with persistent storage fallback

#### 2. Badge & Icons
- Colored session icons via OffscreenCanvas (19×19 px)
- Badge display: session label + color
- Updates on session switch

#### 3. Popup UI
- Current session display (hero section)
- Session list per-origin with switch/delete buttons
- Create session form with name input
- Reset to default button with confirmation

#### 4. Content Script Bridge
- ISOLATED world content script for cookie bootstrap
- MAIN world page-api-proxy for API interception
- Nonce-authenticated postMessage for security
- Storage prefix isolation (localStorage/sessionStorage/indexedDB)

#### 5. Message Routing
- chrome.runtime.onMessage discrimination via union types
- Handlers: setSession, getSession, updateCookie, deleteSession, etc.

#### Files Created
- Core: `background.js`, `content.js`, `page-api-proxy.js`, `manifest.json`
- UI: `popup/popup.html`, `popup/popup.js`, `popup/popup.css`
- Options: `options/options.html`, `options/options.js`, `options/options.css`
- Lib: `lib/cookie-parser.js`, `lib/session-store.js`

#### Test Files Created
- `tests/background-batch.test.js` (140 LOC, 22 tests)
- `tests/options-filter.test.js` (130 LOC, 14 tests)

---

## Known Issues

None currently tracked. See [BACKLOG.md](BACKLOG.md) for deferred features.

---

## Release Process

1. **Version Bump** — Update `manifest.json` `version` field
2. **Changelog Update** — Add entry to this file
3. **Git Tag** — Create annotated tag: `git tag -a v0.4.0 -m "v0.4.0"`
4. **GitHub Release** — Publish on GitHub Releases with changelog excerpt
5. **Chrome Web Store** — Submit via developer dashboard; auto-publishes to users

---

## References

- [Development Roadmap](development-roadmap.md) — Future phases and timeline
- [System Architecture](system-architecture.md) — Technical design
- [Code Standards](code-standards.md) — Implementation guidelines
