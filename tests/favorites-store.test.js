import { describe, it, expect, beforeEach } from 'vitest'
import {
  MAX_FAVORITES,
  getFavorites,
  setFavorites,
  normalizeFavoriteUrl,
  normalizeFavoriteLabel,
  addFavorite,
  updateFavorite,
  deleteFavorite,
  moveFavorite,
  findFavorite,
  removeFavoritesForSession,
} from '../lib/favorites-store.js'

// jsdom provides no crypto.randomUUID in every version; the store only needs
// uniqueness, not cryptographic quality.
beforeEach(() => {
  if (!globalThis.crypto?.randomUUID) {
    let n = 0
    globalThis.crypto = { ...globalThis.crypto, randomUUID: () => `uuid-${++n}` }
  }
})

async function seed(entries) {
  await setFavorites(entries)
}

describe('getFavorites', () => {
  it('reads an absent key as an empty array', async () => {
    expect(await getFavorites()).toEqual([])
  })

  it('reads a non-array value as an empty array', async () => {
    await chrome.storage.local.set({ favorites: { not: 'an array' } })
    expect(await getFavorites()).toEqual([])
  })

  it('round-trips under the literal `favorites` key', async () => {
    const list = [{ id: 'fav_1', label: 'A', url: 'https://a.test/', sessionId: 's1', createdAt: 1 }]
    await setFavorites(list)
    expect(await getFavorites()).toEqual(list)
    const raw = await chrome.storage.local.get(['favorites'])
    expect(raw.favorites).toEqual(list)
  })
})

describe('getFavorites entry validation', () => {
  it('drops malformed entries instead of handing them to renderers', async () => {
    await chrome.storage.local.set({
      favorites: [
        { id: 'fav_ok', label: 'Good', url: 'https://a.test/', sessionId: 's1', createdAt: 1 },
        { id: 'fav_bad_label', label: 42, url: 'https://b.test/', sessionId: 's1', createdAt: 2 },
        { id: 'fav_missing_url', label: 'No url', sessionId: 's1', createdAt: 3 },
        null,
        'not an object',
        { id: 99, label: 'Bad id', url: 'https://c.test/', sessionId: 's1', createdAt: 4 },
      ],
    })
    const list = await getFavorites()
    expect(list.map(f => f.id)).toEqual(['fav_ok'])
  })

  it('keeps a well-formed entry whose profile no longer exists (orphans are not dropped)', async () => {
    await chrome.storage.local.set({
      favorites: [{ id: 'fav_orphan', label: 'Orphan', url: 'https://a.test/', sessionId: 'gone', createdAt: 1 }],
    })
    expect((await getFavorites()).map(f => f.id)).toEqual(['fav_orphan'])
  })
})

describe('normalizeFavoriteUrl', () => {
  it('normalizes http(s) URLs through URL.href', () => {
    expect(normalizeFavoriteUrl('https://example.com')).toBe('https://example.com/')
    expect(normalizeFavoriteUrl('http://example.com/a?b=1')).toBe('http://example.com/a?b=1')
  })

  it('rejects every non-http(s) scheme', () => {
    expect(normalizeFavoriteUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeFavoriteUrl('data:text/html,<b>x</b>')).toBeNull()
    expect(normalizeFavoriteUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeFavoriteUrl('chrome://extensions')).toBeNull()
  })

  it('rejects unparseable input', () => {
    expect(normalizeFavoriteUrl('not a url')).toBeNull()
    expect(normalizeFavoriteUrl('')).toBeNull()
  })
})

describe('normalizeFavoriteLabel', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeFavoriteLabel('  My   Page  ', 'https://a.test/')).toBe('My Page')
  })

  it('falls back to the hostname when blank', () => {
    expect(normalizeFavoriteLabel('   ', 'https://mail.example.com/inbox')).toBe('mail.example.com')
    expect(normalizeFavoriteLabel(undefined, 'https://mail.example.com/inbox')).toBe('mail.example.com')
  })

  it('caps at 100 characters', () => {
    expect(normalizeFavoriteLabel('x'.repeat(250), 'https://a.test/')).toHaveLength(100)
  })
})

describe('addFavorite', () => {
  it('appends and preserves existing order', async () => {
    await seed([{ id: 'fav_first', label: 'First', url: 'https://first.test/', sessionId: 's1', createdAt: 1 }])
    const result = await addFavorite({ url: 'https://second.test/', sessionId: 's1', label: 'Second' })
    expect(result.status).toBe('added')
    const list = await getFavorites()
    expect(list.map(f => f.label)).toEqual(['First', 'Second'])
    expect(list[1].id).toMatch(/^fav_/)
  })

  it('rejects non-http(s) URLs without writing', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', 'chrome://extensions']) {
      expect((await addFavorite({ url, sessionId: 's1' })).status).toBe('invalid-url')
    }
    expect(await getFavorites()).toEqual([])
  })

  it('returns the existing entry instead of duplicating (url + profile match)', async () => {
    const first = await addFavorite({ url: 'https://a.test/x', sessionId: 's1' })
    const again = await addFavorite({ url: 'https://a.test/x', sessionId: 's1' })
    expect(again.status).toBe('exists')
    expect(again.favorite.id).toBe(first.favorite.id)
    expect(await getFavorites()).toHaveLength(1)
  })

  it('treats the same URL under a different profile as a separate favorite', async () => {
    await addFavorite({ url: 'https://a.test/x', sessionId: 's1' })
    expect((await addFavorite({ url: 'https://a.test/x', sessionId: 's2' })).status).toBe('added')
    expect(await getFavorites()).toHaveLength(2)
  })

  it('returns the limit status at the cap and does not mutate storage', async () => {
    await seed(Array.from({ length: MAX_FAVORITES }, (_, i) => ({
      id: `fav_${i}`, label: `F${i}`, url: `https://x${i}.test/`, sessionId: 's1', createdAt: i,
    })))
    const result = await addFavorite({ url: 'https://over.test/', sessionId: 's1' })
    expect(result.status).toBe('limit')
    expect(await getFavorites()).toHaveLength(MAX_FAVORITES)
  })

  it('labels from the hostname when no label is supplied', async () => {
    await addFavorite({ url: 'https://mail.example.com/inbox', sessionId: 's1' })
    expect((await getFavorites())[0].label).toBe('mail.example.com')
  })

  it('serializes two concurrent same-context adds so both land', async () => {
    await Promise.all([
      addFavorite({ url: 'https://a.test/', sessionId: 's1' }),
      addFavorite({ url: 'https://b.test/', sessionId: 's1' }),
    ])
    expect((await getFavorites()).map(f => f.url).sort()).toEqual(['https://a.test/', 'https://b.test/'])
  })
})

describe('findFavorite', () => {
  it('matches on the normalized href, not the raw string', async () => {
    await addFavorite({ url: 'https://example.com', sessionId: 's1' })
    expect(await findFavorite('https://example.com', 's1')).not.toBeNull()
    expect(await findFavorite('https://example.com/', 's1')).not.toBeNull()
  })

  it('does not match a different profile or an invalid URL', async () => {
    await addFavorite({ url: 'https://example.com/', sessionId: 's1' })
    expect(await findFavorite('https://example.com/', 's2')).toBeNull()
    expect(await findFavorite('chrome://extensions', 's1')).toBeNull()
  })
})

describe('updateFavorite', () => {
  it('patches label, url and profile', async () => {
    const { favorite } = await addFavorite({ url: 'https://a.test/', sessionId: 's1', label: 'A' })
    const result = await updateFavorite(favorite.id, { label: 'B', url: 'https://b.test/x', sessionId: 's2' })
    expect(result.status).toBe('updated')
    const [stored] = await getFavorites()
    expect(stored).toMatchObject({ label: 'B', url: 'https://b.test/x', sessionId: 's2', id: favorite.id })
  })

  it('is a no-op on an unknown id, not a throw', async () => {
    await addFavorite({ url: 'https://a.test/', sessionId: 's1' })
    expect((await updateFavorite('fav_missing', { label: 'X' })).status).toBe('not-found')
    expect((await getFavorites())[0].label).toBe('a.test')
  })

  it('rejects a non-http(s) URL without writing', async () => {
    const { favorite } = await addFavorite({ url: 'https://a.test/', sessionId: 's1' })
    expect((await updateFavorite(favorite.id, { url: 'javascript:alert(1)' })).status).toBe('invalid-url')
    expect((await getFavorites())[0].url).toBe('https://a.test/')
  })

  it('falls a blank label back to the new URL hostname, not the old one', async () => {
    const { favorite } = await addFavorite({ url: 'https://old.test/', sessionId: 's1', label: 'Old' })
    await updateFavorite(favorite.id, { label: '   ', url: 'https://new.test/' })
    expect((await getFavorites())[0].label).toBe('new.test')
  })
})

describe('deleteFavorite', () => {
  it('removes by id and reports whether anything was removed', async () => {
    const { favorite } = await addFavorite({ url: 'https://a.test/', sessionId: 's1' })
    expect(await deleteFavorite(favorite.id)).toBe(true)
    expect(await getFavorites()).toEqual([])
    expect(await deleteFavorite(favorite.id)).toBe(false)
  })
})

describe('moveFavorite', () => {
  beforeEach(async () => {
    await seed(['a', 'b', 'c'].map((label, i) => ({
      id: `fav_${label}`, label, url: `https://${label}.test/`, sessionId: 's1', createdAt: i,
    })))
  })

  it('swaps with the previous entry on up', async () => {
    expect(await moveFavorite('fav_b', 'up')).toBe(true)
    expect((await getFavorites()).map(f => f.label)).toEqual(['b', 'a', 'c'])
  })

  it('swaps with the next entry on down', async () => {
    expect(await moveFavorite('fav_b', 'down')).toBe(true)
    expect((await getFavorites()).map(f => f.label)).toEqual(['a', 'c', 'b'])
  })

  it('is a no-op at either bound', async () => {
    expect(await moveFavorite('fav_a', 'up')).toBe(false)
    expect(await moveFavorite('fav_c', 'down')).toBe(false)
    expect((await getFavorites()).map(f => f.label)).toEqual(['a', 'b', 'c'])
  })

  it('is a no-op for an unknown id', async () => {
    expect(await moveFavorite('fav_missing', 'up')).toBe(false)
  })
})

describe('removeFavoritesForSession', () => {
  it('removes only that profile\'s favorites and reports the count', async () => {
    await seed([
      { id: 'fav_1', label: 'A', url: 'https://a.test/', sessionId: 's1', createdAt: 1 },
      { id: 'fav_2', label: 'B', url: 'https://b.test/', sessionId: 's2', createdAt: 2 },
      { id: 'fav_3', label: 'C', url: 'https://c.test/', sessionId: 's1', createdAt: 3 },
    ])
    expect(await removeFavoritesForSession('s1')).toBe(2)
    expect((await getFavorites()).map(f => f.id)).toEqual(['fav_2'])
  })

  it('is a no-op when the profile owns no favorites', async () => {
    await seed([{ id: 'fav_1', label: 'A', url: 'https://a.test/', sessionId: 's1', createdAt: 1 }])
    expect(await removeFavoritesForSession('s9')).toBe(0)
    expect(await getFavorites()).toHaveLength(1)
  })
})
