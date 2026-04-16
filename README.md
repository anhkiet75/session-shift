# SessionShift

A Chrome extension that gives each tab its own isolated session, letting you stay logged into multiple accounts on the same site simultaneously. A free, open-source alternative to SessionBox.

[Install from Chrome Web Store](https://chromewebstore.google.com/detail/sessionshift/incpbanbmacagomhkmbjmncnhimngcmp)

## Features

- **Per-tab session isolation** — cookies are scoped to a session, not the browser profile
- **Named sessions** — create and switch between sessions with custom names
- **Badge indicator** — the toolbar badge shows the active session at a glance
- **Persistent across restarts** — session assignments survive service worker restarts via `chrome.storage.session`
- **Works on any site** — host permissions cover all URLs; no per-site configuration needed
- **No external dependencies** — vanilla JS, Manifest V3, no bundler required

## How It Works

SessionShift intercepts HTTP cookie headers at the network layer and redirects them to a per-session cookie store in `chrome.storage.local`, keeping each session's cookies completely separate from the browser's native cookie jar.

```
Tab → background.js (tab→session map)
         ↓
   webRequest listeners
         ↓
   cookie-parser.js  ←→  session-store.js (chrome.storage.local)
         ↓
   Rewritten Cookie / Set-Cookie headers injected per request
```

`content.js` (ISOLATED world) bridges the extension and the page, while `page-api-proxy.js` (MAIN world) intercepts `document.cookie` reads and writes so JavaScript on the page also sees the isolated session's cookies.

## Install from Source

1. Clone the repo:
   ```sh
   git clone https://github.com/anhkiet75/session-shift.git
   cd session-shift
   ```

2. Open Chrome and navigate to `chrome://extensions`

3. Enable **Developer mode** (toggle, top-right)

4. Click **Load unpacked** and select the repo directory

The extension loads immediately — no build step required.

## Project Structure

```
session-shift/
├── manifest.json          # MV3 manifest
├── background.js          # Service worker — tab/session map, webRequest hooks
├── content.js             # Content script (ISOLATED world) — page bridge
├── page-api-proxy.js      # Content script (MAIN world) — document.cookie proxy
├── lib/
│   ├── cookie-parser.js   # Set-Cookie header parsing and serialization
│   └── session-store.js   # chrome.storage.local read/write helpers
├── popup/
│   ├── popup.html
│   ├── popup.js           # Session create/switch/delete UI logic
│   └── popup.css
└── icons/
```

## Permissions

| Permission | Why |
|---|---|
| `declarativeNetRequest` | Modify request/response headers |
| `webRequest` | Intercept cookie headers |
| `cookies` | Read and write cookies |
| `storage` | Persist session data |
| `tabs` | Track which tab maps to which session |
| `<all_urls>` | Operate on any site |

## Contributing

Pull requests are welcome. For significant changes, open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes
4. Open a pull request

## License

[MIT](LICENSE)
