import { describe, it, expect } from 'vitest'
import { duplicateSession, getProfiles, getCookieStore } from '../lib/session-store.js'

describe('duplicateSession', () => {
  it('creates a new session with "(copy)" suffix', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_orig', name: 'Work', hue: 212 }],
      cookies_session_orig: { token: { value: 'abc', domain: 'github.com', path: '/', secure: true, httpOnly: true, expires: null } },
    })
    const newSession = await duplicateSession('session_orig')
    expect(newSession.name).toBe('Work (copy)')
    expect(newSession.hue).toBe(212)
  })

  it('clones the cookie store', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_src', name: 'Src', hue: 158 }],
      cookies_session_src: { mykey: { value: 'myval', domain: 'github.com', path: '/', secure: false, httpOnly: false, expires: null } },
    })
    const dup = await duplicateSession('session_src')
    const store = await getCookieStore(dup.id)
    expect(store.mykey.value).toBe('myval')
  })

  it('appends new session to the profiles list', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_a', name: 'A', hue: 24 }],
      cookies_session_a: {},
    })
    await duplicateSession('session_a')
    const list = await getProfiles()
    expect(list).toHaveLength(2)
    expect(list[1].name).toBe('A (copy)')
  })

  it('throws when source session not found', async () => {
    await chrome.storage.local.set({ profiles: [] })
    await expect(duplicateSession('nonexistent')).rejects.toThrow()
  })
})
