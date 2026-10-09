import { describe, it, expect, beforeEach } from 'vitest'
import {
  handleBeforeSendHeaders,
  handleHeadersReceived,
  handleRequestCompleted,
} from '../background/dnr-manager.js'
import { tabSessions } from '../background/session-manager.js'
import { getCookieStore } from '../lib/session-store.js'
import { AUTH_BRIDGE_HEADER } from '../lib/auth-transition-bridge.js'

// Regression: post-login redirect race. Chrome can follow a 302 before an async
// webRequest handler finishes rebuilding DNR, so navigation Set-Cookie is allowed
// through to Chrome's jar. We still capture it and rebuild DNR for later isolated
// requests.

function details({ tabId, url, type, setCookie }) {
  return {
    tabId,
    url,
    type,
    responseHeaders: [{ name: 'Set-Cookie', value: setCookie }],
  }
}

beforeEach(() => {
  for (const k of Object.keys(tabSessions)) delete tabSessions[k]
  chrome.tabs.get.mockResolvedValue({ id: 1, url: 'https://github.com/session' })
  chrome.tabs.sendMessage.mockClear()
})

describe('handleHeadersReceived — cookie capture + DNR rebuild timing', () => {
  it('main_frame Set-Cookie is captured and DNR is rebuilt immediately after capture', async () => {
    tabSessions[20] = 'session_login'
    await chrome.storage.local.set({ profiles: [{ id: 'session_login', name: 'L', hue: 0 }] })
    chrome.declarativeNetRequest.updateSessionRules.mockClear()

    await handleHeadersReceived(details({
      tabId: 20,
      url: 'https://github.com/session',
      type: 'main_frame',
      setCookie: 'user_session=abc123; Path=/; HttpOnly; Secure',
    }))

    // Cookie captured into the session store.
    const store = await getCookieStore('session_login')
    expect(Object.values(store).some(e => e.name === 'user_session' && e.value === 'abc123')).toBe(true)

    // DNR rebuilt synchronously (immediate), and the rebuilt rules inject the cookie.
    expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalled()
    const calls = chrome.declarativeNetRequest.updateSessionRules.mock.calls
    const { addRules } = calls[calls.length - 1][0]
    const cookieRule = addRules.find(r => r.action.requestHeaders?.some(
      h => h.header === 'Cookie' && h.operation === 'set' && /user_session=abc123/.test(h.value || '')
    ))
    expect(cookieRule).toBeDefined()
  })

  it('subresource Set-Cookie is captured and DNR is rebuilt immediately', async () => {
    tabSessions[21] = 'session_sub'
    await chrome.storage.local.set({ profiles: [{ id: 'session_sub', name: 'S', hue: 0 }] })
    chrome.declarativeNetRequest.updateSessionRules.mockClear()

    await handleHeadersReceived(details({
      tabId: 21,
      url: 'https://github.com/avatar.png',
      type: 'image',
      setCookie: 'tracker=1; Path=/',
    }))

    // Captured…
    const store = await getCookieStore('session_sub')
    expect(Object.values(store).some(e => e.name === 'tracker')).toBe(true)
    // …and DNR rebuilt immediately so a following navigation/request can use it.
    expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalled()
  })

  it('ignores default/unassigned tabs', async () => {
    chrome.declarativeNetRequest.updateSessionRules.mockClear()
    await handleHeadersReceived(details({
      tabId: 22,
      url: 'https://github.com/',
      type: 'main_frame',
      setCookie: 'x=1',
    }))
    expect(chrome.declarativeNetRequest.updateSessionRules).not.toHaveBeenCalled()
  })

  it('signals bridge completion once the request completes, after Set-Cookie capture and DNR rebuild', async () => {
    tabSessions[23] = 'session_bridge'
    await chrome.storage.local.set({ profiles: [{ id: 'session_bridge', name: 'B', hue: 0 }] })

    handleBeforeSendHeaders({
      requestId: 'req-1',
      tabId: 23,
      frameId: 0,
      requestHeaders: [{ name: AUTH_BRIDGE_HEADER, value: 'bridge-1' }],
    })

    await handleHeadersReceived({
      ...details({
        tabId: 23,
        url: 'https://github.com/session',
        type: 'xmlhttprequest',
        setCookie: 'user_session=abc123; Path=/; HttpOnly; Secure',
      }),
      requestId: 'req-1',
    })
    // The page is released only when the request is over, so a redirect hop's
    // cookies are published before it resumes.
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled()
    await handleRequestCompleted({ requestId: 'req-1', tabId: 23, type: 'xmlhttprequest' })

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      23,
      { action: 'bridgeCookieSyncDone', bridgeId: 'bridge-1' },
      { frameId: 0 },
    )
  })

  it('signals bridge completion on request completion when no Set-Cookie was captured', async () => {
    tabSessions[24] = 'session_bridge_done'
    await chrome.storage.local.set({ profiles: [{ id: 'session_bridge_done', name: 'B', hue: 0 }] })

    handleBeforeSendHeaders({
      requestId: 'req-2',
      tabId: 24,
      frameId: 0,
      requestHeaders: [{ name: AUTH_BRIDGE_HEADER, value: 'bridge-2' }],
    })

    await handleRequestCompleted({ requestId: 'req-2' })

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      24,
      { action: 'bridgeCookieSyncDone', bridgeId: 'bridge-2' },
      { frameId: 0 },
    )
  })
})

// Regression: a fast origin (localhost) answers the redirect hop before the
// login response's capture finishes. The hop carried the pre-login cookie, the
// server answered as a guest, and capturing that guest cookie overwrote the
// login cookie — the tab looped /admin <-> /login forever.
describe('handleHeadersReceived — redirect hop outruns the previous hop capture', () => {
  async function runChain({ tabId, sessionId, type, first, second }) {
    tabSessions[tabId] = sessionId
    await chrome.storage.local.set({ profiles: [{ id: sessionId, name: 'R', hue: 0 }] })
    handleBeforeSendHeaders({ requestId: `chain-${tabId}`, tabId, type, url: first.url, requestHeaders: [] })
    const firstCapture = handleHeadersReceived({ ...details({ tabId, type, ...first }), requestId: `chain-${tabId}` })
    // Chrome follows the redirect before the first capture has finished.
    handleBeforeSendHeaders({ requestId: `chain-${tabId}`, tabId, type, url: second.url, requestHeaders: [] })
    const secondCapture = handleHeadersReceived({ ...details({ tabId, type, ...second }), requestId: `chain-${tabId}` })
    await Promise.all([firstCapture, secondCapture])
    await handleRequestCompleted({ requestId: `chain-${tabId}`, tabId, type })
    return getCookieStore(sessionId)
  }

  it('keeps the rotated login cookie and never re-sends the navigation', async () => {
    chrome.tabs.get.mockResolvedValue({ id: 30, url: 'http://localhost:8000/admin/login' })
    chrome.tabs.update.mockClear()
    const store = await runChain({
      tabId: 30, sessionId: 'session_race', type: 'main_frame',
      first: { url: 'http://localhost:8000/admin/login', setCookie: 'app_session=logged-in; Path=/' },
      second: { url: 'http://localhost:8000/admin', setCookie: 'app_session=guest; Path=/' },
    })
    expect(Object.values(store).find(e => e.name === 'app_session')?.value).toBe('logged-in')
    // A re-sent hop would consume one-shot session state (flashed validation errors).
    expect(chrome.tabs.update).not.toHaveBeenCalled()
  })

  it('applies to XHR redirect chains too (Inertia login)', async () => {
    chrome.tabs.get.mockResolvedValue({ id: 32, url: 'http://localhost:8000/login' })
    const store = await runChain({
      tabId: 32, sessionId: 'session_race_xhr', type: 'xmlhttprequest',
      first: { url: 'http://localhost:8000/login', setCookie: 'app_session=logged-in; Path=/' },
      second: { url: 'http://localhost:8000/dashboard', setCookie: 'app_session=guest; Path=/' },
    })
    expect(Object.values(store).find(e => e.name === 'app_session')?.value).toBe('logged-in')
  })

  it('captures the next hop normally when it was sent after the capture finished', async () => {
    tabSessions[31] = 'session_no_race'
    await chrome.storage.local.set({ profiles: [{ id: 'session_no_race', name: 'N', hue: 0 }] })

    handleBeforeSendHeaders({ requestId: 'nav-2', tabId: 31, type: 'main_frame', url: 'https://example.com/login', requestHeaders: [] })
    await handleHeadersReceived({
      ...details({ tabId: 31, url: 'https://example.com/login', type: 'main_frame', setCookie: 'sid=fresh; Path=/' }),
      requestId: 'nav-2',
    })
    handleBeforeSendHeaders({ requestId: 'nav-2', tabId: 31, type: 'main_frame', url: 'https://example.com/home', requestHeaders: [] })
    await handleHeadersReceived({
      ...details({ tabId: 31, url: 'https://example.com/home', type: 'main_frame', setCookie: 'sid=rotated; Path=/' }),
      requestId: 'nav-2',
    })

    const store = await getCookieStore('session_no_race')
    expect(Object.values(store).find(e => e.name === 'sid')?.value).toBe('rotated')
  })
})

describe('auth bridge release waits for in-flight captures', () => {
  it('releases the page only after a capture still running at completion has been published', async () => {
    tabSessions[40] = 'session_settle'
    await chrome.storage.local.set({ profiles: [{ id: 'session_settle', name: 'S', hue: 0 }] })
    chrome.tabs.get.mockResolvedValue({ id: 40, url: 'http://localhost:8000/login' })
    chrome.tabs.sendMessage.mockClear()

    handleBeforeSendHeaders({
      requestId: 'req-settle', tabId: 40, frameId: 0, type: 'xmlhttprequest', url: 'http://localhost:8000/login',
      requestHeaders: [{ name: AUTH_BRIDGE_HEADER, value: 'bridge-settle' }],
    })
    const capture = handleHeadersReceived({
      ...details({ tabId: 40, url: 'http://localhost:8000/login', type: 'xmlhttprequest', setCookie: 'XSRF-TOKEN=rotated; Path=/' }),
      requestId: 'req-settle',
    })
    // onCompleted arrives while the capture is still writing the store.
    const completed = handleRequestCompleted({ requestId: 'req-settle', tabId: 40, type: 'xmlhttprequest' })
    await Promise.all([capture, completed])

    const store = await getCookieStore('session_settle')
    expect(Object.values(store).find(e => e.name === 'XSRF-TOKEN')?.value).toBe('rotated')
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      40, { action: 'bridgeCookieSyncDone', bridgeId: 'bridge-settle' }, { frameId: 0 })
  })
})

describe('cookie capture republishes every tab of the profile', () => {
  it('rebuilds a sibling tab rules so it stops sending the pre-login session', async () => {
    tabSessions[50] = 'session_shared'
    tabSessions[51] = 'session_shared'
    tabSessions[52] = 'session_other'
    await chrome.storage.local.set({ profiles: [{ id: 'session_shared', name: 'S', hue: 0 }] })
    chrome.tabs.get.mockResolvedValue({ id: 50, url: 'http://localhost:8000/login' })
    chrome.declarativeNetRequest.updateSessionRules.mockClear()

    await handleHeadersReceived({
      ...details({ tabId: 50, url: 'http://localhost:8000/login', type: 'main_frame', setCookie: 'app_session=rotated; Path=/' }),
      requestId: 'req-shared',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const rebuiltTabs = chrome.declarativeNetRequest.updateSessionRules.mock.calls
      .flatMap(([{ addRules }]) => addRules.map(rule => rule.condition.tabIds?.[0]))
    expect(new Set(rebuiltTabs)).toEqual(new Set([50, 51]))
    const siblingCookieRule = chrome.declarativeNetRequest.updateSessionRules.mock.calls
      .flatMap(([{ addRules }]) => addRules)
      .find(rule => rule.condition.tabIds?.[0] === 51 && /app_session=rotated/.test(rule.action.requestHeaders?.[0]?.value || ''))
    expect(siblingCookieRule).toBeDefined()
  })
})

describe('parallel requests that left while the document was being captured', () => {
  it('keeps the document session when a cookieless favicon request gets a guest session back', async () => {
    tabSessions[90] = 'session_parallel'
    await chrome.storage.local.set({ profiles: [{ id: 'session_parallel', name: 'P', hue: 0 }] })
    chrome.tabs.get.mockResolvedValue({ id: 90, url: 'http://localhost:8000/login' })

    handleBeforeSendHeaders({ requestId: 'doc', tabId: 90, type: 'main_frame', url: 'http://localhost:8000/login', requestHeaders: [] })
    const documentCapture = handleHeadersReceived({
      ...details({ tabId: 90, url: 'http://localhost:8000/login', type: 'main_frame', setCookie: 'app_session=document; Path=/' }),
      requestId: 'doc',
    })
    // The favicon leaves before the document's session is in the rules.
    handleBeforeSendHeaders({ requestId: 'icon', tabId: 90, type: 'other', url: 'http://localhost:8000/favicon.ico', requestHeaders: [] })
    const iconCapture = handleHeadersReceived({
      ...details({ tabId: 90, url: 'http://localhost:8000/favicon.ico', type: 'other', setCookie: 'app_session=guest; Path=/' }),
      requestId: 'icon',
    })
    await Promise.all([documentCapture, iconCapture])

    const store = await getCookieStore('session_parallel')
    expect(Object.values(store).find(e => e.name === 'app_session')?.value).toBe('document')
  })
})
