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
