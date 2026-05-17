# Session Persistence Across Browser Restarts

**Date:** 2026-04-06  
**Status:** Approved  
**Scope:** `background.js` only — no changes to popup, content script, or page-api-proxy

---

## Problem

Tab→session assignments are stored in `chrome.storage.session`, which Chrome clears on browser restart. When the user reopens Chrome with "continue where you left off", all tabs lose their session isolation silently.

## Goal

Silently restore every isolated tab to its correct session after a browser restart, with no user action required.

---

## Data Layer

Add a new `chrome.storage.local` key: `persistedTabs`.

Shape — an ordered array (order matters for tie-breaking):

```js
[
  { url: "https://github.com/", sessionId: "session_abc123", windowId: 1, index: 0 },
  { url: "https://github.com/", sessionId: "session_def456", windowId: 1, index: 3 },
]
```

- Only non-default, non-snap sessions are included
- `windowId` and `index` are the tab's position at the time of last write
- Cookie data itself already lives in `chrome.storage.local` under `cookies_<sessionId>` — no change needed there

---

## Startup Restoration (`restorePersistedSessions`)

Runs once at service worker startup, before any other logic.

**Algorithm:**

1. Load `persistedTabs` from `chrome.storage.local`
2. If empty or missing, return immediately (no-op)
3. Query all current tabs via `chrome.tabs.query({})`
4. For each entry in `persistedTabs`:
   - **Primary match:** find tab where `url + windowId + index` all match
   - **Fallback match:** if no exact match, find tab where `url + windowId` match with closest `index`
   - If matched: write to `tabSessions`, apply DNR rule, set badge
5. Skip entries with `sessionId === 'default'` (nothing to apply)
6. Persist restored `tabSessions` to `chrome.storage.session`

This handles the case where Chrome restores multiple tabs on the same origin in different sessions (e.g. two github.com tabs in Work and Personal) — they're distinguished by tab index within the window.

**Coexistence with existing `restoreTabSessions()`:**

The existing function (reads from `chrome.storage.session`) handles service worker restarts mid-session without a full browser restart. Both run at startup; `restoreTabSessions` runs first, then `restorePersistedSessions` fills in any gaps (entries in `.local` not already in `.session`).

---

## Persistence Write Path (`persistTabsToLocal`)

A new async function called alongside every existing `persistTabSessions()` call.

**Implementation:**

```
async function persistTabsToLocal() {
  const tabs = await chrome.tabs.query({})
  const entries = tabs
    .filter(tab => {
      const sid = tabSessions[tab.id]
      return sid && sid !== 'default' && !isInternalSession(sid)
    })
    .map(tab => ({
      url: tab.url,
      sessionId: tabSessions[tab.id],
      windowId: tab.windowId,
      index: tab.index
    }))
  await chrome.storage.local.set({ persistedTabs: entries })
}
```

**Four call sites updated in `background.js`:**

| Handler | Why |
|---|---|
| `setSession` | Tab assigned a session |
| `deleteSession` | Session removed, affected tabs cleared |
| `createSessionTab` | New isolated tab created |
| `tabs.onRemoved` | Tab closed, entry must be removed |

---

## Constraints & Edge Cases

- **No "continue where you left off":** If the user's Chrome is set to open a new tab on start, no tabs are restored by Chrome — `persistedTabs` will find no matches and is a no-op. Correct behavior.
- **URL collision:** Two entries with the same URL in different sessions are disambiguated by `windowId + index`. If Chrome reorders tabs (rare), the worst case is two sessions swapped — not data loss.
- **Deleted session:** If a session was deleted while Chrome was closed, its `cookies_<id>` entry is gone. The DNR rule will apply an empty cookie string (existing behavior for missing stores). The popup will not list it. Acceptable.
- **New permissions:** None required. `chrome.tabs.query` is already permitted via `"tabs"`.

---

## Files Changed

- `background.js` — add `persistTabsToLocal()`, `restorePersistedSessions()`, update four call sites
- No other files touched
