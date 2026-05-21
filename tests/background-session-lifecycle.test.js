import { describe, it, expect } from 'vitest'
import { handleMessage } from '../background.js'

const SENDER = { id: chrome.runtime.id }

describe('getSessionForBootstrap', () => {
  it('returns default + empty cookieStr for unknown tab', async () => {
    const result = await handleMessage(
      { action: 'getSessionForBootstrap', payload: { tabId: 9999 } },
      SENDER
    )
    expect(result.sessionId).toBe('default')
    expect(result.cookieStr).toBe('')
  })

  it('returns sessionId + cookie string for an active session', async () => {
    await chrome.storage.local.set({
      'list_https://test.com': [{ id: 'session_boot1', name: 'Boot', hue: 212 }],
      'cookies_session_boot1': { tok: { value: 'abc', expires: null } },
    })
    await handleMessage(
      { action: 'setSession', payload: { tabId: 55, sessionId: 'session_boot1' } },
      SENDER
    )
    const result = await handleMessage(
      { action: 'getSessionForBootstrap', payload: { tabId: 55 } },
      SENDER
    )
    expect(result.sessionId).toBe('session_boot1')
    expect(result.cookieStr).toContain('tok=abc')
  })
})

describe('refreshBadge', () => {
  it('returns success for valid tabId', async () => {
    const result = await handleMessage(
      { action: 'refreshBadge', payload: { tabId: 1 } },
      SENDER
    )
    expect(result.success).toBe(true)
  })

  it('returns error for non-numeric tabId', async () => {
    const result = await handleMessage(
      { action: 'refreshBadge', payload: { tabId: 'bad' } },
      SENDER
    )
    expect(result.error).toBeTruthy()
  })

  it('returns error when tabId is missing', async () => {
    const result = await handleMessage(
      { action: 'refreshBadge', payload: {} },
      SENDER
    )
    expect(result.error).toBeTruthy()
  })
})

describe('duplicateSession via handleMessage', () => {
  it('returns error for non-string sessionId', async () => {
    const result = await handleMessage(
      { action: 'duplicateSession', payload: { sessionId: 123, origin: 'https://x.com' } },
      SENDER
    )
    expect(result.error).toBeTruthy()
  })

  it('returns error for non-string origin', async () => {
    const result = await handleMessage(
      { action: 'duplicateSession', payload: { sessionId: 'session_x', origin: null } },
      SENDER
    )
    expect(result.error).toBeTruthy()
  })

  it('creates duplicate via message handler', async () => {
    await chrome.storage.local.set({
      'list_https://dup.com': [{ id: 'session_d1', name: 'Orig', hue: 158 }],
      'cookies_session_d1': { c: { value: '1', expires: null } },
    })
    const result = await handleMessage(
      { action: 'duplicateSession', payload: { sessionId: 'session_d1', origin: 'https://dup.com' } },
      SENDER
    )
    expect(result.success).toBe(true)
    expect(result.session.name).toBe('Orig (copy)')
  })
})

describe('unknown action', () => {
  it('returns error for unknown action', async () => {
    const result = await handleMessage(
      { action: 'doesNotExist', payload: {} },
      SENDER
    )
    expect(result.error).toMatch(/unknown action/)
  })
})

describe('updateCookie trust boundary (H3)', () => {
  it('returns error when sender has no tab context', async () => {
    const result = await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: 'a=1' } },
      SENDER
    )
    expect(result.error).toBe('no tab context')
  })

  it('merges new cookies without wiping existing ones', async () => {
    await chrome.storage.local.set({
      'list_https://merge.com': [{ id: 'session_m1', name: 'M', hue: 0 }],
      'cookies_session_m1': { existing: { value: 'old', expires: null } },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 200, sessionId: 'session_m1' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: 'newcookie=val' } },
      { id: chrome.runtime.id, tab: { id: 200 } }
    )
    const stored = await chrome.storage.local.get(['cookies_session_m1'])
    expect(stored['cookies_session_m1'].existing.value).toBe('old')
    expect(stored['cookies_session_m1'].newcookie.value).toBe('val')
  })

  it('empty cookieStr does not wipe existing cookies', async () => {
    await chrome.storage.local.set({
      'list_https://wipe.com': [{ id: 'session_w1', name: 'W', hue: 0 }],
      'cookies_session_w1': { precious: { value: 'keep', expires: null } },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 201, sessionId: 'session_w1' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: '' } },
      { id: chrome.runtime.id, tab: { id: 201 } }
    )
    const stored = await chrome.storage.local.get(['cookies_session_w1'])
    expect(stored['cookies_session_w1'].precious.value).toBe('keep')
  })

  it('deletedNames removes the named cookie', async () => {
    await chrome.storage.local.set({
      'list_https://del.com': [{ id: 'session_del1', name: 'D', hue: 0 }],
      'cookies_session_del1': {
        gone:  { value: 'bye', expires: null },
        stays: { value: 'hi',  expires: null },
      },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 202, sessionId: 'session_del1' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: '', deletedNames: ['gone'] } },
      { id: chrome.runtime.id, tab: { id: 202 } }
    )
    const stored = await chrome.storage.local.get(['cookies_session_del1'])
    expect(stored['cookies_session_del1'].gone).toBeUndefined()
    expect(stored['cookies_session_del1'].stays.value).toBe('hi')
  })

  it('cannot overwrite a server-set httpOnly cookie via document.cookie path', async () => {
    await chrome.storage.local.set({
      'list_https://hp.com': [{ id: 'session_hp1', name: 'HP', hue: 0 }],
      'cookies_session_hp1': { secret: { value: 'original', expires: null, httpOnly: true } },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 203, sessionId: 'session_hp1' } }, SENDER)
    await handleMessage(
      { action: 'updateCookie', payload: { cookieStr: 'secret=hacked' } },
      { id: chrome.runtime.id, tab: { id: 203 } }
    )
    const stored = await chrome.storage.local.get(['cookies_session_hp1'])
    expect(stored['cookies_session_hp1'].secret.value).toBe('original')
  })
})

describe('getSessionForBootstrap httpOnly filtering (H1)', () => {
  it('excludes httpOnly cookies from the bootstrap cookie string', async () => {
    await chrome.storage.local.set({
      'list_https://boot2.com': [{ id: 'session_b2', name: 'B2', hue: 0 }],
      'cookies_session_b2': {
        visible: { value: 'show', expires: null, httpOnly: false },
        hidden:  { value: 'hide', expires: null, httpOnly: true },
      },
    })
    await handleMessage({ action: 'setSession', payload: { tabId: 204, sessionId: 'session_b2' } }, SENDER)
    const result = await handleMessage(
      { action: 'getSessionForBootstrap', payload: { tabId: 204 } },
      SENDER
    )
    expect(result.cookieStr).toContain('visible=show')
    expect(result.cookieStr).not.toContain('hidden=hide')
  })
})

describe('getSession', () => {
  it('returns default for tab with no session', async () => {
    const result = await handleMessage(
      { action: 'getSession', payload: { tabId: 8888 } },
      SENDER
    )
    expect(result.sessionId).toBe('default')
  })

  it('exposes snap sessions as default to popup', async () => {
    await handleMessage(
      { action: 'setSession', payload: { tabId: 77, sessionId: '_snap_77_abc' } },
      SENDER
    )
    const result = await handleMessage(
      { action: 'getSession', payload: { tabId: 77 } },
      SENDER
    )
    expect(result.sessionId).toBe('default')
  })
})
