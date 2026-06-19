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

  it('forwards the full cookie string as setCookieStr, not the whole map', () => {
    document.cookie = 'foo=bar'
    const payload = lastUpdateCookiePayload(postSpy)
    expect(payload.setCookieStr).toBe('foo=bar')
    expect(payload.setCookieStr).not.toContain('ROOT')
  })

  it('preserves Path/Max-Age attributes in setCookieStr', () => {
    document.cookie = 'foo=bar; Path=/a; Max-Age=3600'
    const payload = lastUpdateCookiePayload(postSpy)
    expect(payload.setCookieStr).toBe('foo=bar; Path=/a; Max-Age=3600')
  })

  it('sends deletedNames on a max-age=0 deletion (no setCookieStr)', () => {
    document.cookie = 'foo=bar; max-age=0'
    const payload = lastUpdateCookiePayload(postSpy)
    expect(payload.setCookieStr).toBeUndefined()
    expect(payload.deletedNames).toEqual(['foo'])
  })
})

describe('page-api-proxy window.cookieStore', () => {
  let postSpy

  function lastPayload() {
    return lastUpdateCookiePayload(postSpy)
  }

  beforeEach(async () => {
    vi.resetModules()
    // cookieStore is not defined in jsdom — install a stub so the proxy guard fires.
    if (!('cookieStore' in window)) {
      Object.defineProperty(window, 'cookieStore', { configurable: true, value: {}, writable: true })
    }
    postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    await import('../src/page-api-proxy.ts')
    deliver({ source: 'ext-content', action: 'initNonce', sessionId: SESSION, nonce: NONCE })
    deliver({ source: 'ext-content', action: 'bootstrapCookies', nonce: NONCE, cookieStr: 'ROOT=root' })
  })

  afterEach(() => {
    postSpy.mockRestore()
    delete window.cookieStore
  })

  it('returns a stable singleton (identity holds)', () => {
    expect(window.cookieStore).toBe(window.cookieStore)
  })

  it('get resolves from the local map, never the real jar', async () => {
    expect(await window.cookieStore.get('ROOT')).toEqual({ name: 'ROOT', value: 'root' })
    expect(await window.cookieStore.get('missing')).toBeNull()
  })

  it('set forwards a setCookieStr and updates the local map', async () => {
    await window.cookieStore.set('sid', 'abc')
    expect(lastPayload().setCookieStr).toBe('sid=abc')
    expect(await window.cookieStore.get('sid')).toEqual({ name: 'sid', value: 'abc' })
  })

  it('set with options serializes Path/Expires but never Domain', async () => {
    await window.cookieStore.set({ name: 'sid', value: 'abc', path: '/admin', domain: '.evil.com' })
    const str = lastPayload().setCookieStr
    expect(str).toContain('sid=abc')
    expect(str).toContain('Path=/admin')
    expect(str.toLowerCase()).not.toContain('domain')
  })

  it('delete posts a structured deleteTargets entry', async () => {
    await window.cookieStore.delete({ name: 'sid', path: '/admin' })
    expect(lastPayload().deleteTargets).toEqual([{ name: 'sid', domain: undefined, path: '/admin' }])
  })

  it('rejects invalid cookie names on set', async () => {
    await expect(window.cookieStore.set('bad name', 'v')).rejects.toThrow()
  })
})

describe('page-api-proxy auth bridge fetch wrapper', () => {
  let postSpy
  let fetchSpy

  beforeEach(async () => {
    vi.resetModules()
    postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    fetchSpy = vi.fn(async (request) => new Response(JSON.stringify({
      header: request.headers.get('X-SessionShift-Bridge'),
    }), { status: 200 }))
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      writable: true,
      value: fetchSpy,
    })
    await import('../src/page-api-proxy.ts')
    deliver({ source: 'ext-content', action: 'initNonce', sessionId: SESSION, nonce: NONCE })
    deliver({ source: 'ext-content', action: 'bootstrapCookies', nonce: NONCE, cookieStr: '' })
  })

  afterEach(() => {
    postSpy.mockRestore()
    delete window.fetch
  })

  it('adds a bridge header to same-origin fetches and waits for completion before resolving', async () => {
    let settled = false
    const fetchPromise = window.fetch('/set-resource?user=bob', { credentials: 'include' }).then(async (response) => {
      settled = true
      return response.json()
    })

    await Promise.resolve()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const request = fetchSpy.mock.calls[0][0]
    const bridgeId = request.headers.get('X-SessionShift-Bridge')
    expect(typeof bridgeId).toBe('string')
    expect(bridgeId.length).toBeGreaterThan(0)
    expect(settled).toBe(false)

    deliver({ source: 'ext-content', action: 'bridgeCookieSyncDone', nonce: NONCE, bridgeId })
    await expect(fetchPromise).resolves.toEqual({ header: bridgeId })
    expect(settled).toBe(true)
  })

  it('fails open after the bridge timeout if no completion signal arrives', async () => {
    vi.useFakeTimers()
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }))

    const fetchPromise = window.fetch('/set-resource?user=bob', { credentials: 'include' })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(2000)

    await expect(fetchPromise).resolves.toBeInstanceOf(Response)
    vi.useRealTimers()
  })

  it('leaves cross-origin fetches untouched', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await window.fetch('https://example.com/set-resource')

    expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/set-resource')
  })
})
