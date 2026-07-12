# SessionShift — Code Standards & Conventions

## File Organization

```
session-shift/
├── manifest.json              # MV3 configuration (v0.4.0: added commands block)
├── background.js              # Service worker (main orchestrator; v0.4.0: DNR debounce + commands)
├── content.js                 # ISOLATED world script
├── page-api-proxy.js          # MAIN world script (uses lib/storage-proxy)
├── lib/
│   ├── cookie-parser.js       # Cookie parsing/serialization
│   ├── session-store.js       # Storage access patterns
│   ├── rule-matcher.js        # Hostname pattern matching for auto-assign rules
│   └── storage-proxy.js       # Storage proxy factory for per-session isolation (v0.4.0)
├── popup/
│   ├── popup.html             # UI structure (v0.4.0: aria attributes)
│   ├── popup.js               # UI logic and event handlers (v0.4.0: aria toggle)
│   └── popup.css              # Styles (v0.4.0: :focus-visible rings)
├── options/
│   ├── options.html           # Multi-tab settings UI (Rules | Backup | Settings | About; v0.4.0: aria roles)
│   ├── options.js             # Rule CRUD + settings (v0.4.0: aria toggle)
│   └── options.css            # Settings styles (v0.4.0: :focus-visible rings)
├── icons/                     # Extension icons (16, 32, 48, 128 px)
├── tests/                     # Vitest unit tests (v0.4.0: 94 tests across 9 suites)
├── vitest.config.js           # Test config
└── package.json               # Dependencies (Vitest, jsdom)
```

## Naming Conventions

### Files
- **kebab-case** for all source files (`.js`, `.html`, `.css`)
- Descriptive, self-documenting names: `cookie-parser.js`, `session-store.js`, `page-api-proxy.js`
- No abbreviations (prefer `storage` over `stor`, `parser` over `pars`)

### JavaScript Variables & Functions
- **camelCase** for all variables, functions, and constants
  ```javascript
  const sessionId = 'session_abc123';
  let tabSessions = {};
  function updateBadge(tabId, sessionId) { }
  ```

- **CONSTANT_CASE** for immutable constants (rarely used; prefer const with camelCase)
  ```javascript
  const HUE_PALETTE = [212, 158, 24, 278, 196, 340, 45];
  const ALL_RESOURCE_TYPES = ['main_frame', 'sub_frame', ...];
  ```

### Session & Storage IDs
- User-created sessions: `session_${randomString}` (e.g., `session_abc123de`)
- Internal snapshots: `_snap_${tabId}_${randomSuffix}` (e.g., `_snap_12345_xyz789`)
- Default session: literal string `'default'`
- Storage keys: `cookies_${sessionId}`, `list_${origin}`
- Storage prefix for DOM APIs: `__ext_${sessionId}_`

## Code Style

### General Rules
- **No semicolons** — Use automatic semicolon insertion (ASI)
- **Single quotes** — For all string literals (not double quotes)
- **2-space indentation** — Consistent throughout
- **Trailing commas** — Always in multi-line objects/arrays
- **Descriptive variable names** — Avoid single letters except in loops (`i`, `j`, `k`)

### Comments
- **JSDoc for exported functions** — Include @param, @returns, @description
  ```javascript
  /**
   * Parse Set-Cookie header and extract cookie attributes
   * @param {string} str - The Set-Cookie header value
   * @param {URL} url - The request URL (for domain inference)
   * @returns {Object} Cookie object with name, value, domain, path, expires, secure, httpOnly
   */
  export function parseSetCookie(str, url) { }
  ```

- **Inline comments for non-obvious logic** — Explain "why", not "what"
  ```javascript
  // Generate stable DNR rule ID: avoids collisions with user-defined rules
  // and remains consistent across service worker restarts for the same tab.
  const ruleId = (tabId % 1000000) + 1
  ```

- **Section headers** — Use comment blocks for logical sections
  ```javascript
  // ---------------------------------------------------------------------------
  // Cookie Interception (Network Layer)
  // ---------------------------------------------------------------------------
  ```

### Functions
- **One responsibility per function** — Avoid >30 lines
- **No nested functions** — Extract to module scope if reused
- **Async/await preferred** — Over .then() chains
  ```javascript
  // Good
  const response = await chrome.runtime.sendMessage({ action: 'getSession' })
  
  // Avoid
  chrome.runtime.sendMessage({ action: 'getSession' }).then(response => { })
  ```

- **Error handling** — Always wrap chrome API calls in try/catch
  ```javascript
  try {
    const result = await chrome.storage.session.get(['tabSessions'])
  } catch (e) {
    console.warn('[bg] restoreTabSessions failed:', e)
  }
  ```

### Objects & Arrays
- **Trailing commas in multi-line** — Easier diffs
  ```javascript
  const store = {
    name: 'cookie_value',
    expires: 1735689600000,
  }
  ```

- **Consistent key quoting** — Quote keys only if needed (not required for valid identifiers)
  ```javascript
  const good = { tabId: 123, sessionId: 'abc' }
  const alsoOk = { 'tab-id': 123, sessionId: 'abc' }  // Quote for kebab-case
  ```

## ES Modules & Imports

- **ES module syntax only** — No CommonJS (require)
  ```javascript
  import { parseSetCookie, serializeCookieHeader } from './lib/cookie-parser.js'
  import { getCookieStore } from './lib/session-store.js'
  ```

- **Always include `.js` extension** — MV3 requires explicit extensions
  ```javascript
  // Good
  import { helper } from './lib/helper.js'
  
  // Avoid (will fail)
  import { helper } from './lib/helper'
  ```

- **Named exports preferred** — Over default exports
  ```javascript
  // Recommended
  export function parseSetCookie() { }
  export function serializeCookieHeader() { }
  
  // Avoid (harder to navigate)
  export default function parser() { }
  ```

## Chrome APIs

### Permissions
- Document all used permissions in manifest.json
- Add JSDoc comment explaining "why" for non-obvious permissions
  ```json
  {
    "permissions": [
      "declarativeNetRequest",  // Rewrite Cookie headers per-tab
      "storage",                // Persist session data
      "tabs",                   // Track tab→session mapping
      "webRequest",             // Intercept Set-Cookie responses
      "cookies"                 // Read global cookie jar for snapshots
    ]
  }
  ```

### async/await vs Promises
- All chrome API calls are Promise-based in MV3
- Use async/await for readability
  ```javascript
  async function getSession(tabId) {
    try {
      const result = await chrome.storage.session.get(['tabSessions'])
      return result.tabSessions?.[tabId] || 'default'
    } catch (e) {
      console.error('Failed to get session:', e)
      return 'default'
    }
  }
  ```

### Message Passing
- **Always validate sender.id** — Prevent external scripts from sending messages
  ```javascript
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ error: 'unauthorized' })
      return false
    }
    handleMessage(request, sender).then(sendResponse).catch(err => sendResponse({ error: err.message }))
    return true  // keep channel open for async response
  })
  ```

- **Return true for async responses** — Keeps the message channel open
  ```javascript
  // Good
  return true
  
  // Avoid (message channel closes immediately)
  sendResponse({ })
  ```

## Security Best Practices

### Nonce Authentication
Used for postMessage between ISOLATED and MAIN worlds:
```javascript
// In content.js (ISOLATED)
const nonce = crypto.randomUUID()
document.documentElement.dataset.extNonce = nonce

// In page-api-proxy.js (MAIN)
window.addEventListener('message', (event) => {
  if (event.data.nonce !== nonce) return  // Reject unsigned messages
})
```

**Why:** Prevents malicious page scripts from forging postMessage events.

### No eval, innerHTML with User Input
- **Never use eval()** — Always parse/serialize via functions
- **Never set innerHTML with user input** — Use textContent or createElement
  ```javascript
  // Good
  const div = document.createElement('div')
  div.textContent = userName  // Safe; text is not parsed as HTML
  
  // Avoid
  div.innerHTML = `<span>${userName}</span>`  // XSS risk if userName contains <script>
  ```

### Cookie Storage
- **Never expose cookies in DOM** — Store only in chrome.storage.local and DNR rules
- **Never serialize cookies to JSON without sanitization** — Use dedicated parser
  ```javascript
  // Good
  const store = await getCookieStore(sessionId)
  const cookie = store[cookieName]
  
  // Avoid
  const data = JSON.parse(rawData)  // Assumes trusted format
  ```

### Content Script Isolation
- **Use ISOLATED world for sensitive data** — DOM attributes not visible to MAIN world
- **Use MAIN world only for API interception** — Never store secrets there
  ```javascript
  // In content.js (ISOLATED) — safe to pass sessionId via nonce-validated postMessage
  window.postMessage({ nonce, sessionId }, targetOrigin)
  
  // In page-api-proxy.js (MAIN) — validate nonce before using sessionId
  if (event.data.nonce !== nonce) return
  ```

## Storage Patterns

### Chrome Storage (Persistent & Session)
```javascript
// Async pattern (preferred)
const store = await getCookieStore(sessionId)
const cookie = store[cookieName]

// With fallback
const list = await getSessionList(origin)
if (!list) {
  await setSessionList(origin, [])
}

// Always await to ensure write completes
await setCookieStore(sessionId, store)

// Batch writes when possible
const updates = { ...existing, ...newData }
await chrome.storage.local.set(updates)

// Always clean up deleted sessions
await deleteSessionData(sessionId)
```

### Per-Session DOM Storage (v0.4.0)
Use `lib/storage-proxy.js` to isolate localStorage/sessionStorage per session:

```javascript
// In page-api-proxy.js (MAIN world)
import { makeStorageProxy } from './lib/storage-proxy.js'

const sessionId = '...'
const prefix = '__ext_' + sessionId + '_'

// Override window.localStorage
Object.defineProperty(window, 'localStorage', {
  get: () => makeStorageProxy(realLocalStorage, prefix),
  configurable: true,
})

// Each session sees only its own keys (prefixed)
// Tab A writes: __ext_session_abc_key → localStorage.setItem('key', ...)
// Tab B writes: __ext_session_def_key → localStorage.setItem('key', ...)
// Tab A reads: __ext_session_abc_* only → no cross-tab contamination
```

**Benefits:**
- Testable: `lib/storage-proxy.js` has 11 unit tests
- Reusable: Used across content script files
- Clear: Separated from page-api-proxy.js logic

## Error Handling

### Service Worker Restarts
Chrome can restart service workers at any time. Plan for this:
```javascript
// Restore state on every startup
restoreTabSessions()  // Idempotent; reads from storage

// Persist state on every change
await persistTabSessions()  // Write to storage after modification
```

### Missing Tabs/URLs
Chrome pages (chrome://, chrome-extension://) can't be isolated:
```javascript
const currentTab = await getCurrentTab()
if (!currentTab.url || currentTab.url.startsWith('chrome://')) {
  console.warn('Cannot isolate chrome:// page')
  return
}
```

### Storage Failures
Gracefully degrade if storage.session unavailable (older Chrome):
```javascript
try {
  await chrome.storage.session.get(['tabSessions'])
} catch (e) {
  console.warn('[bg] storage.session unavailable:', e)
  // Fall back to in-memory map or alert user
}
```

## Testing

### Test Structure
```javascript
import { describe, it, expect } from 'vitest'
import { parseSetCookie, serializeCookieHeader } from '../lib/cookie-parser.js'

describe('cookie-parser.js', () => {
  it('should parse Set-Cookie with domain and path', () => {
    const result = parseSetCookie('name=value; Domain=example.com; Path=/', new URL('https://example.com'))
    expect(result).toEqual(expect.objectContaining({
      name: 'name',
      value: 'value',
      domain: 'example.com',
      path: '/',
    }))
  })
})
```

### Mocking Chrome APIs
```javascript
import { beforeEach, vi } from 'vitest'

beforeEach(() => {
  global.chrome = {
    storage: {
      local: {
        get: vi.fn(() => Promise.resolve({})),
        set: vi.fn(() => Promise.resolve()),
      },
    },
  }
})
```

### Test Naming
- Use clear, descriptive test names
- Describe behavior, not implementation
  ```javascript
  // Good
  it('should isolate cookies per session', () => { })
  it('should preserve cookies across tabs', () => { })
  
  // Avoid
  it('updates store', () => { })
  it('handles input', () => { })
  ```

## Code Review Checklist

Before committing, verify:

- [ ] No console.error() except for logging bugs (use console.warn for degraded behavior)
- [ ] All chrome API calls wrapped in try/catch
- [ ] All async operations properly awaited
- [ ] No naked promises (.then() without catch)
- [ ] Session IDs follow naming convention (session_*, _snap_*, or 'default')
- [ ] JSDoc comments on exported functions
- [ ] No hardcoded magic numbers (use named constants)
- [ ] No eval, innerHTML with user input, or unsafe DOM manipulation
- [ ] Tests pass: `npm test`
- [ ] No unhandled promise rejections
- [ ] Storage cleanup for deleted sessions
- [ ] Proper error messages for debugging

## Keyboard Shortcuts & Commands (v0.4.0)

### Manifest Configuration
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

### Background.js Handler
```javascript
chrome.commands.onCommand.addListener(async (command) => {
  const tab = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = tab[0]?.id

  if (command === 'session-next') {
    // Get sessions for tab's origin, find next, switch
  }
  if (command === 'session-prev') {
    // Get sessions for tab's origin, find previous, switch
  }
  // '_execute_action' handled automatically by Chrome
})
```

### User Customization
Users can customize shortcuts at `chrome://extensions/shortcuts`.

---

## Manifest V3 Specifics

### Service Worker (background.js)
- **No window object** — Use chrome APIs only
- **No DOM access** — Use content scripts for that
- **Timeout resilience** — Persist state regularly; expect restarts
- **Type: "module"** — Required for ES imports
- **Command handlers** — Listen for keyboard shortcuts via `chrome.commands.onCommand`
- **Debouncing** — Use `dnrDebounceTimers` Map to batch rapid updates (50ms per-tab)
  ```json
  {
    "background": {
      "service_worker": "background.js",
      "type": "module"
    }
  }
  ```

### Content Scripts
- **ISOLATED world** — Safe for sensitive data; no DOM access
- **MAIN world** — Access to DOM and page APIs; no extension APIs
- **Both run at document_start** — Before page scripts load
  ```json
  {
    "content_scripts": [
      {
        "matches": ["<all_urls>"],
        "js": ["content.js"],
        "run_at": "document_start",
        "world": "ISOLATED"
      },
      {
        "matches": ["<all_urls>"],
        "js": ["page-api-proxy.js"],
        "run_at": "document_start",
        "world": "MAIN"
      }
    ]
  }
  ```

### Declarative Net Request (DNR)
- **Session-scoped rules** — Per-tab isolation via tabIds condition
- **Dynamic rules** — Updated at runtime per tab
- **Rule ID generation** — Must be unique; use `(tabId % 1000000) + 1`
  ```javascript
  const rule = {
    id: dnrRuleId(tabId),
    priority: 100,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Cookie', operation: 'set', value: cookieStr }],
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: ALL_RESOURCE_TYPES,
    },
  }
  ```

## Accessibility Standards (v0.4.0)

### ARIA Attributes (popup.html, options.html)
```html
<!-- Tab groups -->
<div role="tablist">
  <button role="tab" id="tab1" aria-selected="true" aria-controls="panel1">Tab 1</button>
  <button role="tab" id="tab2" aria-selected="false" aria-controls="panel2">Tab 2</button>
</div>

<!-- Tab panels -->
<div id="panel1" role="tabpanel" aria-labelledby="tab1">Content</div>

<!-- Live regions for dynamic updates -->
<span aria-live="polite" aria-atomic="true">0 sessions</span>

<!-- Input labels -->
<input aria-label="Search sessions">
```

### Focus Styling (popup.css, options.css)
```css
/* Keyboard focus rings (v0.4.0) */
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid #4CAF50;
  outline-offset: 2px;
}
```

### JavaScript Aria Toggling
```javascript
// When switching tabs, update aria-selected
function switchTab(mode) {
  const tabA = document.getElementById('tab' + mode)
  const tabB = document.getElementById('tab' + (mode === 'origin' ? 'global' : 'origin'))
  
  tabA.setAttribute('aria-selected', 'true')
  tabB.setAttribute('aria-selected', 'false')
}
```

### Testing for Accessibility
- **Keyboard navigation** — Tab, Shift+Tab, Enter, Space, Arrow keys
- **Screen readers** — NVDA (Windows), JAWS (Windows), VoiceOver (macOS)
- **Focus visibility** — All interactive elements have `:focus-visible` outline
- **Semantic HTML** — Use role="tab", role="tabpanel", role="tablist"

---

## Internationalization (i18n) & Message Catalog

### Message Key Naming
- **Pattern:** `^[A-Za-z][A-Za-z0-9_]*$` (camelCase or snake_case, no `@@` prefix)
- **Examples:** `extensionName`, `deleteTitle`, `switchToDefaultConfirm`
- Chrome reserves `@@` prefix for internal metadata; user keys never use it
- Add new keys to both `src/lib/localization-types.ts` (`MessageKey` union) and `src/_locales/en/messages.json`

### Placeholder Declaration & Reference
- **Declaration:** In `messages.json`, define placeholders only in English:
  ```json
  {
    "deleteAriaLabel": {
      "message": "Delete profile $name$",
      "description": "Aria-label for the delete button, naming the specific profile.",
      "placeholders": {
        "name": {
          "content": "$1",
          "example": "Work"
        }
      }
    }
  }
  ```
- **Reference parity:** Every non-English catalog must reference the same placeholder tokens as English (validated by `npm run validate:locales`)
- **Translators never edit placeholders** — Weblate locks them; only the message text is translated

### Bidirectional & Control Character Rules
- **Disallowed characters:** Bidi overrides/isolates/marks (LRE/RLE/PDF/LRO/RLO U+202A–202E, LRI/RLI/FSI/PDI U+2066–2069, LRM/RLM U+200E/F, ALM U+061C), zero-width space (U+200B), BOM (U+FEFF), soft hyphen (U+00AD)
- **Deliberately allowed:** ZWNJ/ZWJ (U+200C/U+200D) — required orthographic characters in Persian/Arabic/Indic scripts and emoji sequences, not spoofing; never add these to the disallowed set
- **RTL locales:** Arabic (ar), Farsi (fa), Hebrew (he) render with `dir="rtl"` on `<html>`. `applyDocumentLocale()` in `lib/localization.ts` applies the resolved direction (`getTextDirection()`) to the document
- **Validator enforces this** (`npm run validate:locales` blocks catalogs with forbidden characters)

### English Catalog Only
- **Description fields:** Only English (`src/_locales/en/messages.json`) carries `description` fields. All other locales omit them (saves space, prevents translator confusion)
- **Validator rejects** non-English catalogs with `description` fields

### Critical-Key Fallback Policy
- **Critical keys** (destructive/security operations, `CRITICAL_MESSAGE_KEYS` in `lib/localization-types.ts`): `resetToDefault`, `switchToDefaultConfirm`, `resetButton`, `deleteTitle`, `deleteAriaLabel`, `confirmDeleteTitle`
- **Beta locale behavior:** These keys render in English, not the machine translation, until the locale is linguistically reviewed (recorded in `translation-quality.json` with reviewer + date)
- **Decorative keys:** Render immediately in local language even if beta
- **Implementation:** Managed in `lib/localization.ts` via `getMessage()` critical-key check

---

## Dependencies

**None.** Vanilla JavaScript, no npm packages in production code.

**Development:**
- Vitest (testing)
- jsdom (test environment)

Keep it this way — minimal dependencies = fewer security vulnerabilities, smaller bundle, simpler maintenance.

## Formatting & Linting

**No eslint required** — Code style is enforced by convention and code review.

**Pre-commit checklist (manual):**
- [ ] Consistent 2-space indentation
- [ ] No trailing whitespace
- [ ] Single quotes for strings
- [ ] Trailing commas in multi-line objects/arrays
- [ ] Descriptive variable names

## Performance Guidelines

- **Avoid N+1 storage calls** — Batch reads/writes when possible
- **DNR rule size** — Keep cookie strings <1MB (practical limit)
- **Message frequency** — Debounce rapid storage updates (e.g., multiple Set-Cookie headers)
- **Badge updates** — Cache session names to avoid repeated storage.local reads

## Documentation

Every significant module should include:
1. **File header comment** — Purpose, responsibilities, key exports
2. **Function JSDoc** — @param, @returns, @description
3. **Inline comments** — Explain "why", not "what"
4. **Architecture decisions** — Link to this document or codebase-summary.md

Example:
```javascript
/**
 * Cookie Parser Library
 *
 * Parses Set-Cookie headers and manages cookie serialization.
 * Handles domain inference, path defaults, and expires conversion.
 * Single source of truth for cookie parsing logic.
 */

/**
 * Parse Set-Cookie header into a cookie object
 * @param {string} str - Set-Cookie header value
 * @param {URL} url - Request URL (for domain inference)
 * @returns {Object} Cookie object
 */
export function parseSetCookie(str, url) { }
```
