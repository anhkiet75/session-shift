import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const NONCE = 'n1'
const SESSION = 'session_proxy'

function deliver(data) {
  // jsdom's window.postMessage sets source=null, which the proxy rejects.
  // Dispatch a synthetic event with source=window to mimic a same-window post.
  window.dispatchEvent(new MessageEvent('message', {
    data,
    source: window,
    origin: window.location.origin,
  }))
}

function lastUpdateCookiePayload(postSpy) {
  const call = [...postSpy.mock.calls].reverse().find(([msg]) => msg?.action === 'updateCookie')
  return call?.[0]?.payload
}

describe('page-api-proxy document.cookie writes', () => {
  let postSpy

  beforeEach(async () => {
    vi.resetModules()
    postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    await import('../src/page-api-proxy.ts')
    deliver({ source: 'ext-content', action: 'initNonce', sessionId: SESSION, nonce: NONCE })
    // Bootstrap the page's cookie view with a cookie from another scope.
    deliver({ source: 'ext-content', action: 'bootstrapCookies', nonce: NONCE, cookieStr: 'ROOT=root' })
  })

  afterEach(() => {
    postSpy.mockRestore()
    delete document.cookie
  })

  it('sends only the changed cookie, not the whole bootstrapped map', () => {
    document.cookie = 'foo=bar'
    const payload = lastUpdateCookiePayload(postSpy)
    expect(payload.cookieStr).toBe('foo=bar')
    expect(payload.cookieStr).not.toContain('ROOT')
  })

  it('sends empty cookieStr plus deletedNames on a max-age=0 deletion', () => {
    document.cookie = 'foo=bar; max-age=0'
    const payload = lastUpdateCookiePayload(postSpy)
    expect(payload.cookieStr).toBe('')
    expect(payload.deletedNames).toEqual(['foo'])
  })
})
