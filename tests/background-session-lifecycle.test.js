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
