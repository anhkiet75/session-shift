# SessionShift — System Architecture

## Executive Summary

SessionShift isolates cookies and storage per-tab by intercepting at three layers:

1. **Network Layer (DNR)** — Rewrite Cookie headers per-tab via Declarative Net Request
2. **Storage Layer** — Maintain per-session cookie stores in chrome.storage.local
3. **DOM Layer** — Override document.cookie, localStorage, sessionStorage, indexedDB via content scripts

Each layer is independent; cookies don't leak because:
- DNR rules prevent wrong cookies from being sent in requests
- Storage isolation keeps each session's data separate
- DOM proxies ensure page scripts see only their session's data

---

## Permissions & Capabilities

The extension requires the following permissions in `manifest.json`:

| Permission | Used For | v0.6.0 |
|-----------|----------|--------|
| `declarativeNetRequest` | Per-tab cookie header rewriting via DNR rules | Core |
| `storage` | Persist profiles, cookies, settings to chrome.storage.local/.session | Core |
| `tabs` | Monitor tab lifecycle (onRemoved, onActivated, onUpdated) | Core |
| `webRequest` | Capture Set-Cookie responses for session stores (webRequest.onHeadersReceived) | Core |
| `webNavigation` | Detect link-opened tabs for profile inheritance (onCreatedNavigationTarget) | v0.6.0 |
| `contextMenus` | Right-click menu to create/switch sessions | v0.2.0+ |
| `alarms` | Schedule periodic storage garbage collection (1440 min = 24h) | v0.5.0+ |

---

## Service Worker Lifecycle

### Startup Sequence

```
1. Chrome launches service worker
   ↓
2. restoreTabSessions() — Load tab→session map from storage.session
   ↓
3. chrome.tabs.onActivated listener ready
   ↓
4. chrome.runtime.onMessage listener ready
   ↓
5. Ready to accept messages from popup, content scripts, pages
```

**Duration:** <50ms (storage read + listener registration)

**Failure modes:**
- storage.session unavailable → Fall back to in-memory map (not persisted)
- Listener registration fails → Extension breaks; requires manual reload

### During Runtime

**Persistent state:**
- `tabSessions` in-memory map (synced to storage.session on change)
- Message handlers for popup, content, page scripts

**Ephemeral state:**
- DNR rules (session-scoped; cleared on service worker restart)
- Chrome action badge text (reset on restart; recreated on tab activation)

### Service Worker Restart Triggers

Chrome may restart the service worker at any time:
- 5+ minutes of inactivity
- Memory pressure
- Extension update
- Browser update

**Recovery:**
1. restoreTabSessions() reloads tab→session map from storage.session
2. DNR rules are gone; background.js reapplies them on next setSession or tab activation
3. Badge text is reset; refreshBadge rebuilds it from session list

---

## Linked Tab Inheritance (v0.6.0+)

### Problem

When a user clicks a link with `target="_blank"`, uses Ctrl+Click, or middle-clicks in a tab assigned to an isolated profile, the new tab opens in Chrome's default cookie jar instead of inheriting the opener's profile. Users had to manually re-assign the new tab to the same profile.

### Solution: Automatic Profile Inheritance on Link Click

**Concept:** If enabled, new tabs opened from links automatically inherit their opener's profile, maintaining cookie isolation across the browsing session.

```
User in Tab 1 (Work profile) clicks a link (target="_blank")
  ↓
chrome.webNavigation.onCreatedNavigationTarget fires synchronously with url
  ↓
Check: autoInheritProfileForLinkedTabs setting enabled?
  ↓
Check: opener has non-internal profile?
  ↓
tabSessions[newTabId] = openerProfileId
  ↓
Install cookie-strip DNR rule for first navigation
  ↓
Apply DNR rules for inherited profile
  ↓
New tab inherits Work profile's cookies
```

### Design Details

**When it triggers:**
- `chrome.webNavigation.onCreatedNavigationTarget` listener fires when:
  - Link has `target="_blank"`
  - Link is Ctrl+Clicked
  - Link is middle-clicked
- **Not** triggered by:
  - `window.open()` calls (page JavaScript, not declarative links)
  - `createSessionTab` flow (already explicitly isolated)
  - Tabs already assigned to a profile

**Why not `chrome.tabs.onCreated`:**
`tabs.onCreated` fires before the destination URL is known for link-opened tabs (tab.url is empty, tab.pendingUrl is undefined). Too late to install a Cookie-strip DNR rule before the first request. `chrome.webNavigation.onCreatedNavigationTarget` is purpose-built for this case and delivers the URL synchronously.

**First-request cookie leak (known limitation):**
The very first network request from a newly-linked tab may not be hard-guaranteed cookie-clean because Chrome starts navigating the link-opened tab in a single browser-driven step the extension can't delay (unlike `createSessionTab`, which creates the tab as about:blank, installs DNR rules, then triggers navigation — fully controlling timing). Isolation is deterministic from the second request onward. This mirrors the existing behavior of `createSessionTab` itself.

**Opt-out via toggle:**
- Default: On
- User disables via Options → Settings → "Auto-open linked tabs in the same profile"
- Persisted in `chrome.storage.local` as `ext_settings.autoInheritProfileForLinkedTabs`; only an explicit `false` disables it — absent/`undefined` (pre-existing users, fresh installs) means enabled

---

## Network-Layer Cookie Isolation (DNR) & Debounce

### Problem
The browser's global cookie jar is shared across all tabs. We need each tab to send/receive a different set of cookies. Additionally, rapid cookie updates (cascading Set-Cookie responses) can thrash DNR rule regeneration.

### Solution: Declarative Net Request (DNR) + Lazy Debounce

**Concept:** Per-tab DNR rules rewrite the Cookie header before the request leaves the browser.

```
Tab 1 (session A) sends request to example.com
  ↓
DNR Rule ID 1: Replace Cookie header with session A's cookies
  ↓
Network sends: Cookie: session_a_cookie_1=value; session_a_cookie_2=value
  ↓
Server responds: Set-Cookie: new_cookie=new_value
  ↓
content.js intercepts Set-Cookie, sends to background.js
  ↓
background.js parses and stores in session A's cookie store (chrome.storage.local)
  ↓
Next request from Tab 1 uses updated DNR rule with new_cookie included
```

### DNR Rebuild Strategy

Captured `Set-Cookie` responses rebuild DNR immediately:

```javascript
await setCookieStore(sessionId, store);
await updateDNRRulesForTab(tabId, sessionId);
```

**Why:** Auth flows can set a cookie from a navigation, fetch, or XHR response and immediately issue the next request. Delaying DNR publication can make that next request miss the newly captured profile cookie.

### DNR Rule Structure

```javascript
const rule = {
  id: (tabId % 1000000) + 1,     // Stable per-tab ID
  priority: 100,                  // Higher = takes precedence
  action: {
    type: 'modifyHeaders',
    requestHeaders: [
      {
        header: 'Cookie',
        operation: 'set',         // Replace Cookie header for a matching host/path scope
        value: 'session_cookie_1=value; session_cookie_2=value'
      }
    ]
  },
  condition: {
    tabIds: [tabId],              // Only applies to this tab
    urlFilter: '|https://',       // Preserve scheme boundary
    requestDomains: ['google.com'], // eTLD+1 matches google.com + subdomains
    resourceTypes: [              // All request types
      'main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
      'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
      'webbundle', 'other'
    ]
  }
}

await chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: oldRuleIds,
  addRules: [baseRemoveRule, ...scopedCookieRules]
})
```

### Key Properties

| Property | Value | Why |
|----------|-------|-----|
| **Scope** | session-scoped | Cleared on service worker restart (OK; we reapply on next action) |
| **Matching** | tabIds + split base rules + host/path cookie rules | One tab; base Cookie/Set-Cookie stripping covers cross-site subresources, then request-accurate cookie injection covers stored isolated cookies |
| **Scheme guard** | scoped `set` rules use `urlFilter: '|https://'` / `|http://'`; base subresource stripping matches all schemes | Per-host cookie injection respects the scheme boundary; subresource stripping also catches http/ws requests |
| **Header operation** | two base rules for cross-site subresources: request `Cookie: remove` + response `set-cookie: remove`; scoped 'set' | Strips global cookies from third-party subresources, then injects matching isolated cookies; navigation and same-site auth requests can still carry freshly set login cookies |
| **Priority** | 100 base, higher for longer paths/exact hosts | Browser-like path ordering and host-only precedence |

### Registrable-Domain Scoping (PSL)

v0.5.0 widens the response-stripping match from exact host to registrable domain (eTLD+1) using a bundled Public Suffix List snapshot:

- `src/lib/public-suffix-data.ts` is a committed ICANN + private PSL snapshot
- `src/lib/public-suffix.ts` resolves `getEtld1(host)` and `isPublicSuffix(domain)`
- `updateDNRRulesForTab()` adds two base rules for **cross-site subresource** traffic: a request-side `Cookie: remove` and a response-side `set-cookie: remove`
- `src/background/dnr-cookie-rule-builder.ts` adds higher-priority host/path-specific rules that call `serializeCookieHeader(..., { requestUrl })`

This fixes multi-subdomain login flows such as `www.google.com` → `accounts.google.com` while keeping host-only and path-scoped cookies from leaking to sibling subdomains or unrelated paths.

**Third-party Cookie strip:** the request-side `Cookie: remove` is widened to match cross-site subresources/iframes in the tab (every scheme, excluding the active top-level site's eTLD+1) so they stop sending the user's default-jar cookies to third parties. Navigation requests are excluded so login redirects can carry freshly set cookies before async DNR rebuilds complete. The response-side `set-cookie: remove` applies to all subresources, including same-site ones, so isolated tabs never write auth cookies into Chrome's shared jar — same-site fetch/XHR auth responses get strict response stripping with no jar passthrough.

### Auth Transition Bridge

Strict response-side `Set-Cookie` stripping on same-site subresources removes the shared-jar fallback that auth flows like `await fetch('/login'); location.href = '/dashboard'` used to rely on. The bridge (`src/lib/auth-transition-bridge.ts`) closes that gap without reopening the jar:

1. `src/page-api-proxy.ts` wraps `window.fetch` in the MAIN world. Eligible requests (same-origin, `http`/`https`) get a unique `X-SessionShift-Bridge` header and the wrapped fetch does not resolve until a completion signal arrives or `AUTH_BRIDGE_TIMEOUT_MS` (2s) elapses — fail-open by design.
2. `src/background/dnr-manager.ts` maps the bridge header to the originating `requestId`/`tabId`/`frameId` on `onBeforeSendHeaders`. On `onHeadersReceived`, it captures any `Set-Cookie`, calls `updateDNRRulesForTab()`, then sends `bridgeCookieSyncDone` to the tab so the page only resumes after isolated cookies are live in DNR. If no `Set-Cookie` arrives, `onCompleted`/`onErrorOccurred` resolve the bridge after a short settle delay (`AUTH_BRIDGE_DNR_SETTLE_MS`) instead of leaving it pending.
3. `src/content.ts` relays `bridgeCookieSyncDone` from the service worker into the page's nonce-authenticated message channel.

This is fetch-only; XHR is an explicit follow-up rather than bridged today. The page-side constants are duplicated in `page-api-proxy.ts` (rather than imported) because that file is injected as a standalone MAIN-world script with no module imports.

### Limitations

1. **DNR rules don't intercept Set-Cookie responses** — We use webRequest listener to capture them
2. **Rules are cleared on service worker restart** — We reapply on next tab action
3. **Rules are ephemeral** — No persistence; we must regenerate from session store
4. **Large cookie strings** — Each rule has size limits (practical: <10MB per extension)

---

## Keyboard Shortcuts & Commands

### Implementation

v0.4.0 adds three keyboard shortcuts via `manifest.json` `commands` block:

```json
"commands": {
  "_execute_action": {
    "suggested_key": {
      "default": "Ctrl+Shift+S",
      "mac": "Command+Shift+S"
    },
    "description": "Open SessionShift popup"
  },
  "session-next": {
    "suggested_key": {
      "default": "Ctrl+Shift+Right",
      "mac": "Command+Shift+Right"
    },
    "description": "Switch to next session for this tab"
  },
  "session-prev": {
    "suggested_key": {
      "default": "Ctrl+Shift+Left",
      "mac": "Command+Shift+Left"
    },
    "description": "Switch to previous session for this tab"
  }
}
```

### Message Handling

`background.js` listens for commands via `chrome.commands.onCommand`:

```javascript
chrome.commands.onCommand.addListener(async (command) => {
  const tab = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab[0]?.id;
  
  if (command === 'session-next') {
    // Get current session, find next in list, switch to it
    const sessions = await getSessionsForOrigin(tab[0].url);
    const current = tabSessions[tabId];
    const nextIndex = (sessions.indexOf(current) + 1) % sessions.length;
    await setSession(tabId, sessions[nextIndex]);
  }
  
  if (command === 'session-prev') {
    // Get current session, find previous in list, switch to it
    const sessions = await getSessionsForOrigin(tab[0].url);
    const current = tabSessions[tabId];
    const prevIndex = (sessions.indexOf(current) - 1 + sessions.length) % sessions.length;
    await setSession(tabId, sessions[prevIndex]);
  }
  
  // '_execute_action' is handled automatically by Chrome (opens popup)
});
```

### User Customization

Users can customize shortcuts at `chrome://extensions/shortcuts`.

---

## Accessibility Architecture

### Overview

v0.4.0 implements WCAG 2.1 Level A compliance across popup and options pages:

1. **Focus Management** — `:focus-visible` CSS rings on all interactive elements
2. **ARIA Labels** — `aria-selected`, `aria-controls`, `aria-live`, `aria-label` on buttons/inputs
3. **Semantic HTML** — `role="tab"`, `role="tabpanel"`, `role="tablist"` for tab groups
4. **Screen Reader Support** — aria-live announcements for dynamic content

### Popup Accessibility

**File:** `popup/popup.html` + `popup/popup.css` + `popup/popup.js`

```html
<!-- Tab group (ARIA roles) -->
<div class="v2-tabs" role="tablist">
  <button class="v2-tab active" 
          data-mode="origin" 
          role="tab" 
          id="tabOrigin" 
          aria-selected="true" 
          aria-controls="panelOrigin">
    This site
  </button>
  <button class="v2-tab" 
          data-mode="global" 
          role="tab" 
          id="tabGlobal" 
          aria-selected="false" 
          aria-controls="panelGlobal">
    All sessions
  </button>
</div>

<!-- Live region for dynamic counts -->
<span class="v2-list-count" id="sessionCount" aria-live="polite" aria-atomic="true">0</span>

<!-- Search input with label -->
<input type="search" 
       id="searchInput" 
       placeholder="Search sessions or sites…" 
       aria-label="Search sessions">
```

**CSS Focus Rings:**

```css
.v2-tab:focus-visible,
.v2-btn:focus-visible,
input:focus-visible {
  outline: 2px solid #4CAF50;
  outline-offset: 2px;
}
```

**JS Tab Toggle:**

```javascript
function switchTab(mode) {
  document.getElementById('tabOrigin').setAttribute('aria-selected', mode === 'origin');
  document.getElementById('tabGlobal').setAttribute('aria-selected', mode === 'global');
}
```

### Options Accessibility

**File:** `options/options.html` + `options/options.css` + `options/options.js`

Similar structure to popup, with added support for:
- `role="tabpanel"` on tab panels
- `aria-labelledby` linking panels to tab buttons
- `aria-live` on status messages (import success/failure)
- `aria-controls` mapping buttons to controlled regions

### Keyboard Navigation

- **Tab key** — Navigate between interactive elements in logical order
- **Shift+Tab** — Reverse direction
- **Arrow keys** — Move between tab buttons (handled via keyboard event listener)
- **Enter/Space** — Activate focused button

### Screen Reader Testing

Tested with:
- NVDA (Windows)
- JAWS (Windows)
- VoiceOver (macOS)

All interactive elements announce:
- Element type (button, input, tab)
- Current state (selected, active, checked)
- Associated label or aria-label
- Controlled regions (aria-controls target)

---

## Storage-Layer Cookie Isolation

### Problem
Cookies must persist across service worker restarts. DNR rules don't persist, so we need a recovery mechanism.

### Solution: chrome.storage.local + session-keyed stores

**Architecture:**
```javascript
// Storage key pattern: cookies_${sessionId}
{
  "cookies_session_abc123de": {
    "SID|.github.com|/": {
      name: "SID",
      value: "ghp_abc123...",
      domain: ".github.com",
      path: "/",
      expires: 1735689600000,
      secure: true,
      httpOnly: true
    },
    "prefs|www.github.com|/settings": {
      name: "prefs",
      value: "dark_mode=true",
      domain: "www.github.com",
      path: "/settings",
      expires: null,
      secure: false,
      httpOnly: false
    }
  },
  "cookies_session_def456gh": { ... },
  "profiles": [
    { id: "session_abc123de", name: "Work", hue: 212 },
    { id: "session_def456gh", name: "Personal", hue: 158 }
  ]
}
```

**Profile model (v0.6.0+):** Sessions are **global profile containers** — a single `profiles`
key holds every profile `{ id, name, hue }` (no `origin`). A profile's cookie jar
(`cookies_${id}`, already global) applies on every site a tab assigned to it visits.
This replaced the former per-origin `list_${origin}` keys; `migrateToProfiles()`
(`lib/profile-migration.ts`) folds legacy `list_*` entries into `profiles` on
`onInstalled` (deduped by id, idempotent). Profiles have no bound host, so the DNR
rules base-strip `Cookie` and `Set-Cookie` for cross-site subresource traffic.
DNR scheme is taken from the current tab URL, and Secure cookies are emitted only
for an explicitly-https tab.

Cookie entries are keyed by `cookieKey(name, domain, path)`, not just by cookie name. This lets same-name cookies from sibling subdomains coexist in one isolated session and preserves browser-like Cookie-header ordering by longest path first. Network serialization also filters by request URL before building the Cookie header.

**Recovery on service worker restart:**
1. restoreTabSessions() loads tab→session map
2. User clicks a tab or opens popup
3. updateDNRRulesForTab() reads from cookies_${sessionId}
4. serializeCookieHeader() converts matching store entries back to Cookie header strings for each host/path rule
5. DNR rule is reapplied

**No data loss** because:
- Cookies stored in chrome.storage.local (persists forever)
- Tab→session mapping stored in chrome.storage.session (survives ~5 min of inactivity)
- Even if mapping lost, user can manually re-assign session to tab

---

## DOM-Layer Cookie & Storage Isolation

### Problem
Page JavaScript needs to read/write cookies and storage. We must intercept these APIs and scope them to the session.

### Solution: Content Script Bridge

**Flow:**
```
Page JS: document.cookie = 'session_var=123'
  ↓
page-api-proxy.js intercepts setter
  ↓
Adds to in-memory cookieMap: { session_var: '123' }
  ↓
Sends postMessage to content.js: { action: 'updateCookie', ... }
  ↓
content.js validates nonce, relays to background.js
  ↓
background.js parses and updates session store
  ↓
DNR rule regenerated with new cookie for next request
```

### Three-Script Architecture

#### 1. content.js (ISOLATED World)
**Runs:** At document_start, before page scripts load  
**Responsibilities:**
- Request session bootstrap from background
- Generate nonce for message authentication
- Inject sessionId + nonce into DOM (via data attributes)
- Listen for postMessage from page-api-proxy.js
- Relay to background.js

**Security:** No DOM access (can't read page data), can call chrome APIs

```javascript
// Runs in ISOLATED world
const nonce = crypto.randomUUID()
document.documentElement.dataset.extNonce = nonce
window.addEventListener('message', (event) => {
  if (event.data.nonce !== nonce) return  // Reject unsigned
  // Relay to background.js
  chrome.runtime.sendMessage({ action: 'updateCookie', payload: event.data.payload })
})
```

#### 2. page-api-proxy.js (MAIN World)
**Runs:** At document_start, after content.js loads  
**Responsibilities:**
- Read sessionId + nonce from DOM (set by content.js)
- Build storage proxies for localStorage/sessionStorage
- Override document.cookie getter/setter
- Proxy indexedDB and Caches APIs
- Bootstrap cookies via postMessage to content.js

**Security:** Has DOM access (can read page data), can't call chrome APIs

```javascript
// Runs in MAIN world
const nonce = document.documentElement.dataset.extNonce
const cookieMap = new Map()

Object.defineProperty(document, 'cookie', {
  get() {
    // Return cookies from in-memory map
    return Array.from(cookieMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  },
  set(str) {
    // Parse incoming cookie (name=value; attributes...)
    const [pair] = str.split(';')
    const [name, value] = pair.split('=')
    cookieMap.set(name, value)
    // Notify background.js of the change
    window.postMessage({ nonce, action: 'updateCookie', payload: { name, value } }, '*')
  }
})
```

#### 3. background.js (Service Worker)
**Responsibilities:**
- Receive updateCookie messages from content.js
- Parse and store in session store
- Regenerate DNR rules
- Handle session bootstrap requests

```javascript
async function handleMessage(request, sender) {
  switch (request.action) {
    case 'updateCookie':
      const { sessionId } = tabSessions[sender.tab.id] || 'default'
      const store = await getCookieStore(sessionId)
      store[request.payload.name] = { value: request.payload.value, ... }
      await setCookieStore(sessionId, store)
      await updateDNRRulesForTab(sender.tab.id, sessionId)
      break
  }
}
```

### Nonce Authentication

**Why:** Prevent malicious page scripts from forging postMessage events.

**How:**
1. content.js generates `crypto.randomUUID()` and stores in `data-ext-nonce`
2. page-api-proxy.js reads nonce from DOM
3. page-api-proxy.js includes nonce in every postMessage to content.js
4. content.js validates nonce before relaying to background.js
5. If nonce is wrong, message is silently dropped

**Attack prevented:**
```javascript
// Malicious page script tries to hijack postMessage:
// window.postMessage({ action: 'updateCookie', payload: { sessionId: 'other_session', ... } }, '*')
// ↓
// content.js rejects: no nonce or wrong nonce
// ↓
// Attack fails
```

### Storage Proxy Implementation

v0.4.0 extracts the storage proxy into a reusable library: `lib/storage-proxy.js`

**File:** `lib/storage-proxy.js`

```javascript
export function makeStorageProxy(realStorage, prefix) {
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
      // Return nth key matching prefix (without prefix)
    },
    get length() {
      // Count keys matching prefix
    }
  };
}
```

**Usage in page-api-proxy.js:**

```javascript
const prefix = '__ext_' + sessionId + '_'

Object.defineProperty(window, 'localStorage', {
  get: () => makeStorageProxy(realLocalStorage, prefix)
})
```

**Why extracted?**
- Unit testable (page-api-proxy.js runs in MAIN world; can't import modules)
- Reusable logic across content script files
- Clear separation of concerns
- 11 unit tests in `tests/page-proxy-storage.test.js`

**Why prefix?** localStorage is shared across all tabs. Without a prefix, two tabs in different sessions would overwrite each other's keys.

**Data never mixed** because:
- Tab A (session_abc) writes `__ext_session_abc_key`
- Tab B (session_def) writes `__ext_session_def_key`
- Tab A reads with prefix `__ext_session_abc_`, sees only its own data

### indexedDB and Caches Proxying

Same concept: prefix-scope database/cache names.

```javascript
// page-api-proxy.js
const originalOpen = window.indexedDB.open
window.indexedDB.open = function(name, version) {
  const prefixedName = prefix + name
  return originalOpen.call(window.indexedDB, prefixedName, version)
}

const originalDeleteDatabase = window.indexedDB.deleteDatabase
window.indexedDB.deleteDatabase = function(name) {
  const prefixedName = prefix + name
  return originalDeleteDatabase.call(window.indexedDB, prefixedName)
}
```

---

## Session Lifecycle State Machine

### States and Transitions

```
┌──────────────────────────────────────────────────────────────┐
│ User creates session on origin A                             │
│ 1. popup.js generates sessionId: "session_abc123de"          │
│ 2. Session added to list_A in storage.local                  │
│ 3. background.js receives setSession message for Tab N       │
│ 4. tabSessions[N] = "session_abc123de"                       │
│ 5. updateDNRRulesForTab(N, "session_abc123de")              │
│ 6. persistTabSessions() writes to storage.session            │
│ ↓                                                             │
│ ACTIVE — Tab N is assigned to session_abc123de              │
│ DNR rule is applied; page sees session cookies              │
└──────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────┐
│ User navigates Tab N to different origin B                   │
│ 1. background.js receives tabs.onUpdated(tabId, changeInfo) │
│ 2. sessionId is still "session_abc123de" (follows tab)      │
│ 3. DNR rule is reapplied with new origin's cookies         │
│ (cookie store is shared; origin doesn't affect it)         │
│ ↓                                                             │
│ ACTIVE (Different Origin) — Tab N stays in session_abc123de │
│ But page now has cookies from origin B in that session      │
└──────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────┐
│ User clicks "Reset to Default" in popup                      │
│ 1. background.js receives setSession(Tab N, "default")      │
│ 2. tabSessions[N] = "default"                               │
│ 3. updateDNRRulesForTab(N, "default") removes rule         │
│ 4. persistTabSessions()                                      │
│ ↓                                                             │
│ DEFAULT — Tab N uses browser's global cookie jar            │
│ DNR rule is removed; page sees native cookies              │
└──────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────┐
│ Tab N is closed                                              │
│ 1. browser closes tab                                        │
│ 2. tabSessions[N] becomes orphaned (not cleaned up)         │
│ 3. On next service worker restart, orphaned entries remain  │
│ (no harm; just unused storage)                              │
│ ↓                                                             │
│ CLOSED — Tab N no longer exists                             │
│ Entry in tabSessions is ignored                             │
└──────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────┐
│ User clicks "Delete Session" on session_abc123de             │
│ 1. popup.js removes from list_A                             │
│ 2. background.js receives deleteSession("session_abc123de") │
│ 3. Unassign all tabs currently in this session              │
│ 4. Delete cookies_session_abc123de from storage.local       │
│ 5. persistTabSessions()                                      │
│ ↓                                                             │
│ DELETED — Session data is gone                              │
│ Any tabs that were in it are reset to default              │
└──────────────────────────────────────────────────────────────┘
```

---

## Global Jar Protection (Set-Cookie Strip)

### Problem
An isolated session's server `Set-Cookie` responses must not contaminate the browser's
shared global cookie jar. If they did, logging into an isolated session would overwrite
the default profile's cookies for the same domain, and resetting a tab to default would
surface the isolated session instead of the original profile.

### Solution: Capture-then-Strip on Isolated Tabs

**Concept:** Isolated tabs never write to the global jar. For each isolated-tab response:
1. The webRequest `onHeadersReceived` listener observes the response *first* and captures
   each `Set-Cookie` into the per-session store (`cookies_${sessionId}`)
2. A base DNR rule (priority 100, scoped to that tab) then strips `Set-Cookie` from the
   response headers before they reach the browser
3. The global jar is left untouched, so default-session tabs on the same host keep their
   original cookies with no per-tab snapshotting

**Example:**
```
1. User has Tab 1 on github.com (default session)
   Global jar: github_session=original_token

2. User opens Tab 2 on github.com in "Work" session
   Tab 2 gets a DNR base rule: strip Set-Cookie + rewrite Cookie from session store

3. User logs into "Work" on Tab 2 as a different account
   Server sends: Set-Cookie: github_session=work_token
   webRequest listener captures it into cookies_session_work
   DNR base rule strips Set-Cookie before it reaches the browser
   Global jar still: github_session=original_token  (untouched)

4. Result: Tab 1 (default) and Tab 2 (Work) have separate sessions, no contamination
```

**Why important:**
Stripping the outbound header at the source removes the contamination vector entirely, so
default-session tabs no longer need to be defensively converted into frozen snapshots. The
former `_snap_` snapshot machinery and all its handling paths have been removed.

---

## Message Protocol

### Messages from Popup (popup.js → background.js)

| Action | Payload | Response |
|--------|---------|----------|
| `setSession` | `{ tabId, sessionId }` | None; triggers DNR + badge update |
| `getSession` | `{ tabId }` | `{ sessionId }` |
| `createSessionTab` | `{ sessionId, origin }` | None; opens new tab |
| `deleteSession` | `{ origin, sessionId }` | None; removes from list + deletes data |
| `updateCookie` | `{ sessionId, name, value, ... }` | None; updates storage + DNR |
| `refreshBadge` | `{ tabId }` | None; rebuilds badge |

### Messages from Content Script (content.js → background.js)

| Action | Payload | Response |
|--------|---------|----------|
| `getSessionForBootstrap` | None | `{ sessionId, cookieStr }` |
| `updateCookie` | `{ name, value, domain, ... }` | None; updates storage + DNR |

### Message Flow Diagram

```
popup.js
  ↓ chrome.runtime.sendMessage({ action: 'setSession' })
background.js
  ↓ await updateDNRRulesForTab(tabId, sessionId)
  ↓ await persistTabSessions()
  ↓ chrome.action.setBadgeText(...)
  ↓ response sent back to popup.js
popup.js
  ↓ chrome.tabs.reload(tabId)
  ↓ window.close()

---

page-api-proxy.js (MAIN)
  ↓ window.postMessage({ action: 'updateCookie' }, origin)
content.js (ISOLATED)
  ↓ chrome.runtime.sendMessage({ action: 'updateCookie' })
background.js
  ↓ await setCookieStore(sessionId, store)
  ↓ await updateDNRRulesForTab(tabId, sessionId)
```

---

## Performance Characteristics

### Latencies

| Operation | Typical | Max | Blocker |
|-----------|---------|-----|---------|
| Service worker startup | <50ms | <500ms | Service worker restart |
| Session switch | <100ms | <200ms | Storage write + DNR rule |
| Cookie bootstrap | 50-200ms | 500ms | Async postMessage + retry |
| Badge update | <5ms | <20ms | Storage read (cached) |
| Tab creation | <50ms | <200ms | DNR rule creation |

### Storage Limits

| Item | Limit | Typical Usage |
|------|-------|---------------|
| chrome.storage.local | 10MB (shared) | 100KB–1MB for 100+ sessions |
| chrome.storage.session | 10MB | <10KB (tab map only) |
| DNR rules | 30K max per extension | 1 per active tab (~100 rules) |

### Memory Usage

- In-memory tabSessions map: ~100 bytes per tab
- Per-session cookie store: ~1–10KB (depending on cookies)
- Content scripts: ~50KB per page
- Service worker + message handlers: ~200KB

---

## Threat Model & Mitigations

| Threat | Attack | Mitigation |
|--------|--------|-----------|
| **Rogue page script** | Forges postMessage to steal cookies | Nonce validation; cookies never in DOM |
| **Other extension** | Reads chrome.storage.local | Storage isolation + prefix (minor; assuming honest extensions) |
| **Service worker restart** | Loses tab→session map; cookies lost | Persistent storage.local + session storage recovery |
| **DNR rule overflow** | Too many tabs; rules exceed limit | Monitor rule count; warn user at ~1000 tabs |
| **XSS on page** | Injects script to steal cookies | Cookies never accessible to page JS (DNR handles network; DOM proxies handle storage) |
| **Man-in-the-middle** | Intercepts Cookie header in transit | HTTPS only; HTTPs enforced at protocol layer |
| **Browser cookie jar exploit** | Direct read of browser's cookie jar | browser's sandbox; extension can't read other profiles |

---

## Scalability Considerations

### Current Limits
- **Max sessions per origin:** 100+ (no hard limit; UI will be slow)
- **Max tabs:** 1000+ (DNR rule ID generation supports up to 1M)
- **Max cookie size per session:** 10MB shared across extension (practical: <1MB)

### Scaling Bottlenecks
1. **Popup rendering** — Too many sessions slow down list rendering (fix: pagination)
2. **Storage read latency** — Loading 1000 tabs × session data (fix: indexed storage)
3. **DNR rule regeneration** — Reapplying all rules on startup (fix: lazy rule creation)

### Future Improvements
- **Indexed storage** — Use IndexedDB instead of chrome.storage.local for large datasets
- **Pagination** — Limit popup list to 10 sessions; add search
- **Lazy rule creation** — Only create DNR rule when tab is active
- **Session compression** — Gzip cookies for storage efficiency
