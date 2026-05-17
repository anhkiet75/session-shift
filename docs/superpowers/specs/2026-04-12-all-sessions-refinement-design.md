# Design Spec: All-Sessions Manager Power User Refinement

**Date:** 2026-04-12
**Status:** Approved
**Goal:** Improve the "All Sessions" manager with bulk actions, advanced filtering, and efficiency improvements for power users.

---

## 1. Problem Statement
The current "All Sessions" manager is a basic list. As users accumulate sessions across many sites, managing them one-by-one becomes tedious. There is no way to perform bulk operations or quickly isolate active sessions.

## 2. Proposed Solution
Enhance the options page with a selection-driven bulk action system and a more robust filtering engine, while optimizing the background communication for batch operations.

---

## 3. Design Details

### 3.1 Core Architecture & Data Model
- **Selection State:** A `selectedSessions` Set in `options.js` tracks session IDs across all origins.
- **Filter State:** A `FilterState` object manages the current view:
    - `query`: String for substring match on name/origin.
    - `activeOnly`: Boolean to show only sessions with at least one open tab.
    - `sortBy`: Enum (`'alphabetical'`, `'count'`) to order the site sections.
- **Batch Communication:** Introduction of pluralized message handlers in `background.js` (e.g., `deleteSessions`) to minimize API calls to `chrome.declarativeNetRequest`.

### 3.2 UI/UX Components

#### The Toolbar
- **Search Input:** Live-filters the list based on `FilterState.query`.
- **Filter Chips:** Toggles for "Active Only" and "Recent".
- **Sort Dropdown:** Selection for alphabetical vs. count-based sorting.

#### The Bulk Action Bar
- **Trigger:** Appears when `selectedSessions.size > 0`.
- **Position:** Sticky bottom bar.
- **Actions:** 
    - `Rename Selected`: Prompt for a prefix or new name.
    - `Delete Selected`: Confirmed batch removal of sessions.

#### The Enhanced Session Row
- **Checkbox:** For bulk selection.
- **Session Info:** Color dot and name.
- **Quick Actions:**
    - `Active` indicator (visual only).
    - `Switch` button (if tab open).
    - `Delete` icon (single remove).

---

## 4. Implementation Plan

### 4.1 Background Script (`background.js`)
- Implement `deleteSessions` handler:
    - Call `deleteSessionData` for all provided IDs.
    - Calculate all affected `tabIds`.
    - Call `chrome.declarativeNetRequest.updateSessionRules` once to reset all affected tabs to `default`.
- Implement `renameSessions` handler to batch update `list_<origin>` keys.

### 4.2 Options Page (`options.js`)
- Refactor rendering into a `renderList()` function driven by `FilterState`.
- Implement checkbox event listeners to manage the `selectedSessions` set.
- Implement the Bulk Action Bar visibility logic.
- Use `DocumentFragment` for efficient DOM updates.

---

## 5. TDD & Testing Requirements

| Unit | Test Case |
|---|---|
| **Filter Logic** | Verify `activeOnly` correctly hides inactive sessions. |
| **Filter Logic** | Verify `query` matches both session names and origins. |
| **Selection** | Bulk bar visibility toggles correctly on checkbox change. |
| **Batch Delete** | Background script removes multiple session data sets and clears all associated DNR rules in one call. |
| **Batch Rename** | Multiple sessions across different origins are renamed correctly. |
| **Empty State** | "No matching sessions" displays when filters result in an empty list. |

---

## 6. Constraints & Edge Cases
- **Large Lists:** Ensure the UI remains responsive with 100+ sessions.
- **DNR Collision:** Ensure batch DNR updates do not interfere with other active sessions.
- **Partial Deletion:** If a user deletes a session that is the only one for a site, the site section must be removed from the DOM.
