import { describe, it, expect } from 'vitest'
import { migrateToProfiles } from '../lib/profile-migration.js'

describe('migrateToProfiles', () => {
  it('folds all list_* keys into a single profiles key (deduped, origin stripped)', async () => {
    await chrome.storage.local.set({
      'list_https://github.com': [{ id: 'a', name: 'Work', hue: 212, origin: 'https://github.com' }],
      'list_https://gmail.com': [
        { id: 'b', name: 'Work', hue: 24, origin: 'https://gmail.com' },
        { id: 'a', name: 'Work', hue: 212, origin: 'https://github.com' },
      ],
      cookies_a: { tok: { value: '1', expires: null } },
      cookies_b: { tok: { value: '2', expires: null } },
    })

    await migrateToProfiles()

    const { profiles } = await chrome.storage.local.get('profiles')
    expect(profiles).toEqual([
      { id: 'a', name: 'Work', hue: 212 },
      { id: 'b', name: 'Work', hue: 24 },
    ])
    // legacy keys removed
    const all = await chrome.storage.local.get(null)
    expect(Object.keys(all).some(k => k.startsWith('list_'))).toBe(false)
    // cookie stores untouched
    expect(all.cookies_a.tok.value).toBe('1')
    expect(all.cookies_b.tok.value).toBe('2')
  })

  it('is idempotent: a second run is a no-op', async () => {
    await chrome.storage.local.set({
      'list_https://x.com': [{ id: 's1', name: 'S', hue: 1 }],
    })
    await migrateToProfiles()
    const first = (await chrome.storage.local.get('profiles')).profiles
    await migrateToProfiles()
    const second = (await chrome.storage.local.get('profiles')).profiles
    expect(second).toEqual(first)
  })

  it('unions legacy lists with a pre-existing profiles key without dropping existing', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'p0', name: 'Existing', hue: 0 }],
      'list_https://x.com': [{ id: 's1', name: 'S', hue: 1 }],
    })
    await migrateToProfiles()
    const { profiles } = await chrome.storage.local.get('profiles')
    expect(profiles.map(p => p.id)).toEqual(['p0', 's1'])
  })

  it('no-op on a fresh install (no list_* keys, no profiles created)', async () => {
    await migrateToProfiles()
    const all = await chrome.storage.local.get(null)
    expect(all.profiles).toBeUndefined()
  })

  it('falls back to id when a legacy entry has no name', async () => {
    await chrome.storage.local.set({
      'list_https://x.com': [{ id: 'session_xyz' }],
    })
    await migrateToProfiles()
    const { profiles } = await chrome.storage.local.get('profiles')
    expect(profiles[0]).toEqual({ id: 'session_xyz', name: 'session_xyz', hue: undefined })
  })
})
