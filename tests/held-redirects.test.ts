import { describe, it, expect, vi, afterEach } from 'vitest'
import { heldRedirectTarget, noteHeldRedirect, resolveHeldRedirect, forgetHeldRedirectsForTab } from '../src/background/held-redirects.js'
import { beginCookieCapture, endCookieCapture } from '../src/background/redirect-hop-stale-cookie-guard.js'

const response = (overrides: Partial<chrome.webRequest.OnHeadersReceivedDetails> = {}): chrome.webRequest.OnHeadersReceivedDetails => ({
  requestId: "test", statusLine: "HTTP/1.1 302 Found", documentLifecycle: "active", frameId: 0, frameType: "outermost_frame", parentFrameId: -1, method: "GET", tabId: 1, timeStamp: 0,
  type: 'main_frame',
  statusCode: 302,
  url: 'http://localhost:8000/login',
  responseHeaders: [{ name: 'Location', value: '/dashboard' }, { name: 'Set-Cookie', value: 's=1' }],
  ...overrides,
})

describe('heldRedirectTarget', () => {
  it('resolves a navigation 3xx Location against the response URL', () => {
    expect(heldRedirectTarget(response())).toBe('http://localhost:8000/dashboard')
    expect(heldRedirectTarget(response({ type: 'sub_frame', statusCode: 303 }))).toBe('http://localhost:8000/dashboard')
  })

  it('ignores non-redirects, subresources and responses without Location', () => {
    expect(heldRedirectTarget(response({ statusCode: 200 }))).toBeNull()
    expect(heldRedirectTarget(response({ type: 'xmlhttprequest' }))).toBeNull()
    expect(heldRedirectTarget(response({ responseHeaders: [] }))).toBeNull()
  })
})

describe('resolveHeldRedirect', () => {
  afterEach(() => vi.useRealTimers())

  it('answers only after the redirect response cookies are published', async () => {
    beginCookieCapture('req-held')
    noteHeldRedirect(5, 0, 'req-held', 'http://localhost:8000/dashboard')
    let resolved = null
    const pending = resolveHeldRedirect(5, 0).then((url) => { resolved = url })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resolved).toBeNull() // capture still running: the hop must not leave yet

    endCookieCapture('req-held')
    await pending
    expect(resolved).toBe('http://localhost:8000/dashboard')
    // One-shot: the next document in this frame is not a held redirect.
    vi.useFakeTimers()
    const again = resolveHeldRedirect(5, 0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await again).toBeNull()
  })

  it('waits for the note when the content script asks first', async () => {
    const pending = resolveHeldRedirect(6, 3)
    noteHeldRedirect(6, 3, 'req-late', 'https://example.com/next')
    expect(await pending).toBe('https://example.com/next')
  })

  it('returns null for a frame with no held redirect, and after the tab closes', async () => {
    vi.useFakeTimers()
    noteHeldRedirect(7, 0, 'req-closed', 'https://example.com/next')
    forgetHeldRedirectsForTab(7)
    const pending = resolveHeldRedirect(7, 0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toBeNull()
  })
})
