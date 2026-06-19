import { describe, it, expect, beforeEach } from 'vitest'
import { runExpiredPurge, runOrphanPurge } from '../background/storage-gc.js'
import { duplicateSession } from '../lib/session-store.js'

const NOW = Date.now()

describe('runExpiredPurge (Phase 5, #13)', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear()
  })

  it('removes only expired future-dated entries; keeps session (null) and tombstone (0)', async () => {
    await chrome.storage.local.set({
      cookies_session_a: {
        expired:  { name: 'expired',  value: 'x', expires: NOW - 1000 },
        future:   { name: 'future',   value: 'y', expires: NOW + 100000 },
        session:  { name: 'session',  value: 'z', expires: null },
        tombstone:{ name: 'tombstone',value: 't', expires: 0 },
      },
    })

    await runExpiredPurge()

    const store = (await chrome.storage.local.get('cookies_session_a')).cookies_session_a
    expect(store.expired).toBeUndefined()
    expect(store.future?.value).toBe('y')
    expect(store.session?.value).toBe('z')   // expires:null survives
    expect(store.tombstone?.value).toBe('t') // expires:0 not purged by `> 0` predicate
  })

  it('does not touch a store with no expired entries (no needless write)', async () => {
    await chrome.storage.local.set({ cookies_session_b: { a: { name: 'a', value: '1', expires: null } } })
    await runExpiredPurge()
    const store = (await chrome.storage.local.get('cookies_session_b')).cookies_session_b
    expect(store.a.value).toBe('1')
  })
})

describe('runOrphanPurge (Phase 5, #3) — two-snapshot confirmation', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear()
  })

  it('does NOT delete an orphan on first sighting', async () => {
    await chrome.storage.local.set({ cookies_session_orphan: { a: { value: '1', expires: null } } })
    await runOrphanPurge()
    const after = await chrome.storage.local.get('cookies_session_orphan')
    expect(after.cookies_session_orphan).toBeDefined() // survived first run
  })

  it('deletes an orphan confirmed across two runs', async () => {
    await chrome.storage.local.set({ cookies_session_orphan: { a: { value: '1', expires: null } } })
    await runOrphanPurge() // first sighting → candidate
    await runOrphanPurge() // confirmed → deleted
    const after = await chrome.storage.local.get('cookies_session_orphan')
    expect(after.cookies_session_orphan).toBeUndefined()
  })

  it('never deletes a referenced (profile) store, even across runs', async () => {
    await chrome.storage.local.set({
      profiles: [{ id: 'session_live', name: 'L' }],
      cookies_session_live: { a: { value: '1', expires: null } },
    })
    await runOrphanPurge()
    await runOrphanPurge()
    const after = await chrome.storage.local.get('cookies_session_live')
    expect(after.cookies_session_live).toBeDefined()
  })

  it('duplicateSession writes profiles-then-store, so a mid-run snapshot never orphans it', async () => {
    // Snapshot the order of writes duplicateSession performs.
    const order = []
    const realSet = chrome.storage.local.set
    chrome.storage.local.set = async (obj) => {
      for (const k of Object.keys(obj)) {
        if (k === 'profiles') order.push('list')
        if (k.startsWith('cookies_')) order.push('store')
      }
      return realSet(obj)
    }
    await chrome.storage.local.set({ profiles: [{ id: 'session_src', name: 'S' }] })
    order.length = 0
    await duplicateSession('session_src')
    chrome.storage.local.set = realSet
    expect(order).toEqual(['list', 'store'])
  })
})
