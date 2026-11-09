import { required } from './helpers/assert.js'
import { chrome } from './setup.js'
import { describe, it, expect } from 'vitest'
import { profileSiteFromUrl, profileSiteKey, UNASSIGNED_SITE_KEY } from '../src/lib/profile-site.js'
import { duplicateSession, setProfiles } from '../src/lib/session-store.js'

describe('profileSiteFromUrl', () => {
  it('records the site name, canonical origin and original URL', () => {
    expect(profileSiteFromUrl('https://Example.com:8443/inbox?x=1#top', '  Work inbox  ')).toEqual({
      name: 'Work inbox',
      origin: 'https://example.com:8443',
      url: 'https://example.com:8443/inbox?x=1#top',
    })
  })

  it('falls back to the hostname when no title is supplied', () => {
    expect(profileSiteFromUrl('http://localhost:3000/a')?.name).toBe('localhost')
  })

  it('rejects non-http URLs and malformed input', () => {
    expect(profileSiteFromUrl('chrome://settings')).toBeUndefined()
    expect(profileSiteFromUrl('javascript:alert(1)')).toBeUndefined()
    expect(profileSiteFromUrl('not a url')).toBeUndefined()
  })
})

describe('profileSiteKey', () => {
  it('groups different paths on the same origin together', () => {
    const first = profileSiteFromUrl('https://example.com/a')
    const second = profileSiteFromUrl('https://example.com/b?c=1')
    expect(profileSiteKey(first)).toBe('https://example.com')
    expect(profileSiteKey(second)).toBe(profileSiteKey(first))
  })

  it('uses the unassigned group for legacy profiles', () => {
    expect(profileSiteKey(undefined)).toBe(UNASSIGNED_SITE_KEY)
  })
})

describe('duplicateSession site metadata', () => {
  it('copies the creation site to the duplicate', async () => {
    const site = { name: 'Example', origin: 'https://example.com', url: 'https://example.com/inbox' }
    await setProfiles([{ id: 'session_source', name: 'Work', hue: 212, site }])
    await chrome.storage.local.set({ cookies_session_source: {} })

    const duplicate = await duplicateSession('session_source')

    expect(duplicate.site).toEqual(site)
    const stored = await chrome.storage.local.get(['profiles'])
    expect(required(stored.profiles.at(-1)).site).toEqual(site)
  })
})

