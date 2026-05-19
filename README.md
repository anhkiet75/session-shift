# SessionShift

A Chrome extension that gives each tab its own isolated session, letting you stay logged into multiple accounts on the same site simultaneously. A free, open-source alternative to SessionBox.

**[Install from Chrome Web Store](https://chromewebstore.google.com/detail/sessionshift/incpbanbmacagomhkmbjmncnhimngcmp)**  
**Current Version:** 0.5.0

---

## Quick Start

### Install from Chrome Web Store (Recommended)
1. Visit the [Chrome Web Store page](https://chromewebstore.google.com/detail/sessionshift/incpbanbmacagomhkmbjmncnhimngcmp)
2. Click **Add to Chrome**
3. Authorize permissions
4. Done — the popup appears in your toolbar

### Install from Source (Development)
1. Clone: `git clone https://github.com/anhkiet75/session-shift.git`
2. Install deps: `npm install`
3. Build: `npm run build` (outputs to `dist/`)
4. Navigate: `chrome://extensions`
5. Enable **Developer mode** (top-right toggle)
6. Click **Load unpacked** → select the `dist/` directory

---

## Features

- **Per-tab session isolation** — Cookies scoped to session, not browser profile
- **Named sessions** — Create and switch between sessions with custom names
- **All-sessions view** — Cross-origin list with search; switch from any site to any session
- **Auto-assign rules** — Define rules like "github.com → Work session"; automatically applied on tab navigation
- **Context menu integration** — Right-click any link → "Open in Session" to open with a specific session
- **Badge indicator** — Toolbar badge shows active session at a glance (color-coded by session hue)
- **Duplicate session** — Clone a session's cookies into a new session with one click
- **Tab color labels** — Session colors appear in toolbar badge for visual identification
- **Persistent across restarts** — Session assignments survive service worker restarts
- **Works on any site** — No per-site configuration; covers all URLs
- **No external dependencies** — Vanilla JS, Manifest V3, no bundler
- **Keyboard shortcuts** — `Ctrl+Shift+S` to open popup; `Ctrl+Shift+Right/Left` to cycle sessions (customizable in `chrome://extensions/shortcuts`)
- **Lazy DNR optimization** — Debounced DNR rule updates (50ms window) for high-frequency Set-Cookie responses
- **WCAG 2.1 AA compliance** — Keyboard navigation, focus-visible rings, ARIA labels on all interactive elements, ≥4.5:1 contrast ratio
- **Theme switcher** — Dark / Light / System preference in Options, plus a quick toggle in the popup hero (cycles Light → Dark → System on click)

---

## How It Works

SessionShift isolates cookies at three layers:

1. **Network Layer (DNR)** — Rewrite Cookie headers per-tab via Declarative Net Request
2. **Storage Layer** — Maintain per-session cookie stores in `chrome.storage.local`
3. **DOM Layer** — Override `document.cookie`, `localStorage`, `sessionStorage` via content scripts

Each tab gets its own session ID. When a tab makes a network request, the DNR rule injects only that session's cookies. When the page reads `document.cookie`, the proxy returns only that session's cookies.

```
Tab 1 (Session A) ──DNR Rule──→ Cookie: session_a_cookie_1=value
Tab 2 (Session B) ──DNR Rule──→ Cookie: session_b_cookie_1=value
         ↓
    Both tabs simultaneously logged in to the same site
```

**Technical deep-dive:** See [`docs/system-architecture.md`](docs/system-architecture.md)

---

## Project Structure

```
session-shift/
├── src/                       # All source files (TypeScript + assets)
│   ├── manifest.json          # MV3 manifest & permissions
│   ├── background/            # Service worker modules (TS)
│   ├── content.ts             # ISOLATED world bridge
│   ├── page-api-proxy.ts      # MAIN world API interception
│   ├── lib/                   # Cookie/session/rule helpers (TS)
│   ├── popup/                 # popup.{ts,html,css} + fonts/
│   ├── options/               # options.{ts,html,css}
│   └── icons/                 # Extension icons (16–128px)
├── dist/                      # Build output (gitignored) — load this in Chrome
├── scripts/                   # build.sh, package.sh
├── tests/                     # Vitest unit + Playwright E2E
└── docs/                      # Project documentation
```

**Total:** ~3,431 LOC (main source files, excl. assets)

---

## Documentation

Read the docs for deeper understanding:

- **[Project Overview & PDR](docs/project-overview-pdr.md)** — Problem statement, features, success metrics, architecture decisions
- **[Codebase Summary](docs/codebase-summary.md)** — File map, module responsibilities, data flow, storage schema
- **[Code Standards](docs/code-standards.md)** — Conventions, naming, error handling, security patterns, testing
- **[System Architecture](docs/system-architecture.md)** — Service worker lifecycle, DNR cookie isolation, ISOLATED/MAIN world bridge, message protocol
- **[Project Roadmap](docs/project-roadmap.md)** — Current status, phases 2–4, backlog items, timelines

---

## Permissions

| Permission | Why |
|---|---|
| `declarativeNetRequest` | Rewrite Cookie headers per-tab |
| `webRequest` | Intercept Set-Cookie responses |
| `cookies` | Read browser's global cookie jar for snapshots |
| `storage` | Persist session data, tab mapping, and auto-assign rules |
| `tabs` | Track which tab maps to which session |
| `contextMenus` | Create context menu for "Open in Session" |
| `<all_urls>` | Operate on any website |

---

## Usage

### Create a Session
1. Open the SessionShift popup (click toolbar icon)
2. Type a name (e.g., "Work", "Personal")
3. Click **Create**
4. You're now in that session; cookies are isolated

### Switch Sessions
1. Open popup
2. Click any session in the list
3. Page reloads with that session's cookies

### Delete a Session
1. Open popup
2. Hover over a session, click **Delete**
3. All cookies for that session are permanently removed
4. Tabs in that session are reset to default

### Configure Auto-Assign Rules
1. Click the **⚙ Settings** button in the popup
2. Add a rule: e.g., "github.com" → select "Work" session
3. Save rule — now any tab navigating to github.com auto-switches to Work session
4. Edit or delete rules anytime

### Open Link in Session
1. Right-click any link on a web page
2. Hover over **Open in Session**
3. Select a session from the submenu
4. Link opens in a new tab with that session active

### Reset to Default
Click **Reset to default** to return the current tab to the browser's global cookie jar

---

## Security

- **Cookies never exposed in DOM** — Stored only in `chrome.storage.local` and DNR rules
- **Nonce-authenticated messages** — Prevents rogue page scripts from hijacking postMessage
- **Prefix-scoped storage** — localStorage/sessionStorage isolated per session
- **No eval, no unsafe DOM manipulation** — Follows security best practices
- **No external services** — Fully offline; no analytics, no CDN

See [System Architecture § Threat Model](docs/system-architecture.md#threat-model--mitigations) for details.

---

## Testing

### Unit Tests (Vitest)

```bash
npm run test:unit     # run all Vitest unit tests
```

Test suites (94 tests total):
- `tests/background-batch.test.js` — background.js message handlers
- `tests/background-session-lifecycle.test.js` — session lifecycle and keyboard command handlers
- `tests/options-filter.test.js` — cookie-parser.js functionality
- `tests/cookie-parser.test.js` — Set-Cookie parsing edge cases (>90% coverage)
- `tests/rule-matcher.test.js` — hostname pattern matching
- `tests/auto-assign.test.js` — auto-assign rule application
- `tests/page-proxy-storage.test.js` — localStorage/sessionStorage proxy behavior
- Additional coverage tests — DNR debounce, ARIA attribute validation, keyboard navigation

### E2E Tests (Playwright)

Chrome extensions require `headless: false`. On Linux without a display, use `xvfb-run`.

```bash
npm run build         # compile TypeScript first (required)
npm run test:e2e      # run Playwright suite (17 tests, 5 parallel workers)

# Linux / CI without display:
xvfb-run -a npm run test:e2e
```

E2E suites in `tests/e2e/`:
- `session-isolation.test.ts` — DNR cookie isolation between sessions
- `session-crud.test.ts` — create, switch, delete, duplicate via popup UI
- `auto-assign-rules.test.ts` — rule creation and deletion in options page
- `export-import.test.ts` — JSON backup export and import roundtrip
- `theme-switcher.test.ts` — dark/light/system theme persistence
- `global-session-list.test.ts` — cross-origin all-sessions view and search filter

---

## Contributing

Pull requests are welcome! For significant changes:
1. Open an issue first to discuss your idea
2. Fork the repo
3. Create a feature branch: `git checkout -b feature/your-feature`
4. Make your changes (follow [code standards](docs/code-standards.md))
5. Run tests: `npm test`
6. Commit with clear message (conventional commits)
7. Push and open a pull request

**Contribution guidelines:**
- Keep commits focused on one feature/fix
- Write clear commit messages
- Add tests for new functionality
- Update docs if behavior changes

---

## Roadmap

**Phase 1 (Shipped):** Core session isolation  
**Phase 2 (Shipped):** Global session list, auto-assign rules, context menu  
**Phase 3 (Shipped v0.3.0):** Tab colors, export/import, session duplication, settings page  
**Phase 4 (Shipped v0.4.0):** Keyboard shortcuts, lazy DNR optimization, expanded test coverage, WCAG 2.1 AA accessibility  
**Phase 5 (Planned):** IndexedDB migration, cross-device sync, advanced analytics  

See [Project Roadmap](docs/project-roadmap.md) for detailed plan and feature backlog.

---

## Known Limitations

- **Private browsing:** Sessions don't persist (chrome.storage.session limitation)
- **No auto-login:** You must manually log in once per session
- **Session window only:** Service worker restart clears tab→session map (recoverable)
- **No tab grouping:** Sessions are logical, not visual

---

## License

[MIT](LICENSE)

---

## Support

- **Bug reports:** Open a [GitHub issue](https://github.com/anhkiet75/session-shift/issues)
- **Feature requests:** [GitHub discussions](https://github.com/anhkiet75/session-shift/discussions)
- **Reviews:** [Chrome Web Store](https://chromewebstore.google.com/detail/sessionshift/incpbanbmacagomhkmbjmncnhimngcmp)
