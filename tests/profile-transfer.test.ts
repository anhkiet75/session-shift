import { required } from './helpers/assert.js'
import { chrome } from './setup.js'
import { describe, it, expect } from 'vitest'
import {
  PROFILE_TRANSFER_FORMAT,
  PROFILE_TRANSFER_VERSION,
  buildProfileTransferPayload,
  importProfileTransfer,
  parseProfileTransfer,
  profileTransferJson,
} from '../src/lib/profile-transfer.js'

const SITE = { name: 'Example inbox', origin: 'https://example.com', url: 'https://example.com/inbox' }
const COOKIE = { name: 'sid', value: 'token-a', domain: 'example.com', path: '/', secure: true, httpOnly: true, expires: null }

function validPayload(overrides = {}) {
  return {
    format: PROFILE_TRANSFER_FORMAT,
    version: PROFILE_TRANSFER_VERSION,
    exportedAt: new Date().toISOString(),
    profiles: [
      { id: 'session_a', name: 'Alpha', hue: 212, site: SITE },
      { id: 'session_legacy', name: 'Legacy', hue: 24 },
    ],
    cookies: {
      session_a: { sid: COOKIE } as Record<string, unknown>,
      session_legacy: {},
    } as Record<string, Record<string, unknown>>,
    ...overrides,
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

describe('buildProfileTransferPayload', () => {
  it('includes every profile, website metadata, and cookie store in the versioned schema', async () => {
    await chrome.storage.local.set({
      profiles: [
        { id: 'session_a', name: 'Alpha', hue: 212, site: SITE },
        { id: 'session_legacy', name: 'Legacy', hue: 24 },
      ],
      cookies_session_a: { sid: COOKIE } as Record<string, unknown>,
      cookies_session_legacy: {},
    })

    const payload = await buildProfileTransferPayload()

    expect(payload.format).toBe('sessionshift-profile-export')
    expect(payload.version).toBe(1)
    expect(Number.isFinite(Date.parse(payload.exportedAt))).toBe(true)
    expect(payload.profiles).toHaveLength(2)
    expect(payload.profiles[0].site).toEqual(SITE)
    expect(payload.profiles[1].site).toBeUndefined()
    expect(payload.cookies.session_a.sid.value).toBe('token-a')
    expect(payload.cookies.session_legacy).toEqual({})
  })

  it('round-trips through the exported JSON', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_a', name: 'Alpha', hue: 212, site: SITE }],
      cookies_session_a: { sid: COOKIE } as Record<string, unknown>,
    })

    const payload = await buildProfileTransferPayload()
    const parsed = parseProfileTransfer(profileTransferJson(payload))

    expect(parsed).toEqual(payload)
  })

  it('drops unscopable legacy cookie entries so every export is importable', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_a', name: 'Alpha', hue: 212 }],
      cookies_session_a: { sid: { value: 'legacy-token' }, 'sid|example.com|/': COOKIE },
    })

    const payload = await buildProfileTransferPayload()

    expect(Object.keys(payload.cookies.session_a)).toEqual(['sid|example.com|/'])
    expect(parseProfileTransfer(profileTransferJson(payload)).cookies.session_a['sid|example.com|/'].value).toBe('token-a')
  })
})

describe('parseProfileTransfer', () => {
  it('accepts legacy profiles without website metadata', () => {
    expect(parseProfileTransfer(JSON.stringify(validPayload())).profiles).toHaveLength(2)
  })

  it('rejects malformed JSON', () => {
    expect(() => parseProfileTransfer('{not json')).toThrow('invalid-json')
  })

  it('rejects unsupported versions', () => {
    const payload = validPayload({ version: 2 })
    expect(() => parseProfileTransfer(JSON.stringify(payload))).toThrow('unsupported-file')
  })

  it('rejects invalid exported timestamps', () => {
    const payload = validPayload({ exportedAt: 'yesterday' })
    expect(() => parseProfileTransfer(JSON.stringify(payload))).toThrow('unsupported-file')
  })

  it('rejects invalid website URLs and mismatched origins', () => {
    const invalidUrl = validPayload()
    invalidUrl.profiles[0].site = { name: 'Bad', origin: 'https://example.com', url: 'javascript:alert(1)' }
    expect(() => parseProfileTransfer(JSON.stringify(invalidUrl))).toThrow('invalid-profile')

    const mismatchedOrigin = validPayload()
    mismatchedOrigin.profiles[0].site = { name: 'Bad', origin: 'https://other.example', url: 'https://example.com/' }
    expect(() => parseProfileTransfer(JSON.stringify(mismatchedOrigin))).toThrow('invalid-profile')
  })

  it('rejects malformed cookie entries', () => {
    const payload = validPayload()
    payload.cookies.session_a.sid = { ...COOKIE, value: 42 }
    expect(() => parseProfileTransfer(JSON.stringify(payload))).toThrow('invalid-cookies')
  })

  it('rejects cookie entries whose name or value could break the Cookie header', () => {
    const badValue = validPayload()
    badValue.cookies.session_a.sid = { ...COOKIE, value: 'token\r\nX-Injected: 1' }
    expect(() => parseProfileTransfer(JSON.stringify(badValue))).toThrow('invalid-cookies')

    const badName = validPayload()
    badName.cookies.session_a.sid = { ...COOKIE, name: 'sid; Path=/' }
    expect(() => parseProfileTransfer(JSON.stringify(badName))).toThrow('invalid-cookies')
  })

  it('rejects cookie entries with no domain scope', () => {
    const payload = validPayload()
    const { domain: _domain, ...unscoped } = COOKIE
    payload.cookies.session_a.wildcard = unscoped
    expect(() => parseProfileTransfer(JSON.stringify(payload))).toThrow('invalid-cookies')
  })

  it('rejects cookie stores that do not belong to an exported profile', () => {
    const payload = validPayload()
    payload.cookies.session_orphan = {}
    expect(() => parseProfileTransfer(JSON.stringify(payload))).toThrow('invalid-cookies')
  })

  it('rejects duplicate profile ids', () => {
    const payload = validPayload()
    payload.profiles.push(clone(payload.profiles[0]))
    expect(() => parseProfileTransfer(JSON.stringify(payload))).toThrow('duplicate-profile')
  })
})

describe('importProfileTransfer', () => {
  it('keeps unique ids and names, merges with local profiles, and writes cookies', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_local', name: 'Local', hue: 10 }],
      cookies_session_local: { local: { value: 'keep' } },
    })
    const setSpy = chrome.storage.local.set
    setSpy.mockClear()

    const result = await importProfileTransfer(parseProfileTransfer(JSON.stringify(validPayload())))

    const { profiles } = await chrome.storage.local.get(['profiles'])
    expect(profiles.map(profile => profile.id)).toEqual(['session_local', 'session_a', 'session_legacy'])
    expect(required(profiles.find(profile => profile.id === 'session_a')).site).toEqual(SITE)
    expect(result).toEqual({ importedProfiles: 2, importedCookieStores: 1 })
    expect((await chrome.storage.local.get(['cookies_session_a'])).cookies_session_a.sid.value).toBe('token-a')
    expect((await chrome.storage.local.get(['cookies_session_local'])).cookies_session_local.local.value).toBe('keep')

    // One storage write keeps the merge from leaving a half-imported profile list.
    expect(setSpy).toHaveBeenCalledTimes(1)
    const written = setSpy.mock.calls[0][0]
    expect(written.profiles).toHaveLength(3)
    expect((written.cookies_session_a as import("../src/lib/session-store.js").CookieStore).sid.value).toBe('token-a')
  })

  it('renames a duplicate id, keeps local cookies, and rewrites the imported store key', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_a', name: 'Local alpha', hue: 212 }],
      cookies_session_a: { sid: { value: 'local-token' } },
    })

    const result = await importProfileTransfer(parseProfileTransfer(JSON.stringify(validPayload())))

    const { profiles } = await chrome.storage.local.get(['profiles'])
    const imported = profiles.find(profile => profile.name === 'Alpha (imported)')
    expect(required(imported).id).toMatch(/^session_/)
    expect(required(imported).id).not.toBe('session_a')
    expect(result.importedProfiles).toBe(2)
    expect((await chrome.storage.local.get(['cookies_session_a'])).cookies_session_a.sid.value).toBe('local-token')
    const rewritten = await chrome.storage.local.get(['cookies_' + required(imported).id])
    expect((rewritten["cookies_" + required(imported).id] as import("../src/lib/session-store.js").CookieStore).sid.value).toBe('token-a')
  })

  it('renames a duplicate name even when the id is unique', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_other', name: 'Alpha', hue: 1 }],
    })

    await importProfileTransfer(parseProfileTransfer(JSON.stringify(validPayload())))

    const { profiles } = await chrome.storage.local.get(['profiles'])
    const imported = profiles.find(profile => profile.name === 'Alpha (imported)')
    expect(imported).toBeDefined()
    expect(required(imported).id).not.toBe('session_a')
    expect(required(profiles.find(profile => profile.id === 'session_other')).name).toBe('Alpha')
  })

  it('never overwrites an existing cookie store with no matching profile', async () => {
    await chrome.storage.local.set({
      profiles: [],
      cookies_session_a: { sid: { value: 'orphan-token' } },
    })

    await importProfileTransfer(parseProfileTransfer(JSON.stringify(validPayload())))

    const { profiles } = await chrome.storage.local.get(['profiles'])
    const imported = profiles.find(profile => profile.name === 'Alpha (imported)')
    expect(required(imported).id).not.toBe('session_a')
    expect((await chrome.storage.local.get(['cookies_session_a'])).cookies_session_a.sid.value).toBe('orphan-token')
    expect(((await chrome.storage.local.get(["cookies_" + required(imported).id]))["cookies_" + required(imported).id] as import("../src/lib/session-store.js").CookieStore).sid.value).toBe('token-a')
  })

  it('merges the same file twice without duplicating ids or names', async () => {
    const parsed = parseProfileTransfer(JSON.stringify(validPayload()))
    await importProfileTransfer(parsed)
    await importProfileTransfer(parsed)

    const { profiles } = await chrome.storage.local.get(['profiles'])
    expect(profiles).toHaveLength(4)
    expect(new Set(profiles.map(profile => profile.id)).size).toBe(4)
    expect(new Set(profiles.map(profile => profile.name)).size).toBe(4)
  })
})

