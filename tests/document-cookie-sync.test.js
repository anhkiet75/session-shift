import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { registerDocumentCookieBroadcast } from '../background/document-cookie-sync.js'
import { tabSessions } from '../background/session-manager.js'

describe('registerDocumentCookieBroadcast', () => {
  let onChanged

  beforeEach(() => {
    vi.useFakeTimers()
    for (const k of Object.keys(tabSessions)) delete tabSessions[k]
    chrome.storage.onChanged.addListener.mockClear()
    chrome.tabs.sendMessage.mockClear()
    registerDocumentCookieBroadcast()
    onChanged = chrome.storage.onChanged.addListener.mock.calls.at(-1)[0]
  })

  afterEach(() => vi.useRealTimers())

  it('tells every tab of the changed profile — and only those — to refresh document.cookie', () => {
    tabSessions[1] = 'session_a'
    tabSessions[2] = 'session_a'
    tabSessions[3] = 'session_b'

    onChanged({ cookies_session_a: { newValue: {} } }, 'local')
    // Debounced: a burst of captures produces one refresh per tab.
    onChanged({ cookies_session_a: { newValue: {} } }, 'local')
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)

    const tabIds = chrome.tabs.sendMessage.mock.calls.map(([tabId]) => tabId).sort()
    expect(tabIds).toEqual([1, 2])
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { action: 'cookiesChanged' })
  })

  it('ignores non-cookie keys and other storage areas', () => {
    tabSessions[4] = 'session_c'
    onChanged({ profiles: { newValue: [] } }, 'local')
    onChanged({ cookies_session_c: { newValue: {} } }, 'sync')
    vi.advanceTimersByTime(50)
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled()
  })
})
