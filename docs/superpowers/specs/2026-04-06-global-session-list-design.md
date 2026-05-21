# Global Session List

**Date:** 2026-04-06
**Status:** Approved
**Implementation approach:** TDD — tests written before each unit of implementation
**Scope:** `options/` (new), `popup/popup.html` + `popup.js` (entry point), `manifest.json` (options_page)

---

## Problem

The popup is scoped to one origin at a time. There is no way to see, manage, or act on sessions across all sites without navigating to each site individually.

## Goal

A full-page session manager (following SessionBox's pattern) that shows all sessions grouped by site, with inline rename, delete, and switch actions.

---

## Entry Point

Add a "Manage all sessions →" button/link to the popup footer alongside the existing Reset to Default button. Clicking it calls `chrome.runtime.openOptionsPage()` and closes the popup.

**Manifest change:**
```json
"options_page": "options/options.html"
```

No new permissions required.

---

## File Structure

```
options/
  options.html   — page shell, imports options.css + options.js
  options.css    — same design tokens as popup.css (CSS variables, Plus Jakarta Sans)
  options.js     — data loading, rendering, action handling
```

---

## Page Layout

- **Fixed header:** SessionShift logo + "All Sessions" title + search input (filters by session name or origin live as user types)
- **Scrollable body:** collapsible site sections
- **Site section header:** `origin · N sessions` — clickable to collapse/expand; starts expanded
- **Session row:** color dot · session name · active-tab indicator · Rename · Switch · Delete
- **Empty state:** "No sessions yet — create one from the popup on any site"

Sections start expanded on every page load (collapse state not persisted).

---

## Data Loading & Grouping

`options.js` on load:

1. `chrome.storage.local.get(null)` — read all keys at once
2. Filter for keys matching `/^list_/` — these are per-origin session lists
3. Strip `list_` prefix to recover origin; sort origins alphabetically
4. `chrome.tabs.query({})` — build `{sessionId → tabId}` map for active-tab indicators
5. Render one collapsible section per origin; sessions sorted by name within section

**Real-time updates:** `chrome.storage.onChanged` listener re-renders the affected site section when storage changes (session created/deleted/renamed from popup while options page is open). Full page reload not required.

---

## Actions

All three actions use existing background message handlers. No new backend logic.

### Rename
- Click Rename → name span replaced with inline input (same pattern as popup)
- On blur or Enter: update `list_<origin>` in storage directly (same as popup's `renameSession`)
- Row updates in place; sends `refreshBadge` message if session is active in a tab

### Delete
- Click Delete → `confirm("Delete session X on origin.com?")` dialog
- On confirm: send `deleteSession` message to background, remove entry from `list_<origin>` storage key, remove row from DOM
- Background already handles resetting affected tabs to default (existing behavior)

### Switch
- Only shown when origin has an open tab (derived from the tab query at load time)
- Click → send `setSession` message + `chrome.tabs.reload(tabId)` (same as popup)
- Hidden/disabled when no matching tab is open for that origin

---

## Search

The header search input filters the rendered list live (no storage queries on keystroke):

- Match against session name (case-insensitive substring)
- Match against origin (case-insensitive substring)
- Site sections with zero matching sessions are hidden entirely
- Empty search restores full list

---

## TDD Requirements

Each of the following units must have tests written **before** implementation:

| Unit | What to test |
|---|---|
| Storage parser | `list_` key filtering, origin extraction, alphabetical sort |
| Active-tab mapper | `{sessionId → tabId}` map built correctly from tab query results |
| Search filter | Name match, origin match, case-insensitivity, empty query restore |
| Rename handler | Storage write, DOM swap, badge refresh message |
| Delete handler | Background message sent, DOM row removed, confirm gate |
| Switch handler | Hidden when no tab, sends correct setSession + reload |
| Storage change listener | Re-renders correct section on `onChanged` event |

---

## Constraints & Edge Cases

- **No sessions at all:** Empty state message shown instead of any sections
- **Origin with one session:** Section still shown (no minimum)
- **Very long origin:** Section header truncates with ellipsis, full value in `title` attribute
- **Session active in multiple tabs:** Active-tab indicator shown; Switch targets the first matching tab
- **Storage key collision:** Keys not matching `/^list_<origin>/` pattern are silently ignored

---

## Files Changed

- `manifest.json` — add `"options_page": "options/options.html"`
- `options/options.html` — new
- `options/options.css` — new
- `options/options.js` — new
- `popup/popup.html` — add "Manage all sessions" button to footer
- `popup/popup.js` — wire button to `chrome.runtime.openOptionsPage()`
