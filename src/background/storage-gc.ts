// storage-gc.ts — periodic housekeeping for cookie stores (alarm-driven).

import { getCookieStore, setCookieStore, findOrphanedCookieStores } from '../lib/session-store.js';
import { withCookieLock } from '../lib/cookie-write-lock.js';

const ORPHAN_CANDIDATES_KEY = 'gc_orphan_candidates';

/**
 * Purge expired cookie entries from every cookies_* store. Safe to run on startup.
 *
 * Compare-and-retry: re-read each store INSIDE the lock and mutate in place, never
 * blind-overwrite. withCookieLock is in-memory / single-service-worker-lifecycle —
 * it does NOT serialize against a concurrent updateCookie running in another worker
 * generation, so writing back a stale snapshot would clobber a concurrent write.
 */
export async function runExpiredPurge(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const sessionIds = Object.keys(all)
    .filter((k) => k.startsWith('cookies_'))
    .map((k) => k.slice('cookies_'.length));

  for (const sessionId of sessionIds) {
    await withCookieLock(sessionId, async () => {
      const store = await getCookieStore(sessionId); // re-read inside the lock
      let changed = false;
      for (const [key, entry] of Object.entries(store)) {
        // Only real, future-dated expiries that have now passed. Deliberately
        // EXCLUDE expires:null (session cookie, no expiry) and expires:0 (deletion
        // tombstone) — `expires > 0` avoids the looser `expires <= now` catching 0.
        const exp = entry?.expires;
        if (typeof exp === 'number' && exp > 0 && exp <= now) {
          delete store[key];
          changed = true;
        }
      }
      if (changed) await setCookieStore(sessionId, store);
    });
  }
}

/**
 * Remove orphaned cookies_* stores (no list_* reference). MUST NOT run on startup.
 *
 * Two-snapshot confirmation: a store is deleted only if it was orphaned in BOTH the
 * previous run and this one. Combined with list-then-store creation ordering, a live
 * new session's store is never collected — a freshly created store always has its
 * list entry first, and a transient anomaly must persist across two alarm cycles
 * before deletion.
 */
export async function runOrphanPurge(): Promise<void> {
  const stored = await chrome.storage.local.get(ORPHAN_CANDIDATES_KEY);
  const previousCandidates: string[] = Array.isArray(stored[ORPHAN_CANDIDATES_KEY])
    ? stored[ORPHAN_CANDIDATES_KEY]
    : [];
  const currentOrphans = await findOrphanedCookieStores();

  const prevSet = new Set(previousCandidates);
  const confirmed = currentOrphans.filter((id) => prevSet.has(id));
  if (confirmed.length > 0) {
    await chrome.storage.local.remove(confirmed.map((id) => `cookies_${id}`));
  }
  // Carry forward first-time orphans as next run's candidates.
  const nextCandidates = currentOrphans.filter((id) => !confirmed.includes(id));
  await chrome.storage.local.set({ [ORPHAN_CANDIDATES_KEY]: nextCandidates });
}
