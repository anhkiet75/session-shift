// favorites-store.ts — Sole authority for the `favorites` storage key.
//
// A favorite is a saved (url, profile) pair the user launches from the popup.
// This module owns reading, writing, validating and cascade-purging them; UI
// layers never touch the storage key directly, mirroring how `session-store.ts`
// owns `profiles`.
//
// Usable from the popup, the Options page and the service worker — everything
// here is promise-style `chrome.storage`, never callback style.

import type { Favorite } from './types.js'

const FAVORITES_KEY = 'favorites'

/** Hard cap on stored favorites. Surfaced as a UI message, never enforced by throwing. */
export const MAX_FAVORITES = 50

export const MAX_LABEL_LENGTH = 100

/**
 * A stored entry is only usable if every field it is read through is a string.
 * Storage can be edited out of band or left behind by a failed migration, and
 * a malformed record would otherwise throw deep inside a render (`label` is
 * lowercased for search, interpolated into aria-labels, and `id` is
 * interpolated into an attribute selector in Options).
 */
function isFavorite(value: unknown): value is Favorite {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && typeof entry.label === 'string'
    && typeof entry.url === 'string'
    && typeof entry.sessionId === 'string'
}

export async function getFavorites(): Promise<Favorite[]> {
  const result = await chrome.storage.local.get([FAVORITES_KEY])
  const value = result[FAVORITES_KEY]
  return Array.isArray(value) ? value.filter(isFavorite) : []
}

export async function setFavorites(list: Favorite[]): Promise<void> {
  await chrome.storage.local.set({ [FAVORITES_KEY]: list })
}

/**
 * Normalize a candidate favorite URL. Returns the absolute href for http(s)
 * URLs and `null` for everything else — `javascript:`, `data:`, `file:`,
 * `chrome://` and unparseable input all land on the same rejection. Applied on
 * save; `createSessionTab` re-checks the scheme again on launch.
 */
export function normalizeFavoriteUrl(url: string): string | null {
  if (typeof url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.href
}

/** Trim, collapse inner whitespace, cap length; fall back to the URL's hostname when blank. */
export function normalizeFavoriteLabel(label: string | null | undefined, url: string): string {
  const collapsed = (label ?? '').replace(/\s+/g, ' ').trim()
  if (collapsed) return collapsed.slice(0, MAX_LABEL_LENGTH)
  try {
    return new URL(url).hostname
  } catch {
    return url.slice(0, MAX_LABEL_LENGTH)
  }
}

interface Mutation<T> {
  /** Omitted when the mutation is a no-op — nothing is written. */
  next?: Favorite[]
  result: T
}

// Per-context serialization only (each extension page / service-worker instance
// has its own queue) — chained so concurrent same-context writes
// read-modify-write one at a time instead of racing on a stale snapshot. Chrome
// storage has no read-modify-write primitive, so a write from *another* context
// landing between this read and set can still be lost. Same accepted
// limitation as `settings-store.ts`'s `mutateExtSettingsField`: the worst case
// is one lost favorite edit, which is non-destructive and user-visible.
let mutationQueue: Promise<unknown> = Promise.resolve()

function mutateFavorites<T>(mutator: (current: Favorite[]) => Mutation<T>): Promise<T> {
  const task = mutationQueue.then(async () => {
    const current = await getFavorites()
    const { next, result } = mutator(current)
    if (next) await setFavorites(next)
    return result
  })
  mutationQueue = task.catch(() => {})
  return task
}

export type AddFavoriteResult =
  | { status: 'added'; favorite: Favorite }
  | { status: 'exists'; favorite: Favorite }
  | { status: 'invalid-url' }
  | { status: 'limit' }

/** Append a favorite. Never throws — every rejection is a distinguishable status. */
export function addFavorite(input: { url: string; sessionId: string; label?: string }): Promise<AddFavoriteResult> {
  const url = normalizeFavoriteUrl(input.url)
  if (!url) return Promise.resolve<AddFavoriteResult>({ status: 'invalid-url' })
  return mutateFavorites<AddFavoriteResult>((current) => {
    const existing = current.find(f => f.url === url && f.sessionId === input.sessionId)
    if (existing) return { result: { status: 'exists', favorite: existing } }
    if (current.length >= MAX_FAVORITES) return { result: { status: 'limit' } }
    const favorite: Favorite = {
      id: 'fav_' + crypto.randomUUID(),
      label: normalizeFavoriteLabel(input.label, url),
      url,
      sessionId: input.sessionId,
      createdAt: Date.now(),
    }
    return { next: [...current, favorite], result: { status: 'added', favorite } }
  })
}

export type UpdateFavoriteResult =
  | { status: 'updated'; favorite: Favorite }
  | { status: 'not-found' }
  | { status: 'invalid-url' }

/** Patch a favorite by id. An unknown id is a no-op, not a throw. */
export function updateFavorite(
  id: string,
  patch: { label?: string; url?: string; sessionId?: string },
): Promise<UpdateFavoriteResult> {
  let patchedUrl: string | null = null
  if (patch.url !== undefined) {
    patchedUrl = normalizeFavoriteUrl(patch.url)
    if (!patchedUrl) return Promise.resolve<UpdateFavoriteResult>({ status: 'invalid-url' })
  }
  return mutateFavorites<UpdateFavoriteResult>((current) => {
    const index = current.findIndex(f => f.id === id)
    if (index === -1) return { result: { status: 'not-found' } }
    const previous = current[index]
    const url = patchedUrl ?? previous.url
    const favorite: Favorite = {
      ...previous,
      url,
      sessionId: patch.sessionId ?? previous.sessionId,
      // A cleared label falls back to the hostname of the URL actually being
      // stored, not the old one — editing URL and label together must not
      // resurrect the previous host as the label.
      label: patch.label !== undefined ? normalizeFavoriteLabel(patch.label, url) : previous.label,
    }
    const next = [...current]
    next[index] = favorite
    return { next, result: { status: 'updated', favorite } }
  })
}

/** Returns true when a favorite was actually removed. */
export function deleteFavorite(id: string): Promise<boolean> {
  return mutateFavorites<boolean>((current) => {
    const next = current.filter(f => f.id !== id)
    return next.length === current.length ? { result: false } : { next, result: true }
  })
}

/**
 * Swap a favorite with its neighbour. Index-based rather than accepting a
 * caller-supplied array, so a stale caller snapshot cannot silently reorder or
 * drop entries it never saw. A move past either bound is a no-op.
 */
export function moveFavorite(id: string, direction: 'up' | 'down'): Promise<boolean> {
  return mutateFavorites<boolean>((current) => {
    const index = current.findIndex(f => f.id === id)
    if (index === -1) return { result: false }
    const target = direction === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= current.length) return { result: false }
    const next = [...current]
    next[index] = current[target]
    next[target] = current[index]
    return { next, result: true }
  })
}

/** Exact match on normalized href + profile — powers the popup star's toggle state. */
export async function findFavorite(url: string, sessionId: string): Promise<Favorite | null> {
  const normalized = normalizeFavoriteUrl(url)
  if (!normalized) return null
  const list = await getFavorites()
  return list.find(f => f.url === normalized && f.sessionId === sessionId) ?? null
}

/**
 * Cascade purge for a deleted profile. Returns the number removed. Called from
 * the `deleteSession` message handler, where the rest of that profile's
 * cleanup (tab mappings, DNR rules, cookie store) already happens.
 */
export function removeFavoritesForSession(sessionId: string): Promise<number> {
  return mutateFavorites<number>((current) => {
    const next = current.filter(f => f.sessionId !== sessionId)
    const removed = current.length - next.length
    return removed === 0 ? { result: 0 } : { next, result: removed }
  })
}
