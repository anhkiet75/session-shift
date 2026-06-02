# SessionShift — Project Overview & Product Development Requirements

## Product Overview

**SessionShift** is a Chrome extension (Manifest V3) that enables simultaneous multi-account login on any website by isolating each browser tab's session independently. A free, open-source alternative to SessionBox.

**Current Version:** 0.4.0  
**Status:** Shipped to Chrome Web Store  
**License:** MIT  
**Repository:** https://github.com/anhkiet75/session-shift

**Published on Chrome Web Store:**  
https://chromewebstore.google.com/detail/sessionshift/incpbanbmacagomhkmbjmncnhimngcmp

## Problem Statement

Web browsers share cookies globally across all tabs for a given domain. This prevents users from being logged into multiple accounts on the same site simultaneously. Common workarounds are:
- Open a second browser window (cumbersome, memory-intensive)
- Use private browsing mode (limits persistence)
- Switch accounts manually (time-consuming)
- Pay for third-party extensions (cost, privacy concerns)

**SessionShift solves this:** Each tab gets its own cookie jar. You can be logged into 5 different GitHub accounts across 5 tabs—all simultaneously, on the same browser profile.

## Key Features

### Implemented (v0.4.0)
1. **Per-tab session isolation** — Cookies are scoped to session, not browser profile
2. **Named sessions** — Create and switch between sessions with custom names
3. **Badge indicator** — Toolbar badge shows active session label at a glance; colored icons per session
4. **Persistent across restarts** — Session assignments survive service worker restarts
5. **Works on any site** — No per-site configuration; covers `<all_urls>`
6. **No external dependencies** — Vanilla JS, Manifest V3, no bundler
7. **Keyboard shortcuts** — Ctrl+Shift+S (popup), Ctrl+Shift+Right/Left (next/prev session)
8. **Global session list** — Cross-site view of all sessions with search/filter
9. **Auto-assign rules** — Domain-to-session mapping with enable/disable
10. **Context menu** — "Open in session" for links
11. **Session export/import** — JSON backup for device migration
12. **Duplicate session** — Clone session with cookies for quick variations
13. **Multi-tab options** — Rules, backup, settings, about tabs
14. **Lazy DNR debounce** — Batch rapid cookie updates (50ms per-tab timer)
15. **Storage isolation lib** — `lib/storage-proxy.js` for testable per-session storage
16. **Accessibility** — WCAG-compliant focus rings, aria attributes on interactive elements

### Roadmap (Backlog)
- Open link in session (context menu)
- Auto-assign rules (domain-to-session mapping)
- Global session list (cross-site view)
- Session color labels in tab
- Session search/filter
- Session export/import
- Duplicate session

## Target Users

- **Multi-account developers** — GitHub, AWS, Google Cloud Console, etc.
- **QA/testers** — Managing multiple test accounts simultaneously
- **Content creators** — Managing multiple social media accounts
- **Security researchers** — Isolated testing environments per account

## Success Metrics

1. **Adoption** — 1,000+ weekly active users (baseline for fresh CWS extension)
2. **Reliability** — 99%+ uptime; <1% bug-report rate per user
3. **Performance** — Session switching <100ms latency; no visible lag on page load
4. **User retention** — <5% uninstall rate monthly
5. **Code quality** — Test coverage >70%; zero security vulnerabilities

## Technical Constraints

1. **Manifest V3 required** — Chrome Web Store enforces MV3; MV2 deprecated
2. **No bundler** — Keep build process minimal; users load unpacked directly
3. **Vanilla JS only** — No frameworks; small bundle, simple maintenance
4. **HTTPS + HTTP** — Must work on all URLs (privacy risk considered)
5. **No background page** — Service worker-only architecture; context expires

## Architecture Decisions

### Cookie Interception (Network Layer)
- Use `declarativeNetRequest` (DNR) to rewrite Cookie headers per-tab at network layer
- Per-session cookie stores in `chrome.storage.local`
- Network-level isolation prevents cookie leakage across tabs

### ISOLATED/MAIN World Bridge
- `content.js` (ISOLATED world) — Secure bridge between extension and page
- `page-api-proxy.js` (MAIN world) — Synchronous interception of DOM APIs (`document.cookie`, localStorage, sessionStorage, indexedDB)
- Nonce-authenticated postMessage for session bootstrap (prevents malicious page scripts from reading cookies)

### Storage Schema
- `chrome.storage.session` — Volatile tab→session map (cleared on service worker restart but recoverable)
- `chrome.storage.local` — Persistent cookies per session; session list per origin

### Security Principles
1. Cookies never appear in DOM (only in chrome.storage.local and DNR rules)
2. Nonce authentication prevents rogue page scripts from hijacking bootstrap
3. Session IDs are opaque strings; isolated tabs strip outbound `Set-Cookie` so they never write to the shared global jar, keeping default-session tabs uncontaminated (legacy `_snap_` snapshots retained only for backward-compat)
4. Cross-origin isolation enforced by browser native sandbox; extension adds per-site layer

## Core Dependencies

**None.** Vanilla ES modules in Manifest V3.

**Development dependencies:**
- Vitest (testing)
- jsdom (test environment)

## Integration Points

- Chrome Extensions APIs: `tabs`, `storage`, `cookies`, `declarativeNetRequest`, `webRequest`, `runtime`, `action`
- Web APIs: postMessage, crypto.randomUUID, DOM attributes, Storage API
- No external services; fully local

## Deployment

- Manual testing: `chrome://extensions` → Load unpacked
- Automated tests: `npm test` (Vitest + jsdom)
- Release: Manual submission to Chrome Web Store; auto-published after review

## Roadmap Phases

### Phase 1 (Current): Core Session Isolation ✅
- Per-tab session isolation via DNR
- Session CRUD in popup
- Badge indicator
- Storage persistence

### Phase 2 (Planned): Advanced Session Management
- Global session list (cross-origin view)
- Auto-assign rules
- Session search/filter

### Phase 3 (Planned): User Experience
- Session color labels in tab/favicon
- Context menu: "Open in session"
- Session export/import
- Duplicate session

### Phase 4 (Planned): Polish
- Settings page
- Keyboard shortcuts
- Analytics (privacy-respecting)
- Accessibility audit

## Known Limitations

1. **Private browsing** — Sessions do not persist across private mode (chrome.storage.session limitation)
2. **Session window only** — Service worker restart clears tab→session map (recovery via session list)
3. **Passive authentication** — Doesn't auto-log-in; you log in once per session manually
4. **Third-party cookies** — Intercepted like first-party; SameSite enforcement depends on server
5. **No tab grouping** — Sessions are logical, not visual (no native Chrome tab grouping)

## Acceptance Criteria (Shipped)

- [x] Popup UI allows create/switch/delete sessions
- [x] Per-tab cookie isolation works across all URLs
- [x] Session assignments persist across service worker restarts
- [x] DNR rules prevent cookie leakage between tabs
- [x] Content script bootstrap succeeds <500ms
- [x] Badge shows session label without visual lag
- [x] No console errors on extension load
- [x] Passes CWS review; available to public

## Security Audit Checklist

- [x] Cookies never exposed in unsecured DOM
- [x] Nonce authentication prevents postMessage hijacking
- [x] Storage isolation enforced by chrome.storage.local + prefixes
- [x] No eval, no innerHTML with user input
- [x] No external service calls
- [x] Cross-origin policy respected via browser sandbox
- [ ] Third-party cookie audit (planned for Phase 2)
- [ ] Service worker timeout recovery (planned for Phase 2)
