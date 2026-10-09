import { describe, it, expect, beforeEach } from 'vitest'
import { registerLinkedTabInheritance } from '../background/linked-tab-inheritance.js'
import { tabSessions } from '../background/session-manager.js'

function register() {
  registerLinkedTabInheritance(Promise.resolve())
  return chrome.webNavigation.onCreatedNavigationTarget.addListener.mock.calls[0][0]
}

describe('registerLinkedTabInheritance', () => {
  beforeEach(() => {
    for (const key of Object.keys(tabSessions)) delete tabSessions[key]
  })

  it('no settings saved (default on): still inherits', async () => {
    tabSessions[1] = 'session_work'
    const onCreatedNavigationTarget = register()

    await onCreatedNavigationTarget({ sourceTabId: 1, tabId: 2, url: 'https://example.com/' })

    expect(tabSessions[2]).toBe('session_work')
  })

  it('setting explicitly false: does nothing even when opener is on a profile', async () => {
    await chrome.storage.local.set({ ext_settings: { theme: 'system', autoInheritProfileForLinkedTabs: false } })
    tabSessions[51] = 'session_work'
    const onCreatedNavigationTarget = register()

    await onCreatedNavigationTarget({ sourceTabId: 51, tabId: 52, url: 'https://example.com/' })

    expect(tabSessions[52]).toBeUndefined()
  })

  it('setting on, opener has no session: no-op', async () => {
    await chrome.storage.local.set({ ext_settings: { theme: 'system', autoInheritProfileForLinkedTabs: true } })
    const onCreatedNavigationTarget = register()

    await onCreatedNavigationTarget({ sourceTabId: 11, tabId: 12, url: 'https://example.com/' })

    expect(tabSessions[12]).toBeUndefined()
  })

  it('setting on, opener is default: no-op (isInternalSession guard)', async () => {
    await chrome.storage.local.set({ ext_settings: { theme: 'system', autoInheritProfileForLinkedTabs: true } })
    tabSessions[21] = 'default'
    const onCreatedNavigationTarget = register()

    await onCreatedNavigationTarget({ sourceTabId: 21, tabId: 22, url: 'https://example.com/' })

    expect(tabSessions[22]).toBeUndefined()
  })

  it('setting on, opener is a real profile: assigns session + runs isolation sequence', async () => {
    await chrome.storage.local.set({ ext_settings: { theme: 'system', autoInheritProfileForLinkedTabs: true } })
    tabSessions[31] = 'session_work'
    const onCreatedNavigationTarget = register()

    await onCreatedNavigationTarget({ sourceTabId: 31, tabId: 32, url: 'https://example.com/dashboard' })
    await new Promise((resolve) => setTimeout(resolve, 0)) // updateBadge is fire-and-forget

    expect(tabSessions[32]).toBe('session_work')
    expect(chrome.storage.session.set).toHaveBeenCalledWith(expect.objectContaining({ tabSessions }))
    expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalled()
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'WOR', tabId: 32 })
  })

  it('new tab already has a tabSessions entry: does not clobber', async () => {
    await chrome.storage.local.set({ ext_settings: { theme: 'system', autoInheritProfileForLinkedTabs: true } })
    tabSessions[41] = 'session_work'
    tabSessions[42] = 'session_other'
    const onCreatedNavigationTarget = register()

    await onCreatedNavigationTarget({ sourceTabId: 41, tabId: 42, url: 'https://example.com/' })

    expect(tabSessions[42]).toBe('session_other')
  })
})

// Regression: the link's first request leaves before the tab joins the
// profile, carrying Chrome's own jar (the normal account). Its response must
// not be captured into the profile, and the page is re-requested under the
// profile's rules.
describe('linked tab whose first request beat the profile rules', () => {
  beforeEach(() => {
    for (const key of Object.keys(tabSessions)) delete tabSessions[key]
    chrome.tabs.reload.mockClear()
  })

  it('never captures that response and reloads the tab under the profile', async () => {
    const { handleBeforeSendHeaders, handleHeadersReceived } = await import('../background/dnr-manager.js')
    const { getCookieStore } = await import('../lib/session-store.js')
    await chrome.storage.local.set({
      ext_settings: { theme: 'system', autoInheritProfileForLinkedTabs: true },
      profiles: [{ id: 'session_linked', name: 'L', hue: 0 }],
      cookies_session_linked: {},
    })
    chrome.tabs.get.mockResolvedValue({ id: 62, url: 'https://example.com/dashboard' })
    tabSessions[61] = 'session_linked'
    const onCreatedNavigationTarget = register()

    // The request is sent while tab 62 has no profile yet.
    handleBeforeSendHeaders({ requestId: 'early-1', tabId: 62, type: 'main_frame', method: 'GET', timeStamp: Date.now() - 500, url: 'https://example.com/dashboard', requestHeaders: [] })
    await onCreatedNavigationTarget({ sourceTabId: 61, tabId: 62, url: 'https://example.com/dashboard' })
    expect(tabSessions[62]).toBe('session_linked')

    // Its response (the normal account's session) arrives after assignment.
    await handleHeadersReceived({
      requestId: 'early-1', tabId: 62, type: 'main_frame', url: 'https://example.com/dashboard',
      responseHeaders: [{ name: 'Set-Cookie', value: 'app_session=normal-account; Path=/' }],
    })
    expect(Object.keys(await getCookieStore('session_linked'))).toEqual([])
    expect(chrome.tabs.reload).toHaveBeenCalledWith(62, { bypassCache: true })
  })

  it('does not replay a POST that beat the rules', async () => {
    const { handleBeforeSendHeaders } = await import('../background/dnr-manager.js')
    await chrome.storage.local.set({ ext_settings: { theme: 'system', autoInheritProfileForLinkedTabs: true } })
    chrome.tabs.get.mockResolvedValue({ id: 72, url: 'https://example.com/submit' })
    tabSessions[71] = 'session_linked'
    const onCreatedNavigationTarget = register()

    handleBeforeSendHeaders({ requestId: 'early-post', tabId: 72, type: 'main_frame', method: 'POST', timeStamp: Date.now() - 500, url: 'https://example.com/submit', requestHeaders: [] })
    await onCreatedNavigationTarget({ sourceTabId: 71, tabId: 72, url: 'https://example.com/submit' })
    expect(chrome.tabs.reload).not.toHaveBeenCalled()
  })

  it('distrusts an early request whose event only arrives after the tab joined', async () => {
    const { handleBeforeSendHeaders, handleHeadersReceived } = await import('../background/dnr-manager.js')
    const { getCookieStore } = await import('../lib/session-store.js')
    await chrome.storage.local.set({
      ext_settings: { theme: 'system', autoInheritProfileForLinkedTabs: true },
      profiles: [{ id: 'session_late', name: 'L', hue: 0 }],
      cookies_session_late: {},
    })
    chrome.tabs.get.mockResolvedValue({ id: 82, url: 'https://example.com/dashboard' })
    tabSessions[81] = 'session_late'
    const onCreatedNavigationTarget = register()
    const sentBeforeRules = Date.now() - 500

    await onCreatedNavigationTarget({ sourceTabId: 81, tabId: 82, url: 'https://example.com/dashboard' })
    // webRequest delivers the request's event late: the tab is assigned by now.
    handleBeforeSendHeaders({ requestId: 'late-1', tabId: 82, type: 'main_frame', method: 'GET', timeStamp: sentBeforeRules, url: 'https://example.com/dashboard', requestHeaders: [] })
    await handleHeadersReceived({
      requestId: 'late-1', tabId: 82, type: 'main_frame', url: 'https://example.com/dashboard',
      responseHeaders: [{ name: 'Set-Cookie', value: 'app_session=normal-account; Path=/' }],
    })
    expect(Object.keys(await getCookieStore('session_late'))).toEqual([])
    expect(chrome.tabs.reload).toHaveBeenCalledWith(82, { bypassCache: true })

    // The re-request, sent after the rules went live, is captured normally.
    handleBeforeSendHeaders({ requestId: 'late-2', tabId: 82, type: 'main_frame', method: 'GET', timeStamp: Date.now() + 5, url: 'https://example.com/dashboard', requestHeaders: [] })
    await handleHeadersReceived({
      requestId: 'late-2', tabId: 82, type: 'main_frame', url: 'https://example.com/dashboard',
      responseHeaders: [{ name: 'Set-Cookie', value: 'app_session=profile; Path=/' }],
    })
    expect(Object.values(await getCookieStore('session_late')).map((c) => c.value)).toEqual(['profile'])
  })
})
