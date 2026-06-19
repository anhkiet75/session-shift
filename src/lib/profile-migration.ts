// profile-migration.ts — one-shot upgrade from per-origin `list_*` keys to the
// single global `profiles` key. Idempotent; safe to call on every onInstalled.

import type { Session } from './types.js'

/**
 * Fold every legacy `list_${origin}` entry into the single `profiles` key and
 * delete the old keys. Cookie stores (`cookies_${id}`) are untouched.
 *
 * Dedupe is by id (mirrors the old cross-origin union): two same-named sessions
 * from different origins keep distinct ids → two distinct profiles with separate
 * cookie jars. No merge-by-name (that would corrupt jars).
 */
export async function migrateToProfiles(): Promise<void> {
  const all = await chrome.storage.local.get(null)
  const listKeys = Object.keys(all).filter(k => k.startsWith('list_'))
  if (listKeys.length === 0) return // nothing legacy → no-op (idempotent)

  const seen = new Set<string>()
  const profiles: Session[] = Array.isArray(all.profiles) ? [...all.profiles] : []
  for (const p of profiles) if (p && typeof p.id === 'string') seen.add(p.id)

  for (const key of listKeys) {
    const list = all[key]
    if (!Array.isArray(list)) continue
    for (const s of list) {
      if (!s || typeof s.id !== 'string' || seen.has(s.id)) continue
      seen.add(s.id)
      profiles.push({ id: s.id, name: s.name || s.id, hue: s.hue }) // drop origin
    }
  }

  await chrome.storage.local.set({ profiles })
  await chrome.storage.local.remove(listKeys)
}
