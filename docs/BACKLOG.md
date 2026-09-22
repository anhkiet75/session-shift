# SessionShift — Feature Backlog

Ordered by recommended build sequence. Each item gets its own spec → plan →
implementation cycle.

**Status is verified against `src/` and `tests/`, not against past intent.**
A ✅ Shipped row names the module that implements it.

| # | Feature | Status | Implemented by |
|---|---------|--------|----------------|
| 1 | Session persistence across restarts | ✅ Shipped | `background/session-manager.ts` (`tabSessions` + `chrome.storage.session`) |
| 2 | Open link in session (context menu) | ✅ Shipped | `background/context-menu-manager.ts` |
| 3 | Auto-assign rules | Backlog | — (no rule engine exists) |
| 4 | Global session list | ✅ Shipped | single global `profiles` key in `lib/session-store.ts` |
| 5 | Session color labels in tab | ✅ Shipped | `background/profile-icon-renderer.ts` (tinted toolbar icon) + colored badge; optional native tab groups via `background/tab-group-sync.ts` |
| 6 | Session search / filter | ✅ Shipped | popup `#searchInput` → `popup/popup-render-profile-list.ts` |
| 7 | Session export / import | Backlog | — (no export/import code or UI exists) |
| 8 | Duplicate session | ✅ Shipped | `duplicateSession()` in `lib/session-store.ts` |
| 9 | Favorites (saved page + profile launcher) | ✅ Shipped | `lib/favorites-store.ts`, popup favorites section, Options → Favorites |

## Remaining Backlog Items

### 3. Auto-assign rules
User defines rules like "always open github.com in Work session". When a new tab
navigates to a matching origin, the session is applied automatically without
manual switching.

**Not built.** Deliberately declined during the Favorites plan: a
navigation-time rule engine touches every navigation and risks silently taking
over normal browsing. Revisit only with an explicit opt-in design.

### 7. Session export / import
Export all profiles (metadata + cookies) to a JSON file; import on another
machine. Enables backup and cross-device migration.

**Not built.** Note the security weight: an export file would contain live
session cookies in plaintext, so this needs a threat-model decision before a
plan, not just an implementation.

## Shipped Feature Notes

### 2. Open link in session
Right-click any link → **Open in Session** → submenu lists every profile → the
link opens in a new tab bound to the chosen profile.

### 4. Global session list
Profiles are global containers: one `profiles` key holds every profile, and a
profile created on one site is selectable on every site. This replaced the
former per-origin `list_${origin}` keys (`lib/profile-migration.ts` folds legacy
entries in on install).

### 5. Session color labels in tab
Each profile's hue drives the toolbar badge and a tinted extension icon, so two
tabs on different profiles are distinguishable without opening the popup.
Optional native Chrome tab groups add a per-profile colored group in the tab
strip (Options, off by default).

### 6. Session search / filter
The popup search input filters profiles by name, and favorites by label and
hostname.

### 8. Duplicate session
Clones an existing profile's cookie store into a new profile, so a logged-in
state can be forked without logging in again.

### 9. Favorites
A saved `(url, profile)` pair. Saved with the popup hero star, launched from the
popup favorites list into that profile's cookie jar, and fully managed in
Options → Favorites. Deliberately *not* an auto-assign rule: it only acts when
the user clicks it.
