import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const NONCE = 'n-live'
const SESSION = 'session_live'
const BRIDGE_HEADER = 'X-SessionShift-Bridge'

function deliver(data) {
  // jsdom's window.postMessage sets source=null, which the proxy rejects.
  window.dispatchEvent(new MessageEvent('message', { data, source: window, origin: window.location.origin }))
}

// Minimal XHR double: the proxy patches window.XMLHttpRequest.prototype, and a
// test drives completion the way a browser dispatches it (readystatechange at
// DONE, then load, then loadend — synchronously, in that order).
// A fresh class per test: each re-imported proxy patches the prototype it finds.
function createFakeXhrClass() {
  return class FakeXHR extends EventTarget {
    static DONE = 4
    readyState = 0
    status = 0
    headers = {}
    open() { this.readyState = 1 }
    setRequestHeader(name, value) { this.headers[name] = value }
    send() {}
    // Event handler properties behave like listeners added at assignment time.
    set onreadystatechange(fn) { this.addEventListener('readystatechange', fn) }
    set onload(fn) { this.addEventListener('load', fn) }
    complete(status) {
      this.status = status
      this.readyState = 4
      for (const type of ['readystatechange', 'load', 'loadend']) this.dispatchEvent(new Event(type))
    }
  }
}

let realXhr
let postSpy

beforeEach(async () => {
  vi.resetModules()
  realXhr = window.XMLHttpRequest
  window.XMLHttpRequest = createFakeXhrClass()
  postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
  await import('../src/page-api-proxy.ts')
  deliver({ source: 'ext-content', action: 'initNonce', sessionId: SESSION, nonce: NONCE })
  deliver({ source: 'ext-content', action: 'bootstrapCookies', nonce: NONCE, cookieStr: 'XSRF-TOKEN=old; keep=1' })
})

afterEach(() => {
  postSpy.mockRestore()
  window.XMLHttpRequest = realXhr
  delete document.cookie
})

describe('page-api-proxy live document.cookie sync', () => {
  it('replaces the whole cookie view, so server-side changes and deletions show up', () => {
    deliver({ source: 'ext-content', action: 'syncCookies', nonce: NONCE, cookieStr: 'XSRF-TOKEN=new; fresh=2' })
    expect(document.cookie).toBe('XSRF-TOKEN=new; fresh=2')
  })

  it('ignores a snapshot without the session nonce', () => {
    deliver({ source: 'ext-content', action: 'syncCookies', nonce: 'forged', cookieStr: 'evil=1' })
    expect(document.cookie).toBe('XSRF-TOKEN=old; keep=1')
  })
})

describe('page-api-proxy XMLHttpRequest bridge', () => {
  function sendXhr(url, async = true) {
    const xhr = new window.XMLHttpRequest()
    const seen = []
    // axios assigns its handlers after open(), before send().
    xhr.open('POST', url, async)
    xhr.onreadystatechange = () => { if (xhr.readyState === 4) seen.push(`readystatechange:${document.cookie}`) }
    xhr.onload = () => seen.push(`load:${document.cookie}`)
    xhr.addEventListener('loadend', () => seen.push('loadend'))
    xhr.send('{}')
    return { xhr, seen }
  }

  it('holds completion events until the response cookies reached document.cookie', async () => {
    const { xhr, seen } = sendXhr('/login')
    const bridgeId = xhr.headers[BRIDGE_HEADER]
    expect(bridgeId).toBeTruthy()

    xhr.complete(204)
    expect(seen).toEqual([]) // axios would read the stale XSRF-TOKEN here

    // content.ts delivers the refreshed snapshot, then the release — in order.
    deliver({ source: 'ext-content', action: 'syncCookies', nonce: NONCE, cookieStr: 'XSRF-TOKEN=rotated' })
    deliver({ source: 'ext-content', action: 'bridgeCookieSyncDone', nonce: NONCE, bridgeId })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual(['readystatechange:XSRF-TOKEN=rotated', 'load:XSRF-TOKEN=rotated', 'loadend'])
  })

  it('does not hold failed requests', () => {
    const { xhr, seen } = sendXhr('/login')
    xhr.complete(0)
    expect(seen).toEqual(['readystatechange:XSRF-TOKEN=old; keep=1', 'load:XSRF-TOKEN=old; keep=1', 'loadend'])
  })

  it('leaves cross-origin and synchronous requests untouched', () => {
    const cross = sendXhr('https://other.example/api')
    expect(cross.xhr.headers[BRIDGE_HEADER]).toBeUndefined()
    const sync = sendXhr('/sync', false)
    expect(sync.xhr.headers[BRIDGE_HEADER]).toBeUndefined()
    sync.xhr.complete(200)
    expect(sync.seen.length).toBe(3)
  })
})
