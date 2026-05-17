# Security Audit Report: SessionShift Extension

**Date:** 2026-05-17  
**Version Audited:** v0.0.1 (src) / v0.5.0 (dist)  
**Manifest Version:** 3  
**Status:** ✅ Security-sound with medium-priority hardening items

---

## Executive Summary

SessionShift demonstrates solid security architecture for a session-isolation extension. The cross-world bridge between ISOLATED and MAIN content scripts uses nonce-authenticated messaging with targeted origins, message handlers validate sender IDs, and the codebase avoids all major MV3 red flags (eval, remote code loading, hardcoded secrets, unsafe CSP).

**Severity Breakdown:**
- **Critical:** 0
- **High:** 0
- **Medium:** 3 (process, architecture, deployment)
- **Low:** 5 (hardening, defensive practices)

---

## Medium-Priority Findings

### 1. Manifest Version Mismatch (Medium)

**Location:** `src/manifest.json:4` vs `dist/manifest.json:4`

**Issue:**
```
src:  "version": "0.0.1"
dist: "version": "0.5.0"
```

**Risk:** Version drift between source and build artifact suggests either manual dist edits or misaligned build output. CWS reviewers compare versions; this can cause confusion in release tracking and break reproducible builds.

**Recommendation:**
- Define version in a single source (e.g., `package.json`).
- Update `scripts/build.sh` to template version into both `dist/manifest.json` and keep `src/manifest.json` in sync.
- Ensure CI validates version consistency before merging.

---

### 2. Broad Permissions Trio Requires CWS Justification (Medium)

**Location:** `src/manifest.json:12-25`

**Permissions:**
- `"declarativeNetRequest"` — rewrite outbound `Cookie` headers
- `"webRequest"` — observe inbound `Set-Cookie` headers
- `"cookies"` — snapshot global cookie jar for snapshot isolation
- `"<all_urls>"` — apply to every domain

**Risk:** This combination is the most aggressively reviewed permission set in CWS policy. Chrome expects a detailed, single-purpose justification in the store listing.

**Justification Template** (for store):
> This extension isolates user sessions per domain. It uses:
> - `webRequest` to capture `Set-Cookie` response headers (DNR cannot observe responses).
> - `declarativeNetRequest` to rewrite outbound `Cookie` request headers per isolated session.
> - `cookies` to snapshot the global cookie jar when creating snapshot sessions for default-tab protection.
> - `<all_urls>` because session isolation must span all websites.

**Recommendation:**
- Include the above or similar in the CWS "Permissions Justification" section before submission.
- Document this in `README.md` → "Permissions" subsection for transparency.

---

### 3. Cross-World Handshake Briefly Exposes Nonce via DOM (Medium)

**Location:** `src/content.ts:33-34` → `src/page-api-proxy.ts:13-14`

**Flow:**
1. `content.ts` (ISOLATED world) writes `data-ext-session-id` and `data-ext-nonce` to `documentElement.dataset`
2. `page-api-proxy.ts` (MAIN world) reads them, deletes them
3. Both run at `document_start` before page script execution

**Risk:** Any other extension running a MAIN-world script at `document_start` on `<all_urls>` could read the nonce in the brief window before deletion, then forge `updateCookie` messages for the page lifetime.

**Mitigation in Place:** Chrome guarantees content scripts from the same `content_scripts` entry execute in declared order; page scripts cannot race content scripts at `document_start`.

**Improvement:** Replace dataset handshake with `MessageChannel` or have `page-api-proxy.ts` wait for nonce via `postMessage` instead of reading DOM.

**Recommendation:**
```typescript
// Better: content.ts sends nonce via postMessage
window.postMessage({
  source: 'ext-content',
  action: 'initNonce',
  nonce: nonce
}, window.location.origin);

// page-api-proxy.ts listens first, then initializes
let nonce: string | null = null;
window.addEventListener('message', (e) => {
  if (e.data.source === 'ext-content' && e.data.action === 'initNonce') {
    nonce = e.data.nonce;
    // Now initialize storage proxies etc.
  }
});
```

---

## Low-Priority Findings

### 4. Async/Sync Race in Content Script Initialization (Low)

**Location:** `src/content.ts:7-23` + `src/page-api-proxy.ts:9-10`

**Issue:**
- `content.ts` is async; it awaits `chrome.runtime.sendMessage` before setting dataset
- `page-api-proxy.ts` runs synchronously and reads dataset at module load
- On cold service-worker startup (~1-2s), `page-api-proxy.ts` executes before `content.ts` resolves
- Result: `sessionId === undefined` → early return → **isolation silently skipped**

**Impact:** Not an exploit; features simply don't activate. The cookie-bootstrap retry loop (`page-api-proxy.ts:158-177`) only mitigates cookie delivery, not the full init.

**Recommendation:** Refactor to eliminate the race:
- Option A: Have `page-api-proxy.ts` poll dataset with a timeout rather than bailing immediately.
- Option B: Use the postMessage-based handshake from Finding #3.

---

### 5. `innerHTML` for Static Content Creates Precedent (Low)

**Locations:** 14 sites across `src/popup/*.ts`

**Examples:**
- `popup.ts:67` — reset button SVG
- `popup-render-global-list.ts:84,95,102` — "active" pill, checkmark, delete icon
- `popup-hero-updater.ts:15,20` — "No session scoped" text

**Current Status:** ✅ All use static template literals; no XSS risk.

**Risk:** Sets a precedent for future contributors. If extended with `${session.name}`, it becomes an XSS vector. Session names are stored in `chrome.storage.local` and editable by any page that compromises the extension.

**Recommendation:**
```typescript
// Before:
activePill.innerHTML = `<span class="v2-live-dot"></span>active`;

// After:
const activePill = document.createElement('span');
activePill.className = 'v2-card-active-pill';
const dot = document.createElement('span');
dot.className = 'v2-live-dot';
activePill.appendChild(dot);
activePill.appendChild(document.createTextNode('active'));
```

Or use a safer helper:
```typescript
// Define once:
const STATIC_SVG = {
  checkmark: `<svg ...>...</svg>`,
  delete: `<svg ...>...</svg>`
};

// Use:
const check = document.createElement('div');
check.className = 'v2-card-check';
check.innerHTML = STATIC_SVG.checkmark; // OK: only static strings
```

---

### 6. Missing Explicit Content Security Policy (Low)

**Location:** `src/manifest.json` (no `content_security_policy` field)

**Current Status:** MV3 default CSP applies: `script-src 'self'; object-src 'self'` — already safe.

**Recommendation:** Add explicit policy for defense-in-depth and reviewer transparency:
```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'; base-uri 'none'"
}
```

This:
- Makes the policy visible in code and store listings
- Prevents `<base>` injection attacks
- Signals intentionality to future contributors

---

### 7. Cookie Setter Accepts Unvalidated Bytes (Low)

**Location:** `src/page-api-proxy.ts:93-112`

**Issue:**
```typescript
const name = kv.substring(0, eqIdx);
const value = kv.substring(eqIdx + 1);
// ...
cookieMap.set(name, value); // No validation
```

**Risk:** Pages already inject arbitrary cookies via `document.cookie`, but no validation of:
- Control characters (CR/LF)
- Whitespace / separators (`;`)
- Length (unbounded)

If serialization or DNR ever pass raw values into headers, header smuggling is possible. Chrome DNR currently sanitizes, but defensive gating is prudent.

**Recommendation:**
```typescript
function isValidCookieName(name: string): boolean {
  return /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(name) && name.length <= 1024;
}

function isValidCookieValue(value: string): boolean {
  return !/([\r\n]|\0)/.test(value) && value.length <= 4096;
}

if (isValidCookieName(name) && isValidCookieValue(value)) {
  cookieMap.set(name, value);
}
```

---

### 8. Unbounded Storage Reads (Low)

**Locations:**
- `session-store.ts:38` — `getAllSessions()`
- `session-store.ts:70` — `findOrphanedCookieStores()`
- `session-store.ts:104` — `updateSessionHue()`

**Issue:**
```typescript
const all = await chrome.storage.local.get(null); // Reads entire storage
```

**Impact:** Performance, not security. Popup's "All sessions" view (`popup-render-global-list.ts`) will slow as the session count grows (hundreds of sessions = 100s of ms read time).

**Recommendation:** Index session-list keys or paginate:
```typescript
// Maintain a single index key
const result = await chrome.storage.local.get(['session_index']);
const index = result.session_index || {};

// When adding session: add to index
// When reading: use index to get only relevant keys
```

---

## ✅ Passed Security Checks

| Check | Result | Location |
|-------|--------|----------|
| CSP: No `unsafe-inline` / `unsafe-eval` | ✅ | Default MV3 CSP applies |
| HTTPS-only | ✅ | Zero `http://` in source |
| Message sender validation | ✅ | `background/index.ts:28` checks `sender.id` |
| No `eval` / `Function` / string timers | ✅ | Grep clean |
| No hardcoded secrets | ✅ | Grep clean |
| No remote code loading | ✅ | No `importScripts`, `executeScript`, dynamic fetch |
| No `externally_connectable` | ✅ | Not declared |
| No `web_accessible_resources` | ✅ | Not declared (assets not exposed) |
| No inline event handlers | ✅ | `popup.html`, `options.html` clean |
| `postMessage` has origin guard | ✅ | Explicit `targetOrigin`, `'null'` skip |
| Nonce-authenticated bridge | ✅ | Uses `crypto.randomUUID()` |
| User input rendered safely | ✅ | Session names use `textContent` |
| Message payloads validated | ✅ | `typeof` guards in all handlers |
| Dependencies audit | ✅ | `npm audit`: 0 vulnerabilities |

---

## Implementation Roadmap

### Phase 1: Before CWS Submission (High Priority)
- [ ] Sync manifest version to `0.5.0` (or your release target)
- [ ] Add CSP section to manifest
- [ ] Prepare permissions justification for store listing
- [ ] Test extension on CWS staging environment (if available)

### Phase 2: Post-Release Hardening (Medium Priority)
- [ ] Replace DOM-dataset nonce handshake with postMessage-based flow
- [ ] Refactor `page-api-proxy.ts` to eliminate async/sync race
- [ ] Convert `innerHTML` to `createElement` or static-only template
- [ ] Add cookie name/value validation

### Phase 3: Performance (Low Priority)
- [ ] Index session-storage keys to avoid full-read on every operation
- [ ] Measure popup load time with 100+ sessions
- [ ] Profile cold service-worker startup time

---

## References

- [Chrome Web Store Policies](https://chrome.google.com/webstore/category/policies)
- [MV3 Security Best Practices](https://developer.chrome.com/docs/extensions/mv3/security/)
- [Content Security Policy Spec](https://w3c.github.io/webappsec-csp/)
- [RFC 6265 (Cookies)](https://tools.ietf.org/html/rfc6265)

---

## Questions Requiring Clarification

1. **Version strategy:** Is `0.0.1` intentional (fresh branch) or stale? Need to know before recommending sync direction.
2. **CWS status:** Has the extension been submitted yet? If yes, existing permissions justification is sufficient.
3. **Release cadence:** Is the extension following semantic versioning? Should help determine whether `0.5.0` → `1.0.0` → `2.0.0` or `0.0.1` → `0.0.2`.

