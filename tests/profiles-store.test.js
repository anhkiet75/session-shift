import { describe, it, expect } from 'vitest'
import {
  getProfiles,
  setProfiles,
  duplicateSession,
  updateSessionHue,
  getCookieStore,
  findOrphanedCookieStores,
} from '../lib/session-store.js'

describe('getProfiles / setProfiles', () => {
  it('returns empty array when no profiles key', async () => {
    expect(await getProfiles()).toEqual([])
  })

  it('round-trips the single profiles key', async () => {
    const list = [
      { id: 'p1', name: 'Work', hue: 212 },
      { id: 'p2', name: 'Personal', hue: 24 },
    ]
    await setProfiles(list)
    expect(await getProfiles()).toEqual(list)
    // stored under the literal `profiles` key, not list_*
    const raw = await chrome.storage.local.get(['profiles'])
    expect(raw.profiles).toEqual(list)
  })
})

describe('getProfiles shape', () => {
  it('carries no origin field on profiles', async () => {
    await setProfiles([{ id: 'p1', name: 'A', hue: 1 }])
    const [p] = await getProfiles()
    expect(p.origin).toBeUndefined()
  })
})

describe('duplicateSession (no origin arg)', () => {
  it('appends a "(copy)" profile and clones the cookie store', async () => {
    await setProfiles([{ id: 'session_src', name: 'Src', hue: 158 }])
    await chrome.storage.local.set({
      cookies_session_src: { mykey: { value: 'myval', domain: 'x.com', path: '/', expires: null } },
    })
    const dup = await duplicateSession('session_src')
    expect(dup.name).toBe('Src (copy)')
    expect(dup.hue).toBe(158)
    const profiles = await getProfiles()
    expect(profiles).toHaveLength(2)
    expect(profiles[1].id).toBe(dup.id)
    const store = await getCookieStore(dup.id)
    expect(store.mykey.value).toBe('myval')
  })

  it('writes the profiles list BEFORE the cloned cookie store (orphan-GC safety)', async () => {
    await setProfiles([{ id: 'session_a', name: 'A', hue: 24 }])
    await chrome.storage.local.set({ cookies_session_a: {} })
    const setSpy = chrome.storage.local.set
    setSpy.mockClear()
    const dup = await duplicateSession('session_a')
    const order = setSpy.mock.calls.map(([arg]) => Object.keys(arg)[0])
    const profilesIdx = order.indexOf('profiles')
    const cookieIdx = order.indexOf(`cookies_${dup.id}`)
    expect(profilesIdx).toBeGreaterThanOrEqual(0)
    expect(cookieIdx).toBeGreaterThanOrEqual(0)
    expect(profilesIdx).toBeLessThan(cookieIdx)
  })

  it('throws when source profile not found', async () => {
    await setProfiles([])
    await expect(duplicateSession('nonexistent')).rejects.toThrow()
  })
})

describe('updateSessionHue', () => {
  it('patches the matching profile hue in the profiles list', async () => {
    await setProfiles([
      { id: 'p1', name: 'A', hue: 10 },
      { id: 'p2', name: 'B', hue: 20 },
    ])
    await updateSessionHue('p2', 200)
    const profiles = await getProfiles()
    expect(profiles.find(p => p.id === 'p2').hue).toBe(200)
    expect(profiles.find(p => p.id === 'p1').hue).toBe(10)
  })
})

describe('findOrphanedCookieStores (profiles-referenced)', () => {
  it('detects cookie stores with no profiles reference, skips internal', async () => {
    await setProfiles([{ id: 's1', name: 'A' }])
    await chrome.storage.local.set({
      cookies_s1: {},
      cookies_s2: {},
      cookies_default: {},
    })
    expect(await findOrphanedCookieStores()).toEqual(['s2'])
  })

  it('returns empty when all stores referenced', async () => {
    await setProfiles([{ id: 's1' }, { id: 's2' }])
    await chrome.storage.local.set({ cookies_s1: {}, cookies_s2: {} })
    expect(await findOrphanedCookieStores()).toEqual([])
  })
})
