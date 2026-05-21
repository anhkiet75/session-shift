# SessionShift — Feature Backlog

Ordered by recommended build sequence. Each item gets its own spec → plan → implementation cycle.

| # | Feature | Status | Depends on |
|---|---------|--------|------------|
| 1 | Session persistence across restarts | ✅ Specced | — |
| 2 | Open link in session (context menu) | Backlog | — |
| 3 | Auto-assign rules | Backlog | — |
| 4 | Global session list | Backlog | #1 (persistence) |
| 5 | Session color labels in tab | Backlog | — |
| 6 | Session search / filter | Backlog | #4 (global list) |
| 7 | Session export / import | Backlog | #4 (global list) |
| 8 | Duplicate session | Backlog | — |

## Feature Descriptions

### 2. Open link in session
Right-click any link on a page → context menu shows "Open in session…" → submenu lists all sessions for that origin → opens link in chosen session in a new tab.

### 3. Auto-assign rules
User defines rules like "always open github.com in Work session". When a new tab navigates to a matching origin, the session is applied automatically without manual switching.

### 4. Global session list
A dedicated view (separate popup page or expanded panel) showing all sessions across all sites — not just the active tab's origin. Allows managing sessions without needing to be on that site.

### 5. Session color labels in tab
Each session's color is surfaced in the tab favicon area or as a colored border, so the user can distinguish sessions at a glance without opening the popup.

### 6. Session search / filter
A search input in the popup (or global list) to filter sessions by name. Useful when a user accumulates 10+ sessions across many sites.

### 7. Session export / import
Export all sessions (metadata + cookies) to a JSON file. Import on another machine. Enables backup and cross-device migration.

### 8. Duplicate session
Clone an existing session's cookies into a new named session on the same origin. Useful for creating a variation of an existing logged-in state.
