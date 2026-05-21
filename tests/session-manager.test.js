import { describe, it, expect, beforeEach } from 'vitest'
import { hostMatches, getSessionBoundHost, invalidateBoundHostCache } from '../background/session-manager.js'

beforeEach(() => {
  invalidateBoundHostCache()
})

describe('hostMatches', () => {
  it('matches exact host', () => {
    expect(hostMatches('github.com', 'github.com')).toBe(true)
  })

  it('matches subdomain of bound host', () => {
    expect(hostMatches('api.github.com', 'github.com')).toBe(true)
  })

  it('matches deep subdomain', () => {
    expect(hostMatches('a.b.example.com', 'example.com')).toBe(true)
  })

  it('rejects a different host', () => {
    expect(hostMatches('evil.com', 'github.com')).toBe(false)
  })

  it('rejects a host that contains the bound host as a suffix but is not a subdomain', () => {
    expect(hostMatches('evilgithub.com', 'github.com')).toBe(false)
  })

  it('rejects a crafted host like github.com.evil.com', () => {
    expect(hostMatches('github.com.evil.com', 'github.com')).toBe(false)
  })
})

describe('getSessionBoundHost', () => {
  it('returns hostname from stored session origin', async () => {
    await chrome.storage.local.set({
      'list_https://example.com': [{ id: 'session_gbh1', name: 'Test', hue: 0 }],
    })
    const host = await getSessionBoundHost('session_gbh1')
    expect(host).toBe('example.com')
  })

  it('returns null for unknown session', async () => {
    const host = await getSessionBoundHost('session_notexist')
    expect(host).toBeNull()
  })

  it('caches result and returns same value on second call', async () => {
    await chrome.storage.local.set({
      'list_https://cached.com': [{ id: 'session_cached1', name: 'C', hue: 0 }],
    })
    const h1 = await getSessionBoundHost('session_cached1')
    // Clear storage — second call should still return cached value
    await chrome.storage.local.clear()
    const h2 = await getSessionBoundHost('session_cached1')
    expect(h1).toBe('cached.com')
    expect(h2).toBe('cached.com')
  })
})
