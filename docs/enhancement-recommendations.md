# SessionShift — Enhancement Recommendations

**Date:** 2026-06-10
**Reviewed:** `src/` (manifest v0.0.6), `tests/`, `docs/`
**Context:** Core isolation engine (DNR rules, webRequest cookie capture, page-API proxies) is solid and red-team audited (see `security-audit-report.md`). Items below are remaining gaps, ordered by priority.

---

## P1 — Isolation Gaps (Correctness)

### 1.1 Cookie Store API not proxied
- `document.cookie` is intercepted, but `window.cookieStore` (async API) is not.
- Pages in isolated tabs can read/write the real cookie jar via `cookieStore.get/set/delete` — same leak class as audit findings H1/H3, different entry point.
- Fix: proxy `cookieStore` in `page-api-proxy.ts`, route writes through existing `updateCookie` message path.

### 1.2 Third-party requests leak default identity
- Base DNR rule strips `Cookie` only for bound host's eTLD+1 (`dnr-cookie-rule-builder.ts:107`).
- Cross-site subresources/iframes in isolated tab still send global-jar cookies.
- Fix: strip `Cookie` on ALL requests in isolated tabs (resource types already cover everything). Evaluate breakage risk on SSO/CDN flows first.

### 1.3 `document.cookie` setter drops attributes
- Only `name=value` + `max-age<=0` honored (`page-api-proxy.ts:110-152`). `Domain=`, `Path=`, `Expires=` ignored.
- Result: JS-set cookies never reach subdomains, never expire.
- Fix: reuse full parser from `lib/cookie-parser.ts`; pass attrs through `updateCookie` payload.

### 1.4 Storage proxy identity breaks sites
- Getter returns NEW object each access → `window.localStorage !== window.localStorage`, `instanceof Storage` fails. Some libs break.
- `storage` events not remapped: listeners see prefixed keys + other sessions' writes.
- Inline proxy in `page-api-proxy.ts` duplicates `lib/storage-proxy.ts`.
- Fix: cache singleton proxy; filter + strip prefix on `storage` events; dedupe impl.

### 1.5 IndexedDB / Cache API partial coverage
- `indexedDB.databases()` unproxied — leaks prefixed DB names across sessions.
- `caches.match` unproxied.
- Fix: wrap both, filter/strip prefix.

## P2 — Manifest / CWS Review Risk

### 2.1 Unused `cookies` permission
- Nothing in `src/` calls `chrome.cookies`. Permission is part of most heavily reviewed trio (`webRequest` + `declarativeNetRequest` + `cookies` + `<all_urls>`).
- Fix: remove from `src/manifest.json`. Reduces review friction + attack surface.

## P3 — Feature Gaps (Docs Claim Shipped; Code Says No)

`project-roadmap.md` claims auto-assign rules, export/import, OffscreenCanvas colored icons shipped v0.2–0.4. None exist in `src/` — options page is theme + about only. `BACKLOG.md` conversely marks already-implemented features (context menu, global list, duplicate) as "Backlog".

| Feature | Value | Notes |
|---------|-------|-------|
| Auto-assign rules (origin → session) | High | Biggest UX win; needs rule CRUD UI + nav hook |
| Export / import sessions | High | All data in `chrome.storage.local`, zero backup path today |
| Colored tab indicator (icon, not just badge) | Medium | Roadmap Phase 3 item |
| Sync docs to reality | High, cheap | Roadmap + backlog both wrong, mislead future work |

## P4 — Housekeeping

- Expired cookies skipped at serialize (`cookie-parser.ts:188`) but never purged from storage. Add `chrome.alarms` periodic GC.
- `findOrphanedCookieStores()` (`session-store.ts:71`) defined, never called in src. Wire into same GC.
- DNR budget 100 rules/tab; deep-path scopes silently dropped. Add console warning when hit.
- Badge label truncated to 3 chars; fine, but document it.

## Suggested Sequence

1. 1.1 + 1.3 — contained changes, `page-api-proxy.ts` + `message-handler.ts`, existing tests extend naturally
2. 2.1 — one-line manifest change
3. 1.4 + 1.5 — page-proxy refactor pass
4. 1.2 — needs breakage evaluation first
5. P4 GC — small background addition
6. P3 features — own spec → plan → implement cycles per `BACKLOG.md` convention

---

## Unresolved Questions

- 1.2: strip cookies on all third-party requests, or allowlist (e.g., SSO providers)? Breakage risk unmeasured.
- P3: are roadmap "shipped" claims from an older branch/dist not in this repo, or aspirational? Affects whether features are rebuilds or ports.
- Version drift: src manifest 0.0.6, releases/ has 0.0.5–0.0.6, roadmap says 0.4.1 shipped. Which is canonical?
