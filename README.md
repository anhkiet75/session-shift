# SessionShift

A Chrome extension that gives each tab its own isolated session, letting you stay logged into multiple accounts on the same site simultaneously. A free, open-source alternative to SessionBox.

**[Install from Chrome Web Store](https://chromewebstore.google.com/detail/sessionshift/incpbanbmacagomhkmbjmncnhimngcmp)**  
**Current Version:** 0.2.0

---

## Quick Start

### Install from Chrome Web Store (Recommended)
1. Visit the [Chrome Web Store page](https://chromewebstore.google.com/detail/sessionshift/incpbanbmacagomhkmbjmncnhimngcmp)
2. Click **Add to Chrome**
3. Authorize permissions
4. Done — the popup appears in your toolbar

### Install from Source (Development)
1. Clone: `git clone https://github.com/anhkiet75/session-shift.git`
2. Navigate: `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select repo directory
5. Extension loads immediately (no build step)

---

## Features

- **Per-tab session isolation** — Cookies scoped to session, not browser profile
- **Named sessions** — Create and switch between sessions with custom names
- **All-sessions view** — Cross-origin list with search; switch from any site to any session
- **Auto-assign rules** — Define rules like "github.com → Work session"; automatically applied on tab navigation
- **Context menu integration** — Right-click any link → "Open in Session" to open with a specific session
- **Badge indicator** — Toolbar badge shows active session at a glance
- **Persistent across restarts** — Session assignments survive service worker restarts
- **Works on any site** — No per-site configuration; covers all URLs
- **No external dependencies** — Vanilla JS, Manifest V3, no bundler

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
├── manifest.json              # MV3 manifest & permissions
├── background.js              # Service worker (466 LOC)
├── content.js                 # ISOLATED world bridge (86 LOC)
├── page-api-proxy.js          # MAIN world API interception (222 LOC)
├── lib/
│   ├── cookie-parser.js       # Set-Cookie parsing (170 LOC)
│   ├── session-store.js       # Storage abstraction (158 LOC)
│   └── rule-matcher.js        # Hostname pattern matching (52 LOC)
├── popup/
│   ├── popup.html             # UI structure
│   ├── popup.js               # Session CRUD logic (525 LOC)
│   └── popup.css              # Stacks design system (788 LOC)
├── options/
│   ├── options.html           # Rule management UI (55 LOC)
│   ├── options.js             # Rule CRUD (184 LOC)
│   └── options.css            # Design tokens & layout (313 LOC)
├── icons/                     # Extension icons (16–128px)
├── tests/                     # Vitest unit tests (36 tests passing)
└── docs/                      # Project documentation
```

**Total:** ~3,064 LOC (main source files, excl. assets)

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

```bash
npm test          # Run Vitest unit tests
```

Test files:
- `tests/background-batch.test.js` — background.js message handlers
- `tests/options-filter.test.js` — cookie-parser.js functionality
- `tests/rule-matcher.test.js` — hostname pattern matching
- `tests/auto-assign.test.js` — auto-assign rule application

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
**Phase 3 (Q4 2026):** Tab colors, export/import, session duplication  
**Phase 4 (Q1 2027):** Keyboard shortcuts, analytics, accessibility audit  

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
