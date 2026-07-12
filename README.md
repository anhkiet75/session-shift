# SessionShift

A Chrome extension that gives each tab its own isolated session, letting you stay logged into multiple accounts on the same site simultaneously. A free, open-source alternative to SessionBox.

**[Install from Chrome Web Store](https://chromewebstore.google.com/detail/sessionshift/incpbanbmacagomhkmbjmncnhimngcmp)**  
**Current Version:** 0.0.8

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

- **Profile-based isolation** — Each profile is a global cookie container (like a Chrome profile); assign a tab to a profile and its cookies apply on every site that tab visits
- **Named profiles** — Create, rename, recolor, and switch between profiles with custom names
- **One global profile list** — A single searchable list; a profile created on one site is selectable on every site
- **Auto-inherit for linked tabs** — Tabs opened via links (`target="_blank"`, Ctrl+Click, middle-click) automatically inherit the opener tab's profile (toggle in Options, default on)
- **Open in new tab** — Right-click a profile in the popup to open the current page in that profile's session
- **Context menu integration** — Right-click any link → "Open in Session" to open it in a specific profile
- **Badge indicator** — Toolbar badge shows the active profile at a glance (color-coded by hue)
- **Duplicate profile** — Clone a profile's cookies into a new profile with one click
- **Persistent across restarts** — Session assignments survive service worker restarts
- **55 languages** — Full UI localization with honest quality tiers, RTL support (Arabic, Farsi, Hebrew), and English fallback for destructive/security messages on unreviewed locales
- **Keyboard shortcuts** — `Ctrl+Shift+S` to open popup; `Ctrl+Shift+Right/Left` to cycle profiles (customizable in `chrome://extensions/shortcuts`)
- **Theme switcher** — Dark / Light / System preference in Options, plus a quick toggle in the popup hero
- **Works on any site** — No per-site configuration; covers all URLs
- **No external services** — Fully offline; no analytics, no CDN, no runtime dependencies
- **WCAG 2.1 AA compliance** — Keyboard navigation, focus-visible rings, ARIA labels on all interactive elements, ≥4.5:1 contrast ratio

---

## How It Works

SessionShift isolates cookies at three layers:

1. **Network Layer (DNR)** — Rewrite Cookie headers per-tab via Declarative Net Request
2. **Storage Layer** — Maintain per-profile cookie stores in `chrome.storage.local`
3. **DOM Layer** — Override `document.cookie`, `localStorage`, `sessionStorage` via content scripts

Each tab is assigned a profile. When a tab makes a network request, the DNR rule injects only that profile's cookies. When the page reads `document.cookie`, the proxy returns only that profile's cookies.

```
Tab 1 (Profile A) ──DNR Rule──→ Cookie: profile_a_cookie_1=value
Tab 2 (Profile B) ──DNR Rule──→ Cookie: profile_b_cookie_1=value
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
│   ├── _locales/              # 55 Chrome i18n catalogs + quality registry
│   ├── background/            # Service worker modules (DNR, sessions, context menu, linked tabs, GC)
│   ├── content.ts             # ISOLATED world bridge
│   ├── page-api-proxy.ts      # MAIN world API interception
│   ├── lib/                   # Cookie/session/settings/localization helpers
│   ├── popup/                 # Popup UI modules + fonts/
│   ├── options/               # Options page (Settings + About tabs)
│   └── icons/                 # Extension icons (16–128px)
├── dist/                      # Build output (gitignored) — load this in Chrome
├── scripts/                   # build/dev/package scripts, locale validators, Docker e2e runner
├── tests/                     # Vitest unit + Playwright E2E
└── docs/                      # Project documentation
```

**Total:** ~14,300 LOC of TypeScript (excl. locale catalogs and assets)

---

## Documentation

Read the docs for deeper understanding:

- **[Project Overview & PDR](docs/project-overview-pdr.md)** — Problem statement, features, success metrics, architecture decisions
- **[Codebase Summary](docs/codebase-summary.md)** — File map, module responsibilities, data flow, storage schema
- **[Code Standards](docs/code-standards.md)** — Conventions, naming, error handling, security patterns, i18n rules, testing
- **[System Architecture](docs/system-architecture.md)** — Service worker lifecycle, DNR cookie isolation, ISOLATED/MAIN world bridge, message protocol, localization design
- **[Project Roadmap](docs/project-roadmap.md)** — Current status, upcoming phases, backlog items
- **[Translation Contributing](docs/translation-contributing.md)** — Locale quality tiers, critical-key review gate, Weblate contribution/promotion workflow

---

## Permissions

| Permission | Why |
|---|---|
| `declarativeNetRequest` | Rewrite Cookie headers per-tab |
| `webRequest` | Intercept Set-Cookie responses |
| `webNavigation` | Detect link-opened tabs for profile inheritance |
| `storage` | Persist profile data, tab mapping, and settings |
| `tabs` | Track which tab maps to which profile |
| `contextMenus` | Create context menu for "Open in Session" |
| `alarms` | Schedule periodic storage garbage collection |
| `<all_urls>` | Operate on any website |

---

## Usage

### Create a Profile
1. Open the SessionShift popup (click toolbar icon or `Ctrl+Shift+S`)
2. Type a name (e.g., "Work", "Personal")
3. Click **Create**
4. The current tab now uses that profile; cookies are isolated

### Switch Profiles
1. Open popup
2. Click any profile in the list (or cycle with `Ctrl+Shift+Right/Left`)
3. Page reloads with that profile's cookies

### Open Current Page in Another Profile
1. Right-click a profile card in the popup
2. Choose **Open in new tab** — the page opens in a new tab bound to that profile

### Open Link in a Profile
1. Right-click any link on a web page
2. Hover over **Open in Session**
3. Select a profile from the submenu
4. Link opens in a new tab with that profile active

### Delete a Profile
1. Open popup
2. Hover over a profile, click **Delete**
3. All cookies for that profile are permanently removed
4. Tabs in that profile are reset to default

### Settings (Options Page)
- **Theme** — Dark / Light / System
- **Language** — Pick any of the 55 supported languages (applies to popup, Options, and context menus)
- **Auto-open linked tabs in the same profile** — Toggle link-opened-tab profile inheritance (default on)

### Reset to Default
Click **Reset to default** to return the current tab to the browser's global cookie jar

---

## Security

- **Cookies never exposed in DOM** — Stored only in `chrome.storage.local` and DNR rules
- **Nonce-authenticated messages** — Prevents rogue page scripts from hijacking postMessage
- **Prefix-scoped storage** — localStorage/sessionStorage isolated per profile
- **No eval, no unsafe DOM manipulation** — Follows security best practices
- **No external services** — Fully offline; no analytics, no CDN

See [System Architecture § Threat Model](docs/system-architecture.md#threat-model--mitigations) for details.

---

## Testing

### Unit Tests (Vitest)

```bash
npm run test:unit     # run all Vitest unit tests (299 tests)
```

Coverage areas: session lifecycle, DNR rule building, Set-Cookie parsing, cookie write locking, page-proxy isolation and storage, profile migration, linked-tab inheritance, public-suffix matching, storage GC, manifest permissions, and localization (catalog integrity, runtime adapter, critical-key fallback).

### Locale Validation

```bash
npm run validate:locales                  # 55 catalogs: key/placeholder parity, charset checks
npm run validate:localization-artifacts   # build/package localization artifacts
```

### E2E Tests (Playwright)

Chrome extensions require `headless: false`, so E2E runs go through the Docker-based runner (which provides a display on any host):

```bash
npm run build             # compile TypeScript first (required)
npm run test:e2e:docker   # run Playwright suite in Docker (39 tests)
```

E2E suites in `tests/e2e/`:
- `session-isolation.test.ts` — DNR cookie isolation between profiles
- `session-crud.test.ts` — create, switch, delete, duplicate via popup UI
- `global-session-list.test.ts` — cross-origin global profile list and search filter
- `linked-tab-profile-inheritance.test.ts` — profile inheritance for link-opened tabs
- `profile-open-in-new-tab.test.ts` — right-click "Open in new tab" cookie isolation
- `theme-switcher.test.ts` — dark/light/system theme persistence
- `localization-rtl.test.ts` — RTL rendering, locale switching, manifest/context-menu i18n
- `native-locale-smoke.test.ts` — native `chrome.i18n` locale smoke tests

---

## Contributing

Pull requests are welcome! For significant changes:
1. Open an issue first to discuss your idea
2. Fork the repo
3. Create a feature branch: `git checkout -b feature/your-feature`
4. Make your changes (follow [code standards](docs/code-standards.md))
5. Run tests: `npm run test:unit && npm run test:e2e:docker`
6. Commit with clear message (conventional commits)
7. Push and open a pull request

**Translations:** see [Translation Contributing](docs/translation-contributing.md) for the Weblate workflow and quality-tier promotion rules.

**Contribution guidelines:**
- Keep commits focused on one feature/fix
- Write clear commit messages
- Add tests for new functionality
- Update docs if behavior changes

---

## Roadmap

**Shipped:** Core per-tab session isolation · Global profile list · Context menu & keyboard shortcuts · Profile duplication · Theme switcher · WCAG 2.1 AA accessibility · Linked-tab profile inheritance · Popup right-click "Open in new tab" · Full localization (55 locales, RTL support)

See [Project Roadmap](docs/project-roadmap.md) for the detailed plan and feature backlog.

---

## Known Limitations

- **Private browsing:** Sessions don't persist (chrome.storage.session limitation)
- **No auto-login:** You must manually log in once per profile
- **Linked-tab first request:** For link-opened tabs, the very first network request may not be hard-guaranteed cookie-clean due to browser timing; isolation is deterministic from the second request onward
- **No tab grouping:** Profiles are logical, not visual

---

## License

[MIT](LICENSE)

---

## Support

- **Bug reports:** Open a [GitHub issue](https://github.com/anhkiet75/session-shift/issues)
- **Feature requests:** [GitHub discussions](https://github.com/anhkiet75/session-shift/discussions)
- **Reviews:** [Chrome Web Store](https://chromewebstore.google.com/detail/sessionshift/incpbanbmacagomhkmbjmncnhimngcmp)
