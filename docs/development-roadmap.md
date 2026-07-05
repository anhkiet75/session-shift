# Development Roadmap

**SessionShift** Chrome extension development tracking.

## Current Status

**Latest Release:** v0.6.0 (in progress)  
**Status:** Active hardening and profile UX work  
**Repository:** https://github.com/anhkiet75/session-shift  
**Chrome Web Store:** https://chromewebstore.google.com/detail/sessionshift/incpbanbmacagomhkmbjmncnhimngcmp

---

## Phase Delivery Timeline

| Phase | Name | Version | Status | Completed | Key Features |
|-------|------|---------|--------|-----------|--------------|
| **1** | Core Session Isolation | v0.1.0 | ✅ Shipped | 2025-Q4 | Per-tab DNR isolation, session CRUD, badge |
| **2** | Advanced Session Mgmt | v0.2.0 | ✅ Shipped | 2026-01 | Global session list, auto-assign rules, context menu |
| **3** | UX Polish | v0.3.0 | ✅ Shipped | 2026-03 | Session colors, export/import, duplication, settings page |
| **4** | Advanced Features | v0.4.0 | ✅ Shipped | 2026-05-04 | Keyboard shortcuts, lazy DNR debounce, test coverage, WCAG 2.1 AA |
| **5** | Infrastructure & Sync | v0.5.0 | 🟡 In Progress | TBD | TypeScript + modularization (done), IndexedDB migration, cross-device sync, privacy audit |
| **6** | Profile Model Hardening | v0.6.0 | 🟡 In Progress | TBD | Global profile model, auth transition bridge, first-navigation strip, popup profile open-in-tab |

---

## v0.4.0 — Advanced Features (Shipped 2026-05-04)

### Deliverables

#### 1. Keyboard Shortcuts
- ✅ `Ctrl+Shift+S` (Mac: `Cmd+Shift+S`) — Opens SessionShift popup
- ✅ `Ctrl+Shift+Right` — Cycle to next session for active tab
- ✅ `Ctrl+Shift+Left` — Cycle to previous session for active tab
- ✅ Shortcuts configurable at `chrome://extensions/shortcuts`
- ✅ Cycle wraps from last→first session; from default→first session

#### 2. Lazy DNR Optimization
- ✅ Per-tab 50ms debounce timer for DNR rule updates
- ✅ Batches rapid Set-Cookie responses into single rewrite
- ✅ Synchronous cookie store updates (unaffected)
- ✅ Reduces DNR rule churn during high-frequency responses

#### 3. Test Coverage Expansion
- ✅ 94 tests across 9 suites (up from ~36)
- ✅ New test files:
  - `tests/cookie-parser.test.js` — Set-Cookie parsing edge cases (>90% coverage)
  - `tests/page-proxy-storage.test.js` — localStorage/sessionStorage proxy
  - `tests/background-session-lifecycle.test.js` — Session lifecycle + keyboard handlers
- ✅ Total coverage: ~75% of testable JS (up from ~40%)

#### 4. Accessibility Audit (WCAG 2.1 AA)
- ✅ Focus-visible rings on all interactive elements
- ✅ `aria-selected` on session tabs, `aria-controls` on list containers
- ✅ `aria-label` on all dynamic/icon buttons (no visible text)
- ✅ `aria-live` on status messages (e.g., "Session created")
- ✅ Color contrast: ≥4.5:1 for all text elements (AA standard)
- ✅ Keyboard navigation: Tab through session list, Enter to select, Escape to close
- ✅ Screen reader tested with NVDA/JAWS simulation

### Files Modified
- `manifest.json` — Version bump 0.3.0→0.4.0, added `commands` section
- `background.js` — Added `chrome.commands.onCommand` listener, DNR debounce per-tab
- `popup/popup.js` — Added `aria-label`, `aria-live` to dynamic buttons
- `popup/popup.css` — Added `:focus-visible` ring styles, contrast fixes
- `popup/popup.html` — Added ARIA roles to containers
- `options/options.html` — Added ARIA labels to form controls
- `options/options.css` — Added focus ring styles
- `lib/cookie-parser.js` — Full test coverage (no logic changes)

### Files Created
- `tests/cookie-parser.test.js` (156 LOC, 32 test cases)
- `tests/page-proxy-storage.test.js` (118 LOC, 18 test cases)
- `tests/background-session-lifecycle.test.js` (94 LOC, 12 test cases)

### Quality Metrics
- **Tests:** 94/94 passing (100% pass rate)
- **Coverage:** ~75% of testable JS (excluding ISOLATED world bridge, MV3 APIs)
- **Accessibility:** WCAG 2.1 AA compliant (auto + manual audit)
- **Bundle:** No change (0 external deps)
- **Performance:** Session cycle <50ms, no lag on popup open
- **Regression:** Zero P1/P2 bugs on Phase 1–3 features

---

## v0.5.0 — Infrastructure & Sync (In Progress)

> **Estimated Effort:** 4 weeks  
> **Target:** Q3 2026

### Completed Prerequisite Work (2026-05-10 to 2026-05-15)

#### 1. TypeScript Migration
- ✅ Migrated all source files from `.js` to `.ts`
- ✅ No `any` types in lib/ or background/ modules
- ✅ `tsconfig.json` configured with strict mode
- ✅ `vitest.config.ts` setup with esbuild support
- ✅ `tsc --noEmit` passes with 0 errors
- Files migrated: tsconfig.json, vitest.config.ts, lib/*.ts, content.ts, page-api-proxy.ts, popup/popup.ts, options/options.ts, background/index.ts + 5 modules

#### 2. background.js Modularization
- ✅ Split monolithic 556 LOC background.js into 6 focused modules
- ✅ background/index.ts (~109 LOC) — listener registration entry point
- ✅ background/session-manager.ts (~93 LOC) — tab→session map, badge management, icons
- ✅ background/dnr-manager.ts (~134 LOC) — DNR rules, 50ms debounce, cookie capture
- ✅ background/context-menu-manager.ts (~40 LOC) — context menu lifecycle
- ✅ background/auto-assign-handler.ts (~27 LOC) — auto-assign navigation logic
- ✅ background/message-handler.ts (~137 LOC) — chrome.runtime.onMessage routing
- ✅ manifest.json updated (service_worker points to background/index.js)
- ✅ All 94 Vitest tests still passing
- ✅ No regression in extension behavior

### Planned Features

#### 1. IndexedDB Migration
- Migrate from `chrome.storage.local` → IndexedDB for higher quota (50MB+)
- Backwards-compatible: auto-migrate existing sessions on first run
- Backup/restore compatibility maintained
- Estimated effort: 1.5 weeks

#### 2. Cross-Device Sync
- User authentication via Google Sign-In (optional)
- Cloud backup of session list + cookies (end-to-end encrypted)
- Restore on new device via 2FA code
- Privacy-first: users opt-in; no telemetry
- Estimated effort: 2 weeks

#### 3. Privacy & Performance Audit
- Third-party cookie detection + logging
- Storage quota monitoring + alerts
- DNR rule limit tracking (Chrome: 30k rules max)
- Performance profiling: session switch latency, popup render time
- Estimated effort: 1 week

### Success Criteria
- [x] Acceptance criteria defined
- [ ] Research + planning complete (start May 2026)
- [ ] Implementation + testing
- [ ] Release to Web Store

---

## v0.6.0 — Advanced Analytics (Planned)

> **Estimated Effort:** 3 weeks  
> **Target:** Q4 2026

### Planned Features
- Privacy-respecting usage analytics (aggregate, no PII)
- Session creation/deletion trends
- Browser compatibility telemetry
- Feature adoption metrics
- No third-party services; local aggregation only

---

## Known Limitations & Non-Goals

### Known Limitations
1. **Private Browsing** — Sessions don't persist (chrome.storage.session limitation)
2. **Service Worker Restart** — Tab→session map reset (but sessions persist)
3. **No Auto-Login** — Manual login required per session
4. **Third-Party Cookies** — Subject to browser SameSite enforcement
5. **No Tab Grouping** — Sessions are logical, not visual

### Completed Features (v0.5.0, 2026-05-16)

#### 1. E2E Test Suite (Playwright)
- ✅ 17 E2E tests across 6 test files
- ✅ `playwright.config.ts` with chromium-extension project, 5 workers, CI retries
- ✅ Mock cookie server (`tests/e2e/mock-cookie-server.ts`) with random port binding
- ✅ Playwright fixtures (`tests/e2e/extension-fixtures.ts`) for context, extensionId, mockServerUrl, popupPage
- ✅ GitHub Actions workflow (`.github/workflows/test.yml`) with xvfb-run for Linux headless
- ✅ Test coverage:
  - Popup navigation & session switching
  - Session CRUD (create/rename/delete)
  - Auto-assign rules with pattern matching
  - Per-session cookie isolation + DNR enforcement
  - Keyboard shortcuts (Ctrl+Shift+S, cycle next/prev)
  - Export/import backup workflows
- ✅ Vitest config updated to exclude `tests/e2e/**` from unit test runs
- ✅ All tests passing; runs in CI/CD pipeline

### Non-Goals (Deferred or Unlikely)
- Custom browser-like UI — Popup is sufficient
- Extension sync via cloud (Phase 5 scope)
- Automatic cookie import from global jar
- Multi-profile extension

---

## Backlog (Future Consideration)

| Feature | Complexity | Priority | Reason |
|---------|------------|----------|--------|
| Session scheduling | High | Low | Niche use case |
| Browser sidebar integration | Medium | Low | MV3 limitation |
| Export to file picker | Low | Medium | UX improvement; deferred to v0.6 |
| Dark/light theme toggle | Low | Low | Works in system theme already |
| Bulk session import | Medium | Low | One-shot migration feature |
| Session templates | Medium | Low | Reduces setup time; niche |

---

## Rollout & Support

### Release Schedule
- **Patch releases** (0.4.x) — Bugfixes only, weekly cadence
- **Minor releases** (0.x.0) — Features + breaking changes, quarterly
- **Major releases** (1.0) — Rewrite/major refactor, not planned

### Update Mechanism
- Chrome Web Store auto-updates users (no manual action needed)
- Release notes published on GitHub Releases
- Changelog maintained in `docs/project-changelog.md`

### User Communication
- **In-app:** Release badge in options page (v0.5+)
- **Social:** GitHub releases, weekly dev log (if >100 active users)
- **Support:** GitHub Issues for bug reports; GitHub Discussions for feature requests

---

## Success Metrics (Tracking)

| Metric | v0.1 | v0.2 | v0.3 | v0.4 | Target |
|--------|------|------|------|------|--------|
| Chrome Web Store Rating | 4.8/5 | 4.8/5 | 4.8/5 | TBD | ≥4.5 |
| Weekly Active Users | 250 | 500 | 800 | TBD | 5,000+ by v0.6 |
| Test Coverage | 20% | 35% | 50% | 75% | ≥85% by v1.0 |
| Bundle Size (KB) | 125 | 140 | 145 | 145 | <200 |
| P1 Bugs (Open) | 0 | 0 | 0 | 0 | 0 always |

---

## Dependency Management

**Production:**
- Zero external dependencies (vanilla JS + MV3 APIs)

**Development:**
- Vitest (testing)
- jsdom (test environment)
- No build tooling required (unpacked extension)

**Browser Support:**
- Chrome 127+ (MV3 required; MV2 deprecated)
- Edge 127+ (Chromium-based)
- Brave, Vivaldi, Opera (Chromium-based)

---

## Architecture Evolutions

### v0.4 → v0.5
- Storage layer: `chrome.storage.local` → IndexedDB (backwards compatible)
- Auth layer: Add optional Google Sign-In for sync

### v0.5 → v0.6
- Analytics layer: Privacy-respecting aggregation
- Monitoring: Storage quota + DNR rule tracking

### v1.0 (Hypothetical)
- Service worker → Persistent background page (if MV3 allows)
- Rewrite UI: React/Vue for complex state management (if needed)

---

## References

- **Documentation:**
  - [Project Overview & PDR](project-overview-pdr.md)
  - [System Architecture](system-architecture.md)
  - [Code Standards](code-standards.md)
  - [Codebase Summary](codebase-summary.md)

- **Code Locations:**
  - Implementation: `/` (all source files)
  - Tests: `/tests/`
  - Plans: `/plans/`
  - Build artifacts: None (unpacked extension)

- **External Links:**
  - GitHub: https://github.com/anhkiet75/session-shift
  - Chrome Web Store: https://chromewebstore.google.com/detail/sessionshift/incpbanbmacagomhkmbjmncnhimngcmp
  - Issues: https://github.com/anhkiet75/session-shift/issues
  - Discussions: https://github.com/anhkiet75/session-shift/discussions
