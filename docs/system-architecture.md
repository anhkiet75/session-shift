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

### DNR Debounce Strategy

v0.4.0 introduces lazy debouncing to reduce DNR rule thrashing during cookie cascades:

```javascript
// background.js
const dnrDebounceTimers = new Map(); // tabId → timer handle

function scheduleDNRUpdate(tabId, sessionId) {
  const existing = dnrDebounceTimers.get(tabId);
  if (existing) clearTimeout(existing); // Cancel pending update
  
  dnrDebounceTimers.set(tabId, setTimeout(async () => {
    dnrDebounceTimers.delete(tabId);
    await updateDNRRulesForTab(tabId, sessionId); // Apply batched update
  }, 50)); // 50ms per-tab timer
}

// Called from updateCookie handler (batched)
scheduleDNRUpdate(tabId, sessionId);

// Called from setSession handler (immediate, no debounce)
clearImmediate(dnrDebounceTimers.get(tabId));
await updateDNRRulesForTab(tabId, sessionId);
```

**Why:** Server responses may include multiple Set-Cookie headers in quick succession. Instead of regenerating the DNR rule on each cookie, we batch them into a single 50ms window per tab. Explicit session switches bypass the timer and apply immediately.

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
        operation: 'set',         // Replace entire Cookie header
        value: 'session_cookie_1=value; session_cookie_2=value'
      }
    ]
  },
  condition: {
    tabIds: [tabId],              // Only applies to this tab
    resourceTypes: [              // All request types
      'main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
      'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
      'webbundle', 'other'
    ]
  }
}

await chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [oldRuleId],
  addRules: [rule]
})
```

### Key Properties

| Property | Value | Why |
|----------|-------|-----|
| **Scope** | session-scoped | Cleared on service worker restart (OK; we reapply on next action) |
| **Matching** | tabIds condition | Only affects one tab per rule |
| **Header operation** | 'set' (replace) | Ensures exactly one Cookie header |
| **Priority** | 100 | Lower than user-defined rules; prevents conflicts |

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
    "github_session": {
      value: "ghp_abc123...",
      domain: ".github.com",
      path: "/",
      expires: 1735689600000,
      secure: true,
      httpOnly: true
    },
    "user_preferences": {
      value: "dark_mode=true",
      domain: ".github.com",
      path: "/",
      expires: null,
      secure: false,
      httpOnly: false
    }
  },
  "cookies_session_def456gh": { ... },
  "list_https://github.com": [
    { id: "session_abc123de", name: "Work", hue: 212 },
    { id: "session_def456gh", name: "Personal", hue: 158 }
  ]
}
```

**Recovery on service worker restart:**
1. restoreTabSessions() loads tab→session map
2. User clicks a tab or opens popup
3. updateDNRRulesForTab() reads from cookies_${sessionId}
4. serializeCookieHeader() converts store back to Cookie header string
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

## Session Snapshot Protection

### Problem
When a new isolated session is created on a host, server Set-Cookie responses should not contaminate the global cookie jar or other sessions' cookies.

### Solution: Snapshot Sessions

**Concept:** When Tab A (default session) on host X creates a new isolated session, we:
1. Read Tab A's cookies from the browser's global jar
2. Create a snapshot session `_snap_${tabId}_${random}`
3. Lock those cookies in a DNR rule
4. Assign Tab A to the snapshot
5. Tab A is now isolated from the new session's Set-Cookie responses

**Example:**
```
1. User has Tab 1 on github.com (default session)
   Cookies: github_session=original_token

2. User creates "Work" session on github.com
   background.js calls protectDefaultTabsOnHost('github.com', excludeTabId=null)

3. Finds Tab 1 is on github.com with default session
   Reads global cookies: { github_session: 'original_token' }
   Creates snapshot: cookies__snap_1_xyz789 = { github_session: 'original_token' }
   Assigns Tab 1 to _snap_1_xyz789
   DNR rule locks Tab 1's cookies to 'original_token'

4. User logs into "Work" session on github.com as a different account
   Server sends: Set-Cookie: github_session=work_token
   DNR rule on Tab 2 (Work session) stores it
   DNR rule on Tab 1 (snapshot) ignores it — locked to 'original_token'

5. Result: Tab 1 and Tab 2 have separate sessions, no contamination
```

**Why important:**
Without snapshots, Tab 1's original login would be overwritten by Tab 2's login, breaking the default session.

**Snapshot Sessions are Hidden:**
- Badge doesn't show for `_snap_*` sessions
- Popup doesn't list them
- User is unaware of them
- Only visible in storage inspection

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
