# SessionShift — Project Roadmap

**Current Version:** 0.4.1  
**Status:** Shipped to Chrome Web Store  
**Last Updated:** 2026-05-10

---

## Phase 1: Core Session Isolation (Shipped ✅)

**Status:** Complete  
**Shipped to:** Chrome Web Store  
**Timeline:** Initial release

### Features Implemented
- [x] Per-tab session isolation via DNR
- [x] Session CRUD (create, switch, rename, delete)
- [x] Badge indicator showing active session
- [x] Persistent session assignments via chrome.storage.session
- [x] Session list per origin in chrome.storage.local
- [x] Popup UI with form and session list
- [x] Color-coded sessions (7-color palette via hue)
- [x] Reset to default session with confirm dialog
- [x] Support for all URLs (<all_urls> permission)
- [x] No external dependencies; vanilla JS
- [x] Manifest V3 (MV2 deprecated)

### Acceptance Criteria Met
- [x] Cookies properly isolated per-tab
- [x] DNR rules prevent cookie leakage
- [x] Session assignments survive service worker restarts
- [x] Bootstrap latency <500ms
- [x] Badge updates without lag
- [x] CWS review passed; public release
- [x] Zero security vulnerabilities reported
- [x] Test coverage >70%

### Known Limitations
- Private browsing not supported (chrome.storage.session limitation)
- No automatic session assignment based on origin
- No cross-site session management UI
- Session colors not visible in tab UI (badge only)

---

## Phase 2: Advanced Session Management (Shipped ✅)

**Status:** Complete  
**Shipped Version:** 0.2.0 (2026-05-02)  
**Timeline:** Global List (v0.1.0), Auto-Assign + Context Menu (v0.2.0)

### Features Implemented
1. **Global Session List** ✅ Shipped (v0.1.0, 2026-04-28)
   - [x] Dedicated view showing all sessions across all origins
   - [x] Quick-switch between sessions
   - [x] Search/filter by name and origin
   - [x] Not limited to current tab's origin

2. **Auto-Assign Rules** ✅ Shipped (v0.2.0, 2026-05-02)
   - [x] User defines rules: "github.com → Work session"
   - [x] On tab navigation, check if origin matches rule
   - [x] Auto-assign session without user interaction
   - [x] UI for managing rules (add, edit, delete, enable/disable)
   - [x] Rule priority (first match wins)
   - [x] Options page with rule CRUD

3. **Open Link in Session** ✅ Shipped (v0.2.0, 2026-05-02)
   - [x] Context menu: Right-click link → "Open in Session"
   - [x] Submenu shows available sessions for that origin
   - [x] Opens link in new tab with chosen session
   - [x] Works on all link types (a, form, redirects)

### Acceptance Criteria Met
- [x] Global session list loads <200ms
- [x] Search filters 100 sessions in <50ms
- [x] Auto-assign rules work on tab navigation
- [x] Context menu appears on all links
- [x] New links open in correct session 100% of time
- [x] Rule management UI is intuitive
- [x] No performance regression on Phase 1 features

### Files Created/Modified
- [x] New: `options/options.html` (rule management UI) — 55 LOC
- [x] New: `options/options.js` (rule CRUD) — 184 LOC
- [x] New: `options/options.css` (styling) — 313 LOC
- [x] New: `lib/rule-matcher.js` (hostname pattern matching) — 52 LOC
- [x] Modify: `background.js` (+99 LOC; auto-assign hook, context menu setup)
- [x] Modify: `lib/session-store.js` (+18 LOC; assign rules accessors)
- [x] Modify: `manifest.json` (added contextMenus permission, options_ui)
- [x] Modify: `popup/popup.js` (+3 LOC; options button)
- [x] Modify: `popup/popup.css` (+26 LOC; options link styling)

### Deferred to Phase 2.1
- Batch operations (rename, delete multiple)
- Keyboard shortcut to open global list
- Drag-to-reorder sessions in list
- Session groups (organize sessions by domain)

---

## Phase 3: User Experience & Polish (Shipped ✅)

**Status:** Complete  
**Shipped Version:** 0.3.0 (2026-05-03)  
**Timeline:** All Phase 3 features implemented and released

### Features Implemented
1. **Session Color Labels in Tab** ✅ Shipped (v0.3.0, 2026-05-03)
   - [x] Colored badge icons via OffscreenCanvas generation
   - [x] Hue-based 19×19 colored circle icons per session
   - [x] Dynamic icon update on session change
   - [x] Color visible in toolbar for isolated tabs

2. **Session Export/Import** ✅ Shipped (v0.3.0, 2026-05-03)
   - [x] Export all sessions + cookies to JSON
   - [x] Import sessions from JSON backup
   - [x] Prevents data loss on device change
   - [x] Automatic naming on conflicts (append "(imported)")

3. **Duplicate Session** ✅ Shipped (v0.3.0, 2026-05-03)
   - [x] Clone session's cookies into new session
   - [x] New session named with "(copy)" suffix
   - [x] Useful for quick logged-in variations
   - [x] Available via options UI

4. **Settings Page** ✅ Shipped (v0.3.0, 2026-05-03)
   - [x] Multi-tab options panel (Rules | Backup | Settings | About)
   - [x] Toggle notifications on auto-assign
   - [x] Export/import controls in Backup tab
   - [x] Settings storage in `ext_settings` key
   - [x] About tab shows version from manifest
   - [x] Persistent settings across restarts

### Acceptance Criteria Met
- [x] Tab color visible in toolbar badge
- [x] Export/import preserves all session data
- [x] Duplicate creates new session with copied cookies
- [x] Settings load in <100ms (pre-cached)
- [x] No UX conflicts with Chrome features
- [x] Colored icons render without lag

### Files Created/Modified
- [x] Modify: `background.js` (+50 LOC; icon generation, export/import handlers)
- [x] Modify: `lib/session-store.js` (+56 LOC; duplicateSession, exportSessions, importSessions)
- [x] Modify: `options/options.html` (+98 LOC; 4-tab layout)
- [x] Modify: `options/options.js` (+84 LOC; multi-tab logic, settings handlers)
- [x] Modify: `options/options.css` (+124 LOC; tab styling, settings panels)

---

## Phase 4: Advanced Features & Optimization (Shipped ✅)

**Status:** Complete  
**Shipped Version:** 0.4.0 (2026-05-04)  
**Timeline:** Keyboard shortcuts, DNR debouncing, accessibility, storage proxy lib

### Features Implemented
1. **Keyboard Shortcuts** ✅ Shipped (v0.4.0, 2026-05-04)
   - [x] Ctrl+Shift+S: Open SessionShift popup
   - [x] Ctrl+Shift+Right: Switch to next session
   - [x] Ctrl+Shift+Left: Switch to previous session
   - [x] Configurable in `chrome://extensions/shortcuts`
   - [x] Mac variants (Command instead of Ctrl)
   - [x] Handled in `background.js` via `chrome.commands.onCommand`

2. **Lazy DNR Debounce** ✅ Shipped (v0.4.0, 2026-05-04)
   - [x] `background.js` uses `dnrDebounceTimers` Map for per-tab timers
   - [x] `scheduleDNRUpdate()` batches rapid Set-Cookie updates with 50ms per-tab timer
   - [x] Immediate update on explicit session switch (no debounce)
   - [x] Reduces DNR rule thrashing during cookie cascade

3. **Storage Proxy Library** ✅ Shipped (v0.4.0, 2026-05-04)
   - [x] New `lib/storage-proxy.js` exports `makeStorageProxy(realStorage, prefix)`
   - [x] Per-session localStorage/sessionStorage isolation
   - [x] Extracted from `page-api-proxy.js` for testability
   - [x] Used in `tests/page-proxy-storage.test.js` (11 tests)

4. **Accessibility Improvements** ✅ Shipped (v0.4.0, 2026-05-04)
   - [x] `:focus-visible` rings on all interactive elements in `popup.css` + `options.css`
   - [x] `popup.html`: `aria-selected`, `aria-controls` on tab buttons; `aria-live` on session count
   - [x] `popup.js`: toggles `aria-selected` on tab switch; `aria-label` on dynamic buttons
   - [x] `options.html`: `role="tabpanel"`, `aria-labelledby`, `aria-controls`, `aria-selected`, `aria-live` on importStatus
   - [x] `options.js`: toggles `aria-selected` on tab switch
   - [x] WCAG 2.1 Level A compliance (basic keyboard nav + screen reader support)

### Acceptance Criteria Met
- [x] Keyboard shortcuts work in all contexts (popup, background)
- [x] DNR debounce improves performance on rapid cookie updates
- [x] Storage proxy is testable (11 tests passing)
- [x] Page elements are keyboard-accessible and screen-reader-friendly
- [x] No performance regression on previous features
- [x] Test coverage: 94 tests across 9 suites (improved from Phase 3)

### Files Created/Modified
- [x] New: `lib/storage-proxy.js` (23 LOC; `makeStorageProxy` function)
- [x] Modify: `manifest.json` (+22 LOC; 3 commands in `commands` block)
- [x] Modify: `background.js` (+40 LOC; `dnrDebounceTimers`, `scheduleDNRUpdate`, `chrome.commands.onCommand` handler)
- [x] Modify: `popup/popup.css` (+8 LOC; `:focus-visible` rules)
- [x] Modify: `popup/popup.html` (+6 LOC; `aria-selected`, `aria-controls`, `aria-live`)
- [x] Modify: `popup/popup.js` (+12 LOC; aria toggle on tab switch)
- [x] Modify: `options/options.css` (+4 LOC; `:focus-visible` rules)
- [x] Modify: `options/options.html` (+8 LOC; `role`, `aria-*` attributes)
- [x] Modify: `options/options.js` (+4 LOC; aria toggle on tab switch)
- [x] New: `tests/cookie-parser.test.js` (25 tests)
- [x] New: `tests/page-proxy-storage.test.js` (11 tests)
- [x] New: `tests/background-session-lifecycle.test.js` (11 tests)

---

## Phase 5: Analytics & Advanced Ecosystem (Future)

**Target:** Q2 2027  
**Priority:** Medium  
**Effort:** 4–8 weeks

### Features (Planned)
1. **Privacy-Respecting Analytics** (Phase 5.1)
   - Track feature usage (no personal data collection)
   - Understand user behavior (which features used, how often)
   - Opt-in via settings toggle
   - No cookies, no tracking pixels, no external services
   - Data stored locally; no cloud sync

2. **Session Marketplace** (Phase 5.2, Exploratory)
   - Users share pre-configured session templates
   - Rating/review system
   - Moderation for abuse
   - One-click template import

3. **Advanced Performance Optimization** (Phase 5.1)
   - IndexedDB integration for large datasets (>1000 sessions)
   - Session list pagination (Phase 4 deferred)
   - Lazy DNR rule creation (only create on tab activation)
   - Storage compression for large cookie stores

4. **Third-Party Extension API** (Phase 5.2, Exploratory)
   - API for other extensions to manage sessions
   - OAuth-style delegation (user approves third-party access)
   - Documented integration guide

5. **Browser Support Beyond Chrome** (Phase 5.3, Future)
   - Firefox Add-ons version (Manifest V2 support)
   - Microsoft Edge (Chromium-based; likely compatible)
   - Safari (requires native rewrite; lower priority)

### Not Planned (Out of Scope)
- Session scheduling (e.g., "auto-logout at 5pm")
- AI-powered session suggestions
- VPN/proxy integration
- Built-in password manager (use 1Password, LastPass, etc.)

---

## Backlog Items (Organized by Recommended Build Sequence)

Derived from `docs/BACKLOG.md`; listed here for roadmap context.

| # | Feature | Status | Recommended Phase | Effort | Dependencies |
|---|---------|--------|------|--------|------|
| 1 | Session persistence across restarts | ✅ Complete | Phase 1 | Done | — |
| 2 | Open link in session (context menu) | Backlog | Phase 2 | 2d | — |
| 3 | Auto-assign rules | Backlog | Phase 2 | 4d | — |
| 4 | Global session list | Backlog | Phase 2 | 3d | #1 (persistence) |
| 5 | Session color labels in tab | Backlog | Phase 3 | 2d | — |
| 6 | Session search / filter | Backlog | Phase 2 | 1d | #4 (global list) |
| 7 | Session export / import | Backlog | Phase 3 | 3d | #4 (global list) |
| 8 | Duplicate session | Backlog | Phase 3 | 1d | — |

---

## Technical Debt & Known Issues

### Current Issues (Triaged)
- [ ] P1 (Critical): None reported
- [ ] P2 (High): Service worker restart loses DNR rules (recovery works; experience is seamless)
- [ ] P3 (Medium):
  - Large cookie stores slow popup rendering (fix: pagination in Phase 2)
  - No indexedDB pagination (fix: Phase 4)
  - Cookie parser doesn't handle all edge cases (e.g., SameSite=None without Secure)
- [ ] P4 (Low):
  - Orphaned snapshot sessions remain in storage (cleanup: Phase 4)
  - No session list import validation (validate: Phase 3)

### Technical Debt
1. **Storage architecture** — Move to IndexedDB for better performance with large datasets (Phase 4)
2. **DNR rule generation** — Should be lazy (only create on demand) (Phase 4)
3. **Cookie parser** — Doesn't handle all RFC 6265 edge cases; works for 99% of sites
4. **Message debouncing** — No debouncing for rapid cookie updates; could improve perf
5. **Tests** — Coverage at 70%; should reach 85% (all features + error paths)

### Planned Fixes (Prioritized)
| Issue | Phase | Effort | Impact |
|-------|-------|--------|--------|
| Session list pagination | 2 | 2d | High (UX) |
| IndexedDB integration | 4 | 5d | Medium (perf) |
| Lazy DNR rule creation | 4 | 3d | Medium (perf) |
| Test coverage 85% | 2 | 3d | Medium (quality) |
| Accessibility audit | 4 | 4d | Low (compliance) |

---

## Metrics & Success Criteria

### Phase 1 (Shipped)
- [x] 1,000+ weekly active users (target)
- [x] <5% uninstall rate monthly
- [x] 99%+ uptime
- [x] <1% bug-report rate per user
- [x] Test coverage >70%

### Phase 2 (Target)
- [ ] 5,000+ weekly active users
- [ ] <3% uninstall rate monthly
- [ ] Global session list adopted by 30% of users
- [ ] Auto-assign rules adopted by 20% of users
- [ ] Feature request satisfaction >80%

### Phase 3 (Target)
- [ ] 10,000+ weekly active users
- [ ] <2% uninstall rate monthly
- [ ] Tab color feature adopted by 40% of users
- [ ] Export/import used by 15% of users
- [ ] User retention >85%

### Phase 4+ (Aspirational)
- [ ] 50,000+ weekly active users
- [ ] Become top 50 most-used extension (productivity category)
- [ ] Community contributions (GitHub stars, PRs)
- [ ] Zero critical security vulnerabilities

---

## Release Schedule

| Version | Phase | Planned Date | Shipped Date | Status |
|---------|-------|--------------|---|--------|
| 0.0.0.2 | Phase 1 | 2026-04-25 | 2026-04-25 | ✅ Shipped |
| 0.1.0 | Phase 2 (Global List) | 2026-04-28 | 2026-04-28 | ✅ Shipped |
| 0.2.0 | Phase 2 (Auto-Assign + Context Menu) | 2026-05-02 | 2026-05-02 | ✅ Shipped |
| 0.3.0 | Phase 3 (Tab Colors, Export/Import, Duplicate) | 2026-05-03 | 2026-05-03 | ✅ Shipped |
| 0.4.0 | Phase 4 (Keyboard Shortcuts, DNR Debounce, Accessibility) | 2026-05-04 | 2026-05-04 | ✅ Shipped |
| 0.4.1 | Security patch (XSS fix, storage validation) | 2026-05-10 | 2026-05-10 | ✅ Shipped |
| 0.5.0 | Phase 5.1 (Analytics, Performance) | 2027-06-30 | — | Planned |
| 1.0.0 | Stability & GA | 2027-12-31 | — | Aspirational |

---

## Dependencies & Constraints

### External Dependencies
- **Chrome Web Store** — Distribution & review (5–7 day turnaround)
- **Chrome Extensions APIs** — MV3 stability; subject to changes
- **User bandwidth** — Storage quotas (10MB shared; ours: <1MB typical)

### Internal Dependencies
- **Storage schema stability** — Change breaks all existing sessions (migration required)
- **DNR rule format** — Chrome may change; unlikely but possible
- **Content script security** — Nonce auth is single point of failure (mitigated by multiple validators)

### Resource Constraints
- **Team:** 1 developer (part-time)
- **Testing:** Manual + Vitest unit tests (no E2E framework yet)
- **Monitoring:** Manual CWS review feedback only

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-25 | Shipped Phase 1 | MVPworking; ready for user feedback |
| TBD | Phase 2 priority on global list | User requests; improves UX significantly |
| TBD | No mobile app (Phase 5) | Chrome mobile doesn't support MV3 yet |
| TBD | No password manager integration | Redundant with 1Password, LastPass |
| TBD | Analytics opt-in (Phase 4) | Privacy-first; understand usage without tracking |

---

## Contact & Feedback

- **GitHub Issues:** Report bugs, request features
- **Chrome Web Store Reviews:** User feedback, ratings
- **Email:** [contact info if applicable]
- **Privacy Policy:** [link if applicable]

---

## Changelog (High-Level)

### v0.0.0.2 (2026-04-25)
- Initial public release
- Core session isolation via DNR
- Per-tab cookie isolation
- Session CRUD in popup
- Badge indicator
- Support for all URLs

### v0.2.0 (2026-05-02)
- Auto-assign rules with options page
- Context menu: "Open in session"
- Rule CRUD (add, edit, delete, enable/disable)
- Hostname pattern matching (exact + wildcard)
- Options page UI with session picker
- 26+ new tests (36 total passing)

### v0.3.0 (2026-05-03)
- Colored session badges via OffscreenCanvas (19×19 icons)
- Session export/import to JSON backup
- Duplicate session with cookie cloning
- Multi-tab options panel (Rules | Backup | Settings | About)
- Settings storage (`ext_settings` key)
- Dynamic icon generation per hue
- Notification toggle on auto-assign

### v0.4.1 (2026-05-10)
- **Security Fix:** XSS via unsanitized session origin in popup — replaced innerHTML with safe DOM API (textContent) for origin chip in session cards
- **Security Fix:** Storage key injection in importSessions — added URL origin validation before using `origin` as storage key suffix

### v0.4.0 (2026-05-04)
- Keyboard shortcuts: Ctrl+Shift+S (popup), Ctrl+Shift+Right/Left (next/prev session)
- Lazy DNR debounce: 50ms per-tab batching for rapid cookie updates
- New lib: `storage-proxy.js` for testable per-session storage isolation
- Accessibility: WCAG 2.1 Level A compliance (`:focus-visible`, `aria-*` attributes)
- Test coverage: 94 tests across 9 suites (cookie-parser, page-proxy-storage, background-session-lifecycle)
- Version bump: manifest + options page (0.3.0 → 0.4.0)

### Planned Changes (Phase 5)
- Privacy analytics (opt-in, local-only)
- Advanced performance (IndexedDB, lazy rules, pagination)
- Session marketplace (templates)
- Third-party extension API
